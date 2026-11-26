# Gutschein-Check

Web-App (PWA) zum Auslesen von Geschenkkarten per Kamera. Sie erkennt Marke, Kartennummer und PIN/Code und verlinkt die passende Guthaben-Prüfseite.

- läuft komplett im Browser, ohne Server, ohne KI-Tokens, ohne laufende Kosten
- Fotos und Kartendaten verlassen das Gerät nicht
- per Link aufs Handy legen („Zum Home-Bildschirm“)

## Unterstützte Karten

| Marke | Quelle Nummer | Felder für die Prüfseite |
|---|---|---|
| dm | Text (OCR) | Kartennummer (8 Zeichen) + Code; alternativ 24-stellige Barcode-Nummer |
| ALDI (Helaba) | GS1-Barcode, AI `90` | Gutscheinnummer (20-stellig) + PIN |
| Lidl | GS1-Barcode, AI `90` | Gutscheinnummer (20-stellig) + PIN |
| REWE | Aztec-Code, erste 13 Ziffern | Kartennummer + PIN |
| EDEKA (A1 Bank) | GS1-Barcode `(01)…(21)…` | kurzes Feld (6) + langes Feld (14) + PIN |

Barcode-Werte sind exakt. PIN und Code kommen aus der Texterkennung (oft auf Hologramm-Untergrund) und werden markiert, wenn sie unsicher sind.

## So erkennt die App die Karte

1. **Barcode-Bereich finden** (`vision.js`): sucht Stellen mit vielen parallelen Kanten. Das klappt auch, wenn der Barcode zu klein oder unscharf zum Dekodieren ist. Daraus ergeben sich Lage, Größe und Drehung der Karte.
2. **Barcode lesen**: eingebaute `BarcodeDetector`-API des Browsers (falls vorhanden), sonst zxing. Zuerst wird das ganze Bild versucht, dann der gerade gedrehte und vergrößerte Barcode-Ausschnitt mit mehreren Schwellwerten.
3. **Klartext-Nummer unter dem Barcode** lesen, wenn der Barcode nicht lesbar ist. Die Ziffernzeile wird eng zugeschnitten und mehrfach gelesen. Die Lesungen stimmen nach dem bekannten Druckbild ab (ALDI 4-4-4-4-4, EDEKA 3-7-1-3-2-2-4-4-4-2). Solche Werte gelten als unsicher, bis zwei Kamerabilder dasselbe ergeben.
4. **PIN an der bekannten Stelle** lesen: ALDI im Hologramm-Feld rechts oberhalb des Barcodes, EDEKA auf dem Silberstreifen oben links. Sonst über die Beschriftung („Code“, „PIN“).
5. **Kamera-Modus**: Nach einem Treffer sammelt die App noch ca. 0,7 s Bilder und wertet das schärfste aus. Fehlt etwas oder ist etwas unsicher, versucht sie es mit bis zu 3 Bildern und führt die Ergebnisse zusammen.

Tipp: Karte so nah halten, dass sie den Rahmen fast füllt. Laptop-Webcams (oft 720p, Fixfokus) liefern bei kleinen Karten zu wenig Schärfe. Mit der Handykamera geht es meist deutlich besser.

## Handy als Kamera (QR-Code)

Am Rechner „Handy als Kamera verbinden“ wählen und den QR-Code mit dem Handy scannen. Das Handy erkennt die Karte selbst. Nur das Ergebnis (Marke, Nummer, PIN, Rohtext) geht direkt an den Rechner, dort wird kopiert.

- Verbindung per WebRTC über [PeerJS](https://peerjs.com/docs/). Die Daten sind Ende-zu-Ende verschlüsselt (DTLS). Der kostenlose PeerJS-Vermittlungsserver sieht nur die zufällige Verbindungs-ID. Klappt keine Direktverbindung, etwa bei Mobilfunk oder strengem NAT, leitet der öffentliche PeerJS-TURN-Server die weiterhin verschlüsselten Daten weiter.
- Die ID ist eine zufällige UUID, gilt nur für diese Sitzung, und es kann sich nur ein Handy gleichzeitig verbinden. Empfangene Daten werden nur als Text angezeigt.
- Der Rechner muss die Seite über die öffentliche Adresse geöffnet haben (nicht `localhost`), sonst führt der QR-Link ins Leere.
- Ein anderer PeerJS-Server lässt sich über `window.GC_PEER_OPTIONS` setzen (z. B. für Tests).

## Technik

- Barcode/Aztec: [zxing-wasm](https://github.com/Sec-ant/zxing-wasm) (zxing-cpp), Apache-2.0
- Texterkennung: [Tesseract.js](https://github.com/naptha/tesseract.js) v5 mit `eng` (best_int), Apache-2.0
- Kopplung: [PeerJS](https://github.com/peers/peerjs) 1.5.5, MIT; QR-Code: [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 2.0.4, MIT
- Alle Bibliotheken liegen in `vendor/`, es gibt keine Abhängigkeit von CDNs. Beim ersten Laden kommen etwa 8 MB, danach liegen sie im Cache (Service Worker).
- Logik: `brands.js` (Markenerkennung, Feld-Extraktion, Lage der Felder), `vision.js` (Barcode-Bereich, Zuschnitt, Ziffernzeilen, Schärfe), `pair.js` (Kopplung Handy ↔ Rechner), `app.js` (Kamera, Ablauf, UI)

## Lokal starten

```bash
python3 -m http.server 8000
```

Dann <http://localhost:8000> öffnen. Die Kamera braucht `localhost` oder HTTPS.

## Veröffentlichen (kostenlos)

Es sind nur statische Dateien, ohne Build-Schritt.

- **GitHub Pages:** Settings → Pages → „Deploy from a branch“ → `main` / root
- **Cloudflare Pages:** Repo verbinden, Build-Befehl leer lassen, Ausgabeordner `/`

Suchmaschinen sind per `robots.txt` und `noindex` ausgesperrt.

## Wichtig

Niemals echte Kartenfotos committen. Nummer und PIN sind praktisch Bargeld. `.gitignore` blockiert `*.jpg`, `*.jpeg` und `*.heic`.
