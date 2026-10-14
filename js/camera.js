// Cámara dentro de la app: así el rumbo y la posición se leen en el instante exacto del disparo.
import { compass } from './sensors.js';

let stream = null;
let track = null;

export function cameraSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

export async function openCamera(video) {
  closeCamera();
  const tries = [
    { video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 }, aspectRatio: { ideal: 4 / 3 } }, audio: false },
    { video: { facingMode: { ideal: 'environment' } }, audio: false },
    { video: true, audio: false },
  ];
  let lastErr;
  for (const c of tries) {
    try { stream = await navigator.mediaDevices.getUserMedia(c); break; } catch (e) { lastErr = e; }
  }
  if (!stream) throw lastErr || new Error('Sin cámara');
  track = stream.getVideoTracks()[0];
  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  video.muted = true;
  await video.play().catch(() => {});
  if (!video.videoWidth) await new Promise((r) => video.addEventListener('loadedmetadata', r, { once: true }));
  return { width: video.videoWidth, height: video.videoHeight, torch: hasTorch() };
}

export function closeCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null; track = null;
}

export function hasTorch() {
  try { return !!track?.getCapabilities?.().torch; } catch (e) { return false; }
}

export async function setTorch(on) {
  try { await track.applyConstraints({ advanced: [{ torch: !!on }] }); return true; } catch (e) { return false; }
}

function screenAngle() {
  const a = screen.orientation?.angle ?? window.orientation ?? 0;
  return ((a % 360) + 360) % 360;
}

// Gira un lienzo en sentido antihorario (0/90/180/270)
export function rotateCCW(src, deg) {
  deg = ((deg % 360) + 360) % 360;
  if (!deg) return src;
  const c = document.createElement('canvas');
  const swap = deg === 90 || deg === 270;
  c.width = swap ? src.height : src.width;
  c.height = swap ? src.width : src.height;
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(-deg * Math.PI / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

// Captura el fotograma actual. Si el teléfono está girado y la pantalla no rotó
// (rotación automática desactivada), endereza la foto.
export async function captureFrame(video) {
  const c = document.createElement('canvas');
  c.width = video.videoWidth; c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  const delta = (compass.phys - screenAngle() + 360) % 360;
  const out = rotateCCW(c, delta);
  const blob = await new Promise((r) => out.toBlob(r, 'image/jpeg', 0.93));
  return { blob, width: out.width, height: out.height, autoRotated: delta };
}
