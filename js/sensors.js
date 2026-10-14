// GPS y orientación del teléfono (brújula, inclinación y giro físico).
import { norm360, distance } from './geo.js';

const RAD = Math.PI / 180, DEG = 180 / Math.PI;
const subs = new Set();
const emit = () => subs.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }

export const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/* ---------------- GPS ---------------- */

export const gps = { fix: null, status: 'off', message: '' };
let watchId = null;
const recent = []; // últimas posiciones para promediar

export function startGPS() {
  if (watchId !== null) return;
  if (!('geolocation' in navigator)) { gps.status = 'nosoportado'; emit(); return; }
  gps.status = 'buscando'; emit();
  watchId = navigator.geolocation.watchPosition((p) => {
    const c = p.coords;
    gps.fix = {
      lat: c.latitude, lon: c.longitude, acc: c.accuracy,
      alt: c.altitude, altAcc: c.altitudeAccuracy,
      altRef: isIOS ? 'msl' : 'ell', // iOS entrega altitud sobre el nivel del mar; Android, elipsoidal
      t: p.timestamp || Date.now(),
    };
    recent.push(gps.fix);
    while (recent.length && recent[0].t < Date.now() - 60000) recent.shift();
    gps.status = 'ok'; gps.message = '';
    emit();
  }, (err) => {
    if (err.code === 1) { gps.status = 'denegado'; gps.message = 'Permiso de ubicación denegado'; }
    else if (err.code === 3) { gps.status = gps.fix ? 'ok' : 'buscando'; }
    else { gps.status = 'error'; gps.message = err.message; }
    emit();
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}

export function fixAge() { return gps.fix ? (Date.now() - gps.fix.t) / 1000 : Infinity; }

// Estado legible para la interfaz
export function gpsQuality() {
  if (gps.status === 'denegado' || gps.status === 'nosoportado') return 'off';
  if (!gps.fix || fixAge() > 30) return 'sin';
  if (gps.fix.acc <= 10) return 'buena';
  if (gps.fix.acc <= 30) return 'media';
  return 'mala';
}

// Mejor posición de los últimos `seconds` segundos: promedio ponderado de las más precisas.
export function bestFix(seconds = 15) {
  const now = Date.now();
  const last = gps.fix;
  if (!last) return null;
  // Solo lecturas recientes y cercanas a la última: si caminaste, no se mezcla el recorrido
  const near = Math.max(2 * last.acc, 8);
  const pool = recent.filter((f) => f.t >= now - seconds * 1000 && distance(f, last) <= near);
  if (!pool.length) return { ...last, n: 1 };
  const minAcc = Math.min(...pool.map((f) => f.acc));
  const good = pool.filter((f) => f.acc <= minAcc * 1.5);
  let w = 0, lat = 0, lon = 0, alt = 0, wa = 0;
  for (const f of good) {
    const k = 1 / (f.acc * f.acc);
    w += k; lat += f.lat * k; lon += f.lon * k;
    if (f.alt != null) { alt += f.alt * k; wa += k; }
  }
  const newest = good[good.length - 1];
  return {
    lat: lat / w, lon: lon / w, acc: minAcc, alt: wa ? alt / wa : null,
    altRef: newest.altRef, t: newest.t, n: good.length,
  };
}

/* ---------------- Orientación ---------------- */

export const compass = {
  source: 'none',      // 'absolute' (Android), 'webkit' (iOS), 'relative' (sin norte), 'none'
  heading: null,       // rumbo magnético hacia donde mira la cámara trasera
  headingFrom: null,   // 'camara' | 'borde' (teléfono casi horizontal)
  plane: null,         // { dipDir, dip } magnéticos, teléfono apoyado sobre un plano
  phys: 0,             // giro físico del teléfono 0/90/180/270 (antihorario)
  tilt: null,          // inclinación de la cámara respecto a la horizontal (°)
  lastEvent: 0,
};

let started = false;
const K = 0.18; // suavizado
let vCam = null, vTop = null, vNor = null;

function ema(prev, cur) {
  if (!prev) return cur;
  return prev.map((p, i) => p + (cur[i] - p) * K);
}

function handle(alpha, beta, gamma) {
  if (beta == null || gamma == null) return;
  const z = (alpha || 0) * RAD, x = beta * RAD, y = gamma * RAD;
  const cZ = Math.cos(z), sZ = Math.sin(z), cX = Math.cos(x), sX = Math.sin(x), cY = Math.cos(y), sY = Math.sin(y);
  // Matriz de rotación W3C (dispositivo -> tierra: x=Este, y=Norte, z=Arriba)
  const R = [
    [cZ * cY - sZ * sX * sY, -cX * sZ, cY * sZ * sX + cZ * sY],
    [cY * sZ + cZ * sX * sY, cZ * cX, sZ * sY - cZ * cY * sX],
    [-cX * sY, sX, cX * cY],
  ];
  vCam = ema(vCam, [-R[0][2], -R[1][2], -R[2][2]]);
  vTop = ema(vTop, [R[0][1], R[1][1], R[2][1]]);
  vNor = ema(vNor, [R[0][2], R[1][2], R[2][2]]);

  // Giro físico a partir del vector "arriba" en coordenadas del dispositivo
  const ux = R[2][0], uy = R[2][1];
  if (Math.hypot(ux, uy) > 0.55) {
    compass.phys = norm360(Math.round(Math.atan2(ux, uy) * DEG / 90) * 90);
  }

  if (compass.source === 'relative') { compass.heading = null; compass.plane = null; }
  else {
    const hc = Math.hypot(vCam[0], vCam[1]);
    const ht = Math.hypot(vTop[0], vTop[1]);
    if (hc > 0.35) { compass.heading = norm360(Math.atan2(vCam[0], vCam[1]) * DEG); compass.headingFrom = 'camara'; }
    else if (ht > 0.2) { compass.heading = norm360(Math.atan2(vTop[0], vTop[1]) * DEG); compass.headingFrom = 'borde'; }
    // Plano: normal hacia arriba
    let n = vNor.slice();
    const len = Math.hypot(...n); n = n.map((c) => c / len);
    if (n[2] < 0) n = n.map((c) => -c);
    const dip = Math.acos(Math.min(1, n[2])) * DEG;
    const dipDir = Math.hypot(n[0], n[1]) > 1e-3 ? norm360(Math.atan2(n[0], n[1]) * DEG) : 0;
    compass.plane = { dipDir, dip };
  }
  compass.tilt = Math.asin(Math.max(-1, Math.min(1, vCam[2]))) * DEG; // + hacia arriba, - hacia abajo
  compass.lastEvent = Date.now();
  emit();
}

function onAbsolute(e) {
  if (e.alpha == null) return;
  if (compass.source !== 'absolute') compass.source = 'absolute';
  handle(e.alpha, e.beta, e.gamma);
}

function onRelative(e) {
  if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
    compass.source = 'webkit';
    compass.accuracy = e.webkitCompassAccuracy;
    handle(360 - e.webkitCompassHeading, e.beta, e.gamma);
  } else if (e.absolute === true && e.alpha != null) {
    compass.source = 'absolute';
    handle(e.alpha, e.beta, e.gamma);
  } else if (compass.source === 'none' || compass.source === 'relative') {
    compass.source = 'relative'; // hay sensores pero no norte: sirve para el giro físico
    handle(e.alpha, e.beta, e.gamma);
  }
}

export function compassNeedsPermission() {
  return typeof DeviceOrientationEvent !== 'undefined' &&
    typeof DeviceOrientationEvent.requestPermission === 'function' && !started;
}

// Debe llamarse desde un toque del usuario (iOS lo exige).
export async function startCompass() {
  if (started) return true;
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== 'granted') return false;
    }
  } catch (e) { return false; }
  started = true;
  if ('ondeviceorientationabsolute' in window) {
    window.addEventListener('deviceorientationabsolute', onAbsolute);
  } else {
    window.addEventListener('deviceorientation', onRelative);
  }
  return true;
}

export function compassAlive() { return Date.now() - compass.lastEvent < 2000 && compass.source !== 'none'; }
export function compassHasNorth() { return compassAlive() && (compass.source === 'absolute' || compass.source === 'webkit'); }
