// Nombre del lugar a partir de coordenadas (OpenStreetMap Nominatim).
// Solo con conexión; los resultados se guardan para no repetir consultas.
import { getSetting, setSetting } from './db.js';

let cache = null;
let lastCall = 0;
let queue = Promise.resolve();

const key = (lat, lon) => `${(Math.round(lat / 0.005) * 0.005).toFixed(3)},${(Math.round(lon / 0.005) * 0.005).toFixed(3)}`;

async function loadCache() {
  if (!cache) cache = (await getSetting('geocache', {})) || {};
  return cache;
}

export async function cachedPlace(lat, lon) {
  const c = await loadCache();
  return c[key(lat, lon)] || null;
}

export function reversePlace(lat, lon) {
  // Cola: Nominatim pide como máximo una consulta por segundo
  const job = queue.then(async () => {
    const c = await loadCache();
    const k = key(lat, lon);
    if (c[k]) return c[k];
    if (!navigator.onLine) return null;
    const wait = 1100 - (Date.now() - lastCall);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&addressdetails=1&accept-language=es&lat=${lat}&lon=${lon}`;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      clearTimeout(t);
      if (!r.ok) return null;
      const j = await r.json();
      const a = j.address || {};
      const local = a.village || a.town || a.city || a.hamlet || a.municipality || a.locality || a.suburb || a.county;
      const region = a.province || a.state_district || a.state || a.region || a.county;
      const parts = [];
      for (const p of [local, region, a.country]) if (p && !parts.includes(p)) parts.push(p);
      const name = parts.join(', ') || j.display_name || null;
      if (name) { c[k] = name; setSetting('geocache', c); }
      return name;
    } catch (e) { return null; }
  });
  queue = job.catch(() => null);
  return job;
}
