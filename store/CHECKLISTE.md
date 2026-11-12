# Checkliste: Feedback Lens in den Store bringen

Alles, was du hochlädst oder einträgst, liegt in diesem Ordner; die Texte zum Kopieren stehen in [store-eintrag.md](store-eintrag.md).

## Inhalt dieses Pakets

| Datei | Wofür |
|---|---|
| `feedback-lens-1.14.0-chrome-web-store.zip` | das hochzuladende Paket (`manifest.json` auf oberster Ebene) |
| `store-eintrag.md` | Beschreibung (DE/EN), Kategorie, Zweck, Begründung jeder Berechtigung, Angaben zur Datennutzung, Hinweise für die Prüfung |
| `datenschutz.html` | Datenschutzerklärung (DE/EN) – Kontaktdaten eintragen und veröffentlichen |
| `screenshots/` | 5 Screenshots, 1280×800 |
| `werbekacheln/` | kleine Kachel 440×280 (Pflicht im Chrome Web Store), große Kachel 1400×560 (optional) |
| `edge-logo-300x300.png` | Logo für Edge Add-ons |
| `UNTERNEHMEN.md` | für die IT: erlaubte Domains per Browser-Richtlinie festlegen (Vorlage für Windows, macOS, Linux, Admin-Konsole) |

---

## 1. Vorbereiten (einmalig)

- [ ] **Datenschutzerklärung ausfüllen:** In `datenschutz.html` die beiden gelb markierten Felder „Verantwortlich / Kontakt“ ersetzen (Name bzw. Firma, Anschrift, E-Mail).
- [ ] **Datenschutzerklärung veröffentlichen** – sie braucht eine eigene, öffentlich erreichbare Adresse:
  - eigene Website: Datei hochladen, z. B. `https://example.de/feedback-lens/datenschutz.html`, **oder**
  - GitHub Pages: neues öffentliches Repository anlegen, `datenschutz.html` hochladen, unter *Settings → Pages* „Deploy from a branch“ (main) wählen → Adresse `https://<name>.github.io/<repo>/datenschutz.html`.
- [ ] **Namen prüfen:** im Chrome Web Store nach „Feedback Lens“ suchen. Ist der Name vergeben, in `extension/manifest.json` (`name`, `short_name`) anpassen und mit `python3 tools/package.py` neu packen.
- [ ] **Entwicklerkonto anlegen:** Chrome Web Store Developer Dashboard (`https://chrome.google.com/webstore/devconsole`) mit einem Google-Konto öffnen, Bedingungen annehmen, einmalige Registrierungsgebühr (5 $) bezahlen, Kontakt-E-Mail bestätigen. Für ein Team: eine gemeinsame Gruppe als Herausgeber einrichten oder ein eigenes Konto für das Team nutzen.

## 2. Im Chrome Web Store einreichen

- [ ] **Neues Element** → `feedback-lens-1.14.0-chrome-web-store.zip` hochladen.
- [ ] **Store-Eintrag:** ausführliche Beschreibung, Kategorie „Entwicklertools“, Sprache Deutsch; 5 Screenshots und die kleine Werbekachel hochladen (große Kachel optional). Texte: `store-eintrag.md`, Abschnitt 2.
- [ ] **Datenschutz:** einziger Zweck, Begründung für `storage`, `unlimitedStorage`, `scripting`, `offscreen` und die Host-Berechtigung, „Remote-Code: Nein“, Datennutzung ankreuzen, drei Bestätigungen, Adresse der Datenschutzerklärung. Texte: `store-eintrag.md`, Abschnitt 3.
- [ ] **Vertrieb:** Sichtbarkeit wählen – *Öffentlich*, *Nicht gelistet* (nur per Link; empfohlen fürs eigene Team) oder *Privat*; Regionen; kostenlos.
- [ ] **Zur Überprüfung einreichen.** Den Status zeigt das Dashboard; Rückfragen oder Ablehnungsgründe kommen per E-Mail. Wegen der Berechtigung für alle Websites ist mit einer genaueren Prüfung zu rechnen – die Begründung in `store-eintrag.md` erklärt, warum sie nötig ist und dass die Erweiterung nur auf Domains eines laufenden Testlaufs aktiv wird.
- [ ] Nach der Freigabe: Link zum Eintrag ans Team geben.

## 3. Optional: Microsoft Edge Add-ons (kostenlos)

- [ ] Im Microsoft Partner Center (`https://partner.microsoft.com/dashboard/microsoftedge`) ein Entwicklerkonto anlegen.
- [ ] **Neue Erweiterung** → dasselbe ZIP hochladen.
- [ ] Eintrag: Beschreibung aus `store-eintrag.md`, Logo `edge-logo-300x300.png`, Screenshots 1280×800, kleine Werbekachel 440×280; Datenschutzerklärung-Adresse; Hinweise für die Prüfung (Abschnitt 4).
- [ ] Zur Prüfung einreichen.

## 4. Später: Updates veröffentlichen

1. Änderungen machen und testen: `bash test/run-all.sh` (Playwright nötig, siehe README).
2. In `extension/manifest.json` die `version` erhöhen (z. B. `1.14.1` oder `1.15.0`) – der Store akzeptiert nur höhere Versionen.
3. `python3 tools/package.py` → neues `dist/feedback-lens-<version>-chrome-web-store.zip`.
4. Im Dashboard beim Element **„Neues Paket hochladen“**, einreichen. Installierte Erweiterungen aktualisieren sich danach automatisch.
5. Bei sichtbaren Änderungen die Store-Bilder neu erzeugen: `node tools/store-assets.mjs` (schreibt nach `store/`).
6. Kommt eine neue Berechtigung hinzu, müssen Nutzer ihr zustimmen, und die Begründung im Datenschutz-Abschnitt muss ergänzt werden. Ändert sich die Datenverarbeitung, auch `datenschutz.html` anpassen.
