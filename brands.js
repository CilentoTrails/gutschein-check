// Markenerkennung und Feld-Extraktion.
// Eingabe: erkannte Barcodes (Text + Format) und OCR-Zeilen.
// Ausgabe: { brand, fields: [{ key, label, value, check }] }
//   check = true -> dieses Feld wird auf der Prüfseite gebraucht.

export const BRANDS = {
  dm: {
    name: 'dm',
    color: '#1b3d8f',
    url: 'https://www.dm.de/services/services-im-markt/geschenkkarten-3480686#abfrage-guthaben',
    where: {
      card24: '24-stellige Zahl direkt unter dem Barcode (beginnt mit 9071).',
      card8: 'Hinter „Kartennummer:“, 8 Zeichen (Buchstaben und Ziffern).',
      pin: '4-stellig hinter „Code:“ im Hologramm-Feld rechts oberhalb des Barcodes.',
    },
  },
  aldi: {
    name: 'ALDI (Helaba)',
    color: '#00549f',
    url: 'https://www.helaba.com/de/aldi',
    where: {
      pin: '4-stellig im silbernen Hologramm-Feld rechts oberhalb des Barcodes (Höhe „Seriennr.“).',
      card: '20-stellige Zahl direkt unter dem Barcode (5 Vierergruppen).',
    },
  },
  lidl: {
    name: 'Lidl',
    color: '#0050aa',
    url: 'https://www.lidl.de/c/lidl-geschenkkarten/s10007775',
    where: {
      card: 'Zahl direkt unter dem Barcode (18- oder 20-stellig, ohne die kurze Zahl ganz rechts).',
      pin: '4-stellig im silbernen Hologramm-Feld rechts oberhalb des Barcodes.',
    },
  },
  rewe: {
    name: 'REWE',
    color: '#cc071e',
    url: 'https://kartenwelt.rewe.de/rewe-geschenkkarte.html',
  },
  edeka: {
    name: 'EDEKA',
    color: '#1e4fa0',
    url: 'https://evci.pin-host.com/evci/#/guthabenabfrage',
    where: {
      pin: '4-stellig auf dem Silberstreifen oben links.',
      part1: 'Zahlenreihe unter dem Barcode: die 6 Ziffern nach „010 4041578“ (vor „21“).',
      part2: 'Zahlenreihe unter dem Barcode: die 14 Ziffern nach „21“ (bis zum Ende).',
    },
  },
};

const digits = (s) => (s || '').replace(/\D/g, '');

// Häufige OCR-Verwechslungen in rein numerischen Feldern
const toDigits = (s) =>
  (s || '')
    .replace(/[oOQD]/g, '0')
    .replace(/[iIl|!]/g, '1')
    .replace(/[sS]/g, '5')
    .replace(/[B]/g, '8')
    .replace(/[zZ]/g, '2')
    .replace(/\D/g, '');

// GS1-Prüfziffer (GTIN, Modulo 10, Gewichte 3/1 von rechts)
export function gs1Valid(code) {
  if (!/^\d{8,18}$/.test(code)) return false;
  const d = code.split('').map(Number);
  const check = d.pop();
  const sum = d.reverse().reduce((s, x, i) => s + x * (i % 2 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10 === check;
}

const group = (s, n = 4) => s.replace(new RegExp(`(.{${n}})(?=.)`, 'g'), '$1 ');

function scoreBrands(text, barcodes, pseudo = []) {
  const t = text.toLowerCase();
  const s = { dm: 0, aldi: 0, lidl: 0, rewe: 0, edeka: 0 };
  const hit = (b, re, w = 1) => { if (re.test(t)) s[b] += w; };

  hit('dm', /dm-?drogerie|dm\.de|dm-markt|dm-app/, 3);
  hit('dm', /kartennummer\s*:?\s*[a-z0-9]{4}\s?[a-z0-9]{4}\b/, 1);
  hit('aldi', /helaba|landesbank|aldi/, 3);
  // unscharfe Lesungen tolerieren (z. B. „Holaba“, „He1aba“)
  hit('aldi', /h[ceo][l1i|][ao][bh8][ao]|lande[s5]bank|hessen-?th/, 2);
  hit('aldi', /geschenkgutsche[il1]n/, 1); // ALDI: „Geschenkgutschein“ (Lidl: „Geschenkkarte“); „Seriennr.“ steht auf beiden
  // Lidl-Rückseite, auch unscharf gelesen: Herausgeber-Text
  hit('lidl', /bad ?w[il1]mpfen|bonfelder|l[il1]d[l1i] ?d[il1]enst/, 2);
  hit('lidl', /lidl/, 3);
  hit('rewe', /rewe|kartenwelt/, 3);
  hit('edeka', /edeka|a1 ?bank|marktkauf|ktrl/, 3);

  for (const b of barcodes) {
    const d = digits(b.text);
    if (/^9071\d{20}$/.test(d)) s.dm += 4;
    if (/^0104041578\d{6}21\d{14}$/.test(d)) s.edeka += 5;
    if (/aztec/i.test(b.format)) s.rewe += 2;
    if (/^0104053868100364/.test(d)) s.aldi += 3;
    if (/^0104053868100388/.test(d)) s.lidl += 3;
    if (/^0104067534/.test(d)) s.lidl += 3; // neuere Lidl-Geschenkkarten (10 €, 20 €)
  }
  // per Texterkennung gelesene Klartext-Nummer (kann Lesefehler enthalten)
  for (const b of pseudo) {
    // 20-stellig in 5 Vierergruppen gedruckt: Helaba-Gutschein (ALDI); nur schwacher Hinweis
    if (/^\d{20}$/.test(b.text)) s.aldi += 0.5;
    if (/^01\d{16}$/.test(b.text)) s.lidl += 1; // 18-stellig, beginnt mit 01: neuere Lidl-Karten
    if (/4041578\d{6}21\d{10,}/.test(b.text)) s.edeka += 4;
    if (/9071\d{18,}/.test(b.text)) s.dm += 2;
  }
  return s;
}

// 4-stelliger PIN/Code: bevorzugt hinter einem Label („Code:“, „PIN“),
// sonst ein alleinstehender 4er-Block, der nicht Teil einer gruppiert
// gedruckten langen Nummer ist (z. B. „4000 0120 1370 8815 0004“).
function pinCandidates(lines, barcodeDigits, bonus = 0) {
  const out = [];
  // alle 4er-Blöcke der Barcode-Nummern (egal wo die Gruppierung beginnt)
  const excluded = new Set();
  for (const d of barcodeDigits) for (let i = 0; i + 4 <= d.length; i++) excluded.add(d.slice(i, i + 4));
  for (const l of lines) {
    const toks = l.text.split(/\s+/).filter(Boolean);
    toks.forEach((t, i) => {
      const clean = t.replace(/^[^\d]+|[^\d]+$/g, '');
      if (!/^\d{4}$/.test(clean)) return;
      // Teil einer Folge von >=3 kurzen Zifferngruppen?
      let run = 1;
      for (let j = i - 1; j >= 0 && /^\d{2,6}$/.test(toks[j]); j--) run++;
      for (let j = i + 1; j < toks.length && /^\d{2,6}$/.test(toks[j]); j++) run++;
      if (run >= 3) return;
      if (/[.,/:-]\d|\d[.,/-]/.test(t)) return; // Datum, Adresse o. Ä.
      let score = (l.conf || 50) + bonus;
      if (toks.length <= 3) score += 20;
      if (excluded.has(clean)) return; // Block aus der Barcode-Nummer
      out.push({ v: clean, score });
    });
  }
  return out;
}

function findPin(lines, digitLines, barcodeDigits) {
  for (const l of [...lines].sort((a, b) => b.conf - a.conf)) {
    const m = l.text.match(/(?:code|pin)\b[^0-9a-z]{0,6}([0-9oOIl|]{4})(?![0-9])/i);
    if (m) return toDigits(m[1]);
  }
  const c = [...pinCandidates(lines, barcodeDigits, 10), ...pinCandidates(digitLines, barcodeDigits)];
  c.sort((a, b) => b.score - a.score);
  return c[0]?.v || '';
}

// numberLines = per Texterkennung gelesene Klartext-Nummer unter dem Barcode.
// Sie ersetzt den Barcode, wenn der nicht lesbar war; Werte daraus gelten als unsicher.
export function analyze({ barcodes, lines, digitLines = [], numberLines = [] }) {
  const text = lines.map((l) => l.text).join('\n');
  // dazu Zeilen aus dem normalen Text, die fast nur aus Ziffern bestehen (Klartext-Nummer)
  const numLike = lines.filter((l) => /^[\dOoIl| ]{16,}$/.test(l.text.trim()) && digits(l.text).length >= 12);
  const seen = new Set();
  const pseudo = [...numberLines, ...numLike]
    .map((l) => ({ text: toDigits(l.text), format: 'OCR', ocr: true, conf: numberLines.includes(l) ? l.conf : 0 }))
    .filter((b) => b.text.length >= 10 && !seen.has(b.text) && seen.add(b.text));
  const scores = scoreBrands(text, barcodes, pseudo);
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  const brand = best[1] > 0 ? best[0] : null;
  const bc = [...barcodes, ...pseudo].map((b) => ({ ...b, d: digits(b.text) }));
  const pin = findPin(lines, digitLines, bc.map((b) => b.d));
  const fields = [];
  const f = (key, label, value, check = false, unsure = false) =>
    fields.push({ key, label, value: value || '', check, unsure: !!(value && unsure) });
  // erste passende Nummer: exakte Barcodes zuerst, dann OCR-Klartext (ungeankert)
  // ocr = unsicher: aus Texterkennung und nicht sehr sicher gelesen
  const pick = (exact, loose) => {
    for (const b of bc) {
      const m = b.d.match(b.ocr ? loose || exact : exact);
      if (m) return { m, ocr: !!b.ocr && !(b.conf >= 92) };
    }
    return { m: null, ocr: false };
  };

  switch (brand) {
    case 'dm': {
      // Prüfseite: „8- oder 24-stellige Kartennummer“, dann „Code“.
      // Die 24-stellige Nummer steht exakt im Barcode -> bevorzugt; die 8 Zeichen nur als Ersatz.
      const long = pick(/^(9071\d{20})$/, /(9071\d{20})/);
      if (long.m) f('card24', 'Kartennummer (24-stellig)', long.m[1], true, long.ocr);
      if (!long.m || long.ocr) {
        const cands = lines
          .map((l) => ({ m: l.text.match(/kartennummer\s*:?\s*([A-Z0-9]{4})\s?([A-Z0-9]{4})\b/i), conf: l.conf }))
          .filter((x) => x.m)
          .sort((a, b) => b.conf - a.conf);
        const m = cands[0]?.m;
        f('card8', long.m ? 'Alternative: Kartennummer (8 Zeichen)' : 'Kartennummer (8 Zeichen)', m ? `${m[1]}${m[2]}`.toUpperCase() : '', !long.m, true);
      }
      f('pin', 'Code', pin, true);
      break;
    }
    case 'edeka': {
      // Reihenfolge wie auf der Prüfseite: PIN-Code, dann Kartennummer Feld 1 und Feld 2.
      // Feld 1 = letzte 6 Ziffern der GTIN (04041578……) und endet mit einer GS1-Prüfziffer:
      // damit lassen sich Lesefehler erkennen und unter mehreren Lesungen die richtige wählen.
      const cands = bc
        .map((b) => ({ b, m: b.d.match(b.ocr ? /4041578(\d{6})21(\d{14})/ : /^0104041578(\d{6})21(\d{14})$/) }))
        .filter((x) => x.m);
      const exact = cands.find((x) => !x.b.ocr);
      const main = exact || cands[0];
      const valid = exact || cands.find((x) => gs1Valid('04041578' + x.m[1]));
      f('pin', 'PIN-Code', pin, true);
      f('part1', 'Kartennummer – Feld 1 (6 Ziffern nach „010 4041578“)', (valid || main)?.m[1], true, !valid);
      f('part2', 'Kartennummer – Feld 2 (14 Ziffern nach „21“)', main?.m[2], true, !exact && !(main?.b.conf >= 92));
      break;
    }
    case 'aldi':
    case 'lidl': {
      // GS1-Barcode: (01) GTIN + (90) Gutscheinnummer = die Zahl unter dem Barcode.
      // ALDI und ältere Lidl-Karten: 20-stellig, neuere Lidl-Karten (10 €/20 €): 18-stellig.
      const { m: g, ocr } = pick(/^01\d{14}90(\d{16,22})$|^(\d{18}|\d{20})$/);
      const num = g ? g[1] || g[2] : '';
      f('card', brand === 'aldi' ? 'Gutscheinnummer (20-stellig)' : 'Gutschein (Nummer unter dem Barcode)', num, true, ocr);
      f('pin', 'PIN', pin, true);
      break;
    }
    case 'rewe': {
      // Aztec-Code = 13-stellige Kartennummer + 26-stellige Zusatznummer
      const az = bc.filter((b) => !b.ocr).map((b) => b.d.match(/^(\d{13})(\d{26})$/)).find(Boolean);
      let card = az ? az[1] : '';
      if (!card) {
        const m = text.match(/(?<!\d)(\d{13})(?!\d)/);
        card = m ? m[1] : '';
      }
      f('card', 'Kartennummer', card, true, !az);
      f('pin', 'PIN', pin, true);
      break;
    }
    default: {
      const long = bc.find((b) => b.d.length >= 10);
      f('barcode', 'Barcode-Nummer', long ? long.d : '', true, long?.ocr);
      f('pin', 'PIN/Code', pin, true);
    }
  }
  return { brand, scores, fields };
}
