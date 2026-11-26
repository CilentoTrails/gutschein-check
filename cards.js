// Schematische Kartenrückseiten für „Wo finde ich die Nummern?“ (alle Nummern erfunden).
// Markierungen: pinker Rahmen + Nummernkreis; dazu je eine kurze Erklärung.
const P = '#e6007e';
const bars = (x, y, w, h) => {
  let s = '', cx = x, i = 0;
  const pat = [2, 1, 1, 3, 1, 2, 2, 1, 3, 1, 1, 2, 1, 1, 2, 3];
  while (cx < x + w - 3) { const bw = pat[i++ % pat.length]; if (i % 2) s += `<rect x="${cx}" y="${y}" width="${bw}" height="${h}" fill="#222"/>`; cx += bw + 1; }
  return s;
};
const lines = (x, y, w, n, gap = 9, c = '#c9c9c9') =>
  Array.from({ length: n }, (_, i) => `<rect x="${x}" y="${y + i * gap}" width="${i === n - 1 ? w * 0.6 : w}" height="4" rx="2" fill="${c}"/>`).join('');
const mark = (x, y, w, h, n, lx, ly) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="none" stroke="${P}" stroke-width="2.5"/>` +
  `<circle cx="${lx}" cy="${ly}" r="10" fill="${P}"/><text x="${lx}" y="${ly + 4}" text-anchor="middle" font-size="12" font-weight="700" fill="#fff">${n}</text>`;
const holo = (x, y, w, h, pin) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5" fill="#9aa0a8"/>` +
  `<path d="M${x + 4} ${y + h * 0.3} q10 -8 20 0 t20 0 t20 0 M${x + 4} ${y + h * 0.75} q10 -8 20 0 t20 0 t20 0" stroke="#c7ccd3" stroke-width="2" fill="none"/>` +
  `<rect x="${x + w * 0.22}" y="${y + h * 0.18}" width="${w * 0.6}" height="${h * 0.64}" rx="3" fill="#f2f2f2"/>` +
  `<text x="${x + w * 0.52}" y="${y + h * 0.66}" text-anchor="middle" font-size="13" font-family="monospace" fill="#222">${pin}</text>`;
const mono = (x, y, t, size = 11, weight = 400) => `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" font-family="monospace" fill="#222">${t}</text>`;
const card = (inner) => `<svg viewBox="0 0 340 214" xmlns="http://www.w3.org/2000/svg" font-family="system-ui,sans-serif"><rect x="1" y="1" width="338" height="212" rx="14" fill="#fbfbfa" stroke="#d5d5d5"/>${inner}</svg>`;

export const CARDS = {
  aldi: {
    name: 'ALDI',
    svg: card(
      `<path d="M1 15 a14 14 0 0 1 14 -14 h310 a14 14 0 0 1 14 14 v85 h-338z" fill="#2b2f6b"/>` +
      `<rect x="250" y="14" width="76" height="20" rx="4" fill="#fff"/><text x="288" y="29" text-anchor="middle" font-size="12" font-weight="700" fill="#2b2f6b">Helaba</text>` +
      lines(16, 46, 220, 5, 9, '#7a7fb5') +
      `<text x="22" y="118" font-size="10" fill="#555">Geschenkgutschein:</text><text x="22" y="131" font-size="10" fill="#555">Seriennr. 1000000000123456789</text>` +
      holo(236, 106, 80, 28, '7316') + bars(22, 140, 290, 36) + mono(78, 192, '4000 1234 5678 9012 3456', 12) +
      mark(72, 180, 196, 17, 1, 56, 189) + mark(232, 102, 88, 36, 2, 228, 98)
    ),
    legend: [['1', 'Gutscheinnummer', '20 Ziffern direkt unter dem Barcode'], ['2', 'PIN', '4 Ziffern im Hologramm-Feld (freirubbeln)']],
  },
  lidl: {
    name: 'Lidl',
    svg: card(
      `<text x="18" y="34" font-size="17" font-weight="800" fill="#222">Lidl Geschenkkarte</text>` +
      `<rect x="292" y="14" width="30" height="30" rx="3" fill="#0050aa"/><circle cx="307" cy="29" r="11" fill="#ffd500"/>` +
      lines(18, 48, 300, 5, 9) +
      `<text x="22" y="120" font-size="10" fill="#555">Seriennr.: 200000 000012 345678</text>` +
      holo(214, 96, 86, 30, '2950') + bars(22, 130, 296, 36) + mono(24, 184, '0134 1111 2222 3333 44', 12) + `<text x="296" y="184" font-size="10" fill="#999">305</text>` +
      mark(18, 172, 178, 17, 1, 206, 181) + mark(210, 92, 94, 38, 2, 206, 88)
    ),
    legend: [['1', 'Gutschein', 'Zahl direkt unter dem Barcode (18 oder 20 Ziffern), ohne die kleine Zahl rechts'], ['2', 'PIN', '4 Ziffern im Hologramm-Feld (freirubbeln)']],
  },
  dm: {
    name: 'dm',
    svg: card(
      `<path d="M1 15 a14 14 0 0 1 14 -14 h310 a14 14 0 0 1 14 14 v88 h-338z" fill="#9fd3c7"/>` +
      lines(16, 16, 240, 8, 9, '#5f8f84') + `<text x="284" y="86" font-size="22" font-weight="800" fill="#1b3d8f">dm</text>` +
      `<text x="16" y="124" font-size="11" fill="#333">Kartennummer: AB12 CD34</text>` +
      `<text x="190" y="124" font-size="11" fill="#333">Code:</text>` + holo(234, 108, 86, 26, '5821') +
      bars(30, 140, 280, 36) + mono(40, 194, '9071 0000 1234 5678 9012 3456', 11.5) +
      mark(34, 182, 262, 17, 1, 22, 191) + mark(230, 104, 94, 34, 2, 214, 100)
    ),
    legend: [['1', 'Kartennummer', '24 Ziffern unter dem Barcode (alternativ die 8 Zeichen hinter „Kartennummer:“)'], ['2', 'Code', '4 Ziffern im Hologramm-Feld hinter „Code:“ (freirubbeln)']],
  },
  edeka: {
    name: 'EDEKA',
    svg: card(
      holo(14, 14, 110, 26, '4721') + lines(136, 16, 190, 2, 9) + lines(14, 52, 310, 3, 9) +
      `<text x="214" y="96" font-size="9" fill="#555">Ktrl. Nr. 900 123 45 678</text>` +
      bars(28, 102, 290, 34) +
      `<text x="28" y="152" font-size="10.5" font-family="monospace" fill="#222">010 4041578 <tspan font-weight="700">9 000 12</tspan> 21 <tspan font-weight="700">0860 1122 3344 55</tspan></text>` +
      `<rect x="14" y="170" width="40" height="32" fill="#ffd500"/><rect x="20" y="176" width="28" height="20" fill="#1e4fa0"/>` +
      `<rect x="62" y="172" width="36" height="28" fill="#2e8b3d"/><rect x="106" y="172" width="44" height="28" fill="#1e4fa0" opacity=".7"/><rect x="158" y="172" width="34" height="28" fill="#222"/>` +
      `<rect x="200" y="172" width="58" height="28" fill="#c8102e" opacity=".7"/><rect x="266" y="172" width="54" height="28" fill="#1e4fa0" opacity=".5"/>` +
      mark(10, 10, 118, 34, 1, 140, 34) + mark(100, 141, 55, 15, 2, 127, 165) + mark(178, 141, 118, 15, 3, 306, 165)
    ),
    legend: [['1', 'PIN-Code', '4 Ziffern im Silberstreifen oben links (freirubbeln)'], ['2', 'Feld 1', '6 Ziffern nach „010 4041578“'], ['3', 'Feld 2', '14 Ziffern nach „21“']],
  },
};
