// Utilidades geográficas: UTM, formatos, declinación magnética y geoide.
// Todo funciona sin conexión.

const A = 6378137.0;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const EP2 = E2 / (1 - E2);
const K0 = 0.9996;
const RAD = Math.PI / 180;

export function utmZoneFor(lat, lon) {
  let zone = Math.floor((lon + 180) / 6) + 1;
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) zone = 32; // Noruega
  if (lat >= 72 && lat < 84) { // Svalbard
    if (lon >= 0 && lon < 9) zone = 31;
    else if (lon >= 9 && lon < 21) zone = 33;
    else if (lon >= 21 && lon < 33) zone = 35;
    else if (lon >= 33 && lon < 42) zone = 37;
  }
  return Math.min(Math.max(zone, 1), 60);
}

export function latBand(lat) {
  if (lat < -80 || lat > 84) return '';
  return 'CDEFGHJKLMNPQRSTUVWXX'[Math.floor((lat + 80) / 8)];
}

// WGS84 geográficas -> UTM. forcedZone permite fijar el huso del proyecto.
export function toUTM(lat, lon, forcedZone) {
  const zone = forcedZone || utmZoneFor(lat, lon);
  const lon0 = (zone - 1) * 6 - 180 + 3;
  const phi = lat * RAD;
  const sin = Math.sin(phi), cos = Math.cos(phi), tan = Math.tan(phi);
  const N = A / Math.sqrt(1 - E2 * sin * sin);
  const T = tan * tan;
  const C = EP2 * cos * cos;
  const Aa = cos * (lon - lon0) * RAD;
  const e4 = E2 * E2, e6 = e4 * E2;
  const M = A * ((1 - E2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi
    - (3 * E2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * phi)
    + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * phi)
    - (35 * e6 / 3072) * Math.sin(6 * phi));
  const x = K0 * N * (Aa + (1 - T + C) * Aa ** 3 / 6
    + (5 - 18 * T + T * T + 72 * C - 58 * EP2) * Aa ** 5 / 120) + 500000;
  let y = K0 * (M + N * tan * (Aa * Aa / 2 + (5 - T + 9 * C + 4 * C * C) * Aa ** 4 / 24
    + (61 - 58 * T + T * T + 600 * C - 330 * EP2) * Aa ** 6 / 720));
  const hemi = lat < 0 ? 'S' : 'N';
  if (lat < 0) y += 10000000;
  return { zone, band: latBand(lat), hemi, x, y };
}

export function formatUTM(u) {
  return `${u.zone}${u.band} ${Math.round(u.x)} E ${Math.round(u.y)} N`;
}

export function formatLatLon(lat, lon, mode = 'dec') {
  const ns = lat >= 0 ? 'N' : 'S';
  const eo = lon >= 0 ? 'E' : 'O';
  if (mode === 'dms') return `${dms(lat)} ${ns}  ${dms(lon)} ${eo}`;
  return `${Math.abs(lat).toFixed(5)}° ${ns}  ${Math.abs(lon).toFixed(5)}° ${eo}`;
}

function dms(v) {
  v = Math.abs(v);
  let d = Math.floor(v);
  let m = Math.floor((v - d) * 60);
  let s = ((v - d) * 60 - m) * 60;
  if (s >= 59.95) { s = 0; m += 1; }
  if (m >= 60) { m = 0; d += 1; }
  return `${d}°${String(m).padStart(2, '0')}′${s.toFixed(1).padStart(4, '0')}″`;
}

const RUMBOS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
export function cardinal(az) {
  if (az == null || isNaN(az)) return '';
  return RUMBOS[Math.round(norm360(az) / 22.5) % 16];
}

export function norm360(a) { return ((a % 360) + 360) % 360; }

export function fmtAz(az) {
  if (az == null || isNaN(az)) return '—';
  return String(Math.round(norm360(az)) % 360).padStart(3, '0') + '°';
}

// Declinación magnética (WMM2025). Positiva = Este.
export function declination(lat, lon, altM, date) {
  try {
    if (!self.WMM) return null;
    return self.WMM.declination(lat, lon, (altM || 0) / 1000, date || new Date());
  } catch (e) { return null; }
}

// Rumbo magnético -> geográfico
export function magToTrue(azMag, decl) {
  if (azMag == null) return null;
  return norm360(azMag + (decl || 0));
}

// Altitud elipsoidal (la que da el GPS en Android) -> altitud sobre el nivel del mar (EGM96)
export function geoidN(lat, lon) {
  try { return self.GEOIDE ? self.GEOIDE.ondulacion(lat, lon) : null; } catch (e) { return null; }
}

export function distance(a, b) {
  const R = 6371008.8;
  const dLat = (b.lat - a.lat) * RAD, dLon = (b.lon - a.lon) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function fmtDecl(d) {
  if (d == null) return '—';
  const s = Math.abs(d).toFixed(1).replace('.', ',');
  return `${s}° ${d >= 0 ? 'E' : 'O'}`;
}
