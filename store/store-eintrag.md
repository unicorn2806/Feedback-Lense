# Store-Eintrag – Feedback Lens 1.13.0

Alle Texte zum Kopieren in das Chrome Web Store Developer Dashboard (und Microsoft Partner Center für Edge). Felder in der Reihenfolge des Dashboards.

---

## 1. Paket

Datei: `feedback-lens-1.13.0-chrome-web-store.zip` (Ordner `dist/`) – `manifest.json` liegt auf oberster Ebene.

---

## 2. Store-Eintrag (Registerkarte „Store listing“)

**Name** (kommt aus dem Manifest): Feedback Lens – Web-Apps testen & anmerken

**Kurzbeschreibung** (kommt aus dem Manifest, max. 132 Zeichen):
Web-Apps testen: Probleme direkt am Element anmerken – mit Screenshot und Technik-Kontext als Paket für Claude Code. Alles lokal.

**Kategorie:** Entwicklertools (Developer Tools)

**Sprache:** Deutsch (optional zusätzlich Englisch, Text unten)

### Ausführliche Beschreibung (Deutsch)

```
Feedback Lens macht manuelles Testen von Webanwendungen einfach – und das Ergebnis direkt umsetzbar.

Du klickst dich durch die Anwendung und markierst alles, was besser werden kann: ein Element, einen Bereich oder die ganze Seite. Zu jeder Anmerkung hält Feedback Lens automatisch fest, was die Entwicklung braucht, um die Stelle schnell zu finden und das Problem nachzustellen. Am Ende lädst du ein Paket herunter, das Entwickler:innen – oder ein Coding-Assistent wie Claude Code – direkt abarbeiten können.

ANMERKEN, WO ES PASSIERT
• Element markieren (Alt+Shift+E), Bereich aufziehen (Alt+Shift+D) oder Notiz zur ganzen Seite (Alt+Shift+S)
• Kategorie, Priorität, Beschreibung und Erwartung – im Screenshot Rahmen, Kreise, Pfeile und Linien in vier Farben setzen, nummerieren (mit Notiz je Nummer), die letzten Klicks einzeichnen oder Vertrauliches schwärzen; fensterfüllend und auch später im Dashboard
• Mehrere Screenshots pro Anmerkung – z. B. für einen Ablauf oder dieselbe Stelle auf einer anderen Seite; im Dashboard auch Bilder einfügen (Strg+V)
• „Kurz zur Seite“: den Dialog parken, in der Anwendung nachsehen und weiterschreiben – der Entwurf übersteht auch Neuladen und Seitenwechsel
• Diktieren statt tippen – Spracherkennung ausschließlich auf deinem Gerät

SCHNELL-ANMERKUNG FÜR DEN CHAT
• Ohne Testlauf auf jeder Seite: Element, Bereich oder Seite markieren, kurz beschreiben, „Kopieren“ – Text und Screenshot landen in der Zwischenablage, zum Einfügen in Claude, ChatGPT & Co.
• Wählbares Ziel: KI-Chat (Markdown), Teams/Outlook/Word (formatiert, Bild im Text) oder Ticket/E-Mail (schlichter Text) – als Standard in den Einstellungen und je Anmerkung
• Im Testlauf: „Speichern & kopieren“ teilt eine Anmerkung sofort

AUTOMATISCH ERFASST
• Screenshot mit roter Markierung (Ausschnitt und ganze Ansicht)
• Kürzeste Schritte zum Nachstellen aus dem Klickpfad (Eingaben nur als Länge, nie der Inhalt)
• Was nach dem Klick passierte: fehlgeschlagene Anfragen mit Antwortauszug und Request-ID, Konsolenfehler, angezeigte Fehlermeldungen, Seitenwechsel – mit Zeitabstand
• Suchbegriffe, nach Verlässlichkeit sortiert: data-testid, IDs, Feldnamen, Meldungstexte, API-Pfade, sichtbare Texte, CSS-Klassen, Komponentennamen (React, Vue, Angular, Svelte im Entwicklungs-Build)
• Gerendertes HTML, Styles, Kontrast nach WCAG, Barrierefreiheits-Hinweise – Auffälligkeiten ohne Bezug als „Nebenbefund“ gekennzeichnet

DAS PAKET FÜR DIE ENTWICKLUNG
• README mit Anleitung für Claude Code, Kontext, App-Version und Liste nach Priorität
• Beim Export eine Nachricht an die Entwicklung mitgeben (z. B. Reihenfolge, was warten kann) – steht ganz oben, Claude Code liest sie zuerst
• Eine Markdown-Datei pro Anmerkung, Screenshots, vollständiger Klickpfad, JSON und HTML-Bericht
• Festes Format, in dem die Entwicklung das Ergebnis je Punkt festhält (erledigt, vorläufig, Rückfrage, abgelehnt)
• Bericht zum Lesen im Browser: aufklappbare Liste mit Suche und Filtern, technische Fehler und Klickpfad als Zeitleiste – vorab als Vorschau im Dashboard
• Im Bericht entscheiden, was umgesetzt wird – z. B. als Product Owner: umsetzen, anders umsetzen, nicht umsetzen oder zurückstellen, mit Kommentar; als fertiger Auftrag für Claude Code mit Vorrang vor dem Vorschlag der testenden Person
• Doppelte Anmerkungen werden schon beim Testen erkannt

TESTPLAN
• Prüfpunkte vorab festlegen – im Dashboard oder als Markdown-Datei (z. B. von der Entwicklung oder von Claude Code)
• Beim Testen abhaken: in Ordnung (mit Beleg-Screenshot), Problem (mit Anmerkung) oder nicht testbar
• Der Export zeigt die Testabdeckung und enthält den Plan für die nächste Runde

NACHTEST IN DER NEUEN VERSION
• Frühere Anmerkungen der Reihe nach prüfen: behoben, besteht weiter, verändert oder nicht prüfbar
• Gemessener Vergleich vorher/nachher (z. B. Kontrast, was der Klick auslöst) mit Screenshots aus beiden Versionen
• Paket enthält nur, was noch offen ist – plus neue Funde; die Ergebnisse der Entwicklung lassen sich einlesen

ALLES LOKAL
• Keine Anmeldung, kein Server, kein Tracking: Feedback Lens sendet keine Daten ins Netz.
• Aktiv nur auf den Domains, für die du einen Testlauf startest – und für eine Schnell-Anmerkung nur in dem Tab, in dem du sie auslöst.
• Passwörter, Tokens, API-Schlüssel, Kartennummern, IBAN und E-Mail-Adressen werden vor dem Speichern automatisch geschwärzt – in Texten, HTML, Meldungen, Konsole und Fehlerantworten; sensible URL-Parameter werden maskiert. Eingaben in Formularfelder werden nie gespeichert.
• Im Unternehmen lassen sich die erlaubten Domains per Browser-Richtlinie festlegen.
• Der Export ist eine ZIP-Datei auf deinem Rechner – du entscheidest, wem du sie gibst.

Hinweis: Claude Code ist ein Produkt von Anthropic. Feedback Lens ist ein unabhängiges Werkzeug und steht in keiner Verbindung zu Anthropic.
```

### Detailed description (English, optional second listing language)

```
Feedback Lens makes manual testing of web applications easy – and the result directly actionable.

Click through the app and mark whatever could be better: an element, an area or the whole page. For every annotation Feedback Lens records what developers need to find the spot and reproduce the problem. At the end you download a package that developers – or a coding assistant such as Claude Code – can work through directly.

ANNOTATE WHERE IT HAPPENS
• Mark an element (Alt+Shift+E), draw an area (Alt+Shift+D) or note the whole page (Alt+Shift+S)
• Category, priority, description and expectation – draw frames, circles, arrows and lines in four colours on the screenshot, number things (with a note per number), show your last clicks as steps or black out confidential parts; full-window and later in the dashboard
• Several screenshots per annotation – e.g. for a sequence or the same spot on another page; paste pictures in the dashboard (Ctrl+V)
• "Set aside": park the dialog, check something in the app and continue writing – the draft survives reloads and page changes
• Dictate instead of typing – speech recognition runs on your device only

CAPTURED AUTOMATICALLY
• Screenshot with red highlight (crop and full view)
• Shortest steps to reproduce from the click trail (input only as its length, never the content)
• What happened after the click: failed requests with response excerpt and request ID, console errors, error messages shown, navigation – with timing
• Search terms ranked by reliability: data-testid, IDs, field names, message texts, API paths, visible texts, CSS classes, component names (React, Vue, Angular, Svelte in development builds)
• Rendered HTML, styles, WCAG contrast, accessibility hints – unrelated findings marked as side notes

THE PACKAGE FOR DEVELOPERS
• README with instructions for Claude Code, context, app version and a list by priority
• One Markdown file per annotation, screenshots, full click trail, JSON and an HTML report
• A fixed format for developers to record the result of each item (done, partial, question, rejected)
• A report to read in the browser: expandable list with search and filters, technical errors and the click trail as a timeline – previewed in the dashboard
• Pick in the report what to implement – as a ready task for Claude Code; duplicates are recognised while testing

TEST PLAN
• Define checkpoints up front – in the dashboard or as a Markdown file (e.g. from developers or Claude Code)
• Tick them off while testing: OK (with a screenshot as proof), problem (with an annotation) or not testable
• The export shows the test coverage and includes the plan for the next round

RE-TEST IN THE NEW VERSION
• Go through earlier annotations one by one: fixed, still there, changed or not testable
• Measured before/after comparison (e.g. contrast, what a click triggers) with screenshots from both versions
• The package contains only what is still open – plus new findings; developers' results can be imported

EVERYTHING STAYS LOCAL
• No account, no server, no tracking: Feedback Lens sends no data over the network.
• Active only on the domains you start a test run for.
• Passwords, tokens, API keys, card numbers, IBANs and e-mail addresses are redacted automatically before storing – in texts, HTML, messages, console output and error responses; sensitive URL parameters are masked. Form input is never stored.
• Companies can restrict the allowed domains via browser policy.
• The export is a ZIP file on your computer – you decide who gets it.

The user interface is in German.

Note: Claude Code is a product of Anthropic. Feedback Lens is an independent tool and not affiliated with Anthropic.
```

### Grafiken (Ordner `store/`)

| Feld | Datei | Größe |
|---|---|---|
| Store-Icon | im ZIP enthalten (`icons/icon128.png`) | 128×128, Motiv 96×96 mit 16 px Rand |
| Screenshot 1 | `screenshots/1-anmerken-am-element.png` | 1280×800 |
| Screenshot 2 | `screenshots/2-dashboard.png` | 1280×800 |
| Screenshot 3 | `screenshots/3-paket-fuer-claude-code.png` | 1280×800 |
| Screenshot 4 | `screenshots/4-nachtest-liste.png` | 1280×800 |
| Screenshot 5 | `screenshots/5-vorher-nachher.png` | 1280×800 |
| Kleine Werbekachel (Pflicht) | `werbekacheln/kachel-klein-440x280.png` | 440×280 |
| Große Werbekachel (optional) | `werbekacheln/kachel-gross-1400x560.png` | 1400×560 |

Alle Bilder sind PNG ohne Transparenz (24 Bit). Erzeugt aus der echten Erweiterung gegen die Demo-App: `node tools/store-assets.mjs`.

**Website / Support-URL** (optional): z. B. die Seite des Projekts oder eine Kontakt-Adresse.

---

## 3. Datenschutz (Registerkarte „Privacy practices“)

### Einziger Zweck (Single purpose)

```
Webanwendungen manuell testen: Probleme direkt auf der getesteten Seite anmerken (mit Screenshot und technischem Kontext) und als Paket für die Entwicklung exportieren.
```

### Begründungen der Berechtigungen

**storage**
```
Speichert Testläufe, Anmerkungen, Screenshots und Einstellungen lokal im Browser (chrome.storage.local). Es gibt keinen Server; die Daten verlassen das Gerät nur, wenn der Nutzer selbst einen Export herunterlädt und weitergibt.
```

**unlimitedStorage**
```
Jede Anmerkung enthält Screenshots (bis etwa 1 MB). Ein Testlauf mit vielen Anmerkungen überschreitet das Standardlimit von chrome.storage.local schnell. Alle Daten bleiben lokal; der Nutzer kann sie jederzeit löschen.
```

**scripting**
```
Blendet die Feedback-Leiste und die Fehlererfassung (Konsole, fehlgeschlagene Anfragen, Klickpfad) per chrome.scripting.registerContentScripts/executeScript ein – ausschließlich auf den Domains, für die der Nutzer ausdrücklich einen Testlauf gestartet hat. Beim Beenden des Testlaufs werden die Skripte wieder abgemeldet. Für eine Schnell-Anmerkung (Tastenkürzel oder Menü) wird der Dialog per executeScript in genau den Tab geladen, in dem der Nutzer sie auslöst – ohne Fehlererfassung; er entfernt sich nach dem Kopieren oder Abbrechen wieder.
```

**offscreen**
```
Lokales Diktat im Anmerkungsdialog: Die Spracherkennung (Web Speech API mit processLocally, also nur auf dem Gerät) läuft in einem Offscreen-Dokument der Erweiterung. So gehört die Mikrofon-Freigabe der Erweiterung und nicht der getesteten Website. Ohne lokale Erkennung bleibt das Diktat aus; es wird nie Sprache an einen Server geschickt.
```

**Host-Berechtigung `<all_urls>`**
```
Feedback Lens testet beliebige Webanwendungen – Staging-, interne oder lokale Umgebungen, deren Adressen vorher nicht bekannt sind. Die Berechtigung wird benötigt, um (1) auf der Domain, für die der Nutzer einen Testlauf startet, die Leiste einzublenden und Fehler zu erfassen, und (2) Screenshots mit chrome.tabs.captureVisibleTab aufzunehmen, wenn der Nutzer in der Leiste auf der Seite „Element markieren“ wählt – activeTab reicht dafür nicht, weil diese Aktion nicht über das Erweiterungssymbol ausgelöst wird. Auf Seiten ohne laufenden Testlauf lädt die Erweiterung nichts – außer der Nutzer löst dort ausdrücklich eine Schnell-Anmerkung aus (dann nur in diesem Tab und bis sie kopiert oder abgebrochen ist). Nachrichten aus Seiten werden nur angenommen, wenn deren Domain zum laufenden Testlauf gehört bzw. der Tab der gerade ausgelösten Schnell-Anmerkung ist. Sie macht keine eigenen Netzwerkanfragen und überträgt keine Daten. Unternehmen können die erlaubten Domains über die Richtlinie ExtensionSettings (runtime_allowed_hosts / runtime_blocked_hosts) festlegen.
```

### Remote-Code

```
Nein. Sämtlicher Code ist im Paket enthalten; es wird kein Code nachgeladen oder ausgeführt, der nicht im Paket steht.
```

### Datennutzung (Data usage)

Die Erweiterung **verarbeitet und speichert** die folgenden Daten, **überträgt sie aber nie** – sie bleiben im Browser, bis der Nutzer selbst exportiert. Ob lokal gespeicherte Daten anzugeben sind, legt Google im Formular nicht eindeutig fest; die transparente (empfohlene) Variante ist, sie anzukreuzen:

- ☑ **Website-Inhalte** (Screenshots, Texte und HTML der markierten Stellen, angezeigte Meldungen – Passwörter, Tokens, Kartennummern, IBAN und E-Mail-Adressen darin werden vor dem Speichern geschwärzt)
- ☑ **Nutzeraktivität** (Klicks und Eingaben im Klickpfad – bei Eingaben nur die Länge, nie der Inhalt)
- ☑ **Webprotokoll** (Adressen und Titel der Seiten, die während eines Testlaufs besucht werden; sensible Parameter maskiert)
- ☐ alle übrigen Kategorien (personenbezogene Daten, Gesundheit, Finanzen, Authentifizierung, persönliche Kommunikation, Standort) – nicht angekreuzt. Hinweis: Screenshots zeigen, was auf dem Bildschirm war; das steht in der Datenschutzerklärung.

Und alle drei Bestätigungen ankreuzen:
- ☑ Keine Weitergabe/kein Verkauf an Dritte außerhalb der genehmigten Anwendungsfälle
- ☑ Keine Nutzung zu Zwecken, die nichts mit dem einzigen Zweck zu tun haben
- ☑ Keine Nutzung zur Bewertung der Kreditwürdigkeit oder für Kredite

### Datenschutzerklärung

URL der veröffentlichten Seite `datenschutz.html` (siehe Checkliste, Schritt 3) – eine eigene Seite, nicht die Startseite eines Repositorys.

---

## 4. Hinweise für die Prüfung (Feld „Test instructions“ o. ä., falls angeboten)

```
Keine Anmeldung nötig, kein Server.
1. Eine beliebige Website öffnen, z. B. https://example.com
2. Auf das Feedback-Lens-Symbol klicken → „Testlauf auf dieser Seite starten“. Unten rechts erscheint die Leiste.
3. In der Leiste das Fadenkreuz wählen (oder Alt+Shift+E), ein Element anklicken, Beschreibung eingeben, „Speichern“.
4. Im Popup „Beenden & exportieren“: Das Dashboard öffnet sich und lädt das Paket (ZIP) herunter.
Die Erweiterung ist nur auf Domains aktiv, für die ein Testlauf gestartet wurde. Sie macht keine Netzwerkanfragen.
```

---

## 5. Sichtbarkeit (Registerkarte „Distribution“)

- **Öffentlich** – im Store auffindbar.
- **Nicht gelistet** – nur über den direkten Link installierbar (empfohlen für ein Werkzeug im eigenen Team).
- **Privat** – nur für Konten der eigenen Google-Workspace-Domain bzw. Testgruppen.

Regionen: alle (oder nach Bedarf). Preis: kostenlos.
