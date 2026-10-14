// Marca de agua: fecha, hora, lugar, coordenadas, texto propio, logo y rosa con la
// flecha del norte girada según hacia dónde miraba la cámara.
import { toUTM, formatUTM, formatLatLon, cardinal, fmtAz, geoidN, norm360, fmtDecl } from './geo.js';

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MESES_L = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const p2 = (n) => String(n).padStart(2, '0');

export const INK = '#13303A';
export const YELLOW = '#F2C230';
export const RED = '#D3302F';

export const DEFAULT_WM = {
  fecha: true, lugar: true, coords: true, utm: true, alt: true, punto: true, rumbo: true,
  coordMode: 'dec', size: 1, northRef: 'geo',
  position: 'bl',      // tl tc tr | c | bl bc br
  bg: 'banda',         // banda | recuadro | ninguno
  opacity: 0.74,
  dateFmt: 'texto', timeFmt: 'h24s', tz: true,
};

// Ajustes guardados por versiones anteriores
export function migrateWM(wm) {
  if (wm.position === 'bottom') wm.position = 'bl';
  if (wm.position === 'top') wm.position = 'tl';
  if (['24s', '24', '12'].includes(wm.timeFmt)) wm.timeFmt = `h${wm.timeFmt}`;
  return wm;
}

export const POSITIONS = [
  ['tl', 'Arriba a la izquierda', 1, 1], ['tc', 'Arriba al centro', 2, 1], ['tr', 'Arriba a la derecha', 3, 1],
  ['c', 'En el centro', 2, 2],
  ['bl', 'Abajo a la izquierda', 1, 3], ['bc', 'Abajo al centro', 2, 3], ['br', 'Abajo a la derecha', 3, 3],
];

// Fecha y hora tal como se vivieron en campo (zona horaria guardada al tomar la foto)
export function dateParts(time, tzOff) {
  const off = tzOff ?? new Date(time).getTimezoneOffset();
  const d = new Date(time - off * 60000);
  const sign = off <= 0 ? '+' : '−';
  const a = Math.abs(off);
  const Y = d.getUTCFullYear(), Mo = d.getUTCMonth() + 1, D = d.getUTCDate();
  const h = d.getUTCHours(), mi = d.getUTCMinutes(), s = d.getUTCSeconds();
  return {
    Y, Mo, D, h, mi, s, wd: d.getUTCDay(),
    date: `${D} ${MESES[Mo - 1]} ${Y}`,
    dateNum: `${p2(D)}/${p2(Mo)}/${Y}`,
    time: `${p2(h)}:${p2(mi)}:${p2(s)}`,
    hm: `${p2(h)}:${p2(mi)}`,
    tz: `UTC${sign}${p2(Math.floor(a / 60))}:${p2(a % 60)}`,
    iso: `${Y}-${p2(Mo)}-${p2(D)}T${p2(h)}:${p2(mi)}:${p2(s)}${sign === '+' ? '+' : '-'}${p2(Math.floor(a / 60))}:${p2(a % 60)}`,
    exif: `${Y}:${p2(Mo)}:${p2(D)} ${p2(h)}:${p2(mi)}:${p2(s)}`,
  };
}

export const DATE_FORMATS = {
  texto: (p) => `${p.D} ${MESES[p.Mo - 1]} ${p.Y}`,
  larga: (p) => `${DIAS[p.wd]}, ${p.D} de ${MESES_L[p.Mo - 1]} de ${p.Y}`,
  dmy: (p) => `${p2(p.D)}/${p2(p.Mo)}/${p.Y}`,
  dmyg: (p) => `${p2(p.D)}-${p2(p.Mo)}-${p.Y}`,
  iso: (p) => `${p.Y}-${p2(p.Mo)}-${p2(p.D)}`,
  mdy: (p) => `${p2(p.Mo)}/${p2(p.D)}/${p.Y}`,
};
export const TIME_FORMATS = {
  h24s: (p) => `${p2(p.h)}:${p2(p.mi)}:${p2(p.s)}`,
  h24: (p) => `${p2(p.h)}:${p2(p.mi)}`,
  h12: (p) => `${((p.h + 11) % 12) + 1}:${p2(p.mi)}:${p2(p.s)} ${p.h < 12 ? 'a. m.' : 'p. m.'}`,
};

export function stampText(dp, wm) {
  const df = DATE_FORMATS[wm.dateFmt] || DATE_FORMATS.texto;
  const tf = TIME_FORMATS[wm.timeFmt] || TIME_FORMATS.h24s;
  return `${df(dp)}   ${tf(dp)}`;
}

// Altitud sobre el nivel del mar
export function altMSL(rec) {
  if (rec.alt == null) return null;
  if (rec.altRef === 'msl') return rec.alt;
  const n = geoidN(rec.lat, rec.lon);
  return n == null ? rec.alt : rec.alt - n;
}

// Rumbo de la foto según el norte elegido
export function photoAzimuth(photo, northRef = 'geo') {
  if (photo.azMag == null) return null;
  if (northRef === 'mag' || photo.decl == null) return norm360(photo.azMag);
  return norm360(photo.azMag + photo.decl);
}

export function photoInfo(photo, point, project, wm) {
  const dp = dateParts(photo.time, photo.tzOff);
  const utm = toUTM(photo.lat, photo.lon, project?.utmZone || undefined);
  const alt = altMSL(photo);
  const az = photoAzimuth(photo, wm.northRef);
  return {
    dp, utm,
    latlon: formatLatLon(photo.lat, photo.lon, wm.coordMode),
    utmText: `UTM ${formatUTM(utm)}`,
    acc: photo.acc != null ? `±${Math.round(photo.acc)} m` : '',
    alt: alt != null ? `${Math.round(alt).toLocaleString('es-ES')} m s.n.m.` : '',
    place: photo.place || point?.place || '',
    code: point?.code || '',
    project: project?.name || '',
    custom: project?.wmText || '',
    az,
    azText: az != null ? `Az ${fmtAz(az)} ${cardinal(az)} (${wm.northRef === 'mag' || photo.decl == null ? 'N mag' : 'N geo'})` : '',
    decl: photo.decl != null ? fmtDecl(photo.decl) : '',
  };
}

let fontsReady = null;
export function ensureFonts() {
  if (!fontsReady) {
    fontsReady = Promise.all([
      document.fonts.load('700 40px "Barlow Condensed"'),
      document.fonts.load('600 40px "Barlow Condensed"'),
      document.fonts.load('500 40px "Barlow"'),
    ]).catch(() => null);
  }
  return fontsReady;
}

/* ---------- Logo ---------- */
let logoBmp = null;
export async function setLogo(blob) {
  logoBmp?.close?.();
  logoBmp = null;
  if (blob) { try { logoBmp = await createImageBitmap(blob); } catch (e) { logoBmp = null; } }
}

function fitFont(ctx, text, weight, family, size, maxW) {
  let s = size;
  ctx.font = `${weight} ${s}px ${family}`;
  while (ctx.measureText(text).width > maxW && s > size * 0.5) {
    s *= 0.94;
    ctx.font = `${weight} ${s}px ${family}`;
  }
  return s;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

export function drawWatermark(ctx, w, h, info, wm) {
  const base = Math.min(w, h);
  const S = wm.size || 1;
  const pad = base * 0.028 * S;
  const gap = pad * 0.8;
  const COND = '"Barlow Condensed", sans-serif', SANS = '"Barlow", sans-serif';
  const pos = wm.position || 'bl';
  const row = pos === 'c' ? 'c' : pos[0];
  const col = pos === 'c' ? 'c' : pos[1];
  const bg = wm.bg || 'banda';
  const band = bg === 'banda';

  const lines = [];
  if (wm.fecha) lines.push({ text: stampText(info.dp, wm), small: wm.tz === false ? '' : info.dp.tz, weight: 700, fam: COND, size: 0.052, color: '#FFFFFF' });
  for (const t of String(info.custom || '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 2)) {
    lines.push({ text: t, weight: 600, fam: COND, size: 0.038, color: '#FFFFFF' });
  }
  const l2 = [wm.lugar && info.place, wm.punto && info.code, !info.place && info.project].filter(Boolean).join('   ');
  if (l2) lines.push({ text: l2, weight: 600, fam: COND, size: 0.040, color: YELLOW });
  const l3 = [wm.coords && info.latlon, wm.coords && info.acc, wm.alt && info.alt].filter(Boolean).join('    ');
  if (l3) lines.push({ text: l3, weight: 500, fam: SANS, size: 0.029, color: 'rgba(255,255,255,.94)' });
  const l4 = [wm.utm && info.utmText, wm.rumbo && info.azText].filter(Boolean).join('    ');
  if (l4) lines.push({ text: l4, weight: 500, fam: SANS, size: 0.029, color: 'rgba(255,255,255,.94)' });

  const showDial = wm.rumbo && info.az != null;
  const logo = logoBmp;
  if (!lines.length && !showDial && !logo) return;

  const lineGap = 0.35;
  const D = showDial ? base * 0.152 * S : 0;
  const nominalH = lines.reduce((a, l) => a + l.size * base * S * (1 + lineGap), 0) - (lines.length ? lines[lines.length - 1].size * base * S * lineGap : 0);
  let LW = 0, LH = 0;
  if (logo) {
    LH = Math.min(Math.max(nominalH, D, base * 0.1 * S), base * 0.17 * S);
    LW = LH * logo.width / logo.height;
    const cap = w * 0.28;
    if (LW > cap) { LW = cap; LH = LW * logo.height / logo.width; }
  }

  // Ancho disponible para el texto
  const margin = band ? 0 : pad;
  const extras = (showDial ? D + gap : 0) + (logo ? LW + gap : 0);
  const textMax = Math.max(base * 0.2, w - 2 * margin - 2 * pad - extras);

  // Ajusta cada línea al ancho y mide
  ctx.save();
  ctx.textBaseline = 'top';
  let textW = 0, textH = 0;
  for (const l of lines) {
    const full = l.small ? `${l.text}  ${l.small}` : l.text;
    l.s = fitFont(ctx, full, l.weight, l.fam, l.size * base * S, textMax);
    ctx.font = `${l.weight} ${l.s}px ${l.fam}`;
    l.mainW = ctx.measureText(l.text).width;
    l.w = l.mainW;
    if (l.small) {
      ctx.font = `600 ${l.s * 0.55}px ${COND}`;
      l.smallGap = ctx.measureText('  ').width * 1.6;
      l.w += l.smallGap + ctx.measureText(l.small).width;
    }
    textW = Math.max(textW, l.w);
  }
  lines.forEach((l, i) => { textH += l.s * (i < lines.length - 1 ? 1 + lineGap : 1); });

  const blockH = Math.max(textH, D, LH);
  const vpad = pad * 0.75;
  const boxH = blockH + vpad * 2;
  const contentW = textW + extras - (lines.length ? 0 : gap);
  const boxW = band ? w : contentW + pad * 2;
  const boxX = band ? 0 : (col === 'l' ? margin : col === 'r' ? w - boxW - margin : (w - boxW) / 2);
  const boxY = row === 't' ? margin : row === 'b' ? h - boxH - margin : (h - boxH) / 2;
  const cy = boxY + boxH / 2;

  // Fondo
  if (bg !== 'ninguno') {
    const op = Math.max(0, Math.min(1, wm.opacity ?? 0.74));
    ctx.fillStyle = `rgba(19,48,58,${op})`;
    const rule = Math.max(2, base * 0.004 * S);
    if (band) {
      ctx.fillRect(boxX, boxY, boxW, boxH);
      ctx.fillStyle = YELLOW;
      ctx.fillRect(0, row === 't' ? boxY + boxH - rule : boxY, w, rule);
    } else {
      const r = pad * 0.45;
      roundRect(ctx, boxX, boxY, boxW, boxH, r); ctx.fill();
      ctx.save(); roundRect(ctx, boxX, boxY, boxW, boxH, r); ctx.clip();
      ctx.fillStyle = YELLOW;
      ctx.fillRect(boxX, row === 't' ? boxY + boxH - rule : boxY, boxW, rule);
      ctx.restore();
    }
  } else {
    ctx.shadowColor = 'rgba(0,0,0,.8)';
    ctx.shadowBlur = base * 0.006;
    ctx.shadowOffsetY = base * 0.0015;
  }

  // Posiciones horizontales: logo | texto | rosa
  let logoX, textX, dialX;
  if (band) {
    logoX = pad;
    dialX = w - pad - D;
    const regionL = pad + (logo ? LW + gap : 0);
    const regionR = w - pad - (showDial ? D + gap : 0);
    textX = col === 'l' ? regionL : col === 'r' ? regionR - textW : regionL + (regionR - regionL - textW) / 2;
  } else {
    let x = boxX + pad;
    logoX = x; if (logo) x += LW + gap;
    textX = x; x += textW + (lines.length ? gap : 0);
    dialX = x;
  }

  if (logo) {
    ctx.save(); ctx.shadowColor = 'transparent';
    ctx.drawImage(logo, logoX, cy - LH / 2, LW, LH);
    ctx.restore();
  }

  let y = cy - textH / 2;
  for (const l of lines) {
    const x = col === 'l' ? textX : col === 'r' ? textX + textW - l.w : textX + (textW - l.w) / 2;
    ctx.font = `${l.weight} ${l.s}px ${l.fam}`;
    ctx.fillStyle = l.color;
    ctx.fillText(l.text, x, y);
    if (l.small) {
      ctx.font = `600 ${l.s * 0.55}px ${COND}`;
      ctx.fillStyle = 'rgba(255,255,255,.72)';
      ctx.fillText(l.small, x + l.mainW + l.smallGap, y + l.s * 0.38);
    }
    y += l.s * (1 + lineGap);
  }
  ctx.restore();

  if (showDial) drawDial(ctx, dialX + D / 2, cy, D / 2, info.az);
}

// Rosa: la parte superior es la dirección de la foto; la aguja roja marca el norte.
export function drawDial(ctx, cx, cy, r, az) {
  const rot = -az * Math.PI / 180;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(10,28,34,0.85)'; ctx.fill();
  ctx.lineWidth = r * 0.06; ctx.strokeStyle = '#FFFFFF'; ctx.stroke();

  // Índice fijo: hacia donde mira la cámara
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.97); ctx.lineTo(-r * 0.13, -r * 1.2); ctx.lineTo(r * 0.13, -r * 1.2); ctx.closePath();
  ctx.fillStyle = YELLOW; ctx.fill();

  ctx.rotate(rot);
  for (let a = 0; a < 360; a += 15) {
    const major = a % 90 === 0, mid = a % 45 === 0;
    const len = major ? 0 : (mid ? r * 0.16 : r * 0.09);
    if (!len) continue;
    ctx.save(); ctx.rotate(a * Math.PI / 180);
    ctx.beginPath(); ctx.moveTo(0, -r * 0.9); ctx.lineTo(0, -r * 0.9 + len);
    ctx.lineWidth = r * (mid ? 0.045 : 0.03); ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.stroke();
    ctx.restore();
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const letters = [['N', 0], ['E', 90], ['S', 180], ['O', 270]];
  for (const [t, a] of letters) {
    ctx.save(); ctx.rotate(a * Math.PI / 180); ctx.translate(0, -r * 0.72);
    ctx.font = `700 ${r * (t === 'N' ? 0.36 : 0.27)}px "Barlow Condensed", sans-serif`;
    ctx.fillStyle = t === 'N' ? '#FFFFFF' : 'rgba(255,255,255,.8)';
    ctx.fillText(t, 0, 0);
    ctx.restore();
  }
  // Aguja
  const nl = r * 0.52, sw = r * 0.15;
  ctx.beginPath(); ctx.moveTo(0, -nl); ctx.lineTo(sw, 0); ctx.lineTo(-sw, 0); ctx.closePath();
  ctx.fillStyle = RED; ctx.fill();
  ctx.beginPath(); ctx.moveTo(0, nl); ctx.lineTo(sw, 0); ctx.lineTo(-sw, 0); ctx.closePath();
  ctx.fillStyle = '#F4F4F0'; ctx.fill();
  ctx.beginPath(); ctx.arc(0, 0, r * 0.07, 0, Math.PI * 2); ctx.fillStyle = INK; ctx.fill();
  ctx.restore();
}

// Dibuja la foto (con giro manual) y opcionalmente la marca. maxSide limita el tamaño (vista previa).
export async function renderPhoto(blob, photo, point, project, wm, { watermark = true, maxSide = 0 } = {}) {
  await ensureFonts();
  const bmp = await createImageBitmap(blob);
  const rot = norm360(photo.rotation || 0);
  let sw = bmp.width, sh = bmp.height;
  let scale = 1;
  const side = Math.max(sw, sh);
  if (maxSide && side > maxSide) scale = maxSide / side;
  const dw = Math.round(sw * scale), dh = Math.round(sh * scale);
  const swap = rot === 90 || rot === 270;
  const canvas = document.createElement('canvas');
  canvas.width = swap ? dh : dw; canvas.height = swap ? dw : dh;
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(rot * Math.PI / 180);
  ctx.drawImage(bmp, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
  bmp.close?.();
  if (watermark) drawWatermark(ctx, canvas.width, canvas.height, photoInfo(photo, point, project, wm), wm);
  return canvas;
}

export function canvasToBlob(canvas, quality = 0.9) {
  return new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
}
