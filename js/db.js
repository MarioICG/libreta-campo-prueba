// Almacenamiento local en IndexedDB. Todo queda en el teléfono, sin cuentas ni nube.
//   projects : { id, name, prefix, counter, utmZone, fields:[{key,label,type,options}], created }
//   points   : { id, projectId, code, lat, lon, acc, altEll, source, time, values:{}, notes, place }
//   photos   : { id, projectId, pointId, n, time, lat, lon, acc, altEll, azMag, azSource, decl,
//                rotation, caption, place, thumb:Blob, w, h }
//   blobs    : { id (=photo id), blob }   foto original sin marca de agua
//   settings : { key, value }

const DB_NAME = 'libreta-campo';
const DB_VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('projects', { keyPath: 'id' });
      const pts = db.createObjectStore('points', { keyPath: 'id' });
      pts.createIndex('projectId', 'projectId');
      const ph = db.createObjectStore('photos', { keyPath: 'id' });
      ph.createIndex('projectId', 'projectId');
      ph.createIndex('pointId', 'pointId');
      db.createObjectStore('blobs', { keyPath: 'id' });
      db.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export async function get(name, id) { return wrap((await store(name)).get(id)); }
export async function put(name, obj) { return wrap((await store(name, 'readwrite')).put(obj)); }
export async function del(name, id) { return wrap((await store(name, 'readwrite')).delete(id)); }
export async function all(name) { return wrap((await store(name)).getAll()); }
export async function byIndex(name, index, value) {
  return wrap((await store(name)).index(index).getAll(value));
}

export async function getSetting(key, fallback) {
  const r = await get('settings', key);
  return r ? r.value : fallback;
}
export async function setSetting(key, value) { return put('settings', { key, value }); }

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Borra un punto con sus fotos
export async function deletePoint(pointId) {
  const photos = await byIndex('photos', 'pointId', pointId);
  for (const p of photos) { await del('blobs', p.id); await del('photos', p.id); }
  await del('points', pointId);
}

export async function deletePhoto(photoId) {
  await del('blobs', photoId);
  await del('photos', photoId);
}

export async function deleteProject(projectId) {
  const pts = await byIndex('points', 'projectId', projectId);
  for (const p of pts) await deletePoint(p.id);
  const loose = await byIndex('photos', 'projectId', projectId);
  for (const p of loose) await deletePhoto(p.id);
  await del('projects', projectId);
}

export async function storageInfo() {
  const out = { persisted: false, usage: null, quota: null };
  try {
    if (navigator.storage?.persisted) out.persisted = await navigator.storage.persisted();
    if (navigator.storage?.estimate) {
      const e = await navigator.storage.estimate();
      out.usage = e.usage; out.quota = e.quota;
    }
  } catch (e) { /* sin soporte */ }
  return out;
}

export async function requestPersist() {
  try { return navigator.storage?.persist ? await navigator.storage.persist() : false; }
  catch (e) { return false; }
}
