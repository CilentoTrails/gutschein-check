import { BRANDS, analyze } from './brands.js';
import { startHost, startGuest, pairCodeFromUrl } from './pair.js';
import { locateBarcode, cropAligned, enhance, sharpness, findTextRow, findTextRows, cutBox } from './vision.js';

const $ = (s) => document.querySelector(s);
const els = {
  start: $('#btn-camera'),
  frame: $('.frame'),
  stage: $('#stage'),
  video: $('#video'),
  snap: $('#btn-snap'),
  stop: $('#btn-stop'),
  status: $('#status'),
  result: $('#result'),
  viewport: $('.viewport'),
  phoneStart: $('#phone-start'),
  pair: $('#pair'),
  pairQr: $('#pair-qr'),
  pairState: $('#pair-state'),
  pairNew: $('#btn-pair-new'),
  pairNote: $('#pair-note'),
};

/* ---------- Barcode (zxing-wasm + BarcodeDetector) ---------- */
const ZW = window.ZXingWASM;
ZW.prepareZXingModule({
  overrides: {
    locateFile: (path, prefix) =>
      path.endsWith('.wasm') ? new URL('./vendor/zxing/zxing_reader.wasm', location.href).href : prefix + path,
  },
  fireImmediately: true,
});
const FORMATS = ['Code128', 'ITF', 'EAN-13', 'Code39', 'DataBar', 'QRCode', 'Aztec', 'DataMatrix'];

// Eingebaute Barcode-Erkennung des Browsers (Android/Chrome, teils Safari) – oft robuster als zxing
let native = null;
if ('BarcodeDetector' in window) {
  BarcodeDetector.getSupportedFormats?.()
    .then((f) => {
      const want = ['code_128', 'itf', 'ean_13', 'code_39', 'aztec', 'qr_code', 'data_matrix'].filter((x) => f.includes(x));
      if (want.length) native = new BarcodeDetector({ formats: want });
    })
    .catch(() => {});
}
async function decodeNative(src) {
  if (!native) return null;
  try {
    const r = (await native.detect(src)).find((x) => x.rawValue);
    return r ? { text: r.rawValue.replace(/^\][A-Za-z]\d/, ''), format: r.format.replace('code_128', 'Code128'), via: 'native' } : null;
  } catch {
    return null;
  }
}

async function decodeCanvas(canvas, opts = {}) {
  const img = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
  try {
    const res = await ZW.readBarcodes(img, { tryHarder: true, formats: FORMATS, maxNumberOfSymbols: 1, ...opts });
    const r = res.find((x) => x.isValid);
    return r ? { text: r.text, format: r.format, orientation: r.orientation, position: r.position } : null;
  } catch {
    return null;
  }
}

function scaled(src, maxSide, minSide = 0) {
  const w = src.videoWidth || src.width;
  const h = src.videoHeight || src.height;
  let s = Math.min(1, maxSide / Math.max(w, h));
  if (minSide && Math.max(w, h) * s < minSide) s = minSide / Math.max(w, h);
  const c = document.createElement('canvas');
  c.width = Math.round(w * s);
  c.height = Math.round(h * s);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  c._scale = s;
  return c;
}

// Ausschnitt um den gefundenen Strich-Bereich, gerade gedreht und vergrößert
function barcodeCrop(canvas, loc, target = 1400) {
  const k = Math.max(1, Math.min(4, target / (loc.L * 1.25)));
  return cropAligned(canvas, loc, { bw: loc.L * 1.25, bh: Math.max(loc.T * 1.6, loc.L * 0.12), k });
}

// Leserichtung (Winkel, Bogenmaß) aus einem zxing-Treffer im ganzen Bild
function readingAngle(bc) {
  const p = bc.position;
  if (p?.topLeft && p?.topRight) {
    const dx = p.topRight.x - p.topLeft.x, dy = p.topRight.y - p.topLeft.y;
    if (Math.hypot(dx, dy) > 5) return Math.atan2(dy, dx);
  }
  return typeof bc.orientation === 'number' ? (bc.orientation * Math.PI) / 180 : null;
}

// Gefundenen Bereich so drehen, dass die Leserichtung stimmt (Text dann aufrecht)
function orient(loc, angle) {
  let d = angle - loc.angle;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return { ...loc, angle: Math.abs(d) > Math.PI / 2 ? loc.angle + Math.PI : loc.angle, upright: true };
}

async function findBarcode(canvas) {
  const loc = locateBarcode(canvas);
  const nat = await decodeNative(canvas);
  if (nat) return { ...nat, loc };
  // 1. ganzes Bild
  for (const side of [1600, 2400]) {
    const c = scaled(canvas, side);
    const r = await decodeCanvas(c);
    if (r) {
      const a = readingAngle(r);
      return { ...r, loc: loc && a != null ? orient(loc, a) : loc };
    }
  }
  if (!loc) return { loc: null };
  // 2. nur der Strich-Bereich, gerade gedreht, vergrößert, verschiedene Schwellwerte
  for (const target of [1400, 2200]) {
    const crop = barcodeCrop(canvas, loc, target);
    for (const [binarizer, pre] of [['LocalAverage', false], ['GlobalHistogram', true], ['LocalAverage', true], ['FixedThreshold', true]]) {
      const c = pre ? enhance(barcodeCrop(canvas, loc, target)) : crop;
      const r = (await decodeNative(c)) || (await decodeCanvas(c, { binarizer, tryDenoise: pre, tryRotate: false }));
      if (r) {
        const flip = typeof r.orientation === 'number' && Math.abs(r.orientation) > 90;
        return { ...r, loc: { ...loc, angle: loc.angle + (flip ? Math.PI : 0), upright: r.via !== 'native' } };
      }
    }
  }
  return { loc };
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
  guest?.status(msg);
}

// Ergebnis anzeigen und (wenn mit dem Rechner gekoppelt) dorthin schicken
function show(r) {
  render(r);
  if (guest) {
    pairNote('Wird an den Rechner gesendet …');
    let waited = false;
    const onWait = () => {
      if (!waited) pairNote('Wartet auf die Verbindung zum Rechner … (wird automatisch gesendet)', true);
      waited = true;
    };
    guest.result(r, onWait).then((ok) =>
      pairNote(
        ok ? 'Am Rechner angekommen ✓ – dort kopieren.' : 'Nicht am Rechner angekommen. Ist die Seite dort noch offen? Sonst QR-Code neu scannen. Die Werte stehen auch hier unten.',
        !ok
      )
    );
  }
}
const tick = () => new Promise((r) => setTimeout(r, 0));

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

// Kartenbereich rund um den Barcode, aufrecht gedreht und so vergrößert, dass die Schrift lesbar wird
function cardCrop(canvas, loc, flip) {
  const bw = loc.L * 1.9, bh = loc.L * 1.5;
  const k = Math.max(1, Math.min(4, 2000 / bw));
  return cropAligned(canvas, loc, { bw, bh, k, flip });
}

// Bekannte Druckbilder der Klartext-Nummern (Zifferngruppen)
const NUMBER_TEMPLATES = [
  [4, 4, 4, 4, 4], // ALDI/Lidl (Helaba): 20-stellige Gutscheinnummer
  [3, 7, 1, 3, 2, 2, 4, 4, 4, 2], // EDEKA: 010 4041578 6 023 09 21 0860 … (GS1)
];

// Mehrheitsentscheid je Stelle (gewichtet mit Sicherheit)
function voteDigits(cands) {
  let d = '';
  for (let i = 0; i < cands[0].d.length; i++) {
    const votes = {};
    for (const r of cands) votes[r.d[i]] = (votes[r.d[i]] || 0) + r.conf + 1;
    d += Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0];
  }
  return d;
}

// Lesungen gruppenweise nach einem Druckbild zusammenführen. Ergebnis: Text oder null
function voteTemplate(reads, tpl) {
  const sum = tpl.reduce((a, b) => a + b, 0);
  const split = (d) => { let i = 0; return tpl.map((n) => d.slice(i, (i += n))); };
  // passt die Ziffernzahl genau, nach Druckbild teilen (Tesseract verschluckt oft Leerzeichen)
  const toks = reads.map((r) => ({ conf: r.conf, t: r.d.length === sum ? split(r.d) : r.text.split(/\s+/).filter(Boolean) }));
  const out = [];
  let support = 0, confSum = 0;
  for (let i = 0; i < tpl.length; i++) {
    const cands = [];
    for (const r of toks) {
      // Position i passt, wenn die Lesung gleich viele Gruppen hat oder bis hier gleich aussieht
      const okPrefix = r.t.slice(0, i + 1).every((x, j) => x.length === tpl[j]);
      if ((r.t.length === tpl.length || okPrefix) && r.t[i]?.length === tpl[i]) cands.push({ d: r.t[i], conf: r.conf });
    }
    if (!cands.length) return null;
    support += cands.length;
    const v = voteDigits(cands);
    // Sicherheit dieser Gruppe: Anteil übereinstimmender Lesungen und deren Tesseract-Sicherheit
    const agree = cands.filter((c) => c.d === v);
    confSum += Math.min((agree.length / reads.length) * 100, agree.reduce((a, c) => a + c.conf, 0) / agree.length + 15);
    out.push(v);
  }
  return { text: out.join(' '), support: support / tpl.length, conf: confSum / tpl.length };
}

// Ziffernzeile in einem Ausschnitt finden, eng zuschneiden und mehrfach nur mit Ziffern lesen.
async function readDigitRow(crop, minChars, templates = [], box = findTextRow(crop, { minChars })) {
  if (!box) return null;
  const reads = [];
  const variants = [[36, 0, 0], [36, 0.5, 3], [48, 0, 0], [28, 0.3, 0], [44, 0.8, 0], [56, 0.4, 3]];
  for (const [h, sharpen, flat] of variants) {
    const img = enhance(cutBox(crop, box, h), sharpen, flat);
    const lines = await ocrLines(img, { tessedit_pageseg_mode: '7', tessedit_char_whitelist: '0123456789 ' });
    const text = lines.map((l) => l.text).join(' ').trim();
    const conf = lines.reduce((s, l) => s + l.conf, 0) / (lines.length || 1);
    if (text) reads.push({ text, d: text.replace(/\D/g, ''), conf });
    // kurze Felder (PIN): zwei übereinstimmende sichere Lesungen reichen
    if (minChars <= 4 && reads.length >= 2 && reads.at(-1).d === reads.at(-2).d && conf > 80) break;
  }
  if (!reads.length) return null;
  // 1. bekanntes Druckbild
  let best = null;
  for (const tpl of templates) {
    const v = voteTemplate(reads, tpl);
    if (v && (!best || v.support > best.support)) best = v;
  }
  if (best) {
    const conf = Math.min(99, best.conf);
    return { text: best.text, conf, lines: [{ text: best.text, conf, words: [] }], score: 1000 + best.support };
  }
  // 2. sonst: häufigste Länge, dann Mehrheit je Stelle
  const byLen = {};
  for (const r of reads) (byLen[r.d.length] ||= []).push(r);
  const group = Object.values(byLen).sort((a, b) => b.length - a.length || b[0].d.length - a[0].d.length)[0];
  const d = voteDigits(group);
  const ref = group.sort((a, b) => b.conf - a.conf)[0];
  let k = 0;
  const text = ref.text.replace(/\d/g, () => d[k++]);
  const conf = ref.conf * (group.length / reads.length);
  return { text, conf, lines: [{ text, conf, words: [] }], score: Math.min(d.length, box.chars + 2) * conf };
}

// Klartext-Nummer direkt unter dem Barcode (ALDI, Lidl, EDEKA, dm drucken sie dort)
async function readNumberBand(canvas, loc, flip) {
  const bh = Math.max(loc.T * 0.75, loc.L * 0.1);
  const k = Math.max(1, Math.min(6, 160 / bh));
  const crop = cropAligned(canvas, loc, { dv: loc.T / 2 + bh / 2, bw: loc.L * 1.3, bh, k, flip });
  const r = await readDigitRow(crop, 8, NUMBER_TEMPLATES);
  return r ? { lines: r.lines, score: r.score } : { lines: [], score: 0 };
}

// Wo der PIN relativ zum Barcode sitzt (L = Barcode-Länge, T = Barcode-Höhe, Text aufrecht)
const PIN_LAYOUT = {
  // ALDI (Helaba): Hologramm-Feld rechts oberhalb des Barcodes, auf Höhe der Seriennummer
  aldi: (L, T) => ({ du: L * 0.47, dv: -T / 2 - L * 0.06, bw: L * 0.4, bh: L * 0.2 }),
  // EDEKA (A1 Bank): Silberstreifen oben links über dem Text
  edeka: (L) => ({ du: -L * 0.33, dv: -L * 0.42, bw: L * 0.65, bh: L * 0.26 }),
};

async function readPinAt(canvas, loc, brand) {
  const lay = PIN_LAYOUT[brand]?.(loc.L, loc.T);
  if (!lay) return { value: '', conf: 0 };
  const k = Math.max(1, Math.min(6, 300 / lay.bh));
  const crop = cropAligned(canvas, loc, { ...lay, k });
  // mehrere Textzeilen im Bereich prüfen; PIN = Zeile aus genau 4 Ziffern (kein Fließtext)
  let best = { value: '', conf: 0 };
  for (const box of findTextRows(crop, { minChars: 3, maxRows: 4 })) {
    if (box.chars > 7) continue;
    const plain = await ocrLines(enhance(cutBox(crop, box, 36), 0, 0), { tessedit_pageseg_mode: '7' });
    if (/[a-zA-Z]{2,}/.test(plain.map((l) => l.text).join(' '))) continue; // Wörter -> kein PIN
    const r = await readDigitRow(crop, 3, [[4]], box);
    const d = r?.text.replace(/\s/g, '') || '';
    if (/^\d{4}$/.test(d) && r.conf > best.conf) best = { value: d, conf: r.conf };
  }
  // Rückfall: ganzen Bereich hintergrundbereinigt als verstreuten Text lesen
  if (!best.value || best.conf < 70) {
    for (const flat of [6, 12]) {
      const lines = await ocrLines(enhance(cropAligned(canvas, loc, { ...lay, k }), 0.3, flat), {
        tessedit_pageseg_mode: '11',
        tessedit_char_whitelist: '0123456789',
      });
      for (const w of lines.flatMap((l) => l.words)) {
        const d = w.text.replace(/\D/g, '');
        if (/^\d{4}$/.test(d) && w.conf > best.conf) best = { value: d, conf: w.conf };
      }
    }
  }
  return best;
}

function completeness(res) {
  if (!res) return -1;
  let s = res.brand ? 10 : 0;
  for (const f of res.fields) if (f.check) s += f.value ? (f.unsure ? 3 : 5) : 0;
  return s;
}
const isComplete = (res) => res.brand && res.fields.every((f) => !f.check || (f.value && !f.unsure));

// Ein Bild komplett auswerten (ohne Anzeige)
export async function analyzeFrame(source, say = status) {
  const canvas = scaled(source, 3000);
  say('Suche Barcode …');
  await tick();
  const bc = await findBarcode(canvas);
  const loc = bc.loc;
  const barcodes = bc.text ? [bc] : [];

  // Text lesen: Kartenausschnitt (wenn Barcode-Bereich bekannt), sonst ganzes Bild in 4 Richtungen
  let best = null;
  const variants = loc
    ? (loc.upright ? [false] : [false, true]).map((flip) => ({ flip, img: () => cardCrop(canvas, loc, flip) }))
    : [0, 90, 270, 180].map((deg) => ({ deg, img: () => rotate(scaled(canvas, 2400, 1800), deg) }));
  for (const [i, v] of variants.entries()) {
    say(`Lese Text … ${variants.length > 1 ? `(${i + 1}/${variants.length})` : ''}`);
    const img = v.img();
    const lines = await ocrLines(img);
    const score = textScore(lines);
    if (!best || score > best.score) best = { ...v, lines, score, upright: img };
    if (score > 120) break;
  }
  // Ausrichtung aus dem Text übernehmen, falls der Barcode sie nicht verraten hat
  let oloc = loc && !loc.upright && best.flip != null ? { ...loc, angle: loc.angle + (best.flip ? Math.PI : 0) } : loc;
  const lines = best.lines;
  const upright = best.upright;

  let numberLines = [];
  if (oloc && !barcodes.length) {
    say('Lese Nummer unter dem Barcode …');
    const flips = loc.upright ? [false] : [false, true];
    let nb = null;
    for (const flip of flips) {
      const r = await readNumberBand(canvas, oloc, flip);
      if (!nb || r.score > nb.score) nb = { ...r, flip };
    }
    numberLines = nb.lines;
    if (nb.flip) oloc = { ...oloc, angle: oloc.angle + Math.PI };
  }

  say('Prüfe Nummern …');
  let extra = [];
  let res = analyze({ barcodes, lines, numberLines });
  // Marke nicht erkannt: Kartenausschnitt noch einmal kontrastverstärkt als verstreuten Text lesen
  if (!res.brand && oloc) {
    say('Suche Markenname …');
    const img = enhance(scaled(cardCrop(canvas, oloc, false), 1400), 0.4, 8);
    const more = await ocrLines(img, { tessedit_pageseg_mode: '11' });
    lines.push(...more);
    res = analyze({ barcodes, lines, numberLines });
  }
  // PIN gezielt an der bekannten Stelle der Marke lesen (ALDI: Hologramm-Feld rechts über dem Barcode)
  if (PIN_LAYOUT[res.brand] && oloc) {
    say('Lese PIN …');
    const p = await readPinAt(canvas, oloc, res.brand);
    const pf = res.fields.find((f) => f.key === 'pin');
    if (p.value && pf) {
      pf.value = p.value;
      pf.unsure = p.conf < 85;
      pf.done = true;
    }
  }
  if (res.fields.some((f) => f.key === 'pin' && !f.value)) {
    extra = await digitPass(upright);
    res = analyze({ barcodes, lines, digitLines: extra, numberLines });
  }
  const pinField = res.fields.find((f) => f.key === 'pin' && f.value && !f.done);
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
  return { res, lines, barcodes, numberLines, located: !!loc };
}

// Ergebnisse mehrerer Bilder zusammenführen: pro Feld der sicherste Wert
function merge(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.res.brand !== b.res.brand) return completeness(b.res) > completeness(a.res) ? b : a;
  const rank = (f) => (f.value ? (f.unsure ? 1 : 2) : 0);
  const fields = a.res.fields.map((f) => {
    const g = b.res.fields.find((x) => x.key === f.key);
    // zwei Bilder lesen unabhängig voneinander dasselbe -> sicher
    if (g && f.value && f.value === g.value && (f.unsure || g.unsure)) return { ...f, unsure: false, agreed: true };
    return g && rank(g) > rank(f) ? g : f;
  });
  for (const g of b.res.fields) if (!fields.some((f) => f.key === g.key)) fields.push(g);
  return {
    ...a,
    res: { ...a.res, fields },
    barcodes: a.barcodes.length ? a.barcodes : b.barcodes,
    lines: a.lines.length >= b.lines.length ? a.lines : b.lines,
    numberLines: a.numberLines.length ? a.numberLines : b.numberLines,
  };
}

export async function processImage(source) {
  els.result.hidden = true;
  const r = await analyzeFrame(source);
  status('');
  show(r);
  return r.res;
}

// lange Ziffernfolgen in Vierergruppen anzeigen (Kopieren nimmt die Leerzeichen wieder raus)
const groupDigits = (v) => (/^\d{9,}$/.test(v) ? v.replace(/(\d{4})(?=\d)/g, '$1 ') : v);
function fitHeight(t) {
  t.style.height = 'auto';
  t.style.height = t.scrollHeight + 2 + 'px';
}

function render({ res, lines, barcodes, numberLines = [], located }, { fromPhone = false } = {}) {
  const b = res.brand && Object.hasOwn(BRANDS, res.brand) ? BRANDS[res.brand] : null;
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
    const cap = document.createElement('span');
    cap.append(f.label);
    if (f.check) cap.append(' ', Object.assign(document.createElement('em'), { textContent: 'für Prüfseite' }));
    if (f.unsure) cap.append(' ', Object.assign(document.createElement('strong'), { className: 'warn-badge', textContent: '⚠ Bitte mit Karte vergleichen' }));
    row.append(cap);
    const wrap = document.createElement('div');
    // mehrzeiliges Feld: lange Nummern brechen um statt abgeschnitten zu werden
    const inp = document.createElement('textarea');
    inp.rows = 1;
    inp.value = groupDigits(f.value);
    inp.placeholder = 'nicht erkannt – bitte eintragen';
    inp.autocomplete = 'off';
    inp.spellcheck = false;
    inp.inputMode = /^\d*$/.test(f.value) ? 'numeric' : 'text';
    inp.dataset.key = f.key;
    inp.onkeydown = (e) => { if (e.key === 'Enter') e.preventDefault(); };
    inp.oninput = () => fitHeight(inp);
    requestAnimationFrame(() => fitHeight(inp));
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
    // wo steht das Feld auf der Karte? (hilft beim Vergleichen/Nachtragen)
    const where = b?.where?.[f.key];
    if (where && (!f.value || f.unsure)) {
      const h = document.createElement('small');
      h.className = 'where';
      h.textContent = where;
      row.append(h);
    }
    r.append(row);
  }

  if (b && !guest) {
    const a = document.createElement('a');
    a.className = 'cta';
    a.href = b.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = `Guthaben bei ${b.name} prüfen ↗`;
    r.append(a);
  } else if (!b) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Tipp: Karte näher an die Kamera halten, bis sie den Rahmen fast füllt. Gutes Licht, keine Spiegelung, kurz ruhig halten.';
    r.append(p);
  }

  if (fromPhone) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Vom Handy empfangen. Nächste Karte einfach am Handy scannen.';
    r.append(p);
  } else {
    // Handy: Knopf für die nächste Karte bleibt unten am Bildschirm sichtbar
    const bar = document.createElement('div');
    bar.className = 'actions bar';
    const again = document.createElement('button');
    again.textContent = 'Nächste Karte';
    again.onclick = () => { r.hidden = true; startCamera(); };
    bar.append(again);
    r.append(bar);
    els.phoneStart.hidden = true; // Knöpfe oben nicht doppelt zeigen
  }

  const dbg = document.createElement('details');
  dbg.innerHTML = '<summary>Erkannter Rohtext</summary>';
  const pre = document.createElement('pre');
  pre.textContent =
    (barcodes.length ? barcodes.map((x) => `[${x.format}] ${x.text}`).join('\n') + '\n\n' : `[kein Barcode lesbar${located ? ', Bereich gefunden' : ''}]\n\n`) +
    (numberLines.length ? '[Nummer unter dem Barcode] ' + numberLines.map((l) => l.text).join(' ') + '\n\n' : '') +
    lines.map((l) => l.text).join('\n');
  dbg.append(pre);
  if (fromPhone || !guest) r.append(dbg);
  else r.insertBefore(dbg, r.lastChild); // Rohtext über dem Knopf
  if (guest) window.scrollTo({ top: 0, behavior: 'smooth' });
  else r.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------- Kamera ---------- */
// Ablauf: laufend nach einem Barcode suchen und die letzten Bilder merken.
// Bei einem Treffer kurz weitersammeln, das schärfste Bild auswerten. Fehlt danach noch etwas,
// weitere Bilder auswerten (Kamera läuft weiter) und die Ergebnisse zusammenführen.
let stream = null;
let session = 0;
const MAX_TRIES = 3;

async function startCamera() {
  stopCamera();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 3840 }, height: { ideal: 2160 } },
      audio: false,
    });
  } catch (e) {
    status('Kamera nicht verfügbar. Bitte den Zugriff auf die Kamera erlauben und neu laden. (' + e.name + ')');
    return;
  }
  const track = stream.getVideoTracks()[0];
  track.applyConstraints?.({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
  els.video.srcObject = stream;
  await els.video.play();
  // Vorschau im Seitenverhältnis der Kamera, aber höchstens ~55 % der Bildschirmhöhe,
  // damit der Auslöse-Knopf ohne Scrollen sichtbar bleibt
  els.viewport.style.setProperty('--ar', String(els.video.videoWidth / els.video.videoHeight || 16 / 9));
  els.phoneStart.hidden = true;
  els.stage.hidden = false;
  els.result.hidden = true;
  els.stage.scrollIntoView({ block: 'start' });
  status('Karte mit der Rückseite (Barcode) in den Rahmen halten, möglichst nah und ruhig …');
  ocrWorker(); // OCR schon mal im Hintergrund laden
  scanLoop(++session);
}

function stopCamera() {
  session++;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  els.stage.hidden = true;
  els.phoneStart.hidden = false;
}

// Rahmen-Ausschnitt: genau der Bereich, den der Rahmen (.frame) in der Vorschau zeigt.
// Die Vorschau zeigt mit object-fit: cover nur einen Ausschnitt des Kamerabilds.
function frameCrop(video, maxSide) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const vr = video.getBoundingClientRect(), fr = els.frame.getBoundingClientRect();
  let x = 0, y = 0, cw = vw, ch = vh;
  if (vr.width && fr.width) {
    const k = Math.max(vr.width / vw, vr.height / vh); // Bildschirm-px pro Kamera-px
    const ox = (vr.width - vw * k) / 2, oy = (vr.height - vh * k) / 2; // Versatz (negativ = abgeschnitten)
    x = Math.max(0, (fr.left - vr.left - ox) / k);
    y = Math.max(0, (fr.top - vr.top - oy) / k);
    cw = Math.min(vw - x, fr.width / k);
    ch = Math.min(vh - y, fr.height / k);
  }
  const s = Math.min(1, maxSide / Math.max(cw, ch));
  const c = document.createElement('canvas');
  c.width = Math.round(cw * s);
  c.height = Math.round(ch * s);
  c.getContext('2d', { willReadFrequently: true }).drawImage(video, x, y, cw, ch, 0, 0, c.width, c.height);
  return c;
}

let manual = false;
async function scanLoop(id) {
  const alive = () => id === session && stream;
  const frames = []; // letzte Bilder mit Schärfe
  let best = null;
  let tries = 0;
  let firstHit = 0;
  let regionSince = 0;
  let lastAnalysis = 0;
  const t0 = Date.now();
  let n = 0;
  manual = false;
  while (alive()) {
    await new Promise((r) => setTimeout(r, 120));
    if (!alive() || !els.video.videoWidth) continue;
    n++;
    const frame = scaled(els.video, 3000);
    frames.push({ frame, sharp: sharpness(frame) });
    if (frames.length > 6) frames.shift();

    // schnelle Barcode-Suche im Rahmen; jedes zweite Mal im gefundenen Strich-Bereich
    let hit = await decodeNative(frameCrop(els.video, 1600));
    if (!hit && n % 2) hit = await decodeCanvas(frameCrop(els.video, 1400), { tryDownscale: false });
    if (!hit && !(n % 2)) {
      const roi = frameCrop(els.video, 2400);
      const loc = locateBarcode(roi);
      if (loc) {
        hit = await decodeCanvas(barcodeCrop(roi, loc, 1400), { tryRotate: false });
        // Barcode-Bereich sichtbar, aber (noch) nicht lesbar: Größe prüfen
        const rel = loc.L / Math.max(roi.width, roi.height);
        if (!hit && !firstHit && !regionSince && rel > 0.12) {
          regionSince = Date.now();
          status(rel < 0.3 ? 'Karte erkannt – bitte näher an die Kamera, bis sie den Rahmen fast füllt …' : 'Karte erkannt – kurz ruhig halten …');
        }
      }
    }
    if (hit && !firstHit) {
      firstHit = Date.now();
      navigator.vibrate?.(40);
      status('Barcode gefunden – Karte noch kurz ruhig halten …');
    }
    const now = Date.now();
    const due =
      manual ||
      (firstHit && now - firstHit > 700 && frames.length >= 4) || // nach Treffer kurz weitersammeln
      (!firstHit && regionSince && now - regionSince > 1800 && now - lastAnalysis > 4000) || // Bereich da, Barcode unlesbar: Klartext lesen
      (!firstHit && now - t0 > 7000 && now - lastAnalysis > 5000); // gar nichts gefunden: trotzdem Text versuchen
    if (!firstHit && !regionSince && !manual && now - t0 > 3500 && now - lastAnalysis > 5000)
      status('Noch keine Karte erkannt – Rückseite mit Barcode nah an die Kamera halten. Gutes Licht, keine Spiegelung.');
    if (!due) continue;

    // schärfstes der letzten Bilder auswerten
    const pick = frames.reduce((a, b) => (b.sharp > a.sharp ? b : a));
    frames.length = 0;
    tries++;
    lastAnalysis = now;
    const r = await analyzeFrame(pick.frame, (m) => alive() && status(`${m} ${tries > 1 ? `· Versuch ${tries}/${MAX_TRIES}` : ''}`));
    if (!alive()) return;
    best = merge(best, r);
    if (manual || isComplete(best.res) || tries >= MAX_TRIES || (firstHit && now - firstHit > 15000)) break;
    firstHit = r.barcodes.length ? Date.now() - 300 : 0;
    regionSince = r.located && !firstHit ? Date.now() : 0;
    status(`Noch nicht alles sicher erkannt – Karte ruhig halten, ich schaue noch einmal hin …`);
  }
  if (!best || id !== session) return;
  navigator.vibrate?.(80);
  stopCamera();
  status('');
  show(best);
}

els.start.onclick = startCamera;
els.snap.onclick = () => { manual = true; status('Lese aus …'); };
els.stop.onclick = () => { stopCamera(); status(''); };

/* ---------- Handy als Kamera ---------- */
let guest = null; // gesetzt, wenn diese Seite das Handy ist
let host = null; // gesetzt, wenn diese Seite der Rechner ist

function pairNote(text, warn = false) {
  els.pairNote.textContent = text;
  els.pairNote.classList.toggle('warn', warn);
  els.pairNote.hidden = !text;
}

// Rechner: QR-Code zeigen und auf das Handy warten
function startPairing() {
  host?.stop();
  els.pairQr.innerHTML = '';
  els.pairQr.hidden = true;
  els.pairState.textContent = 'Verbindung wird vorbereitet …';
  host = startHost({
    onState: (state, info) => {
      if (state === 'waiting') {
        const qr = qrcode(0, 'M');
        qr.addData(info);
        qr.make();
        els.pairQr.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 3, scalable: true });
        els.pairQr.hidden = false;
        els.pairState.textContent = 'QR-Code mit der Handykamera scannen und den Link öffnen.';
      } else if (state === 'connected') {
        els.pairQr.hidden = true;
        els.pairState.textContent = 'Handy verbunden ✓ Karte jetzt am Handy scannen. Nummer und PIN erscheinen hier.';
      } else if (state === 'idle') {
        els.pairState.textContent = 'Handy gerade nicht erreichbar (Bildschirm gesperrt?). Es verbindet sich automatisch wieder, sobald die Seite am Handy offen ist.';
      } else if (state === 'disconnected') {
        els.pairQr.hidden = false;
        els.pairState.textContent = 'Handy getrennt. Es verbindet sich automatisch wieder, solange die Seite am Handy offen ist. Sonst den QR-Code noch einmal scannen.';
      } else if (state === 'error') {
        els.pairState.textContent = info;
      }
    },
    onStatus: (text) => {
      els.status.textContent = text ? 'Handy: ' + text : '';
      els.status.hidden = !text;
    },
    onResult: (r) => {
      els.status.hidden = true;
      render(r, { fromPhone: true });
    },
  });
}

// Rechner (Seite ohne Kopplungs-Code): sofort QR-Code zeigen.
// Handy (über den QR-Link geöffnet): Karte scannen und Ergebnis an den Rechner schicken.
const pairCode = pairCodeFromUrl();
document.body.classList.add(pairCode ? 'mode-phone' : 'mode-desk');
els.pairNew.onclick = startPairing;
if (!pairCode) startPairing();
else {
  pairNote('Verbinde mit dem Rechner …');
  guest = startGuest(pairCode, {
    onState: (state, info) => {
      if (state === 'connected') pairNote('Mit dem Rechner verbunden ✓ Karte scannen – das Ergebnis erscheint auch am Rechner.');
      else if (state === 'reconnecting') pairNote('Verbindung zum Rechner unterbrochen – verbinde neu …', true);
      else if (state === 'waiting-host') pairNote('Rechner gerade nicht erreichbar – versuche weiter … (Ist die Seite dort noch offen?)', true);
      else if (state === 'error') pairNote(info, true);
    },
  });
}

// Handy: Bildschirm wach halten, solange die Seite offen ist und benutzt wird (Screen Wake Lock).
// Sonst sperrt sich das Handy beim Liegenlassen, und der Browser trennt die Verbindung.
// Nach 10 Minuten ohne Bedienung wieder freigeben (Akku).
if (pairCode && 'wakeLock' in navigator) {
  let lock = null;
  let lastUse = Date.now();
  const want = () => document.visibilityState === 'visible' && Date.now() - lastUse < 10 * 60 * 1000;
  const acquire = async () => {
    if (lock || !want()) return;
    try {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { lock = null; });
    } catch {} // z. B. Energiesparmodus: dann eben ohne
  };
  const used = () => { lastUse = Date.now(); acquire(); };
  ['pointerdown', 'keydown'].forEach((e) => document.addEventListener(e, used, { passive: true }));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') used(); });
  setInterval(() => { if (lock && !want()) lock.release().catch(() => {}); }, 30000);
  acquire();
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
