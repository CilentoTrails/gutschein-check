// Markenerkennung und Feld-Extraktion.
// Eingabe: erkannte Barcodes (Text + Format) und OCR-Zeilen.
// Ausgabe: { brand, fields: [{ key, label, value, check }] }
//   check = true -> dieses Feld wird auf der Prüfseite gebraucht.

export const BRANDS = {
  dm: {
    name: 'dm',
    color: '#1b3d8f',
    url: 'https://www.dm.de/services/services-im-markt/geschenkkarten-3480686#abfrage-guthaben',
  },
  aldi: {
    name: 'ALDI (Helaba)',
    color: '#00549f',
    url: 'https://www.helaba.com/de/aldi',
  },
  lidl: {
    name: 'Lidl',
    color: '#0050aa',
    url: 'https://www.lidl.de/c/lidl-geschenkkarten/s10007775',
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

const group = (s, n = 4) => s.replace(new RegExp(`(.{${n}})(?=.)`, 'g'), '$1 ');

function scoreBrands(text, barcodes) {
  const t = text.toLowerCase();
  const s = { dm: 0, aldi: 0, lidl: 0, rewe: 0, edeka: 0 };
  const hit = (b, re, w = 1) => { if (re.test(t)) s[b] += w; };

  hit('dm', /dm-?drogerie|dm\.de|dm-markt|dm-app/, 3);
  hit('dm', /kartennummer\s*:?\s*[a-z0-9]{4}\s?[a-z0-9]{4}\b/, 1);
  hit('aldi', /helaba|landesbank|aldi/, 3);
  hit('lidl', /lidl/, 3);
  hit('rewe', /rewe|kartenwelt/, 3);
  hit('edeka', /edeka|a1 ?bank|marktkauf|ktrl/, 3);

  for (const b of barcodes) {
    const d = digits(b.text);
    if (/^9071\d{16}$/.test(d)) s.dm += 4;
    if (/^0104041578\d{6}21\d{14}$/.test(d)) s.edeka += 5;
    if (/aztec/i.test(b.format)) s.rewe += 2;
    if (/^0104053868100364/.test(d)) s.aldi += 3;
    if (/^0104053868100388/.test(d)) s.lidl += 3;
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

function longNumberAfter(text, labelRe, min, max) {
  const re = new RegExp(labelRe.source + '\\s*[.:]*\\s*([0-9oOIl| ]{' + min + ',' + (max + 10) + '})', 'i');
  const m = text.match(re);
  if (!m) return '';
  const d = toDigits(m[1]);
  return d.length >= min ? d.slice(0, max) : '';
}

export function analyze({ barcodes, lines, digitLines = [] }) {
  const text = lines.map((l) => l.text).join('\n');
  const scores = scoreBrands(text, barcodes);
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  const brand = best[1] > 0 ? best[0] : null;
  const bc = barcodes.map((b) => ({ ...b, d: digits(b.text) }));
  const pin = findPin(lines, digitLines, bc.map((b) => b.d));
  const fields = [];
  const f = (key, label, value, check = false) => fields.push({ key, label, value: value || '', check });

  switch (brand) {
    case 'dm': {
      // alle Lesungen der Zeile prüfen, die mit der höchsten Sicherheit gewinnt
      const cands = lines
        .map((l) => ({ m: l.text.match(/kartennummer\s*:?\s*([A-Z0-9]{4})\s?([A-Z0-9]{4})\b/i), conf: l.conf }))
        .filter((x) => x.m)
        .sort((a, b) => b.conf - a.conf);
      const m = cands[0]?.m;
      f('card', 'Kartennummer (8 Zeichen)', m ? `${m[1]}${m[2]}`.toUpperCase() : '', true);
      f('pin', 'Code', pin, true);
      const long = bc.find((b) => /^9071\d{20}$/.test(b.d));
      if (long) f('card24', 'Alternative: 24-stellige Nummer (Barcode)', long.d);
      break;
    }
    case 'edeka': {
      const g = bc.map((b) => b.d.match(/^0104041578(\d{6})21(\d{14})$/)).find(Boolean);
      f('part1', 'Kartennummer – kurzes Feld (nach 010 4041578)', g ? g[1] : '', true);
      f('part2', 'Kartennummer – langes Feld (nach 21)', g ? g[2] : '', true);
      f('pin', 'PIN-Code', pin, true);
      break;
    }
    case 'aldi':
    case 'lidl': {
      // GS1-Barcode: (01) GTIN + (90) 20-stellige Gutscheinnummer
      const g = bc.map((b) => b.d.match(/^01\d{14}90(\d{20})$/) || b.d.match(/^(\d{20})$/)).find(Boolean);
      f('card', brand === 'aldi' ? 'Gutscheinnummer (20-stellig)' : 'Gutscheinnummer', g ? g[1] : '', true);
      f('pin', 'PIN', pin, true);
      const s = longNumberAfter(text, /seriennr/, 12, 22);
      if (s) f('serial', 'Seriennummer', s);
      break;
    }
    case 'rewe': {
      // Aztec-Code = 13-stellige Kartennummer + 26-stellige Zusatznummer
      const az = bc.map((b) => b.d.match(/^(\d{13})(\d{26})$/)).find(Boolean);
      let card = az ? az[1] : '';
      if (!card) {
        const m = text.match(/(?<!\d)(\d{13})(?!\d)/);
        card = m ? m[1] : '';
      }
      f('card', 'Kartennummer', card, true);
      f('pin', 'PIN', pin, true);
      break;
    }
    default: {
      const long = bc.find((b) => b.d.length >= 10);
      f('barcode', 'Barcode-Nummer', long ? long.d : '', true);
      f('pin', 'PIN/Code', pin, true);
    }
  }
  return { brand, scores, fields };
}
