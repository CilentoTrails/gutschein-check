// Bildanalyse ohne Bibliotheken: Barcode-Bereich finden, Ausschnitte drehen/vergrößern, Schärfe messen.

function gray(src, maxSide) {
  const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height;
  const s = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * s)), h = Math.max(1, Math.round(sh * s));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  return { g, w, h, s };
}

// Box-Blur (separabel, O(n))
function boxBlur(a, w, h, r) {
  const t = new Float32Array(a.length), o = new Float32Array(a.length);
  for (let y = 0; y < h; y++) {
    let acc = 0;
    const row = y * w;
    for (let x = -r; x <= r; x++) acc += a[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      t[row + x] = acc / (2 * r + 1);
      acc += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += t[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      o[y * w + x] = acc / (2 * r + 1);
      acc += t[Math.min(h - 1, y + r + 1) * w + x] - t[Math.max(0, y - r) * w + x];
    }
  }
  return o;
}

// Sucht den Bereich mit dichten parallelen Strichen (Strukturtensor).
// Ergebnis in Koordinaten von src: Mitte, Länge L (quer zu den Strichen), Höhe T, Winkel der Leserichtung.
export function locateBarcode(src, maxSide = 720) {
  const { g, w, h, s } = gray(src, maxSide);
  const n = w * h;
  // Kantenrichtungen als Einheitsvektoren (doppelter Winkel): Kontrast zählt nicht, nur wie viele
  // Kanten in der Umgebung parallel liegen. Barcode = sehr viele parallele Kanten, Text/Rauschen
  // heben sich auf, eine einzelne kräftige Linie ist zu dünn.
  const c2 = new Float32Array(n), s2 = new Float32Array(n), jxx = new Float32Array(n), jyy = new Float32Array(n), jxy = new Float32Array(n);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1];
      const gy = g[i + w - 1] + 2 * g[i + w] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - w] - g[i - w + 1];
      const m2 = gx * gx + gy * gy;
      if (m2 < 24 * 24) continue;
      c2[i] = (gx * gx - gy * gy) / m2;
      s2[i] = (2 * gx * gy) / m2;
      jxx[i] = gx * gx; jyy[i] = gy * gy; jxy[i] = gx * gy;
    }
  const r = Math.max(3, Math.round(Math.max(w, h) / 90));
  const bc2 = boxBlur(c2, w, h, r), bs2 = boxBlur(s2, w, h, r);
  const bxx = boxBlur(jxx, w, h, r), byy = boxBlur(jyy, w, h, r), bxy = boxBlur(jxy, w, h, r);
  const m = new Float32Array(n);
  let mx = 0;
  for (let i = 0; i < n; i++) {
    m[i] = Math.sqrt(bc2[i] * bc2[i] + bs2[i] * bs2[i]); // Anteil paralleler Kanten im Fenster (0..1)
    if (m[i] > mx) mx = m[i];
  }
  if (mx < 0.3) return null;
  const thr = Math.max(0.22, mx * 0.45);
  // Zusammenhängende Bereiche, der mit der größten Summe gewinnt
  const lab = new Int32Array(n);
  const stack = [];
  let best = null;
  let id = 0;
  for (let i = 0; i < n; i++) {
    if (lab[i] || m[i] < thr) continue;
    id++;
    let sum = 0, cnt = 0, sxx = 0, syy = 0, sxy = 0;
    const px = [];
    stack.push(i); lab[i] = id;
    while (stack.length) {
      const k = stack.pop();
      sum += m[k]; cnt++;
      sxx += bxx[k]; syy += byy[k]; sxy += bxy[k];
      px.push(k);
      const x = k % w, y = (k - x) / w;
      if (x > 0 && !lab[k - 1] && m[k - 1] >= thr) { lab[k - 1] = id; stack.push(k - 1); }
      if (x < w - 1 && !lab[k + 1] && m[k + 1] >= thr) { lab[k + 1] = id; stack.push(k + 1); }
      if (y > 0 && !lab[k - w] && m[k - w] >= thr) { lab[k - w] = id; stack.push(k - w); }
      if (y < h - 1 && !lab[k + w] && m[k + w] >= thr) { lab[k + w] = id; stack.push(k + w); }
    }
    if (cnt < 30) continue;
    // Gradientenrichtung = Leserichtung des Barcodes (quer zu den Strichen)
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const ux = Math.cos(ang), uy = Math.sin(ang);
    const us = [], vs = [];
    let cx = 0, cy = 0;
    for (const k of px) { cx += k % w; cy += Math.floor(k / w); }
    cx /= cnt; cy /= cnt;
    for (const k of px) {
      const dx = (k % w) - cx, dy = Math.floor(k / w) - cy;
      us.push(dx * ux + dy * uy); vs.push(-dx * uy + dy * ux);
    }
    us.sort((a, b) => a - b); vs.sort((a, b) => a - b);
    const q = (a, p) => a[Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))))];
    const u0 = q(us, 0.01), u1 = q(us, 0.99), v0 = q(vs, 0.01), v1 = q(vs, 0.99);
    const L = Math.max(1, u1 - u0 - r), T = Math.max(1, v1 - v0 - r);
    // Barcodes sind deutlich breiter als hoch
    if (L < T * 1.2 || L < 25) continue;
    const score = sum * Math.min(1, L / (3 * T));
    if (!best || score > best.score) {
      const mu = (u0 + u1) / 2, mv = (v0 + v1) / 2;
      best = {
        score,
        cx: (cx + mu * ux - mv * uy) / s,
        cy: (cy + mu * uy + mv * ux) / s,
        L: L / s, T: T / s, angle: ang,
      };
    }
  }
  return best && refineLoc(src, best);
}

// Ausschnitt entlang des Barcodes: (du, dv) = Versatz der Mitte in Barcode-Koordinaten,
// bw × bh = Größe, alles in Pixeln von src. k = Vergrößerung.
export function cropAligned(src, loc, { du = 0, dv = 0, bw, bh, k = 1, flip = false }) {
  const a = loc.angle + (flip ? Math.PI : 0);
  const ux = Math.cos(a), uy = Math.sin(a);
  const cx = loc.cx + du * ux - dv * uy, cy = loc.cy + du * uy + dv * ux;
  const c = document.createElement('canvas');
  c.width = Math.max(8, Math.round(bw * k));
  c.height = Math.max(8, Math.round(bh * k));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(c.width / 2, c.height / 2);
  ctx.scale(k, k);
  ctx.rotate(-a);
  ctx.translate(-cx, -cy);
  ctx.drawImage(src, 0, 0);
  return c;
}

// Graustufen + Kontrast strecken (Perzentile) + leichtes Nachschärfen
// flatten: Hintergrund ausgleichen (dunkle Ziffern auf grauem Feld/Hologramm), sonst wird
// das ganze Feld beim Schwarz/Weiß-Schwellwert schwarz und die Ziffern verschwinden.
export function enhance(c, sharpen = 0.6, flatten = false) {
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data, w = c.width, h = c.height;
  let g = new Float32Array(w * h);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  if (flatten) {
    const r = Math.max(4, Math.round(Math.min(w, h) / (typeof flatten === 'number' ? flatten : 5)));
    const bg = boxBlur(g, w, h, r);
    for (let i = 0; i < g.length; i++) g[i] = 128 + g[i] - bg[i];
  }
  let out = g;
  if (sharpen) {
    const b = boxBlur(g, w, h, Math.max(1, Math.round(Math.min(w, h) / 120)));
    out = new Float32Array(g.length);
    for (let i = 0; i < g.length; i++) out[i] = g[i] + sharpen * (g[i] - b[i]);
  }
  const hist = new Uint32Array(256);
  for (const v of out) hist[Math.max(0, Math.min(255, Math.round(v)))]++;
  let lo = 0, hi = 255, acc = 0;
  for (; lo < 255 && (acc += hist[lo]) < out.length * 0.01; lo++);
  acc = 0;
  for (; hi > 0 && (acc += hist[hi]) < out.length * 0.01; hi--);
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < out.length; i++) {
    const v = Math.max(0, Math.min(255, ((out[i] - lo) / span) * 255));
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// Schärfe (Varianz des Laplace-Filters) im mittleren Bildbereich
export function sharpness(src, maxSide = 480) {
  const { g, w, h } = gray(src, maxSide);
  let sum = 0, sq = 0, cnt = 0;
  for (let y = Math.round(h * 0.15); y < h * 0.85; y++)
    for (let x = Math.round(w * 0.1); x < w * 0.9; x++) {
      const i = y * w + x;
      const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
      sum += l; sq += l * l; cnt++;
    }
  const mean = sum / cnt;
  return sq / cnt - mean * mean;
}

// Lage verfeinern: im gerade gedrehten Ausschnitt Zeilen/Spalten mit vielen senkrechten Kanten suchen
export function refineLoc(src, loc) {
  const bw = loc.L * 1.3, bh = Math.max(loc.T * 4, loc.L * 0.6);
  const k = Math.min(4, 700 / bw);
  const c = cropAligned(src, loc, { bw, bh, k });
  const w = c.width, h = c.height;
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0; i < g.length; i++) g[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
  const rowE = new Float32Array(h), rowV = new Float32Array(h);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      rowE[y] += Math.abs(g[i + 1] - g[i - 1]);
      rowV[y] += Math.abs(g[i + w] - g[i - w]);
    }
  // Barcode-Zeilen: viel horizontale Änderung, wenig vertikale
  const prof = rowE.map((e, y) => Math.max(0, e - 1.5 * rowV[y]));
  const sm = boxBlur(prof, h, 1, Math.max(1, Math.round(h / 150)));
  const cy = Math.round(h / 2);
  let peak = 0, py = cy;
  for (let y = Math.round(h * 0.3); y < h * 0.7; y++) if (sm[y] > peak) { peak = sm[y]; py = y; }
  if (!peak) return loc;
  let y0 = py, y1 = py;
  while (y0 > 0 && sm[y0 - 1] > peak * 0.35) y0--;
  while (y1 < h - 1 && sm[y1 + 1] > peak * 0.35) y1++;
  const T = (y1 - y0 + 1) / k;
  if (T < loc.T * 0.6 || T > loc.L) return loc;
  const dv = ((y0 + y1) / 2 - h / 2) / k;
  return { ...loc, T, cx: loc.cx - dv * Math.sin(loc.angle), cy: loc.cy + dv * Math.cos(loc.angle) };
}

// Sucht in einem Ausschnitt die Zeile aus Zeichen (dunkle Flecken gleicher Höhe nebeneinander)
// und gibt ihren Rahmen zurück. minChars = mindestens so viele Zeichen.
export function findTextRows(c, { minChars = 3, minH = 0.08, maxH = 0.8, maxRows = 4, extend = false } = {}) {
  const w = c.width, h = c.height;
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  // Hintergrund per Closing (Max- dann Min-Filter): entfernt dünne dunkle Striche, lässt graue Felder stehen
  const r = Math.max(2, Math.round(h * 0.05));
  const bg = minMax(minMax(g, w, h, r, Math.max), w, h, r, Math.min);
  const f = new Float32Array(g.length);
  for (let i = 0; i < g.length; i++) f[i] = g[i] - bg[i];
  const sorted = Float32Array.from(f).sort();
  const lo = sorted[Math.floor(sorted.length * 0.02)];
  const thr = lo * 0.45; // deutlich dunkler als die Umgebung
  if (thr > -6) return [];
  const lab = new Int32Array(w * h);
  const comps = [];
  const st = [];
  for (let i = 0; i < f.length; i++) {
    if (lab[i] || f[i] > thr) continue;
    const id = comps.length + 1;
    let x0 = w, y0 = h, x1 = 0, y1 = 0, n = 0;
    st.push(i); lab[i] = id;
    while (st.length) {
      const k = st.pop();
      const x = k % w, y = (k - x) / w;
      n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const j of [k - 1, k + 1, k - w, k + w]) {
        if (j < 0 || j >= f.length || lab[j] || f[j] > thr) continue;
        if ((j === k - 1 && x === 0) || (j === k + 1 && x === w - 1)) continue;
        lab[j] = id; st.push(j);
      }
    }
    const ch = y1 - y0 + 1, cw = x1 - x0 + 1;
    if (ch < h * minH || ch > h * maxH) continue;
    if (cw > ch * 12 || cw < ch * 0.12) continue; // Striche, Kanten raus (verschmolzene Ziffern erlaubt)
    if (y0 === 0 || y1 === h - 1) continue; // angeschnitten (z. B. Barcode-Striche am Rand)
    if (n < cw * ch * 0.12) continue;
    comps.push({ x0, y0, x1, y1, cy: (y0 + y1) / 2, ch });
  }
  const rows = [];
  let rest = comps;
  for (let n = 0; n < maxRows && rest.length; n++) {
    const r = pickRow(rest, h, w, minChars);
    if (!r) break;
    rows.push(...r.boxes);
    rest = rest.filter((c) => !r.used.has(c));
  }
  // extend: Zeile seitlich erweitern (nur für lange Nummern): Zeichen, die mit etwas darüber/darunter verschmolzen sind (z. B. Barcode-
  // Striche im unscharfen Bild), fehlen sonst. Solange in der Zeilenhöhe dunkle Spalten folgen.
  for (const b of extend ? rows : []) {
    const yA = Math.round(b.y + b.charH * 0.45), yB = Math.round(b.y + b.h - b.charH * 0.45);
    const darkCol = (x) => { for (let y = yA; y <= yB; y++) if (f[y * w + x] <= thr) return true; return false; };
    const gapMax = b.charH * 1.2;
    for (const dir of [1, -1]) {
      let x = dir > 0 ? Math.round(b.x + b.w) : Math.round(b.x), last = x, gap = 0;
      while (x > 0 && x < w - 1 && gap < gapMax) {
        x += dir;
        if (darkCol(x)) { last = x; gap = 0; } else gap++;
      }
      const pad = b.charH * 0.6;
      if (dir > 0 && last > b.x + b.w) { const r = Math.min(w, last + pad); b.chars += Math.round((r - b.x - b.w) / (b.charH * 0.6)); b.w = r - b.x; }
      if (dir < 0 && last < b.x) { const l = Math.max(0, last - pad); b.chars += Math.round((b.x - l) / (b.charH * 0.6)); b.w += b.x - l; b.x = l; }
    }
  }
  return rows.sort((a, b) => b.chars - a.chars);
}

export function findTextRow(c, opts = {}) {
  return findTextRows(c, { ...opts, maxRows: 1 })[0] || null;
}

// Textzeile = Zeilenbereich, in dem die meisten Zeichen liegen (robust gegen verschmolzene Ziffern)
function pickRow(comps, h, w, minChars) {
  const prof = new Float32Array(h);
  for (const c of comps) for (let y = c.y0; y <= c.y1; y++) prof[y] += c.x1 - c.x0 + 1;
  let py = 0;
  for (let y = 1; y < h; y++) if (prof[y] > prof[py]) py = y;
  if (!prof[py]) return null;
  const inRow = comps.filter((c) => c.y0 <= py && c.y1 >= py);
  const hMed = inRow.map((c) => c.ch).sort((a, b) => a - b)[Math.floor(inRow.length / 2)];
  const row = inRow.filter((c) => c.ch > hMed * 0.6 && c.ch < hMed * 1.6).sort((a, b) => a.x0 - b.x0);
  // in zusammenhängende Gruppen teilen (Lücke > 3,5 Zeichenhöhen); jede Gruppe ist ein Kandidat
  const groups = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    const n = cur.reduce((s, x) => s + Math.max(1, Math.round((x.x1 - x.x0 + 1) / (x.ch * 0.6))), 0);
    if (n >= minChars) groups.push({ score: n, row: cur });
    cur = [];
  };
  for (const c of row) {
    if (cur.length && c.x0 - cur[cur.length - 1].x1 > hMed * 3.5) flush();
    cur.push(c);
  }
  flush();
  const boxes = groups.map(({ score, row: rw }) => {
    const hh = Math.max(...rw.map((x) => x.ch));
    const pad = hh * 0.45, padX = hh * 0.9;
    const x0 = Math.max(0, Math.min(...rw.map((x) => x.x0)) - padX), x1 = Math.min(w, Math.max(...rw.map((x) => x.x1)) + padX);
    const y0 = Math.max(0, Math.min(...rw.map((x) => x.y0)) - pad), y1 = Math.min(h, Math.max(...rw.map((x) => x.y1)) + pad);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, chars: score, charH: hh };
  });
  return { boxes, used: new Set(inRow) };
}

// Rahmen aus c ausschneiden und auf Zeichenhöhe ~targetH skalieren
export function cutBox(c, box, targetH = 40) {
  const k = Math.max(0.3, Math.min(5, targetH / box.charH));
  const m = Math.round(targetH * 0.8); // weißer Rand: Tesseract verschluckt sonst Zeichen am Bildrand
  const o = document.createElement('canvas');
  o.width = Math.round(box.w * k) + 2 * m;
  o.height = Math.round(box.h * k) + 2 * m;
  const ctx = o.getContext('2d', { willReadFrequently: true });
  // Rand in der hellsten Farbe des Ausschnitts füllen
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(box.x, box.y, Math.max(1, box.w), Math.max(1, box.h)).data;
  const lum = [];
  for (let i = 0; i < d.length; i += 16) lum.push([0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2], i]);
  lum.sort((a, b) => a[0] - b[0]);
  const j = lum[Math.floor(lum.length * 0.9)]?.[1] ?? 0;
  ctx.fillStyle = `rgb(${d[j]},${d[j + 1]},${d[j + 2]})`;
  ctx.fillRect(0, 0, o.width, o.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(c, box.x, box.y, box.w, box.h, m, m, o.width - 2 * m, o.height - 2 * m);
  return o;
}

// Separabler Max- bzw. Min-Filter (Radius r)
function minMax(a, w, h, r, fn) {
  const t = new Float32Array(a.length), o = new Float32Array(a.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = a[y * w + x];
      for (let i = Math.max(0, x - r), e = Math.min(w - 1, x + r); i <= e; i++) v = fn(v, a[y * w + i]);
      t[y * w + x] = v;
    }
  for (let x = 0; x < w; x++)
    for (let y = 0; y < h; y++) {
      let v = t[y * w + x];
      for (let i = Math.max(0, y - r), e = Math.min(h - 1, y + r); i <= e; i++) v = fn(v, t[i * w + x]);
      o[y * w + x] = v;
    }
  return o;
}
