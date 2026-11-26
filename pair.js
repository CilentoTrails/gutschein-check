// Handy als Kamera: Rechner und Handy per WebRTC (PeerJS) koppeln.
// Der Rechner zeigt einen QR-Code mit einer zufälligen Verbindungs-ID. Das Handy öffnet den Link,
// erkennt die Karte selbst und schickt nur das Ergebnis direkt (verschlüsselt) an den Rechner.
// Der PeerJS-Vermittlungsserver sieht nur die ID, keine Kartendaten.
//
// Robustheit:
// - Mehrere Verbindungen vom Handy werden angenommen (QR-Scanner öffnen Links oft doppelt, Seite neu geladen …).
// - Der Rechner bestätigt jedes Ergebnis (ack). Ohne Bestätigung sendet das Handy erneut bzw. meldet es.
// - Das Handy schickt regelmäßig ein Lebenszeichen und verbindet sich nach Abbrüchen neu
//   (z. B. nach Bildschirmsperre), solange die Seite offen ist. Beim Zurückkehren zur Seite
//   sofort, ohne Wartezeit. Fällt der Vermittlungsdienst ganz aus, wird neu angemeldet.
// - Ergebnisse warten bis zu 2 Minuten auf die Verbindung, statt verloren zu gehen.
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

// Verbindung zum Vermittlungsserver nach Abbruch neu aufbauen: kurze, wachsende Pause (max. 10 s),
// beim Zurückkehren zur Seite sofort.
function keepSignaling(getPeer) {
  let retry = 0;
  let timer = null;
  const now = () => {
    clearTimeout(timer);
    const peer = getPeer();
    if (peer && !peer.destroyed && peer.disconnected) peer.reconnect();
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(now, Math.min(10000, 1000 * 2 ** retry++));
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { retry = 0; now(); }
  });
  return { opened: () => { retry = 0; }, lost: later };
}

/* ---------- Rechner ---------- */
export function startHost({ onState, onStatus, onResult }) {
  const id = PREFIX + crypto.randomUUID();
  let peer = null;
  let stopped = false;
  let announced = false;
  let conn = null;
  let lastSeen = 0;
  let alive = false;
  const seen = new Set(); // bereits angezeigte Ergebnisse (bei erneutem Senden nicht doppelt)
  const conns = new Set();
  const sig = keepSignaling(() => peer);

  function makePeer() {
    if (stopped) return;
    peer = new Peer(id, OPTS); // dieselbe ID auch nach einem Neustart, damit der QR-Code gültig bleibt
    peer.on('open', () => {
      sig.opened();
      if (announced) return;
      announced = true;
      const url = new URL(location.href);
      url.search = '';
      url.hash = 'pair=' + id.slice(PREFIX.length);
      onState('waiting', url.href);
    });
    peer.on('connection', accept);
    peer.on('disconnected', sig.lost);
    peer.on('error', (e) => {
      // ID noch belegt (alte Anmeldung) oder Dienst weg: gleich noch einmal anmelden
      if (peer.destroyed) setTimeout(() => { if (peer.destroyed) makePeer(); }, 3000);
      if (!announced || !conns.size) onState('error', errText(e));
    });
  }

  // Alle offenen Verbindungen annehmen (QR-Scanner-Vorschau und Browser können beide offen sein);
  // was zuletzt Daten schickt, zählt als aktiv.
  function accept(c) {
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
  }

  // kein Lebenszeichen mehr (Handy gesperrt, Verbindung tot)
  const watch = setInterval(() => {
    if (conn && alive && Date.now() - lastSeen > PING_MS * 4) {
      alive = false;
      onState('idle');
    }
  }, 1000);
  const onVisible = () => { if (document.visibilityState === 'visible' && peer?.destroyed) makePeer(); };
  document.addEventListener('visibilitychange', onVisible);
  makePeer();
  return {
    stop: () => {
      stopped = true;
      clearInterval(watch);
      document.removeEventListener('visibilitychange', onVisible);
      peer?.destroy();
    },
  };
}

/* ---------- Handy ---------- */
export function startGuest(code, { onState }) {
  try { sessionStorage.setItem(STORE, code); } catch {}
  let peer = null;
  let conn = null;
  let connecting = false;
  let lastPong = 0;
  const waiting = new Map(); // n -> resolve
  let counter = 0;
  const sig = keepSignaling(() => peer);
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

  function makePeer() {
    peer?.destroy();
    peer = new Peer(OPTS);
    peer.on('open', () => { sig.opened(); connect(); });
    peer.on('disconnected', sig.lost);
    peer.on('error', (e) => {
      connecting = false;
      // Rechner gerade nicht angemeldet (z. B. Tab im Hintergrund): einfach weiter versuchen
      if (e.type === 'peer-unavailable') onState('waiting-host');
      else onState('error', errText(e));
      if (peer.destroyed) setTimeout(() => { if (peer.destroyed) makePeer(); }, 3000);
    });
  }

  function connect() {
    if (!peer?.open || connecting) return;
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

  function dropDead() {
    try { conn?.close(); } catch {}
    conn = null;
    onState('reconnecting');
  }

  // Lebenszeichen; tote Verbindung erkennen und neu verbinden
  const beat = setInterval(() => {
    if (conn?.open) {
      try { conn.send({ type: 'ping' }); } catch {}
      if (Date.now() - lastPong > PING_MS * 4) dropDead();
    } else if (peer?.destroyed) makePeer();
    else if (!connecting && peer?.open) connect();
  }, PING_MS);

  // Zurück zur Seite (Bildschirm wieder an, App gewechselt): sofort prüfen statt auf den Takt zu warten.
  // Nach dem Einfrieren ist eine scheinbar offene Verbindung oft tot -> ohne frisches Lebenszeichen neu.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (peer?.destroyed) return makePeer();
    if (conn?.open && Date.now() - lastPong > PING_MS * 1.5) dropDead();
    if (conn?.open) try { conn.send({ type: 'ping' }); } catch {}
    else if (peer?.open) { connecting = false; connect(); }
  });

  const send = (msg) => {
    if (!conn?.open) return false;
    try { conn.send(msg); return true; } catch { return false; }
  };

  // Ergebnis senden und auf Bestätigung warten. Ist gerade keine Verbindung da, wartet es
  // bis zu 2 Minuten darauf (z. B. während das Handy neu verbindet).
  async function result(r, onWait) {
    const n = Date.now().toString(36) + '-' + counter++;
    const msg = { type: 'result', n, data: pack(r) };
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      if (!send(msg)) {
        onWait?.();
        await sleep(1000);
        continue;
      }
      const ok = await new Promise((resolve) => {
        waiting.set(n, resolve);
        setTimeout(() => { if (waiting.get(n) === resolve) { waiting.delete(n); resolve(false); } }, ACK_MS);
      });
      if (ok) return true;
    }
    return false;
  }

  makePeer();
  return {
    status: (text) => send({ type: 'status', text: (text || '').slice(0, LIMIT) }),
    result,
    stop: () => { clearInterval(beat); peer?.destroy(); },
  };
}

// Kompakt: nur was der Rechner anzeigt (Rohtext gekürzt)
function pack(r) {
  return {
    brand: r.res.brand,
    fields: r.res.fields.map(({ key, label, value, check, unsure }) => ({ key, label, value, check, unsure })),
    barcodes: r.barcodes.map((b) => ({ format: b.format, text: b.text })),
    lines: r.lines.slice(0, 40).map((l) => ({ text: l.text.slice(0, 120) })),
    numberLines: (r.numberLines || []).filter((l) => !l.alt).map((l) => ({ text: l.text })),
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
