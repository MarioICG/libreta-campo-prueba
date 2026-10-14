// Libreta de campo: lógica de la interfaz
import * as db from './db.js';
import {
  gps, compass, subscribe, startGPS, startCompass, bestFix, gpsQuality, fixAge,
  compassHasNorth, compassAlive, isIOS,
} from './sensors.js';
import { toUTM, formatUTM, formatLatLon, cardinal, fmtAz, declination, fmtDecl, distance, norm360 } from './geo.js';
import {
  DEFAULT_WM, dateParts, altMSL, photoAzimuth, photoInfo, renderPhoto, canvasToBlob, drawWatermark, ensureFonts,
  migrateWM, POSITIONS, DATE_FORMATS, TIME_FORMATS, setLogo,
} from './watermark.js';
import { openCamera, closeCamera, captureFrame, setTorch, cameraSupported } from './camera.js';
import * as mapx from './map.js';
import { exportZip, importZip, makeThumb, withExif, photoFileName } from './export.js';
import { reversePlace } from './place.js';

const VERSION = '1.1.0';
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const TIPOS = {
  texto: 'Texto corto', largo: 'Texto largo', numero: 'Número', lista: 'Lista de opciones',
  sino: 'Sí / No', plano: 'Plano (dir. buz. / buz.)',
};

const PLANTILLAS = {
  geologia: {
    nombre: 'Geología', prefix: 'E-', fields: [
      { key: 'tipo', label: 'Tipo de punto', type: 'lista', options: ['Afloramiento', 'Talud', 'Muestra', 'Contacto', 'Estructura', 'Otro'] },
      { key: 'litologia', label: 'Litología', type: 'texto' },
      { key: 'unidad', label: 'Unidad / formación', type: 'texto' },
      { key: 'so', label: 'Estratificación (S0)', type: 'plano' },
      { key: 'muestra', label: 'Código de muestra', type: 'texto' },
    ],
  },
  libre: { nombre: 'Libre (solo notas)', prefix: 'P-', fields: [] },
};

const S = {
  view: 'mapa', project: null, projects: [], points: [], photos: [],
  thumbs: new Map(), wm: { ...DEFAULT_WM }, autoPlace: true,
  openPointId: null, camTarget: 'new', viewer: null, mapReady: false,
};

/* ================= Utilidades ================= */

function toast(msg, action, ms = 3200) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label; b.onclick = () => { t.classList.remove('on'); action.run(); };
    t.append(b);
  }
  t.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('on'), action ? 8000 : ms);
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
}

async function shareFile(blob, name, title) {
  const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title }); return true; }
    catch (e) { if (e.name === 'AbortError') return true; }
  }
  download(blob, name);
  return false;
}

function slug(label, taken) {
  let k = String(label).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'campo';
  if (/^\d/.test(k)) k = 'c_' + k;
  const reserved = ['id', 'codigo', 'proyecto', 'fecha', 'lat', 'lon', 'notas', 'lugar', 'fotos', 'foto_1', 'n_fotos', 'origen', 'utm_x', 'utm_y', 'utm_huso', 'alt_msnm', 'precision_m'];
  let out = k, i = 2;
  while (taken.includes(out) || reserved.includes(out)) out = `${k}_${i++}`;
  return out;
}

function dayLabel(time, tzOff) {
  const off = tzOff ?? new Date(time).getTimezoneOffset();
  const d = new Date(time - off * 60000);
  const s = `${DIAS[d.getUTCDay()]}, ${dateParts(time, tzOff).date}`;
  return s[0].toUpperCase() + s.slice(1);
}

function thumbURL(ph) {
  if (!S.thumbs.has(ph.id) && ph.thumb) S.thumbs.set(ph.id, URL.createObjectURL(ph.thumb));
  return S.thumbs.get(ph.id) || '';
}

function declAt(lat, lon) {
  const k = `${lat.toFixed(1)},${lon.toFixed(1)}`;
  declAt.c = declAt.c || {};
  if (!(k in declAt.c)) declAt.c[k] = declination(lat, lon, 0, new Date());
  return declAt.c[k];
}

// Rumbo en vivo según la referencia de norte elegida
function liveHeading() {
  if (!compassHasNorth() || compass.heading == null) return null;
  if (S.wm.northRef === 'mag' || !gps.fix) return compass.heading;
  const d = declAt(gps.fix.lat, gps.fix.lon);
  return d == null ? compass.heading : norm360(compass.heading + d);
}

/* ---------- Pila de ventanas (el botón atrás de Android las cierra) ---------- */
// Una sola entrada de historial mientras haya ventanas abiertas: cada «atrás» cierra la de arriba.
const stack = [];
let ignorePop = 0, armed = false;
function pushOverlay(name, close) {
  stack.push({ name, close });
  if (!armed) { history.pushState({ ov: 1 }, ''); armed = true; }
}
function popOverlay(name) {
  const i = stack.map((o) => o.name).lastIndexOf(name);
  if (i < 0) return;
  const removed = stack.splice(i);
  removed.reverse().forEach((o) => o.close());
  if (!stack.length && armed) { armed = false; ignorePop++; history.back(); }
}
window.addEventListener('popstate', () => {
  if (ignorePop > 0) { ignorePop--; return; }
  armed = false;
  const o = stack.pop();
  if (o) o.close();
  if (stack.length) { history.pushState({ ov: 1 }, ''); armed = true; }
});

/* ---------- Diálogo ---------- */
function dialog({ title, body = '', actions = [], onMount }) {
  return new Promise((resolve) => {
    const wrap = $('#dialog');
    $('#dlg-title').textContent = title;
    const b = $('#dlg-body');
    b.innerHTML = typeof body === 'string' ? body : '';
    if (body instanceof Node) b.append(body);
    const a = $('#dlg-actions'); a.innerHTML = '';
    let cleanup = null, done = false;
    const close = (v) => {
      if (done) return; done = true;
      wrap.hidden = true; cleanup?.();
      popOverlay('dialog');
      resolve(v);
    };
    for (const act of actions) {
      const btn = document.createElement('button');
      btn.className = `btn ${act.cls || ''}`; btn.textContent = act.label;
      if (act.id) btn.id = act.id;
      btn.onclick = () => { if (act.validate && !act.validate(b)) return; close(typeof act.value === 'function' ? act.value(b) : act.value); };
      a.append(btn);
    }
    wrap.onclick = (e) => { if (e.target === wrap) close(null); };
    wrap.hidden = false;
    pushOverlay('dialog', () => { if (!done) { done = true; wrap.hidden = true; cleanup?.(); resolve(null); } });
    cleanup = onMount?.(b, close) || null;
    setTimeout(() => b.querySelector('input,select,textarea')?.focus(), 50);
  });
}

async function confirmDlg(title, text, okLabel = 'Eliminar') {
  return dialog({
    title, body: `<p>${esc(text)}</p>`,
    actions: [{ label: 'Cancelar', value: false }, { label: okLabel, cls: 'danger', value: true }],
  });
}

/* ================= Datos ================= */

async function loadProjects() {
  S.projects = (await db.all('projects')).sort((a, b) => a.created - b.created);
}

async function createProject(name, tpl = 'geologia', fields = null) {
  const t = PLANTILLAS[tpl] || PLANTILLAS.geologia;
  const p = {
    id: db.uid(), name: name || 'Proyecto de campo', prefix: t.prefix, counter: 0, utmZone: null,
    fields: structuredClone(fields || t.fields), created: Date.now(),
  };
  await db.put('projects', p);
  await loadProjects();
  return p;
}

async function selectProject(id) {
  const p = S.projects.find((x) => x.id === id) || S.projects[0];
  S.project = p;
  await db.setSetting('currentProject', p.id);
  for (const u of S.thumbs.values()) URL.revokeObjectURL(u);
  S.thumbs.clear();
  S.points = await db.byIndex('points', 'projectId', p.id);
  S.photos = await db.byIndex('photos', 'projectId', p.id);
  mapx.resetFit();
  renderAll();
}

async function saveProject() { await db.put('projects', S.project); }

async function nextCode() {
  S.project.counter = (S.project.counter || 0) + 1;
  await saveProject();
  return `${S.project.prefix || ''}${String(S.project.counter).padStart(3, '0')}`;
}

let persistAsked = false;
async function askPersist() {
  if (persistAsked) return; persistAsked = true;
  await db.requestPersist();
}

async function createPointAt(fix, source = 'gps', { open = true } = {}) {
  const now = Date.now();
  const pt = {
    id: db.uid(), projectId: S.project.id, code: await nextCode(),
    lat: fix.lat, lon: fix.lon, acc: fix.acc ?? null, alt: fix.alt ?? null, altRef: fix.altRef || 'ell',
    source, time: now, tzOff: new Date(now).getTimezoneOffset(), values: {}, notes: '', place: null,
  };
  await db.put('points', pt);
  S.points.push(pt);
  askPersist();
  renderAll();
  if (open) openPoint(pt.id);
  geocode(pt, 'points');
  return pt;
}

async function geocode(rec, store) {
  if (!S.autoPlace || rec.place) return;
  const name = await reversePlace(rec.lat, rec.lon);
  if (!name) return;
  rec.place = name;
  await db.put(store, rec);
  if (store === 'points' && S.openPointId === rec.id) {
    const inp = $('#f-place'); if (inp && !inp.value) inp.value = name;
  }
  if (store === 'points') renderList();
}

/* ================= Vistas ================= */

function switchView(v) {
  S.view = v;
  for (const sec of document.querySelectorAll('.view')) sec.hidden = sec.id !== `view-${v}`;
  for (const t of document.querySelectorAll('.tab[data-view]')) {
    if (t.dataset.view === v) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  }
  $('#fab-punto').hidden = v === 'proyecto';
  if (v === 'mapa') { ensureMap(); setTimeout(() => mapx.invalidate(), 50); }
  if (v === 'proyecto') renderProject();
}

function renderAll() {
  $('#proj-name').textContent = S.project?.name || 'Proyecto';
  renderList();
  renderMap();
  if (S.view === 'proyecto') renderProject();
}

/* ---------- GPS en la barra superior ---------- */
function renderGPS() {
  const pill = $('#gps-pill');
  const q = gpsQuality();
  pill.dataset.q = q;
  const txt = $('#gps-text');
  if (q === 'off') txt.textContent = gps.status === 'nosoportado' ? 'Sin GPS' : 'GPS desactivado';
  else if (q === 'sin') txt.textContent = 'Buscando GPS…';
  else txt.textContent = `±${Math.round(gps.fix.acc)} m`;
}

async function showGPSInfo() {
  const f = gps.fix;
  let body = '';
  if (gps.status === 'denegado') {
    body = `<p>El permiso de ubicación está bloqueado. Actívalo en los ajustes del navegador para este sitio (icono del candado junto a la dirección) y vuelve a abrir la app.</p>`;
  } else if (!f) {
    body = `<p>Esperando la primera posición. Sal a cielo abierto y espera unos segundos.</p>`;
  } else {
    const u = toUTM(f.lat, f.lon, S.project?.utmZone || undefined);
    const alt = altMSL(f);
    const d = declAt(f.lat, f.lon);
    const h = liveHeading();
    body = `<dl class="loc">
      <dt>Coordenadas</dt><dd>${formatLatLon(f.lat, f.lon, S.wm.coordMode)}</dd>
      <dt>UTM</dt><dd>${formatUTM(u)}</dd>
      <dt>Precisión</dt><dd>±${Math.round(f.acc)} m</dd>
      <dt>Altitud</dt><dd>${alt != null ? `${Math.round(alt)} m s.n.m.${f.altAcc ? ` (±${Math.round(f.altAcc)} m)` : ''}` : '—'}</dd>
      <dt>Hace</dt><dd>${Math.round(fixAge())} s</dd>
      <dt>Declinación</dt><dd>${fmtDecl(d)} (WMM2025)</dd>
      <dt>Brújula</dt><dd>${compassHasNorth() ? `${fmtAz(h)} ${cardinal(h)}` : (compassAlive() ? 'sin norte magnético' : 'sin datos')}</dd>
    </dl>`;
  }
  await dialog({ title: 'Posición', body, actions: [{ label: 'Cerrar', cls: 'dark', value: null }] });
}

/* ---------- Libreta ---------- */
function summary(pt) {
  const vals = [];
  for (const f of S.project.fields) {
    const v = pt.values?.[f.key];
    if (v == null || v === '') continue;
    if (f.type === 'plano') { if (v.dipDir != null) vals.push(`${f.label} ${fmtAz(v.dipDir).replace('°', '')}/${Math.round(v.dip)}`); }
    else if (f.type === 'sino') { if (v) vals.push(f.label); }
    else vals.push(String(v));
    if (vals.length >= 3) break;
  }
  return vals.join(', ');
}

function renderList() {
  const box = $('#list');
  if (!S.project) { box.innerHTML = ''; return; }
  const pts = [...S.points].sort((a, b) => b.time - a.time);
  if (!pts.length) {
    box.innerHTML = `<div class="empty">
      <h2>Libreta en blanco</h2>
      <p>Toca «Punto» para anotar donde estás, o la cámara para empezar con una foto. Todo queda guardado en el teléfono, también sin cobertura.</p>
      <button class="btn primary" data-act="new-point">Crear el primer punto</button>
    </div>`;
    return;
  }
  const byPoint = new Map();
  for (const ph of S.photos) {
    if (!byPoint.has(ph.pointId)) byPoint.set(ph.pointId, []);
    byPoint.get(ph.pointId).push(ph);
  }
  let html = '', lastDay = '';
  for (const pt of pts) {
    const day = dayLabel(pt.time, pt.tzOff);
    if (day !== lastDay) { html += `<div class="day">${esc(day)}</div>`; lastDay = day; }
    const phs = (byPoint.get(pt.id) || []).sort((a, b) => a.n - b.n);
    const thumbs = phs.slice(0, 4).map((p) => `<img alt="" loading="lazy" src="${thumbURL(p)}">`).join('')
      + (phs.length > 4 ? `<span class="more">+${phs.length - 4}</span>` : '');
    const sum = summary(pt);
    html += `<button class="entry" data-open="${pt.id}">
      <span class="entry-margin"><span class="entry-code">${esc(pt.code)}</span><span class="entry-time">${dateParts(pt.time, pt.tzOff).hm}</span></span>
      <span class="entry-main">
        <span class="entry-line">${esc(sum || pt.place || 'Sin datos todavía')}</span>
        ${pt.notes ? `<span class="entry-sub">${esc(pt.notes)}</span>` : ''}
        <span class="entry-coords">${formatLatLon(pt.lat, pt.lon, S.wm.coordMode)}${pt.acc != null ? `  ±${Math.round(pt.acc)} m` : ''}</span>
        ${phs.length ? `<span class="thumbs">${thumbs}</span>` : ''}
      </span>
    </button>`;
  }
  box.innerHTML = html;
}

/* ---------- Mapa ---------- */
async function ensureMap() {
  if (S.mapReady || !self.L) return;
  S.mapReady = true;
  const baseId = await db.getSetting('baseId', 'topo');
  const overlayIds = await db.getSetting('overlays', []);
  mapx.initMap($('#map'), {
    baseId, overlayIds,
    onBaseChange: (id) => db.setSetting('baseId', id),
    onOverlayChange: (ids) => db.setSetting('overlays', ids),
    onFollowChange: (on) => $('#btn-me').setAttribute('aria-pressed', String(on)),
    onPointClick: (id) => openPoint(id),
    onPhotoClick: (id) => {
      const list = [...S.photos].sort((a, b) => a.time - b.time).map((p) => p.id);
      openViewer(list, list.indexOf(id));
    },
    onLongPress: async (lat, lon) => {
      const ok = await dialog({
        title: 'Punto en el mapa',
        body: `<p>¿Crear un punto aquí? Se guardará como ubicado a mano, sin precisión GPS.</p><p class="kv num">${formatLatLon(lat, lon, S.wm.coordMode)}</p>`,
        actions: [{ label: 'Cancelar', value: false }, { label: 'Crear punto', cls: 'primary', value: true }],
      });
      if (ok) createPointAt({ lat, lon, acc: null, alt: null }, 'manual');
    },
  });
  renderMap();
  if (!S.points.length && gps.fix) mapx.centerOnMe(gps.fix, false);
}

function renderMap() {
  if (!S.mapReady) return;
  mapx.renderData(S.points, S.photos, new Map(S.photos.map((p) => [p.id, thumbURL(p)])), (ph) => photoAzimuth(ph, S.wm.northRef));
}

let lastMe = 0;
function updateMe() {
  if (!S.mapReady || !gps.fix || Date.now() - lastMe < 250) return;
  lastMe = Date.now();
  if (!S.centeredOnce && !S.points.length) S.centeredOnce = mapx.centerOnMe(gps.fix, false);
  mapx.updateMe(gps.fix, liveHeading());
}

/* ================= Nuevo punto ================= */

async function newPointFlow() {
  if (gpsQuality() === 'buena') return createPointAt(bestFix(10), 'gps');
  const res = await dialog({
    title: 'Fijando posición',
    body: `<p class="kv">Espera unos segundos a cielo abierto. La app promedia las lecturas más precisas.</p>
      <div class="big-num" id="fx-acc">—</div><p class="kv" id="fx-info"></p>`,
    actions: [
      { label: 'Colocar en el mapa', value: 'map' },
      { label: 'Usar esta posición', cls: 'primary', value: 'use', id: 'fx-use' },
    ],
    onMount(b) {
      const upd = () => {
        const f = bestFix(15);
        const btn = $('#fx-use');
        if (!f) { $('#fx-acc', b).textContent = '—'; $('#fx-info', b).textContent = gps.status === 'denegado' ? 'Permiso de ubicación denegado.' : 'Sin señal todavía.'; if (btn) btn.disabled = true; return; }
        $('#fx-acc', b).textContent = `±${Math.round(f.acc)} m`;
        $('#fx-info', b).textContent = `${f.n} lectura${f.n === 1 ? '' : 's'} promediada${f.n === 1 ? '' : 's'}`;
        if (btn) btn.disabled = false;
      };
      upd();
      return subscribe(upd);
    },
  });
  if (res === 'use') { const f = bestFix(15); if (f) createPointAt(f, 'gps'); }
  if (res === 'map') { switchView('mapa'); toast('Mantén pulsado el mapa donde quieras crear el punto'); }
}

/* ================= Ficha de punto ================= */

let saveTimer = null;
function scheduleSave(pt) {
  $('#sheet-saved').textContent = 'Guardando…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flushSave(pt), 400);
}
async function flushSave(pt) {
  clearTimeout(saveTimer); saveTimer = null;
  if (!pt) return;
  await db.put('points', pt);
  const s = $('#sheet-saved'); if (s) s.textContent = 'Guardado';
}

function curPoint() { return S.points.find((p) => p.id === S.openPointId); }

function openPoint(id) {
  const pt = S.points.find((p) => p.id === id);
  if (!pt) return;
  const already = S.openPointId != null;
  S.openPointId = id;
  $('#sheet').hidden = false;
  if (!already) pushOverlay('sheet', closeSheetUI);
  renderSheet();
}

function closeSheetUI() {
  const pt = curPoint();
  if (saveTimer) flushSave(pt);
  $('#sheet').hidden = true;
  S.openPointId = null;
  renderAll();
}

function fieldInput(f, v) {
  const id = `fx-${f.key}`;
  const lab = `<span class="fld-label">${esc(f.label)}</span>`;
  switch (f.type) {
    case 'largo':
      return `<label class="fld">${lab}<textarea class="inp" id="${id}" data-key="${f.key}">${esc(v ?? '')}</textarea></label>`;
    case 'numero':
      return `<label class="fld">${lab}<input class="inp num" id="${id}" data-key="${f.key}" type="number" inputmode="decimal" step="any" value="${esc(v ?? '')}"></label>`;
    case 'lista':
      return `<label class="fld">${lab}<select class="inp" id="${id}" data-key="${f.key}"><option value=""></option>${(f.options || []).map((o) => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
    case 'sino':
      return `<label class="switch fld"><input type="checkbox" id="${id}" data-key="${f.key}" data-bool="1"${v ? ' checked' : ''}><span>${esc(f.label)}</span></label>`;
    case 'plano': {
      const dd = v?.dipDir ?? '', dp = v?.dip ?? '';
      return `<div class="fld"><span class="fld-label">${esc(f.label)}</span><div class="plane">
        <label><span class="sub-label">Dir. buzamiento</span><input class="inp num" type="number" inputmode="numeric" min="0" max="360" placeholder="0–360" data-key="${f.key}" data-sub="dipDir" value="${dd}"></label>
        <label><span class="sub-label">Buzamiento</span><input class="inp num" type="number" inputmode="numeric" min="0" max="90" placeholder="0–90" data-key="${f.key}" data-sub="dip" value="${dp}"></label>
        <button class="btn dark" data-measure="${f.key}">Medir</button></div></div>`;
    }
    default:
      return `<label class="fld">${lab}<input class="inp" id="${id}" data-key="${f.key}" value="${esc(v ?? '')}" autocomplete="off"></label>`;
  }
}

function renderSheet() {
  const pt = curPoint(); if (!pt) return;
  $('#sheet-code').value = pt.code;
  $('#sheet-saved').textContent = '';
  const u = toUTM(pt.lat, pt.lon, S.project.utmZone || undefined);
  const alt = altMSL(pt);
  const d = declAt(pt.lat, pt.lon);
  const phs = S.photos.filter((p) => p.pointId === pt.id).sort((a, b) => a.n - b.n);
  const hasPlane = S.project.fields.some((f) => f.type === 'plano');
  $('#sheet-body').innerHTML = `
    <section class="block">
      <h3>Ubicación</h3>
      <dl class="loc">
        <dt>Coordenadas</dt><dd>${formatLatLon(pt.lat, pt.lon, S.wm.coordMode)}</dd>
        <dt>UTM</dt><dd>${formatUTM(u)}</dd>
        <dt>Precisión</dt><dd>${pt.source === 'manual' ? 'ubicado a mano' : (pt.acc != null ? `±${Math.round(pt.acc)} m` : '—')}</dd>
        <dt>Altitud</dt><dd>${alt != null ? `${Math.round(alt).toLocaleString('es-ES')} m s.n.m.` : '—'}</dd>
        <dt>Fecha</dt><dd>${dateParts(pt.time, pt.tzOff).dateNum} ${dateParts(pt.time, pt.tzOff).hm}</dd>
      </dl>
      <label class="fld"><span class="fld-label">Lugar</span><input class="inp" id="f-place" value="${esc(pt.place || '')}" placeholder="${S.autoPlace ? 'Se completa solo con conexión' : 'Nombre del lugar'}" autocomplete="off"></label>
      <div class="btn-row">
        <button class="btn" data-act="relocate"><svg class="ico sm"><use href="#i-gps"/></svg>Actualizar posición</button>
        <button class="btn" data-act="show-on-map"><svg class="ico sm"><use href="#i-map"/></svg>Ver en el mapa</button>
      </div>
    </section>
    <section class="block">
      <h3>Fotos</h3>
      ${phs.length ? `<div class="photo-grid">${phs.map((p) => {
        const az = photoAzimuth(p, S.wm.northRef);
        return `<button data-photo="${p.id}" aria-label="Foto ${p.n}"><img alt="" src="${thumbURL(p)}">${az != null ? `<span class="az">${fmtAz(az)}</span>` : ''}</button>`;
      }).join('')}</div>` : ''}
      <div class="btn-row">
        <button class="btn primary" data-act="cam-point"><svg class="ico sm"><use href="#i-cam"/></svg>Tomar foto</button>
        <button class="btn" data-act="gallery"><svg class="ico sm"><use href="#i-image"/></svg>Desde la galería</button>
      </div>
    </section>
    <section class="block">
      <h3>Datos</h3>
      ${S.project.fields.map((f) => fieldInput(f, pt.values?.[f.key])).join('')}
      ${hasPlane ? `<p class="hint">Rumbos en grados respecto al norte ${S.wm.northRef === 'mag' ? 'magnético' : 'geográfico'}. Declinación aquí: ${fmtDecl(d)}.</p>` : ''}
      <label class="fld"><span class="fld-label">Notas</span><textarea class="inp" id="f-notes" placeholder="Descripción, observaciones, croquis mental…">${esc(pt.notes || '')}</textarea></label>
    </section>
    <section class="block">
      <button class="btn danger block" data-act="delete-point"><svg class="ico sm"><use href="#i-trash"/></svg>Eliminar punto ${esc(pt.code)}</button>
    </section>`;
}

function onSheetInput(e) {
  const pt = curPoint(); if (!pt) return;
  const t = e.target;
  if (t.id === 'f-notes') pt.notes = t.value;
  else if (t.id === 'f-place') pt.place = t.value.trim() || null;
  else if (t.dataset.key) {
    pt.values = pt.values || {};
    const k = t.dataset.key;
    if (t.dataset.sub) {
      const cur = { ...(pt.values[k] || {}) };
      cur[t.dataset.sub] = t.value === '' ? null : Number(t.value);
      pt.values[k] = cur;
    } else if (t.dataset.bool) pt.values[k] = t.checked;
    else pt.values[k] = t.value;
  } else return;
  scheduleSave(pt);
}

async function onSheetClick(e) {
  const pt = curPoint(); if (!pt) return;
  const ph = e.target.closest('[data-photo]');
  if (ph) {
    const list = S.photos.filter((p) => p.pointId === pt.id).sort((a, b) => a.n - b.n).map((p) => p.id);
    return openViewer(list, list.indexOf(ph.dataset.photo));
  }
  const m = e.target.closest('[data-measure]');
  if (m) return measurePlane(pt, m.dataset.measure);
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'cam-point') openCam(pt.id);
  else if (act === 'gallery') { galleryTarget = pt.id; $('#gallery-input').click(); }
  else if (act === 'show-on-map') { popOverlay('sheet'); switchView('mapa'); setTimeout(() => mapx.centerOn(pt.lat, pt.lon), 80); }
  else if (act === 'relocate') {
    const f = bestFix(15);
    if (!f) return toast('Sin posición GPS todavía');
    const dist = distance(pt, f);
    if (dist > 30) {
      const ok = await dialog({
        title: 'Mover el punto', body: `<p>La nueva posición está a ${Math.round(dist)} m de la guardada. ¿Mover ${esc(pt.code)}?</p>`,
        actions: [{ label: 'Cancelar', value: false }, { label: 'Mover', cls: 'primary', value: true }],
      });
      if (!ok) return;
    }
    Object.assign(pt, { lat: f.lat, lon: f.lon, acc: f.acc, alt: f.alt, altRef: f.altRef, source: 'gps' });
    await flushSave(pt); renderSheet(); toast(`Posición actualizada (±${Math.round(f.acc)} m)`);
  } else if (act === 'delete-point') {
    const n = S.photos.filter((p) => p.pointId === pt.id).length;
    if (!(await confirmDlg(`Eliminar ${pt.code}`, `Se borrarán el punto y ${n} foto${n === 1 ? '' : 's'}. No se puede deshacer.`))) return;
    await db.deletePoint(pt.id);
    S.points = S.points.filter((p) => p.id !== pt.id);
    S.photos = S.photos.filter((p) => p.pointId !== pt.id);
    popOverlay('sheet');
    toast(`${pt.code} eliminado`);
  }
}

/* ---------- Medir un plano con el teléfono ---------- */
async function measurePlane(pt, key) {
  const ok = await startCompass();
  const field = S.project.fields.find((f) => f.key === key);
  const val = await dialog({
    title: field?.label || 'Medir plano',
    body: `<p class="kv">Apoya la parte trasera del teléfono sobre el plano, con la pantalla hacia ti, y espera a que los números se estabilicen.</p>
      <div class="measure"><div><div class="big-num" id="m-dd">—</div><small>Dir. de buzamiento</small></div><div><div class="big-num" id="m-dp">—</div><small>Buzamiento</small></div></div>
      <p class="kv num" id="m-extra"></p>`,
    actions: [{ label: 'Cancelar', value: null }, { label: 'Fijar', cls: 'primary', id: 'm-ok', value: () => measurePlane.last }],
    onMount(b) {
      measurePlane.last = null;
      const upd = () => {
        const btn = $('#m-ok');
        if (!ok || !compassHasNorth() || !compass.plane) {
          $('#m-extra', b).textContent = !ok ? 'No se concedió acceso a los sensores.' : 'Esperando la brújula… Si no aparece, este teléfono no tiene magnetómetro: escribe los valores a mano.';
          if (btn) btn.disabled = true; return;
        }
        const d = S.wm.northRef === 'mag' ? 0 : (declAt(pt.lat, pt.lon) || 0);
        const dd = norm360(compass.plane.dipDir + d), dp = compass.plane.dip;
        measurePlane.last = { dipDir: Math.round(dd) % 360, dip: Math.round(dp) };
        $('#m-dd', b).textContent = fmtAz(dd);
        $('#m-dp', b).textContent = `${Math.round(dp)}°`;
        $('#m-extra', b).textContent = `Rumbo (regla mano derecha) ${fmtAz(norm360(dd - 90))}  ·  N ${S.wm.northRef === 'mag' ? 'magnético' : 'geográfico'}`;
        if (btn) btn.disabled = false;
      };
      upd();
      return subscribe(upd);
    },
  });
  if (val) {
    pt.values = pt.values || {};
    pt.values[key] = val;
    await flushSave(pt);
    renderSheet();
  }
}

/* ================= Cámara ================= */

let camLoop = null, shooting = false, hintShown = false;

function nearestPoints(fix, max = 5, within = 500) {
  if (!fix) return [];
  return S.points.map((p) => ({ p, d: distance(p, fix) })).filter((x) => x.d <= within)
    .sort((a, b) => a.d - b.d).slice(0, max);
}

function autoTarget() {
  if (S.openPointId) return S.openPointId;
  const near = nearestPoints(gps.fix, 1, 30)[0];
  if (near && Date.now() - near.p.time < 3 * 3600 * 1000) return near.p.id;
  return 'new';
}

async function openCam(targetId) {
  const compassOk = startCompass(); // iOS: debe pedirse dentro del toque
  S.camTarget = targetId || autoTarget();
  const cam = $('#camera');
  cam.hidden = false;
  pushOverlay('camera', closeCamUI);
  $('#cam-thumb').removeAttribute('style');
  renderCamChips();
  await compassOk;
  const video = $('#cam-video');
  $('.cam-error')?.remove();
  if (!cameraSupported()) { camError('Este navegador no da acceso a la cámara. Usa el botón de cámara del sistema.'); }
  else {
    try {
      const info = await openCamera(video);
      $('#cam-torch').hidden = !info.torch;
      $('#cam-torch').setAttribute('aria-pressed', 'false');
    } catch (e) {
      camError(e.name === 'NotAllowedError'
        ? 'Permiso de cámara denegado. Actívalo en los ajustes del sitio o usa la cámara del sistema.'
        : `No se pudo abrir la cámara (${e.name || e.message}). Prueba con la cámara del sistema.`);
    }
  }
  if (!hintShown) {
    hintShown = true;
    setTimeout(() => showCamHint('Si el rumbo se desvía, mueve el teléfono dibujando un 8 para calibrar la brújula.', 6000), 1200);
  }
  const tick = () => { drawTape(); renderCamChips(); camLoop = requestAnimationFrame(tick); };
  camLoop = requestAnimationFrame(tick);
}

function camError(msg) {
  const d = document.createElement('div');
  d.className = 'cam-error'; d.innerHTML = `<p>${esc(msg)}</p>`;
  $('#camera').append(d);
}

function showCamHint(msg, ms = 4000) {
  const h = $('#cam-hint');
  h.textContent = msg; h.hidden = false;
  clearTimeout(showCamHint.t);
  showCamHint.t = setTimeout(() => { h.hidden = true; }, ms);
}

function closeCamUI() {
  cancelAnimationFrame(camLoop); camLoop = null;
  closeCamera();
  $('#cam-video').srcObject = null;
  $('#camera').hidden = true;
  $('.cam-error')?.remove();
  if (S.openPointId) renderSheet();
  renderAll();
}

let chipCache = '';
function renderCamChips() {
  const q = gpsQuality();
  const gpsTxt = q === 'off' ? 'Sin GPS' : q === 'sin' ? 'Buscando GPS…' : `GPS ±${Math.round(gps.fix.acc)} m`;
  const pt = S.points.find((p) => p.id === S.camTarget);
  const tgt = pt ? `Guardar en ${pt.code}` : 'Punto nuevo';
  const key = `${q}|${gpsTxt}|${tgt}`;
  if (key === chipCache) return;
  chipCache = key;
  const g = $('#cam-gps');
  g.textContent = gpsTxt; g.classList.toggle('warn', q === 'mala' || q === 'sin' || q === 'off');
  $('#cam-target').textContent = tgt;
  $('#shutter').disabled = !pt && !gps.fix;
}

function drawTape() {
  const c = $('#tape');
  const dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth * dpr, H = c.clientHeight * dpr;
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  const h = liveHeading();
  const az = $('#cam-az'), cd = $('#cam-card');
  if (h == null) {
    az.textContent = '—';
    cd.textContent = compassAlive() ? 'sin norte' : 'sin brújula';
  } else {
    az.textContent = fmtAz(h);
    cd.textContent = cardinal(h);
  }
  const ppd = 5 * dpr, cx = W / 2;
  const span = Math.ceil(cx / ppd) + 2;
  const hv = h ?? 0;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.globalAlpha = h == null ? 0.35 : 1;
  const names = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SO', 270: 'O', 315: 'NO' };
  for (let dg = Math.floor(hv - span); dg <= hv + span; dg++) {
    if (dg % 5) continue;
    const x = cx + (dg - hv) * ppd;
    const n = norm360(dg);
    const major = n % 15 === 0;
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.lineWidth = (major ? 2 : 1) * dpr;
    ctx.beginPath(); ctx.moveTo(x, H - (major ? 16 : 8) * dpr); ctx.lineTo(x, H); ctx.stroke();
    if (n % 45 === 0) {
      ctx.font = `700 ${18 * dpr}px "Barlow Condensed", sans-serif`;
      ctx.fillStyle = n === 0 ? '#FF5A4E' : '#FFFFFF';
      ctx.fillText(names[n], x, 10 * dpr);
    } else if (major) {
      ctx.font = `500 ${13 * dpr}px "Barlow Condensed", sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,.75)';
      ctx.fillText(String(n), x, 14 * dpr);
    }
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#F2C230';
  ctx.beginPath(); ctx.moveTo(cx, H - 18 * dpr); ctx.lineTo(cx - 8 * dpr, H); ctx.lineTo(cx + 8 * dpr, H); ctx.closePath(); ctx.fill();
}

async function chooseTarget() {
  const near = nearestPoints(gps.fix, 6, 1000);
  const cur = S.points.find((p) => p.id === S.camTarget);
  if (cur && !near.find((x) => x.p.id === cur.id)) near.unshift({ p: cur, d: gps.fix ? distance(cur, gps.fix) : null });
  const body = document.createElement('div');
  body.className = 'proj-list';
  body.innerHTML = `<button data-t="new"><span><b>Punto nuevo</b><br><small class="kv">Se crea con la primera foto</small></span>${S.camTarget === 'new' ? '<span class="cur">Elegido</span>' : ''}</button>`
    + near.map(({ p, d }) => `<button data-t="${p.id}"><span><b>${esc(p.code)}</b><br><small class="kv">${d != null ? `a ${Math.round(d)} m` : ''} ${esc(summary(p) || p.place || '')}</small></span>${S.camTarget === p.id ? '<span class="cur">Elegido</span>' : ''}</button>`).join('');
  const v = await dialog({
    title: 'Guardar las fotos en', body, actions: [{ label: 'Cerrar', value: null }],
    onMount(b, close) { b.onclick = (e) => { const t = e.target.closest('[data-t]'); if (t) close(t.dataset.t); }; },
  });
  if (v) { S.camTarget = v; chipCache = ''; renderCamChips(); }
}

function snapshotSensors() {
  return {
    fix: gps.fix ? { ...gps.fix } : null,
    azMag: compassHasNorth() ? compass.heading : null,
    azSource: compassHasNorth() ? compass.headingFrom : null,
    tilt: compassAlive() ? compass.tilt : null,
  };
}

async function shoot() {
  if (shooting) return;
  const video = $('#cam-video');
  if (!video.videoWidth) return toast('La cámara aún no está lista');
  shooting = true;
  const snap = snapshotSensors();
  const fl = $('#cam-flash'); fl.classList.remove('on'); void fl.offsetWidth; fl.classList.add('on');
  navigator.vibrate?.(25);
  try {
    const frame = await captureFrame(video);
    const ph = await savePhoto(frame.blob, snap, S.camTarget);
    $('#cam-thumb').style.backgroundImage = `url(${thumbURL(ph)})`;
    $('#cam-thumb').dataset.photo = ph.id;
    if (snap.azMag == null) showCamHint('Foto guardada sin dirección: la brújula no está disponible.');
    else if (snap.fix && fixAge() > 30) showCamHint('Foto guardada con una posición de hace más de 30 s.');
  } catch (e) {
    console.error(e); toast('No se pudo guardar la foto: ' + e.message);
  } finally { shooting = false; }
}

// Guarda una foto en un punto (o crea el punto si target = 'new')
async function savePhoto(blob, snap, target, extra = {}) {
  let pt = S.points.find((p) => p.id === target);
  if (!pt) {
    const f = snap.fix || gps.fix;
    if (!f) throw new Error('sin posición para crear el punto');
    pt = await createPointAt(f, 'gps', { open: false });
    if (S.camTarget === 'new') { S.camTarget = pt.id; chipCache = ''; }
  }
  const pos = snap.fix || { lat: pt.lat, lon: pt.lon, acc: pt.acc, alt: pt.alt, altRef: pt.altRef };
  const { thumb, w, h } = await makeThumb(blob);
  const time = extra.time || Date.now();
  const n = Math.max(0, ...S.photos.filter((p) => p.pointId === pt.id).map((p) => p.n || 0)) + 1;
  const ph = {
    id: db.uid(), projectId: S.project.id, pointId: pt.id, n,
    time, tzOff: extra.tzOff ?? new Date(time).getTimezoneOffset(),
    lat: pos.lat, lon: pos.lon, acc: pos.acc ?? null, alt: pos.alt ?? null, altRef: pos.altRef || 'ell',
    posSource: snap.fix ? (extra.posSource || 'gps') : 'punto',
    azMag: snap.azMag != null ? norm360(snap.azMag) : null, azSource: snap.azSource || null,
    decl: declination(pos.lat, pos.lon, 0, new Date(time)), tilt: snap.tilt ?? null,
    rotation: 0, caption: '', place: pt.place || null, thumb, w, h,
  };
  await db.put('blobs', { id: ph.id, blob });
  await db.put('photos', ph);
  S.photos.push(ph);
  askPersist();
  if (!$('#sheet').hidden && S.openPointId === pt.id) renderSheet();
  renderMap();
  geocode(ph, 'photos');
  return ph;
}

// Endereza según EXIF y recomprime: así el original exportado nunca sale girado
async function normalizeImage(file) {
  const bmp = await createImageBitmap(file);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close?.();
  const b = await canvasToBlob(c, 0.93);
  c.width = c.height = 0;
  return b;
}

let sysSnap = null;
function useSystemCamera() {
  startCompass();
  sysSnap = snapshotSensors();
  if (sysSnap.azSource) sysSnap.azSource = 'aprox';
  $('#sys-input').value = '';
  $('#sys-input').click();
}

async function onSystemPhoto(e) {
  const f = e.target.files?.[0]; if (!f) return;
  try {
    const blob = await normalizeImage(f);
    const snap = { ...sysSnap, fix: gps.fix ? { ...gps.fix } : sysSnap?.fix };
    const ph = await savePhoto(blob, snap, S.camTarget);
    $('#cam-thumb').style.backgroundImage = `url(${thumbURL(ph)})`;
    $('#cam-thumb').dataset.photo = ph.id;
    toast('Foto guardada');
  } catch (err) { toast('No se pudo guardar la foto: ' + err.message); }
}

/* ---------- Galería: usa el GPS del EXIF si lo trae ---------- */
let galleryTarget = null;

async function readExif(file) {
  try {
    if (!self.piexif || !/jpe?g/i.test(file.type || file.name)) return null;
    const buf = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    const ex = self.piexif.load(s);
    const G = ex.GPS || {}, P = self.piexif.GPSIFD;
    const out = {};
    const dms = (r) => r ? r[0][0] / r[0][1] + r[1][0] / r[1][1] / 60 + r[2][0] / r[2][1] / 3600 : null;
    const lat = dms(G[P.GPSLatitude]), lon = dms(G[P.GPSLongitude]);
    if (lat != null && lon != null && !(lat === 0 && lon === 0)) {
      out.fix = {
        lat: G[P.GPSLatitudeRef] === 'S' ? -lat : lat,
        lon: G[P.GPSLongitudeRef] === 'W' ? -lon : lon,
        acc: G[P.GPSHPositioningError] ? G[P.GPSHPositioningError][0] / G[P.GPSHPositioningError][1] : null,
        alt: G[P.GPSAltitude] ? (G[P.GPSAltitudeRef] === 1 ? -1 : 1) * G[P.GPSAltitude][0] / G[P.GPSAltitude][1] : null,
        altRef: 'msl',
      };
    }
    if (G[P.GPSImgDirection]) {
      const dir = G[P.GPSImgDirection][0] / G[P.GPSImgDirection][1];
      out.dir = dir; out.dirRef = G[P.GPSImgDirectionRef] || 'T';
    }
    const dt = ex.Exif?.[self.piexif.ExifIFD.DateTimeOriginal];
    if (dt) {
      const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(dt);
      if (m) out.time = new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    }
    return out;
  } catch (e) { return null; }
}

async function onGallery(e) {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  const target = galleryTarget; galleryTarget = null;
  const pt = S.points.find((p) => p.id === target);
  if (!files.length || !pt) return;
  let withGps = 0;
  for (const f of files) {
    try {
      const ex = await readExif(f) || {};
      const blob = await normalizeImage(f);
      let azMag = null, azSource = null;
      const pos = ex.fix || null;
      if (ex.dir != null) {
        const lat = pos?.lat ?? pt.lat, lon = pos?.lon ?? pt.lon;
        azMag = ex.dirRef === 'M' ? ex.dir : norm360(ex.dir - (declination(lat, lon, 0, new Date(ex.time || Date.now())) || 0));
        azSource = 'exif';
      }
      if (pos) withGps++;
      await savePhoto(blob, { fix: pos, azMag, azSource, tilt: null }, pt.id, { time: ex.time || f.lastModified || Date.now(), posSource: 'exif' });
    } catch (err) { console.error(err); toast(`No se pudo importar ${f.name}`); }
  }
  renderSheet();
  toast(`${files.length} foto${files.length === 1 ? '' : 's'} añadida${files.length === 1 ? '' : 's'}${withGps < files.length ? ` (${files.length - withGps} con la posición del punto)` : ''}`);
}

/* ================= Visor ================= */

async function openViewer(list, idx) {
  if (idx < 0) return;
  const first = !S.viewer;
  S.viewer = { list, idx };
  $('#viewer').hidden = false;
  if (first) pushOverlay('viewer', closeViewerUI);
  await renderViewer();
}

function closeViewerUI() {
  $('#viewer').hidden = true;
  S.viewer = null;
}

function curPhoto() { return S.viewer ? S.photos.find((p) => p.id === S.viewer.list[S.viewer.idx]) : null; }

let viewerJob = 0;
async function renderViewer() {
  const ph = curPhoto(); if (!ph) return;
  const job = ++viewerJob;
  const pt = S.points.find((p) => p.id === ph.pointId);
  $('#v-title').textContent = `${pt?.code || ''}  foto ${ph.n}`;
  $('#v-caption').value = ph.caption || '';
  $('#v-prev').hidden = S.viewer.idx <= 0;
  $('#v-next').hidden = S.viewer.idx >= S.viewer.list.length - 1;
  const info = photoInfo(ph, pt, S.project, S.wm);
  const src = { gps: 'GPS', punto: 'posición del punto', exif: 'EXIF' }[ph.posSource] || 'GPS';
  $('#v-meta').textContent = `${info.dp.dateNum} ${info.dp.time}  |  ${info.latlon}  ${info.acc} (${src})  |  ${info.azText || 'sin dirección'}`;
  const rec = await db.get('blobs', ph.id);
  if (!rec || job !== viewerJob) return;
  const dpr = window.devicePixelRatio || 1;
  const stage = $('.viewer-stage');
  const maxSide = Math.min(2400, Math.max(stage.clientWidth, stage.clientHeight) * dpr);
  const c = await renderPhoto(rec.blob, ph, pt, S.project, S.wm, { watermark: $('#v-wm').checked, maxSide });
  if (job !== viewerJob) return;
  const vc = $('#v-canvas');
  vc.width = c.width; vc.height = c.height;
  vc.getContext('2d').drawImage(c, 0, 0);
  const scale = Math.min(stage.clientWidth / c.width, stage.clientHeight / c.height);
  vc.style.width = `${c.width * scale}px`; vc.style.height = `${c.height * scale}px`;
}

async function exportOne(withWm) {
  const ph = curPhoto(); if (!ph) return null;
  const pt = S.points.find((p) => p.id === ph.pointId);
  const rec = await db.get('blobs', ph.id);
  const c = await renderPhoto(rec.blob, ph, pt, S.project, S.wm, { watermark: withWm });
  let b = await canvasToBlob(c, 0.92);
  c.width = c.height = 0;
  b = await withExif(b, ph, pt, S.project, S.wm, [pt?.code, ph.caption, S.project.name].filter(Boolean).join(' | '));
  return { blob: b, name: photoFileName(pt, ph), title: `${pt?.code || ''} foto ${ph.n}` };
}

async function rotatePhoto(delta) {
  const ph = curPhoto(); if (!ph) return;
  ph.rotation = norm360((ph.rotation || 0) + delta);
  const rec = await db.get('blobs', ph.id);
  const c = await renderPhoto(rec.blob, ph, null, S.project, S.wm, { watermark: false, maxSide: 320 });
  ph.thumb = await canvasToBlob(c, 0.8);
  if (S.thumbs.has(ph.id)) { URL.revokeObjectURL(S.thumbs.get(ph.id)); S.thumbs.delete(ph.id); }
  await db.put('photos', ph);
  renderViewer();
}

/* ================= Proyecto ================= */

let exportResult = null;

async function renderProject() {
  const p = S.project; if (!p) return;
  const st = await db.storageInfo();
  const mb = (b) => b == null ? '—' : b > 1e9 ? `${(b / 1e9).toFixed(1).replace('.', ',')} GB` : `${Math.round(b / 1e6)} MB`;
  const wm = S.wm;
  const times = S.points.map((x) => x.time);
  const iso = (t) => t ? dateParts(t).iso.slice(0, 10) : '';
  const seg = (name, val, opts) => `<div class="seg" data-seg="${name}">${opts.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${String(val) === String(v)}">${l}</button>`).join('')}</div>`;
  const chk = (k, l) => `<label class="switch"><input type="checkbox" data-wm="${k}"${wm[k] !== false ? ' checked' : ''}><span>${l}</span></label>`;
  const nowParts = dateParts(Date.now());
  $('#proj').innerHTML = `
    <section class="block">
      <h3>Proyecto</h3>
      <label class="fld"><span class="fld-label">Nombre</span><input class="inp" data-p="name" value="${esc(p.name)}"></label>
      <div class="row">
        <label class="fld"><span class="fld-label">Prefijo de los puntos</span><input class="inp" data-p="prefix" value="${esc(p.prefix || '')}" autocomplete="off"></label>
        <label class="fld"><span class="fld-label">Huso UTM</span><input class="inp num" data-p="utmZone" type="number" min="1" max="60" placeholder="Automático" value="${p.utmZone || ''}"></label>
      </div>
      <p class="hint">${S.points.length} punto${S.points.length === 1 ? '' : 's'} y ${S.photos.length} foto${S.photos.length === 1 ? '' : 's'}. Fija el huso si el proyecto cruza dos (por ejemplo 30 en todo el Pirineo).</p>
    </section>

    <section class="block">
      <h3>Campos de la libreta</h3>
      <div id="fields">${p.fields.length ? p.fields.map((f, i) => `<div class="field-row">
        <button class="linkish" data-edit-field="${i}" style="all:unset;cursor:pointer"><b>${esc(f.label)}</b><small>${TIPOS[f.type] || f.type}${f.type === 'lista' ? `: ${esc((f.options || []).join(', '))}` : ''}</small></button>
        <span class="ctl">
          <button class="icon-btn" data-move="${i}" data-dir="-1" aria-label="Subir"${i === 0 ? ' disabled' : ''}><svg class="ico sm"><use href="#i-up"/></svg></button>
          <button class="icon-btn" data-move="${i}" data-dir="1" aria-label="Bajar"${i === p.fields.length - 1 ? ' disabled' : ''}><svg class="ico sm"><use href="#i-down"/></svg></button>
          <button class="icon-btn" data-del-field="${i}" aria-label="Quitar campo"><svg class="ico sm"><use href="#i-x"/></svg></button>
        </span></div>`).join('') : '<p class="hint" style="margin:0 0 8px">Sin campos: cada punto solo tendrá notas.</p>'}</div>
      <div class="btn-row" style="margin-top:12px"><button class="btn" data-act="add-field"><svg class="ico sm"><use href="#i-plus"/></svg>Añadir campo</button></div>
      <p class="hint">Las notas libres están siempre disponibles en cada punto.</p>
    </section>

    <section class="block">
      <h3>Exportar</h3>
      <div class="row">
        <label class="fld"><span class="fld-label">Desde</span><input class="inp" type="date" id="ex-from" value="${iso(times.length ? Math.min(...times) : null)}"></label>
        <label class="fld"><span class="fld-label">Hasta</span><input class="inp" type="date" id="ex-to" value="${iso(times.length ? Math.max(...times) : null)}"></label>
      </div>
      <label class="switch"><input type="checkbox" id="ex-orig"><span>Incluir también las fotos originales sin marca</span></label>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn primary" data-act="export-sig"${S.points.length ? '' : ' disabled'}>Exportar para SIG (ZIP)</button>
        <button class="btn" data-act="export-backup"${S.points.length ? '' : ' disabled'}>Copia de seguridad</button>
      </div>
      <div id="ex-status" hidden><div class="progress"><i id="ex-bar"></i></div><p class="kv" id="ex-msg"></p></div>
      <div id="ex-done" class="btn-row" hidden>
        <button class="btn dark" data-act="ex-download"><svg class="ico sm"><use href="#i-save"/></svg>Descargar</button>
        <button class="btn" data-act="ex-share"><svg class="ico sm"><use href="#i-share"/></svg>Compartir</button>
      </div>
      <p class="hint">El ZIP para SIG trae puntos.geojson, fotos.geojson (con el azimut de cada foto), estilos de QGIS que se cargan solos y las fotos con marca de agua. La copia de seguridad se vuelve a abrir con «Importar».</p>
      <div class="btn-row"><button class="btn" data-act="import">Importar copia o ZIP</button></div>
    </section>

    <section class="block">
      <h3>Marca de agua</h3>
      <canvas class="wm-preview" id="wm-preview" width="900" height="600"></canvas>
      <label class="fld"><span class="fld-label">Texto propio de este proyecto</span><textarea class="inp short" data-p="wmText" maxlength="140" placeholder="Ej.: Control 7, obra A-23&#10;Cliente: Ayuntamiento de Ansó">${esc(p.wmText || '')}</textarea></label>
      <p class="hint">Hasta dos líneas, debajo de la fecha. Cada proyecto tiene el suyo.</p>
      <div class="fld"><span class="fld-label">Logo (el mismo en todos los proyectos)</span>
        <div class="logo-row">${S.logoURL ? `<img class="logo-prev" alt="Logo actual" src="${S.logoURL}">` : '<span class="kv">Sin logo</span>'}
          <button class="btn" data-act="logo-pick">${S.logoURL ? 'Cambiar logo' : 'Elegir imagen'}</button>
          ${S.logoURL ? '<button class="btn danger" data-act="logo-remove">Quitar</button>' : ''}</div>
      </div>
      <p class="hint">Mejor un PNG con fondo transparente.</p>
      <div class="fld"><span class="fld-label">Posición</span>
        <div class="pos-grid" role="radiogroup" aria-label="Posición de la marca">${POSITIONS.map(([k, label, gx, gy]) => `<button type="button" role="radio" data-pos="${k}" aria-label="${label}" title="${label}" aria-checked="${wm.position === k}" style="grid-column:${gx};grid-row:${gy}"><i></i></button>`).join('')}</div>
      </div>
      <div class="fld"><span class="fld-label">Fondo</span>${seg('bg', wm.bg, [['banda', 'Banda'], ['recuadro', 'Recuadro'], ['ninguno', 'Sin fondo']])}
        <label class="range"><span class="fld-label">Opacidad del fondo <output id="op-out">${Math.round((wm.opacity ?? 0.74) * 100)} %</output></span><input type="range" min="0" max="100" step="5" data-wmrange="opacity" value="${Math.round((wm.opacity ?? 0.74) * 100)}"${wm.bg === 'ninguno' ? ' disabled' : ''}></label>
      </div>
      <div class="fld"><span class="fld-label">Tamaño</span>${seg('size', wm.size, [[0.8, 'Pequeño'], [1, 'Medio'], [1.25, 'Grande']])}</div>
      <label class="fld"><span class="fld-label">Fecha</span><select class="inp" data-wmsel="dateFmt">${Object.entries(DATE_FORMATS).map(([k, f]) => `<option value="${k}"${wm.dateFmt === k ? ' selected' : ''}>${esc(f(nowParts))}</option>`).join('')}</select></label>
      <div class="fld"><span class="fld-label">Hora</span>${seg('timeFmt', wm.timeFmt, Object.entries(TIME_FORMATS).map(([k, f]) => [k, f(nowParts)]))}</div>
      <div>${chk('tz', `Mostrar la zona horaria (${nowParts.tz})`)}</div>
      <div class="fld" style="margin-top:14px"><span class="fld-label">Datos que aparecen</span>
        <div>${chk('fecha', 'Fecha y hora')}</div>
        <div>${chk('lugar', 'Lugar')}</div>
        <div>${chk('punto', 'Código del punto')}</div>
        <div>${chk('coords', 'Coordenadas y precisión')}</div>
        <div>${chk('utm', 'UTM')}</div>
        <div>${chk('alt', 'Altitud')}</div>
        <div>${chk('rumbo', 'Rosa con el norte y azimut')}</div>
      </div>
      <div class="fld"><span class="fld-label">Coordenadas</span>${seg('coordMode', wm.coordMode, [['dec', 'Decimales'], ['dms', 'Grados, min, seg']])}</div>
      <div class="fld"><span class="fld-label">Norte de referencia</span>${seg('northRef', wm.northRef, [['geo', 'Geográfico'], ['mag', 'Magnético']])}</div>
      <p class="hint">Con norte geográfico la app corrige la declinación magnética del lugar y la fecha (modelo WMM2025).</p>
    </section>

    <section class="block">
      <h3>Lugar y almacenamiento</h3>
      <label class="switch"><input type="checkbox" id="opt-place"${S.autoPlace ? ' checked' : ''}><span>Buscar el nombre del lugar (OpenStreetMap, con conexión)</span></label>
      <p class="kv">Espacio usado: ${mb(st.usage)}${st.quota ? ` de ${mb(st.quota)}` : ''}. ${st.persisted ? 'Datos protegidos: el navegador no los borrará para liberar espacio.' : 'Los datos aún no están protegidos contra la limpieza automática del navegador.'}</p>
      ${st.persisted ? '' : '<div class="btn-row"><button class="btn" data-act="persist">Proteger datos</button></div>'}
      <p class="hint">Todo se guarda solo en este teléfono. Haz una copia de seguridad de vez en cuando: si borras los datos del navegador, se pierde la libreta.</p>
    </section>

    <section class="block">
      <h3>Proyectos</h3>
      <div class="btn-row">
        <button class="btn" data-act="projects">Cambiar o crear proyecto</button>
        <button class="btn danger" data-act="delete-project">Eliminar este proyecto</button>
      </div>
      <p class="credits">Libreta de campo ${VERSION}. Mapas © OpenStreetMap, OpenTopoMap, Esri, IGN, Macrostrat. Declinación: NOAA WMM2025. Geoide: EGM96. Librerías: Leaflet, JSZip, piexifjs. Tipografía Barlow (OFL).</p>
    </section>`;
  drawWmPreview();
}

let wmBase = null, wmBaseKey = null, wmJob = 0;
async function drawWmPreview() {
  const c = $('#wm-preview'); if (!c) return;
  const job = ++wmJob;
  await ensureFonts();
  const last = [...S.photos].sort((a, b) => b.time - a.time)[0];
  const key = last ? `${last.id}:${last.rotation || 0}` : 'ejemplo';
  if (wmBaseKey !== key) {
    let base = null;
    if (last) {
      const rec = await db.get('blobs', last.id);
      if (rec) base = await renderPhoto(rec.blob, last, null, S.project, S.wm, { watermark: false, maxSide: 900 });
    }
    if (!base) {
      base = document.createElement('canvas'); base.width = 900; base.height = 600;
      const bx = base.getContext('2d');
      const g = bx.createLinearGradient(0, 0, 0, 600);
      g.addColorStop(0, '#8FB3C9'); g.addColorStop(0.55, '#D8D2C0'); g.addColorStop(0.56, '#9C8B6E'); g.addColorStop(1, '#5E5240');
      bx.fillStyle = g; bx.fillRect(0, 0, 900, 600);
      bx.fillStyle = '#7A6A50';
      bx.beginPath(); bx.moveTo(0, 340); bx.lineTo(180, 230); bx.lineTo(330, 300); bx.lineTo(520, 180); bx.lineTo(700, 290); bx.lineTo(900, 220); bx.lineTo(900, 600); bx.lineTo(0, 600); bx.fill();
    }
    if (job !== wmJob) return;
    wmBase = base; wmBaseKey = key;
  }
  if (job !== wmJob || !$('#wm-preview')) return;
  const cv = $('#wm-preview');
  cv.width = wmBase.width; cv.height = wmBase.height;
  const ctx = cv.getContext('2d');
  ctx.drawImage(wmBase, 0, 0);
  let info;
  if (last) info = photoInfo(last, S.points.find((p) => p.id === last.pointId), S.project, S.wm);
  else {
    const t = Date.now();
    const fake = { id: 'x', time: t, tzOff: new Date(t).getTimezoneOffset(), lat: 42.7583, lon: -0.8291, acc: 4, alt: 1285 + 51, altRef: 'ell', azMag: 243.6, decl: 1.4, place: 'Ansó, Huesca, España' };
    info = photoInfo(fake, { code: 'E-004' }, S.project, S.wm);
  }
  drawWatermark(ctx, cv.width, cv.height, info, S.wm);
}

let wmSaveT = null;
function saveWmSoon() { clearTimeout(wmSaveT); wmSaveT = setTimeout(() => db.setSetting('wm', S.wm), 300); }

// Cambios en vivo (deslizador de opacidad y texto propio)
let projTextT = null;
function onProjectLiveInput(e) {
  const t = e.target;
  if (t.dataset.wmrange) {
    S.wm[t.dataset.wmrange] = Number(t.value) / 100;
    const o = $('#op-out'); if (o) o.textContent = `${t.value} %`;
    drawWmPreview(); saveWmSoon();
  } else if (t.dataset.p === 'wmText') {
    S.project.wmText = t.value;
    drawWmPreview();
    clearTimeout(projTextT); projTextT = setTimeout(saveProject, 400);
  }
}

async function onLogoFile(e) {
  const f = e.target.files?.[0]; e.target.value = '';
  if (!f) return;
  try {
    const bmp = await createImageBitmap(f);
    const k = Math.min(1, 800 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    await db.setSetting('wmLogo', blob);
    await setLogo(blob);
    if (S.logoURL) URL.revokeObjectURL(S.logoURL);
    S.logoURL = URL.createObjectURL(blob);
    renderProject();
    toast('Logo guardado');
  } catch (err) { toast('No se pudo leer esa imagen'); }
}

async function onProjectInput(e) {
  const t = e.target;
  if (t.dataset.p) {
    const k = t.dataset.p;
    if (k === 'utmZone') { const z = parseInt(t.value, 10); S.project.utmZone = z >= 1 && z <= 60 ? z : null; }
    else S.project[k] = t.value;
    if (k === 'name') $('#proj-name').textContent = t.value || 'Proyecto';
    await saveProject();
    if (k === 'wmText') drawWmPreview();
  } else if (t.dataset.wm) {
    S.wm[t.dataset.wm] = t.checked;
    await db.setSetting('wm', S.wm);
    drawWmPreview();
  } else if (t.dataset.wmsel) {
    S.wm[t.dataset.wmsel] = t.value;
    await db.setSetting('wm', S.wm);
    drawWmPreview();
  } else if (t.dataset.wmrange) {
    await db.setSetting('wm', S.wm);
  } else if (t.id === 'opt-place') {
    S.autoPlace = t.checked; await db.setSetting('autoPlace', S.autoPlace);
  }
}

async function editField(idx) {
  const p = S.project;
  const f = idx != null ? p.fields[idx] : { label: '', type: 'texto', options: [] };
  const body = `
    <label class="fld"><span class="fld-label">Nombre del campo</span><input class="inp" id="ef-label" value="${esc(f.label)}" placeholder="Ej.: Grado de meteorización"></label>
    <label class="fld"><span class="fld-label">Tipo</span><select class="inp" id="ef-type">${Object.entries(TIPOS).map(([k, l]) => `<option value="${k}"${k === f.type ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    <label class="fld" id="ef-opts-wrap"${f.type === 'lista' ? '' : ' hidden'}><span class="fld-label">Opciones (una por línea)</span><textarea class="inp" id="ef-opts">${esc((f.options || []).join('\n'))}</textarea></label>`;
  const res = await dialog({
    title: idx != null ? 'Editar campo' : 'Nuevo campo', body,
    actions: [{ label: 'Cancelar', value: null }, {
      label: 'Guardar', cls: 'primary',
      validate: (b) => { const ok = $('#ef-label', b).value.trim(); if (!ok) $('#ef-label', b).focus(); return !!ok; },
      value: (b) => ({ label: $('#ef-label', b).value.trim(), type: $('#ef-type', b).value, options: $('#ef-opts', b).value.split('\n').map((s) => s.trim()).filter(Boolean) }),
    }],
    onMount(b) { $('#ef-type', b).onchange = (e) => { $('#ef-opts-wrap', b).hidden = e.target.value !== 'lista'; }; },
  });
  if (!res) return;
  if (idx != null) Object.assign(p.fields[idx], res, res.type === 'lista' ? {} : { options: undefined });
  else p.fields.push({ key: slug(res.label, p.fields.map((x) => x.key)), ...res, options: res.type === 'lista' ? res.options : undefined });
  await saveProject(); renderProject();
}

async function projectsDialog() {
  await loadProjects();
  const counts = {};
  for (const p of S.projects) counts[p.id] = (await db.byIndex('points', 'projectId', p.id)).length;
  const body = document.createElement('div');
  body.innerHTML = `<div class="proj-list">${S.projects.map((p) => `<button data-pid="${p.id}"><span><b>${esc(p.name)}</b><br><small class="kv">${counts[p.id]} punto${counts[p.id] === 1 ? '' : 's'}</small></span>${p.id === S.project.id ? '<span class="cur">Abierto</span>' : ''}</button>`).join('')}</div>`;
  const v = await dialog({
    title: 'Proyectos', body,
    actions: [{ label: 'Cerrar', value: null }, { label: 'Nuevo proyecto', cls: 'primary', value: 'new' }],
    onMount(b, close) { b.onclick = (e) => { const t = e.target.closest('[data-pid]'); if (t) close(t.dataset.pid); }; },
  });
  if (v === 'new') return newProjectDialog();
  if (v && v !== S.project.id) { await selectProject(v); toast(`Proyecto «${S.project.name}» abierto`); }
}

async function newProjectDialog() {
  const res = await dialog({
    title: 'Nuevo proyecto',
    body: `<label class="fld"><span class="fld-label">Nombre</span><input class="inp" id="np-name" placeholder="Ej.: TFM Pirineos, campaña octubre"></label>
      <label class="fld"><span class="fld-label">Campos</span><select class="inp" id="np-tpl">
        <option value="geologia">Plantilla de geología</option>
        <option value="libre">Solo notas</option>
        <option value="copy">Copiar los campos de «${esc(S.project?.name || '')}»</option>
      </select></label>`,
    actions: [{ label: 'Cancelar', value: null }, {
      label: 'Crear', cls: 'primary',
      validate: (b) => !!$('#np-name', b).value.trim(),
      value: (b) => ({ name: $('#np-name', b).value.trim(), tpl: $('#np-tpl', b).value }),
    }],
  });
  if (!res) return;
  const p = res.tpl === 'copy'
    ? await createProject(res.name, 'geologia', S.project.fields)
    : await createProject(res.name, res.tpl);
  if (res.tpl === 'copy') { p.prefix = S.project.prefix; p.utmZone = S.project.utmZone; await db.put('projects', p); }
  await selectProject(p.id);
  toast(`Proyecto «${p.name}» creado`);
}

async function onProjectClick(e) {
  const posBtn = e.target.closest('[data-pos]');
  if (posBtn) {
    S.wm.position = posBtn.dataset.pos;
    for (const b of posBtn.parentElement.children) b.setAttribute('aria-checked', String(b === posBtn));
    await db.setSetting('wm', S.wm);
    return drawWmPreview();
  }
  const segBtn = e.target.closest('.seg button');
  if (segBtn) {
    const name = segBtn.parentElement.dataset.seg;
    let v = segBtn.dataset.v;
    if (name === 'size') v = Number(v);
    S.wm[name] = v;
    await db.setSetting('wm', S.wm);
    for (const b of segBtn.parentElement.children) b.setAttribute('aria-pressed', String(b === segBtn));
    if (name === 'bg') { const r = document.querySelector('[data-wmrange="opacity"]'); if (r) r.disabled = v === 'ninguno'; }
    drawWmPreview(); renderMap(); renderList();
    return;
  }
  const ef = e.target.closest('[data-edit-field]');
  if (ef) return editField(Number(ef.dataset.editField));
  const mv = e.target.closest('[data-move]');
  if (mv) {
    const i = Number(mv.dataset.move), j = i + Number(mv.dataset.dir);
    const f = S.project.fields;
    if (j < 0 || j >= f.length) return;
    [f[i], f[j]] = [f[j], f[i]];
    await saveProject(); return renderProject();
  }
  const df = e.target.closest('[data-del-field]');
  if (df) {
    const f = S.project.fields[Number(df.dataset.delField)];
    if (!(await confirmDlg('Quitar campo', `Se quitará «${f.label}» del formulario. Los valores ya guardados se conservan en los datos.`, 'Quitar'))) return;
    S.project.fields.splice(Number(df.dataset.delField), 1);
    await saveProject(); return renderProject();
  }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  if (act === 'add-field') editField(null);
  else if (act === 'logo-pick') $('#logo-input').click();
  else if (act === 'logo-remove') {
    await db.setSetting('wmLogo', null); await setLogo(null);
    if (S.logoURL) URL.revokeObjectURL(S.logoURL);
    S.logoURL = null; renderProject();
  }
  else if (act === 'export-sig' || act === 'export-backup') runExport(act === 'export-backup' ? 'backup' : 'sig');
  else if (act === 'ex-download' && exportResult) download(exportResult.blob, exportResult.name);
  else if (act === 'ex-share' && exportResult) shareFile(exportResult.blob, exportResult.name, exportResult.name);
  else if (act === 'import') $('#import-input').click();
  else if (act === 'persist') { const ok = await db.requestPersist(); toast(ok ? 'Datos protegidos' : 'El navegador no lo permitió todavía. Instalar la app suele ayudar.'); renderProject(); }
  else if (act === 'projects') projectsDialog();
  else if (act === 'delete-project') {
    const ok = await dialog({
      title: 'Eliminar proyecto',
      body: `<p>Se borrarán ${S.points.length} puntos y ${S.photos.length} fotos de «${esc(S.project.name)}». Escribe <b>BORRAR</b> para confirmar.</p><input class="inp" id="del-conf" autocomplete="off">`,
      actions: [{ label: 'Cancelar', value: false }, { label: 'Eliminar', cls: 'danger', validate: (b) => $('#del-conf', b).value.trim().toUpperCase() === 'BORRAR', value: true }],
    });
    if (!ok) return;
    await db.deleteProject(S.project.id);
    await loadProjects();
    if (!S.projects.length) await createProject('Proyecto de campo');
    await selectProject(S.projects[0].id);
    toast('Proyecto eliminado');
  }
}

async function runExport(mode) {
  const from = $('#ex-from').value ? new Date(`${$('#ex-from').value}T00:00:00`).getTime() : null;
  const to = $('#ex-to').value ? new Date(`${$('#ex-to').value}T23:59:59`).getTime() : null;
  const status = $('#ex-status'), bar = $('#ex-bar'), msg = $('#ex-msg');
  $('#ex-done').hidden = true; exportResult = null;
  status.hidden = false; bar.style.width = '0%'; msg.textContent = 'Preparando…';
  for (const b of document.querySelectorAll('[data-act^="export"]')) b.disabled = true;
  try {
    exportResult = await exportZip(S.project.id, {
      from, to, mode, originals: $('#ex-orig').checked, wm: S.wm, places: S.autoPlace,
      onProgress: (f, label) => { bar.style.width = `${Math.round(f * 100)}%`; if (label) msg.textContent = label; },
    });
    bar.style.width = '100%';
    const mb = (exportResult.blob.size / 1e6).toFixed(1).replace('.', ',');
    msg.textContent = `${exportResult.name}: ${exportResult.counts.points} puntos, ${exportResult.counts.photos} fotos, ${mb} MB.`;
    $('#ex-done').hidden = false;
  } catch (err) {
    console.error(err);
    msg.textContent = `No se pudo exportar: ${err.message}`;
  } finally {
    for (const b of document.querySelectorAll('[data-act^="export"]')) b.disabled = false;
  }
}

async function onImport(e) {
  const f = e.target.files?.[0]; e.target.value = '';
  if (!f) return;
  toast('Importando…', null, 60000);
  try {
    const r = await importZip(f, (x, label) => toast(`Importando… ${label}`, null, 60000));
    await loadProjects();
    await selectProject(r.project.id);
    toast(`Importado «${r.project.name}»: ${r.points} puntos, ${r.photos} fotos${r.missing ? ` (${r.missing} sin archivo original)` : ''}`, null, 6000);
  } catch (err) { toast(err.message, null, 6000); }
}

/* ================= Arranque ================= */

function bind() {
  for (const t of document.querySelectorAll('.tab[data-view]')) t.onclick = () => switchView(t.dataset.view);
  $('#tab-cam').onclick = () => openCam(null);
  $('#fab-punto').onclick = () => newPointFlow();
  $('#proj-btn').onclick = () => projectsDialog();
  $('#gps-pill').onclick = () => showGPSInfo();
  $('#btn-me').onclick = () => { startCompass(); if (!mapx.centerOnMe(gps.fix)) toast('Sin posición GPS todavía'); };
  $('#btn-fit').onclick = () => { if (!mapx.fitData(S.points, S.photos)) toast('Aún no hay puntos en este proyecto'); };
  $('#list').onclick = (e) => {
    const o = e.target.closest('[data-open]'); if (o) return openPoint(o.dataset.open);
    if (e.target.closest('[data-act="new-point"]')) newPointFlow();
  };
  $('#sheet-close').onclick = () => popOverlay('sheet');
  $('#sheet-body').addEventListener('input', onSheetInput);
  $('#sheet-body').addEventListener('change', onSheetInput);
  $('#sheet-body').addEventListener('click', onSheetClick);
  $('#sheet-code').addEventListener('change', (e) => {
    const pt = curPoint(); if (!pt) return;
    pt.code = e.target.value.trim() || pt.code; e.target.value = pt.code; scheduleSave(pt);
  });
  $('#proj').addEventListener('change', onProjectInput);
  $('#proj').addEventListener('input', onProjectLiveInput);
  $('#logo-input').onchange = onLogoFile;
  $('#proj').addEventListener('click', onProjectClick);
  // cámara
  $('#shutter').onclick = shoot;
  $('#cam-done').onclick = () => popOverlay('camera');
  $('#cam-target').onclick = chooseTarget;
  $('#cam-sys').onclick = useSystemCamera;
  $('#sys-input').onchange = onSystemPhoto;
  $('#cam-torch').onclick = async (e) => {
    const b = e.currentTarget; const on = b.getAttribute('aria-pressed') !== 'true';
    if (await setTorch(on)) b.setAttribute('aria-pressed', String(on));
  };
  $('#cam-thumb').onclick = (e) => {
    const id = e.currentTarget.dataset.photo; if (!id) return;
    const ph = S.photos.find((p) => p.id === id); if (!ph) return;
    const list = S.photos.filter((p) => p.pointId === ph.pointId).sort((a, b) => a.n - b.n).map((p) => p.id);
    openViewer(list, list.indexOf(id));
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && stack.length) history.back();
    if (!$('#camera').hidden && (e.key === ' ' || e.key === 'Enter') && document.activeElement === document.body) { e.preventDefault(); shoot(); }
    if (S.viewer && e.key === 'ArrowLeft') $('#v-prev').click();
    if (S.viewer && e.key === 'ArrowRight') $('#v-next').click();
  });
  // visor
  $('#v-close').onclick = () => popOverlay('viewer');
  $('#v-wm').onchange = renderViewer;
  $('#v-prev').onclick = () => { if (S.viewer.idx > 0) { S.viewer.idx--; renderViewer(); } };
  $('#v-next').onclick = () => { if (S.viewer.idx < S.viewer.list.length - 1) { S.viewer.idx++; renderViewer(); } };
  $('#v-rotl').onclick = () => rotatePhoto(-90);
  $('#v-rotr').onclick = () => rotatePhoto(90);
  let capT = null;
  $('#v-caption').oninput = (e) => {
    const ph = curPhoto(); if (!ph) return;
    ph.caption = e.target.value;
    clearTimeout(capT); capT = setTimeout(() => db.put('photos', ph), 400);
  };
  $('#v-save').onclick = async () => { const r = await exportOne($('#v-wm').checked); if (r) download(r.blob, r.name); };
  $('#v-share').onclick = async () => { const r = await exportOne($('#v-wm').checked); if (r) shareFile(r.blob, r.name, r.title); };
  $('#v-map').onclick = () => {
    const ph = curPhoto(); if (!ph) return;
    for (const n of ['viewer', 'camera', 'sheet']) popOverlay(n);
    switchView('mapa');
    setTimeout(() => mapx.centerOn(ph.lat, ph.lon, 18), 100);
  };
  $('#v-del').onclick = async () => {
    const ph = curPhoto(); if (!ph) return;
    if (!(await confirmDlg('Eliminar foto', 'La foto se borrará del teléfono. No se puede deshacer.'))) return;
    await db.deletePhoto(ph.id);
    S.photos = S.photos.filter((p) => p.id !== ph.id);
    S.viewer.list = S.viewer.list.filter((id) => id !== ph.id);
    if (!S.viewer.list.length) { popOverlay('viewer'); if (S.openPointId) renderSheet(); renderAll(); return; }
    S.viewer.idx = Math.min(S.viewer.idx, S.viewer.list.length - 1);
    renderViewer(); renderMap();
    if (S.openPointId) renderSheet();
  };
  $('#gallery-input').onchange = onGallery;
  $('#import-input').onchange = onImport;
  window.addEventListener('resize', () => { if (S.viewer) renderViewer(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && !$('#camera').hidden) popOverlay('camera');
  });

  subscribe(() => { renderGPS(); updateMe(); });
}

function registerSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw?.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          toast('Hay una versión nueva de la app', { label: 'Actualizar', run: () => nw.postMessage('skipWaiting') });
        }
      });
    });
  }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded) { reloaded = true; location.reload(); } });
}

async function init() {
  bind();
  registerSW();
  S.wm = migrateWM({ ...DEFAULT_WM, ...(await db.getSetting('wm', {})) });
  const logoBlob = await db.getSetting('wmLogo', null);
  if (logoBlob) { await setLogo(logoBlob); S.logoURL = URL.createObjectURL(logoBlob); }
  S.autoPlace = await db.getSetting('autoPlace', true);
  await loadProjects();
  if (!S.projects.length) await createProject('Proyecto de campo');
  const cur = await db.getSetting('currentProject', null);
  await selectProject(cur && S.projects.some((p) => p.id === cur) ? cur : S.projects[0].id);
  switchView('mapa');
  startGPS();
  if (!isIOS) startCompass();
  renderGPS();
  ensureFonts();
}

init().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<div class="toast on" style="bottom:20px">Error al iniciar: ${esc(e.message)}</div>`);
});

// Para pruebas
self.__libreta = { S, gps, compass };
