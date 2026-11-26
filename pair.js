// Handy als Kamera: Rechner und Handy per WebRTC (PeerJS) koppeln.
// Der Rechner zeigt einen QR-Code mit einer zufälligen Verbindungs-ID. Das Handy öffnet den Link,
// erkennt die Karte selbst und schickt nur das Ergebnis direkt (verschlüsselt) an den Rechner.
// Der PeerJS-Vermittlungsserver sieht nur die ID, keine Kartendaten.

const OPTS = window.GC_PEER_OPTIONS || { debug: 0 }; // Standard: kostenloser PeerJS-Server
const PREFIX = 'gutschein-check-';
const LIMIT = 300; // max. Länge eines Textes in einer Nachricht

const ERRORS = {
  'peer-unavailable': 'Rechner nicht erreichbar. Ist die Seite dort noch offen? QR-Code neu scannen.',
  network: 'Keine Verbindung zum Vermittlungsserver. Internetverbindung prüfen.',
  'server-error': 'Vermittlungsserver nicht erreichbar. Später noch einmal versuchen.',
  'browser-incompatible': 'Dieser Browser kann keine Direktverbindung (WebRTC).',
};
const errText = (e) => ERRORS[e?.type] || 'Verbindung fehlgeschlagen (' + (e?.type || e) + ').';

/* ---------- Rechner ---------- */
export function startHost({ onState, onStatus, onResult }) {
  const id = PREFIX + crypto.randomUUID();
  const peer = new Peer(id, OPTS);
  let conn = null;
  peer.on('open', () => {
    const url = new URL(location.href);
    url.search = '';
    url.hash = 'pair=' + id.slice(PREFIX.length);
    onState('waiting', url.href);
  });
  peer.on('connection', (c) => {
    // nur ein Handy gleichzeitig
    if (conn?.open) {
      c.on('open', () => c.close());
      return;
    }
    conn = c;
    c.on('open', () => onState('connected'));
    c.on('data', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'status') onStatus(clip(msg.text));
      if (msg.type === 'result') {
        const r = cleanResult(msg.data);
        if (r) onResult(r);
      }
    });
    c.on('close', () => { if (conn === c) { conn = null; onState('disconnected'); } });
    c.on('error', () => {});
  });
  // Verbindung zum Vermittlungsserver verloren: ID behalten und nach kurzer Pause neu verbinden
  let retry = 0;
  peer.on('open', () => { retry = 0; });
  peer.on('disconnected', () => {
    const wait = Math.min(30000, 2000 * 2 ** retry++);
    setTimeout(() => { if (!peer.destroyed && peer.disconnected) peer.reconnect(); }, wait);
  });
  peer.on('error', (e) => onState('error', errText(e)));
  return { stop: () => peer.destroy() };
}

/* ---------- Handy ---------- */
export function startGuest(code, { onState }) {
  const peer = new Peer(OPTS);
  let conn = null;
  peer.on('open', () => {
    conn = peer.connect(PREFIX + code, { reliable: true });
    conn.on('open', () => onState('connected'));
    conn.on('close', () => onState('disconnected'));
    conn.on('error', (e) => onState('error', errText(e)));
  });
  peer.on('error', (e) => onState('error', errText(e)));
  const send = (msg) => {
    if (!conn?.open) return false;
    conn.send(msg);
    return true;
  };
  return {
    status: (text) => send({ type: 'status', text: text || '' }),
    result: (r) =>
      send({
        type: 'result',
        data: {
          brand: r.res.brand,
          fields: r.res.fields.map(({ key, label, value, check, unsure }) => ({ key, label, value, check, unsure })),
          barcodes: r.barcodes.map((b) => ({ format: b.format, text: b.text })),
          lines: r.lines.map((l) => ({ text: l.text })),
          numberLines: (r.numberLines || []).map((l) => ({ text: l.text })),
          located: !!r.located,
        },
      }),
    isOpen: () => !!conn?.open,
    stop: () => peer.destroy(),
  };
}

// Code aus dem Link (#pair=…) lesen und aus der Adresszeile entfernen
export function pairCodeFromUrl() {
  const m = location.hash.match(/^#pair=([0-9a-f-]{36})$/i);
  if (!m) return null;
  history.replaceState(null, '', location.pathname + location.search);
  return m[1];
}

/* ---------- empfangene Daten prüfen (nur Text, begrenzte Länge) ---------- */
function clip(s) {
  return typeof s === 'string' ? s.slice(0, LIMIT) : '';
}
function cleanResult(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.fields)) return null;
  const list = (a, n) => (Array.isArray(a) ? a.slice(0, n) : []);
  return {
    res: {
      brand: typeof d.brand === 'string' ? d.brand : null,
      fields: list(d.fields, 12).map((f) => ({
        key: clip(f?.key),
        label: clip(f?.label),
        value: clip(f?.value),
        check: !!f?.check,
        unsure: !!f?.unsure,
      })),
    },
    barcodes: list(d.barcodes, 5).map((b) => ({ format: clip(b?.format), text: clip(b?.text) })),
    lines: list(d.lines, 80).map((l) => ({ text: clip(l?.text) })),
    numberLines: list(d.numberLines, 5).map((l) => ({ text: clip(l?.text) })),
    located: !!d.located,
  };
}
