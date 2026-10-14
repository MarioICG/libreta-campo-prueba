// Mapa con Leaflet: puntos de la libreta, fotos con su dirección y tu posición.
import { BASES, OVERLAYS } from './capas.js';

let map = null;
let ptsLayer, phLayer, meMarker, meCircle;
let handlers = {};
let fittedOnce = false;
let followMe = false;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function initMap(el, opts) {
  handlers = opts;
  const L = self.L;
  map = L.map(el, { zoomControl: false, attributionControl: true, tapHold: true }).setView([40.4, -3.7], 6);
  self.__map = map;
  const bases = {}, overlays = {};
  let current = null;
  for (const b of BASES) {
    const layer = L.tileLayer(b.url, { ...b.opts, crossOrigin: b.cors ? 'anonymous' : undefined });
    bases[b.nombre] = layer; layer._libretaId = b.id;
    if (b.id === opts.baseId) current = layer;
  }
  for (const o of OVERLAYS) {
    const layer = L.tileLayer(o.url, { ...o.opts, crossOrigin: o.cors ? 'anonymous' : undefined });
    overlays[o.nombre] = layer; layer._libretaId = o.id;
    if (opts.overlayIds?.includes(o.id)) layer.addTo(map);
  }
  (current || Object.values(bases)[0]).addTo(map);
  L.control.layers(bases, overlays, { position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
  map.attributionControl.setPrefix('');
  map.on('baselayerchange', (e) => opts.onBaseChange?.(e.layer._libretaId));
  map.on('overlayadd overlayremove', () => {
    const on = Object.values(overlays).filter((l) => map.hasLayer(l)).map((l) => l._libretaId);
    opts.onOverlayChange?.(on);
  });
  map.on('contextmenu', (e) => opts.onLongPress?.(e.latlng.lat, e.latlng.lng));
  map.on('dragstart', () => setFollow(false));

  ptsLayer = L.layerGroup().addTo(map);
  phLayer = L.layerGroup().addTo(map);
  return map;
}

export function invalidate() { map?.invalidateSize(); }

export function renderData(points, photos, thumbs, azOf) {
  if (!map) return;
  const L = self.L;
  ptsLayer.clearLayers(); phLayer.clearLayers();
  for (const ph of photos) {
    const az = azOf(ph);
    // La miniatura se dibuja desplazada hacia donde miraba la cámara; el vértice del cono es el punto exacto.
    const a = (az ?? 45) * Math.PI / 180;
    const dx = Math.round(Math.sin(a) * 40), dy = Math.round(-Math.cos(a) * 40);
    const html = `<div class="ph-ico" style="--az:${az ?? 0}deg">${az != null ? '<i class="ph-cone"></i>' : ''}<i class="ph-at"></i><img alt="" src="${thumbs.get(ph.id) || ''}" style="left:${dx - 17}px;top:${dy - 17}px"></div>`;
    const m = L.marker([ph.lat, ph.lon], { icon: L.divIcon({ className: 'ph-wrap', html, iconSize: [0, 0], iconAnchor: [0, 0] }), zIndexOffset: 700 });
    m.on('click', () => handlers.onPhotoClick?.(ph.id));
    m.addTo(phLayer);
  }
  for (const pt of points) {
    const html = `<span class="pt-dot"></span><span class="pt-lbl">${esc(pt.code)}</span>`;
    const m = L.marker([pt.lat, pt.lon], { icon: L.divIcon({ className: 'pt-ico', html, iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 500 });
    m.on('click', () => handlers.onPointClick?.(pt.id));
    m.addTo(ptsLayer);
  }
  if (!fittedOnce && (points.length || photos.length)) { fitData(points, photos); fittedOnce = true; }
}

function setFollow(v) {
  if (followMe === v) return;
  followMe = v;
  handlers.onFollowChange?.(v);
}

export function fitData(points, photos) {
  const L = self.L;
  if (!map) return false;
  setFollow(false);
  const ll = [...points.map((p) => [p.lat, p.lon]), ...photos.map((p) => [p.lat, p.lon])];
  if (!ll.length) return false;
  if (ll.length === 1) map.setView(ll[0], 16);
  else map.fitBounds(L.latLngBounds(ll).pad(0.2), { maxZoom: 17 });
  return true;
}

export function resetFit() { fittedOnce = false; }

let lastFixT = 0;
export function updateMe(fix, heading) {
  if (!map || !fix) return;
  const moved = fix.t !== lastFixT;
  lastFixT = fix.t;
  const L = self.L;
  const ll = [fix.lat, fix.lon];
  const html = `<div class="me-ico">${heading != null ? `<i class="me-cone" style="--az:${heading}deg"></i>` : ''}<span class="me-dot"></span></div>`;
  if (!meMarker) {
    meCircle = L.circle(ll, { radius: fix.acc, className: 'me-acc', interactive: false }).addTo(map);
    meMarker = L.marker(ll, { icon: L.divIcon({ className: 'me-wrap', html, iconSize: [60, 60], iconAnchor: [30, 30] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
  } else {
    meCircle.setLatLng(ll).setRadius(fix.acc);
    meMarker.setLatLng(ll);
    const el = meMarker.getElement();
    if (el) el.innerHTML = html;
  }
  if (followMe && moved) map.panTo(ll, { animate: true });
}

export function centerOnMe(fix, follow = true) {
  if (!fix || !map) return false;
  setFollow(follow);
  map.setView([fix.lat, fix.lon], Math.max(map.getZoom(), 16));
  return true;
}

export function centerOn(lat, lon, zoom = 17) { setFollow(false); map?.setView([lat, lon], zoom); }
