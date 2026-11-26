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

## Technik

- Barcode/Aztec: [zxing-wasm](https://github.com/Sec-ant/zxing-wasm) (zxing-cpp), Apache-2.0
- Texterkennung: [Tesseract.js](https://github.com/naptha/tesseract.js) v5 mit `eng` (best_int), Apache-2.0
- Alle Bibliotheken liegen in `vendor/`, es gibt keine Abhängigkeit von CDNs. Beim ersten Laden kommen etwa 8 MB, danach liegen sie im Cache (Service Worker).
- Logik: `brands.js` (Markenerkennung, Feld-Extraktion), `app.js` (Kamera, Ablauf, UI)

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
