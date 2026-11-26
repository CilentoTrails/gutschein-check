// Handy als Kamera: Rechner und Handy per WebRTC (PeerJS) koppeln.
// Der Rechner zeigt einen QR-Code mit einer zufälligen Verbindungs-ID. Das Handy öffnet den Link,
// erkennt die Karte selbst und schickt nur das Ergebnis direkt (verschlüsselt) an den Rechner.
// Der PeerJS-Vermittlungsserver sieht nur die ID, keine Kartendaten.
//
// Robustheit:
// - Mehrere Verbindungen vom Handy werden angenommen (QR-Scanner öffnen Links oft doppelt, Seite neu geladen …).
// - Der Rechner bestätigt jedes Ergebnis (ack). Ohne Bestätigung sendet das Handy erneut bzw. meldet es.
// - Das Handy schickt regelmäßig ein Lebenszeichen und verbindet sich nach Abbrüchen neu
//   (z. B. nach Bildschirmsperre), solange die Seite offen ist.
// - JSON statt Binärformat: funktioniert in allen Browsern (auch Safari) gleich.

const OPTS = window.GC_PEER_OPTIONS || { debug: 0 }; // Standard: kostenloser PeerJS-Server
const PREFIX = 'gutschein-check-';
const LIMIT = 300; // max. Länge eines Textes in einer Nachricht
const PING_MS = 3000;
const ACK_MS = 5000;
const STORE = 'gc-pair-code';

const ERRORS = {
  'peer-unavailable': 'Rechner nicht erreichbar. Ist die Seite dort noch offen? QR-Code neu scannen.',
  network: 'Keine Verbindung zum Vermittlungsserver. Internetverbindung prüfen.',
  'server-error': 'Vermittlungsserver nicht erreichbar. Später noch einmal versuchen.',
  'browser-incompatible': 'Dieser Browser kann keine Direktverbindung (WebRTC).',
};
const errText = (e) => ERRORS[e?.type] || 'Verbindung fehlgeschlagen (' + (e?.type || e) + ').';

// Verbindung zum Vermittlungsserver nach Abbruch mit wachsender Pause neu aufbauen
function keepSignaling(peer) {
  let retry = 0;
  peer.on('open', () => { retry = 0; });
  peer.on('disconnected', () => {
    const wait = Math.min(30000, 2000 * 2 ** retry++);
    setTimeout(() => { if (!peer.destroyed && peer.disconnected) peer.reconnect(); }, wait);
  });
}

/* ---------- Rechner ---------- */
export function startHost({ onState, onStatus, onResult }) {
  const id = PREFIX + crypto.randomUUID();
  const peer = new Peer(id, OPTS);
  let conn = null;
  let lastSeen = 0;
  let alive = false;
  const seen = new Set(); // bereits angezeigte Ergebnisse (bei erneutem Senden nicht doppelt)

  peer.on('open', () => {
    const url = new URL(location.href);
    url.search = '';
    url.hash = 'pair=' + id.slice(PREFIX.length);
    onState('waiting', url.href);
  });
  // Alle offenen Verbindungen annehmen (QR-Scanner-Vorschau und Browser können beide offen sein);
  // was zuletzt Daten schickt, zählt als aktiv.
  const conns = new Set();
  peer.on('connection', (c) => {
    c.on('open', () => {
      conns.add(c);
      conn = c;
      lastSeen = Date.now();
      alive = true;
      onState('connected');
    });
    c.on('data', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      conn = c;
      lastSeen = Date.now();
      if (!alive) { alive = true; onState('connected'); }
      if (msg.type === 'ping') c.send({ type: 'pong' });
      if (msg.type === 'status') onStatus(clip(msg.text));
      if (msg.type === 'result') {
        const n = clip(String(msg.n ?? ''));
        c.send({ type: 'ack', n });
        if (seen.has(n)) return;
        seen.add(n);
        const r = cleanResult(msg.data);
        if (r) onResult(r);
      }
    });
    c.on('close', () => {
      conns.delete(c);
      if (conn === c) conn = [...conns].pop() || null;
      if (!conns.size) { alive = false; onState('disconnected'); }
    });
    c.on('error', () => {});
  });
  // kein Lebenszeichen mehr (Handy gesperrt, Verbindung tot)
  const watch = setInterval(() => {
    if (conn && alive && Date.now() - lastSeen > PING_MS * 4) {
      alive = false;
      onState('idle');
    }
  }, 1000);
  keepSignaling(peer);
  peer.on('error', (e) => onState('error', errText(e)));
  return { stop: () => { clearInterval(watch); peer.destroy(); } };
}

/* ---------- Handy ---------- */
export function startGuest(code, { onState }) {
  try { sessionStorage.setItem(STORE, code); } catch {}
  const peer = new Peer(OPTS);
  let conn = null;
  let connecting = false;
  let lastPong = 0;
  const waiting = new Map(); // n -> resolve
  let counter = 0;

  function connect() {
    if (peer.destroyed || connecting || peer.disconnected) return;
    connecting = true;
    const c = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
    const giveUp = setTimeout(() => { if (!c.open) { connecting = false; try { c.close(); } catch {} } }, 8000);
    c.on('open', () => {
      clearTimeout(giveUp);
      connecting = false;
      if (conn && conn !== c) try { conn.close(); } catch {}
      conn = c;
      lastPong = Date.now();
      onState('connected');
    });
    c.on('data', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      lastPong = Date.now();
      if (msg.type === 'ack') {
        waiting.get(msg.n)?.(true);
        waiting.delete(msg.n);
      }
    });
    c.on('close', () => {
      clearTimeout(giveUp);
      connecting = false;
      if (conn === c) { conn = null; onState('reconnecting'); }
    });
    c.on('error', () => {});
  }

  peer.on('open', connect);
  keepSignaling(peer);
  peer.on('error', (e) => {
    connecting = false;
    // Rechner (noch) nicht erreichbar: weiter versuchen, aber Bescheid geben
    onState('error', errText(e));
  });

  // Lebenszeichen; tote Verbindung erkennen und neu verbinden
  const beat = setInterval(() => {
    if (conn?.open) {
      try { conn.send({ type: 'ping' }); } catch {}
      if (Date.now() - lastPong > PING_MS * 4) {
        try { conn.close(); } catch {}
        conn = null;
        onState('reconnecting');
      }
    } else if (!connecting && peer.open) connect();
  }, PING_MS);
  // nach Bildschirmsperre / App-Wechsel sofort prüfen
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !conn?.open && peer.open) connect();
  });

  const send = (msg) => {
    if (!conn?.open) return false;
    try { conn.send(msg); return true; } catch { return false; }
  };

  // Ergebnis senden und auf Bestätigung warten; bis zu 3 Versuche (auch über Neuverbindung hinweg)
  async function result(r) {
    const n = Date.now().toString(36) + '-' + counter++;
    const msg = { type: 'result', n, data: pack(r) };
    for (let i = 0; i < 3; i++) {
      if (!conn?.open) await new Promise((ok) => setTimeout(ok, 2500));
      if (!send(msg)) continue;
      const ok = await new Promise((resolve) => {
        waiting.set(n, resolve);
        setTimeout(() => { if (waiting.get(n) === resolve) { waiting.delete(n); resolve(false); } }, ACK_MS);
      });
      if (ok) return true;
    }
    return false;
  }

  return {
    status: (text) => send({ type: 'status', text: (text || '').slice(0, LIMIT) }),
    result,
    stop: () => { clearInterval(beat); peer.destroy(); },
  };
}

// Kompakt: nur was der Rechner anzeigt (Rohtext gekürzt)
function pack(r) {
  return {
    brand: r.res.brand,
    fields: r.res.fields.map(({ key, label, value, check, unsure }) => ({ key, label, value, check, unsure })),
    barcodes: r.barcodes.map((b) => ({ format: b.format, text: b.text })),
    lines: r.lines.slice(0, 40).map((l) => ({ text: l.text.slice(0, 120) })),
    numberLines: (r.numberLines || []).map((l) => ({ text: l.text })),
    located: !!r.located,
  };
}

// Code aus dem Link (#pair=…) lesen und aus der Adresszeile entfernen.
// Beim Neuladen der Seite (Link ohne Code) wird der Code aus dieser Browser-Sitzung übernommen.
export function pairCodeFromUrl() {
  const m = location.hash.match(/^#pair=([0-9a-f-]{36})$/i);
  if (m) {
    history.replaceState(null, '', location.pathname + location.search);
    return m[1];
  }
  try {
    const nav = performance.getEntriesByType('navigation')[0];
    if (nav?.type === 'reload') return sessionStorage.getItem(STORE);
  } catch {}
  return null;
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
