import { BRANDS, analyze } from './brands.js';

const $ = (s) => document.querySelector(s);
const els = {
  start: $('#btn-camera'),
  file: $('#file'),
  stage: $('#stage'),
  video: $('#video'),
  snap: $('#btn-snap'),
  stop: $('#btn-stop'),
  status: $('#status'),
  result: $('#result'),
};

/* ---------- Barcode (zxing-wasm) ---------- */
const ZW = window.ZXingWASM;
ZW.prepareZXingModule({
  overrides: {
    locateFile: (path, prefix) =>
      path.endsWith('.wasm') ? new URL('./vendor/zxing/zxing_reader.wasm', location.href).href : prefix + path,
  },
  fireImmediately: true,
});
const FORMATS = ['Code128', 'ITF', 'EAN-13', 'Code39', 'DataBar', 'QRCode', 'Aztec', 'DataMatrix'];

async function decodeCanvas(canvas, tryHarder = true) {
  const img = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
  try {
    const res = await ZW.readBarcodes(img, { tryHarder, formats: FORMATS, maxNumberOfSymbols: 1 });
    const r = res.find((x) => x.isValid);
    return r ? { text: r.text, format: r.format, orientation: r.orientation } : null;
  } catch {
    return null;
  }
}

function scaled(src, maxSide) {
  const w = src.videoWidth || src.width;
  const h = src.videoHeight || src.height;
  const s = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * s);
  c.height = Math.round(h * s);
  c.getContext('2d', { willReadFrequently: true }).drawImage(src, 0, 0, c.width, c.height);
  c._scale = s;
  return c;
}

async function findBarcode(canvas) {
  for (const side of [1600, 2400, 1000]) {
    const r = await decodeCanvas(scaled(canvas, side));
    if (r) return r;
  }
  return null;
}

// Lage des Barcodes -> um wie viel Grad das Bild für die Texterkennung gedreht wird
function uprightRotation(bc) {
  if (!bc || typeof bc.orientation !== 'number') return null;
  return ((Math.round(-bc.orientation / 90) * 90) % 360 + 360) % 360;
}

function rotate(src, deg) {
  if (!deg) return src;
  const c = document.createElement('canvas');
  const swap = deg % 180 !== 0;
  c.width = swap ? src.height : src.width;
  c.height = swap ? src.width : src.height;
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

/* ---------- OCR (Tesseract) ---------- */
let workerP = null;
function ocrWorker() {
  if (!workerP) {
    const base = new URL('./vendor/', location.href).href;
    workerP = Tesseract.createWorker('eng', 1, {
      workerPath: base + 'tesseract/worker.min.js',
      corePath: base + 'tesseract-core/',
      langPath: base + 'lang',
      gzip: true,
    });
  }
  return workerP;
}

async function ocrLines(canvas, params) {
  const w = await ocrWorker();
  if (params) await w.setParameters(params);
  try {
    const { data } = await w.recognize(canvas, {}, { blocks: true, text: true });
    const lines = [];
    for (const b of data.blocks || [])
      for (const p of b.paragraphs)
        for (const l of p.lines)
          lines.push({
            text: l.text.trim(),
            conf: l.confidence,
            words: l.words.map((x) => ({ text: x.text, conf: x.confidence, bbox: x.bbox })),
          });
    return lines.filter((l) => l.text);
  } finally {
    if (params) await w.setParameters({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: '' });
  }
}

// Wort-Ausschnitt vergrößern; mode 'stretch' = Kontrast strecken, 'otsu' = schwarz/weiß
function cropWord(src, bb, mode, targetH = 100) {
  const h = bb.y1 - bb.y0;
  const pad = h * 0.35;
  const x0 = Math.max(0, bb.x0 - pad), y0 = Math.max(0, bb.y0 - pad);
  const w = Math.min(src.width - x0, bb.x1 - bb.x0 + 2 * pad);
  const hh = Math.min(src.height - y0, h + 2 * pad);
  const k = Math.max(1, Math.min(5, targetH / hh));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k);
  c.height = Math.round(hh * k);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, x0, y0, w, hh, 0, 0, c.width, c.height);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const g = new Float32Array(d.length / 4);
  let mn = 255, mx = 0;
  for (let i = 0; i < g.length; i++) {
    g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    if (g[i] < mn) mn = g[i];
    if (g[i] > mx) mx = g[i];
  }
  const span = mx - mn || 1;
  let thr = 128;
  if (mode === 'otsu') {
    const hist = new Array(256).fill(0);
    for (const v of g) hist[Math.round(((v - mn) / span) * 255)]++;
    let sum = 0, sB = 0, wB = 0, best = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = g.length - wB;
      if (!wF) break;
      sB += t * hist[t];
      const v = wB * wF * (sB / wB - (sum - sB) / wF) ** 2;
      if (v > best) { best = v; thr = t; }
    }
  }
  for (let i = 0; i < g.length; i++) {
    let v = ((g[i] - mn) / span) * 255;
    if (mode === 'otsu') v = v > thr ? 255 : 0;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// PIN/Code noch einmal einzeln, vergrößert und nur mit Ziffern lesen
// (Hologramm-Hintergründe führen sonst zu Fehlern wie 9956 statt 9959)
async function rereadPin(canvas, allLines, pin) {
  const words = allLines.flatMap((l) => l.words || []);
  const word = words.find((x) => x.text.replace(/\D/g, '') === pin) ||
    words.find((x) => x.text.replace(/\D/g, '').includes(pin));
  if (!word) return { value: pin, conf: 0 };
  let best = { value: pin, conf: word.conf };
  for (const mode of ['stretch', 'otsu']) {
    const r = await ocrLines(cropWord(canvas, word.bbox, mode), {
      tessedit_pageseg_mode: '8',
      tessedit_char_whitelist: '0123456789',
    });
    const t = r.map((x) => x.text).join('').replace(/\D/g, '');
    const conf = r[0]?.conf || 0;
    if (/^\d{4}$/.test(t) && conf > best.conf) best = { value: t, conf };
  }
  return best;
}

// Zusatzdurchgang nur für Ziffern (für PINs ohne Beschriftung, z. B. auf Hologrammen)
function digitPass(canvas) {
  return ocrLines(canvas, { tessedit_pageseg_mode: '11', tessedit_char_whitelist: '0123456789' });
}

const KEYWORDS = /kartennummer|code|pin|seriennr|geschenk|guthaben|karte|lidl|rewe|edeka|aldi|helaba|drogerie|ktrl/gi;
function textScore(lines) {
  const t = lines.map((l) => l.text).join(' ');
  const kw = (t.match(KEYWORDS) || []).length;
  const conf = lines.reduce((s, l) => s + l.conf, 0) / (lines.length || 1);
  return kw * 10 + conf;
}

/* ---------- Ablauf ---------- */
function status(msg) {
  els.status.textContent = msg || '';
  els.status.hidden = !msg;
}

export async function processImage(source) {
  els.result.hidden = true;
  const canvas = scaled(source, 2200);

  status('Suche Barcode …');
  await new Promise((r) => setTimeout(r, 30));
  const bc = await findBarcode(canvas);
  const barcodes = bc ? [bc] : [];

  const fixed = uprightRotation(bc);
  const tries = fixed != null ? [fixed] : [0, 90, 270, 180];
  let best = null;
  for (const [i, deg] of tries.entries()) {
    status(`Lese Text … ${tries.length > 1 ? `(${i + 1}/${tries.length})` : ''}`);
    const lines = await ocrLines(rotate(canvas, deg));
    const score = textScore(lines);
    if (!best || score > best.score) best = { lines, score, deg };
    if (score > 120) break; // eindeutig lesbar
  }
  status('Prüfe Nummern …');
  const upright = rotate(canvas, best.deg);
  const lines = best.lines;
  let extra = [];
  let res = analyze({ barcodes, lines });
  if (res.fields.some((f) => f.key === 'pin' && !f.value)) {
    extra = await digitPass(upright);
    res = analyze({ barcodes, lines, digitLines: extra });
  }
  const pinField = res.fields.find((f) => f.key === 'pin' && f.value);
  if (pinField) {
    const r = await rereadPin(upright, [...lines, ...extra], pinField.value);
    pinField.value = r.value;
    pinField.unsure = r.conf < 85;
  }
  // unsichere OCR-Felder markieren (Barcode-Werte sind exakt)
  const words = lines.flatMap((l) => l.words || []);
  for (const f of res.fields) {
    if (f.key !== 'card' || res.brand !== 'dm' || !f.value) continue;
    const parts = [f.value.slice(0, 4), f.value.slice(4)];
    f.unsure = parts.some((p) => (words.find((w) => w.text.toUpperCase().includes(p))?.conf ?? 0) < 85);
  }
  status('');
  render(res, lines, barcodes);
  return res;
}

function render(res, lines, barcodes) {
  const b = res.brand ? BRANDS[res.brand] : null;
  const r = els.result;
  r.innerHTML = '';
  r.hidden = false;

  const head = document.createElement('div');
  head.className = 'brand';
  head.style.setProperty('--brand', b ? b.color : '#666');
  head.textContent = b ? b.name : 'Marke nicht erkannt';
  r.append(head);

  for (const f of res.fields) {
    const row = document.createElement('label');
    row.className = 'field' + (f.check ? ' check' : '');
    row.innerHTML = `<span>${f.label}${f.check ? ' <em>für Prüfseite</em>' : ''}${f.unsure ? ' <strong>bitte mit Karte vergleichen</strong>' : ''}</span>`;
    const wrap = document.createElement('div');
    const inp = document.createElement('input');
    inp.value = f.value;
    inp.placeholder = 'nicht erkannt – bitte eintragen';
    inp.autocomplete = 'off';
    inp.spellcheck = false;
    inp.dataset.key = f.key;
    if (!f.value) row.classList.add('missing');
    else if (f.unsure) row.classList.add('unsure');
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Kopieren';
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(inp.value.replace(/\s/g, ''));
        copy.textContent = 'Kopiert ✓';
        setTimeout(() => (copy.textContent = 'Kopieren'), 1500);
      } catch { inp.select(); }
    };
    wrap.append(inp, copy);
    row.append(wrap);
    r.append(row);
  }

  if (b) {
    const a = document.createElement('a');
    a.className = 'cta';
    a.href = b.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = `Guthaben bei ${b.name} prüfen ↗`;
    r.append(a);
  } else {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Tipp: Karte flach, gut beleuchtet und formatfüllend halten. Barcode und Text sollten scharf sein.';
    r.append(p);
  }

  const again = document.createElement('button');
  again.className = 'secondary';
  again.textContent = 'Nächste Karte scannen';
  again.onclick = () => { r.hidden = true; startCamera(); };
  r.append(again);

  const dbg = document.createElement('details');
  dbg.innerHTML = '<summary>Erkannter Rohtext</summary>';
  const pre = document.createElement('pre');
  pre.textContent =
    (barcodes.length ? barcodes.map((x) => `[${x.format}] ${x.text}`).join('\n') + '\n\n' : '[kein Barcode]\n\n') +
    lines.map((l) => l.text).join('\n');
  dbg.append(pre);
  r.append(dbg);
  r.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------- Kamera ---------- */
let stream = null;
let loop = null;

async function startCamera() {
  stopCamera();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
  } catch (e) {
    status('Kamera nicht verfügbar. Nutze „Foto wählen“. (' + e.name + ')');
    return;
  }
  const track = stream.getVideoTracks()[0];
  track.applyConstraints?.({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
  els.video.srcObject = stream;
  await els.video.play();
  els.stage.hidden = false;
  els.result.hidden = true;
  status('Karte mit der Rückseite (Barcode) ins Bild halten …');
  ocrWorker(); // OCR schon mal im Hintergrund laden

  let busy = false;
  loop = setInterval(async () => {
    if (busy || !stream || !els.video.videoWidth) return;
    busy = true;
    const bc = await decodeCanvas(scaled(els.video, 1600));
    busy = false;
    if (bc && stream) capture();
  }, 250);
}

function stopCamera() {
  clearInterval(loop);
  loop = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  els.stage.hidden = true;
}

async function capture() {
  if (!stream) return;
  const frame = scaled(els.video, 4000);
  navigator.vibrate?.(80);
  stopCamera();
  await processImage(frame);
}

els.start.onclick = startCamera;
els.snap.onclick = capture;
els.stop.onclick = () => { stopCamera(); status(''); };
els.file.onchange = async () => {
  const file = els.file.files[0];
  if (!file) return;
  stopCamera();
  const img = await createImageBitmap(file, { imageOrientation: 'from-image' });
  els.file.value = '';
  await processImage(img);
};

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
