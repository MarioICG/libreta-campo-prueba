// Exportación a ZIP (GeoJSON + fotos) e importación de copias de seguridad.
import * as db from './db.js';
import { toUTM, norm360 } from './geo.js';
import { renderPhoto, canvasToBlob, photoInfo, dateParts, altMSL, photoAzimuth } from './watermark.js';
import { reversePlace } from './place.js';
import { PUNTOS_QML, FOTOS_QML } from './qml.js';

const safe = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'sin_nombre';

const ascii = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7E]/g, '?');

export function photoFileName(point, photo) {
  return `${safe(point?.code || 'foto')}_${String(photo.n || 1).padStart(2, '0')}.jpg`;
}

/* ---------- EXIF ---------- */

async function blobToBinary(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return s;
}
function binaryToBlob(bin) {
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Blob([u], { type: 'image/jpeg' });
}
const rat = (v, d = 100) => [Math.round(v * d), d];

export async function withExif(jpeg, photo, point, project, wm, description) {
  const P = self.piexif;
  if (!P) return jpeg;
  try {
    const dp = dateParts(photo.time, photo.tzOff);
    const u = new Date(photo.time);
    const zeroth = {}, exif = {}, gps = {};
    zeroth[P.ImageIFD.Make] = 'Libreta de campo';
    zeroth[P.ImageIFD.Software] = 'Libreta de campo (PWA)';
    zeroth[P.ImageIFD.DateTime] = dp.exif;
    zeroth[P.ImageIFD.Orientation] = 1;
    if (description) {
      zeroth[P.ImageIFD.ImageDescription] = ascii(description);
      const utf16 = [];
      for (const ch of description + '\0') { const c = ch.charCodeAt(0); utf16.push(c & 255, c >> 8); }
      zeroth[P.ImageIFD.XPComment] = utf16;
    }
    exif[P.ExifIFD.DateTimeOriginal] = dp.exif;
    gps[P.GPSIFD.GPSVersionID] = [2, 3, 0, 0];
    gps[P.GPSIFD.GPSMapDatum] = 'WGS-84';
    gps[P.GPSIFD.GPSLatitudeRef] = photo.lat >= 0 ? 'N' : 'S';
    gps[P.GPSIFD.GPSLatitude] = P.GPSHelper.degToDmsRational(Math.abs(photo.lat));
    gps[P.GPSIFD.GPSLongitudeRef] = photo.lon >= 0 ? 'E' : 'W';
    gps[P.GPSIFD.GPSLongitude] = P.GPSHelper.degToDmsRational(Math.abs(photo.lon));
    const alt = altMSL(photo);
    if (alt != null) {
      gps[P.GPSIFD.GPSAltitudeRef] = alt < 0 ? 1 : 0;
      gps[P.GPSIFD.GPSAltitude] = rat(Math.abs(alt));
    }
    if (photo.acc != null) gps[P.GPSIFD.GPSHPositioningError] = rat(photo.acc);
    const az = photoAzimuth(photo, wm.northRef);
    if (az != null) {
      gps[P.GPSIFD.GPSImgDirectionRef] = (wm.northRef === 'mag' || photo.decl == null) ? 'M' : 'T';
      gps[P.GPSIFD.GPSImgDirection] = rat(az);
    }
    const p2 = (n) => String(n).padStart(2, '0');
    gps[P.GPSIFD.GPSDateStamp] = `${u.getUTCFullYear()}:${p2(u.getUTCMonth() + 1)}:${p2(u.getUTCDate())}`;
    gps[P.GPSIFD.GPSTimeStamp] = [[u.getUTCHours(), 1], [u.getUTCMinutes(), 1], [u.getUTCSeconds(), 1]];
    const bytes = P.dump({ '0th': zeroth, Exif: exif, GPS: gps });
    const bin = P.insert(bytes, await blobToBinary(jpeg));
    return binaryToBlob(bin);
  } catch (e) {
    console.warn('EXIF no escrito', e);
    return jpeg;
  }
}

/* ---------- GeoJSON ---------- */

function fieldProps(project, values) {
  const out = {};
  for (const f of project.fields || []) {
    const v = values?.[f.key];
    if (f.type === 'plano') {
      out[`${f.key}_dirbuz`] = v?.dipDir ?? null;
      out[`${f.key}_buz`] = v?.dip ?? null;
      out[`${f.key}_rumbo`] = v?.dipDir != null ? norm360(v.dipDir - 90) : null;
    } else if (f.type === 'numero') {
      out[f.key] = v === '' || v == null ? null : Number(v);
    } else if (f.type === 'sino') {
      out[f.key] = v == null ? null : !!v;
    } else {
      out[f.key] = v ?? null;
    }
  }
  return out;
}

function round(v, d) { return v == null ? null : Math.round(v * 10 ** d) / 10 ** d; }

export function buildGeoJSON(project, points, photos, names, wm) {
  const ptFeatures = points.map((pt) => {
    const u = toUTM(pt.lat, pt.lon, project.utmZone || undefined);
    const ph = photos.filter((p) => p.pointId === pt.id).sort((a, b) => a.n - b.n);
    const files = ph.map((p) => `fotos/${names.get(p.id)}`);
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [round(pt.lon, 7), round(pt.lat, 7)] },
      properties: {
        id: pt.id, codigo: pt.code, proyecto: project.name,
        fecha: dateParts(pt.time, pt.tzOff).iso,
        lat: round(pt.lat, 7), lon: round(pt.lon, 7),
        precision_m: round(pt.acc, 1), alt_msnm: round(altMSL(pt), 1),
        utm_huso: `${u.zone}${u.hemi}`, utm_x: round(u.x, 1), utm_y: round(u.y, 1),
        origen: pt.source || 'gps', lugar: pt.place || null,
        ...fieldProps(project, pt.values),
        notas: pt.notes || null,
        n_fotos: ph.length, foto_1: files[0] || null, fotos: files.join(';') || null,
      },
    };
  });
  const phFeatures = photos.map((p) => {
    const pt = points.find((x) => x.id === p.pointId);
    const u = toUTM(p.lat, p.lon, project.utmZone || undefined);
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [round(p.lon, 7), round(p.lat, 7)] },
      properties: {
        id: p.id, foto: `fotos/${names.get(p.id)}`, punto: pt?.code || null,
        fecha: dateParts(p.time, p.tzOff).iso,
        azimut: round(photoAzimuth(p, 'geo'), 1), azimut_mag: round(p.azMag, 1),
        declinacion: round(p.decl, 2), azimut_origen: p.azSource || null,
        lat: round(p.lat, 7), lon: round(p.lon, 7), precision_m: round(p.acc, 1),
        alt_msnm: round(altMSL(p), 1), utm_x: round(u.x, 1), utm_y: round(u.y, 1),
        lugar: p.place || pt?.place || null, descripcion: p.caption || null,
      },
    };
  });
  const fc = (name, features) => ({ type: 'FeatureCollection', name, features });
  return { puntos: fc('puntos', ptFeatures), fotos: fc('fotos', phFeatures) };
}

/* ---------- ZIP ---------- */

function leeme(project, opts) {
  return `LIBRETA DE CAMPO - ${project.name}
Exportado: ${new Date().toLocaleString('es-ES')}

Contenido
  puntos.geojson   Un punto por estación con todos los campos de la libreta.
  fotos.geojson    Un punto por foto, con el azimut (hacia dónde miraba la cámara).
  puntos.qml       Estilo de QGIS para puntos (QGIS lo carga solo).
  fotos.qml        Estilo de QGIS para fotos: flecha girada según el azimut,
                   vista previa de la foto y formulario con la imagen.
  fotos/           Fotos con marca de agua y GPS en el EXIF.
${opts.originals ? '  originales/      Fotos sin marca de agua (también con EXIF).\n' : ''}  datos.json       Copia completa para volver a importarla en la app.

Coordenadas: WGS84 (EPSG:4326). UTM calculada en WGS84${project.utmZone ? `, huso fijo ${project.utmZone}` : ', huso automático'}.
Altitud: sobre el nivel del mar (geoide EGM96). Precisión vertical del GPS: decenas de metros.
Azimut: grados respecto al norte geográfico (declinación magnética WMM2025 ya aplicada).
         azimut_mag guarda el valor magnético original.

En QGIS (probado en 3.34)
  1. Descomprime el ZIP (sin mover los archivos entre carpetas) y arrastra
     puntos.geojson y fotos.geojson al mapa. Los estilos .qml se aplican solos.
  2. Activa Ver > Mostrar avisos del mapa y pasa el ratón por un punto o una flecha
     para ver la foto. Con la herramienta Identificar, el formulario de "fotos" la muestra.
  3. Si quieres guardar las capas en GeoPackage, hazlo después de cargarlas: el estilo
     se conserva en el proyecto.
`;
}

// Completa nombres de lugar que faltan (si hay conexión)
export async function fillPlaces(photos, points, onProgress) {
  if (!navigator.onLine) return;
  let i = 0;
  for (const p of photos) {
    i++;
    if (!p.place) {
      const name = await reversePlace(p.lat, p.lon);
      if (name) { p.place = name; await db.put('photos', p); }
    }
    onProgress?.(i / photos.length);
  }
  for (const pt of points) {
    if (!pt.place) {
      const name = await reversePlace(pt.lat, pt.lon);
      if (name) { pt.place = name; await db.put('points', pt); }
    }
  }
}

export async function collect(projectId, from, to) {
  const project = await db.get('projects', projectId);
  let points = await db.byIndex('points', 'projectId', projectId);
  let photos = await db.byIndex('photos', 'projectId', projectId);
  if (from) points = points.filter((p) => p.time >= from);
  if (to) points = points.filter((p) => p.time <= to);
  const ids = new Set(points.map((p) => p.id));
  photos = photos.filter((p) => ids.has(p.pointId));
  points.sort((a, b) => a.time - b.time);
  photos.sort((a, b) => a.time - b.time);
  return { project, points, photos };
}

// mode: 'sig' (fotos con marca + GeoJSON) | 'backup' (datos + originales)
export async function exportZip(projectId, { from, to, originals = false, mode = 'sig', wm, places = true, onProgress }) {
  const JSZip = self.JSZip;
  const { project, points, photos } = await collect(projectId, from, to);
  const zip = new JSZip();
  const names = new Map();
  for (const p of photos) names.set(p.id, photoFileName(points.find((x) => x.id === p.pointId), p));

  const total = photos.length || 1;
  let done = 0;
  const step = (label) => onProgress?.(done / total, label);

  if (mode === 'sig' && places) {
    step('Buscando nombres de lugar…');
    await fillPlaces(photos, points);
  }

  for (const p of photos) {
    const pt = points.find((x) => x.id === p.pointId);
    const rec = await db.get('blobs', p.id);
    if (!rec) { done++; continue; }
    const desc = [pt?.code, p.caption, project.name].filter(Boolean).join(' | ');
    step(`Foto ${done + 1} de ${photos.length}`);
    if (mode === 'sig') {
      const canvas = await renderPhoto(rec.blob, p, pt, project, wm, { watermark: true });
      let jpg = await canvasToBlob(canvas, 0.9);
      canvas.width = canvas.height = 0;
      jpg = await withExif(jpg, p, pt, project, wm, desc);
      zip.file(`fotos/${names.get(p.id)}`, jpg, { compression: 'STORE' });
    }
    if (mode === 'backup' || originals) {
      let orig = rec.blob;
      if (p.rotation) { // aplica el giro manual también al original
        const c = await renderPhoto(rec.blob, p, pt, project, wm, { watermark: false });
        orig = await canvasToBlob(c, 0.94); c.width = c.height = 0;
      }
      orig = await withExif(orig, p, pt, project, wm, desc);
      zip.file(`originales/${names.get(p.id)}`, orig, { compression: 'STORE' });
    }
    done++;
  }

  const gj = buildGeoJSON(project, points, photos, names, wm);
  if (mode === 'sig') {
    zip.file('puntos.geojson', JSON.stringify(gj.puntos, null, 1));
    zip.file('fotos.geojson', JSON.stringify(gj.fotos, null, 1));
    zip.file('puntos.qml', PUNTOS_QML);
    zip.file('fotos.qml', FOTOS_QML);
    zip.file('LEEME.txt', leeme(project, { originals }));
  }
  const datos = {
    formato: 'libreta-campo', version: 1, exportado: new Date().toISOString(),
    fotosOriginales: mode === 'backup' || originals,
    proyecto: project,
    puntos: points,
    fotos: photos.map(({ thumb, ...rest }) => ({ ...rest, archivo: names.get(rest.id) })),
  };
  zip.file('datos.json', JSON.stringify(datos));

  step('Comprimiendo…');
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', streamFiles: true },
    (m) => onProgress?.(1, `Comprimiendo… ${Math.round(m.percent)} %`));
  const stamp = dateParts(Date.now()).iso.slice(0, 16).replace(/[-:]/g, '').replace('T', '_');
  const name = `${safe(project.name)}_${mode === 'backup' ? 'copia' : 'SIG'}_${stamp}.zip`;
  return { blob, name, counts: { points: points.length, photos: photos.length } };
}

/* ---------- Importar ---------- */

export async function makeThumb(blob, side = 320) {
  const bmp = await createImageBitmap(blob);
  const s = side / Math.max(bmp.width, bmp.height);
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const w = bmp.width, h = bmp.height;
  bmp.close?.();
  const thumb = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
  return { thumb, w, h };
}

export async function importZip(file, onProgress) {
  const zip = await self.JSZip.loadAsync(file);
  const entry = zip.file('datos.json');
  if (!entry) throw new Error('El ZIP no contiene datos.json. Usa una copia exportada desde la app.');
  const datos = JSON.parse(await entry.async('string'));
  if (datos.formato !== 'libreta-campo') throw new Error('Este archivo no es de Libreta de campo.');
  const existing = await db.get('projects', datos.proyecto.id);
  const project = existing ? { ...existing, ...datos.proyecto, counter: Math.max(existing.counter || 0, datos.proyecto.counter || 0) } : datos.proyecto;
  await db.put('projects', project);
  for (const pt of datos.puntos) await db.put('points', pt);
  let ok = 0, missing = 0, i = 0;
  for (const ph of datos.fotos) {
    i++;
    onProgress?.(i / datos.fotos.length, `Foto ${i} de ${datos.fotos.length}`);
    const f = zip.file(`originales/${ph.archivo}`);
    if (!f) { missing++; continue; }
    const blob = new Blob([await f.async('arraybuffer')], { type: 'image/jpeg' });
    const { thumb, w, h } = await makeThumb(blob);
    const { archivo, ...meta } = ph;
    await db.put('blobs', { id: ph.id, blob });
    await db.put('photos', { ...meta, rotation: 0, thumb, w, h });
    ok++;
  }
  return { project, points: datos.puntos.length, photos: ok, missing };
}
