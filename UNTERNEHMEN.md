# Feedback Lens im Unternehmen: Domains per Richtlinie festlegen

Feedback Lens braucht die Berechtigung „auf allen Websites“, weil es beliebige Anwendungen testen können soll. Aktiv wird es nur auf den Domains eines laufenden Testlaufs, und es prüft bei jeder Anfrage aus einer Seite, ob diese zum Testlauf gehört.

Wer das zusätzlich **hart begrenzen** will, legt per Browser-Richtlinie fest, auf welchen Domains die Erweiterung überhaupt arbeiten darf. Auf allen anderen Seiten kann sie dann weder Skripte ausführen noch Screenshots machen – auch nicht durch einen Fehler in der Erweiterung oder ein manipuliertes Update. Die Sperre setzt der Browser durch, nicht die Erweiterung.

## Vorlage

```json
{
  "ExtensionSettings": {
    "ERWEITERUNGS-ID": {
      "runtime_blocked_hosts": ["*://*"],
      "runtime_allowed_hosts": [
        "*://*.staging.example.com",
        "*://test.example.com",
        "*://localhost"
      ]
    }
  }
}
```

- `runtime_blocked_hosts: ["*://*"]` sperrt alle Websites, `runtime_allowed_hosts` gibt die Testsysteme wieder frei. Freigaben haben Vorrang vor Sperren.
- Muster: `Schema://Host`, ohne Pfad und ohne Port. `*://*.example.com` erfasst `example.com` und alle Subdomains, `https://test.example.com` nur genau diese Adresse über HTTPS.
- Höchstens 100 Einträge je Liste.
- `ERWEITERUNGS-ID` durch die ID ersetzen (siehe unten).

**Vor dem Rollout testen:** Die Kombination „alles sperren (`*://*`), Testsysteme freigeben“ ist mit Chrome 153 geprüft (`test/security.mjs`, Abschnitt „Richtlinie“): Auf einer gesperrten Domain lehnt Feedback Lens den Start mit einer Meldung ab und kann keinen Screenshot machen, auf einer freigegebenen Domain funktioniert alles normal. Bitte mit der eigenen Browser-Version einmal nachprüfen (siehe „Prüfen“).

## Erweiterungs-ID

- **Aus dem Chrome Web Store:** die 32 Buchstaben am Ende der Store-Adresse (`chromewebstore.google.com/detail/feedback-lens/<ID>`). Microsoft Edge Add-ons vergibt eine eigene ID.
- **Entpackt geladen:** `chrome://extensions` → Feedback Lens → „Details“ → ID. Sie hängt vom Ordner ab, aus dem geladen wurde.

## Verteilen

| Umgebung | Wo |
|---|---|
| **Windows** (Gruppenrichtlinie, Intune) | Mit den ADMX-Vorlagen von Chrome bzw. Edge: „Einstellungen für die Erweiterungsverwaltung konfigurieren“ und das JSON (nur den Inhalt von `ExtensionSettings`) in einer Zeile eintragen. Direkt in der Registry: Zeichenfolge `ExtensionSettings` unter `HKLM\Software\Policies\Google\Chrome` bzw. `HKLM\Software\Policies\Microsoft\Edge`. |
| **macOS** (Jamf, Intune, Kandji …) | Konfigurationsprofil für `com.google.Chrome` bzw. `com.microsoft.Edge` mit dem Schlüssel `ExtensionSettings` (Beispiel unten). |
| **Linux** | JSON-Datei (Vorlage oben) ablegen in `/etc/opt/chrome/policies/managed/` (Chrome), `/etc/chromium/policies/managed/` (Chromium) bzw. `/etc/opt/edge/policies/managed/` (Edge). |
| **Google Admin-Konsole** (Chrome Enterprise Core) | Geräte → Chrome → Apps und Erweiterungen → Feedback Lens auswählen → bei den Host-Einstellungen die gesperrten und zulässigen Hosts eintragen (entspricht `runtime_blocked_hosts` / `runtime_allowed_hosts`). |

Registry-Datei (Windows, Chrome):

```reg
Windows Registry Editor Version 5.00

[HKEY_LOCAL_MACHINE\Software\Policies\Google\Chrome]
"ExtensionSettings"="{\"ERWEITERUNGS-ID\":{\"runtime_blocked_hosts\":[\"*://*\"],\"runtime_allowed_hosts\":[\"*://*.staging.example.com\",\"*://localhost\"]}}"
```

Konfigurationsprofil (macOS, Ausschnitt aus dem Payload für `com.google.Chrome`):

```xml
<key>ExtensionSettings</key>
<dict>
  <key>ERWEITERUNGS-ID</key>
  <dict>
    <key>runtime_blocked_hosts</key>
    <array><string>*://*</string></array>
    <key>runtime_allowed_hosts</key>
    <array>
      <string>*://*.staging.example.com</string>
      <string>*://localhost</string>
    </array>
  </dict>
</dict>
```

Gibt es schon eine `ExtensionSettings`-Richtlinie (z. B. für andere Erweiterungen), den Eintrag für Feedback Lens dort ergänzen – die Richtlinie ist ein einziges Objekt für alle Erweiterungen.

Optional lässt sich Feedback Lens im selben Eintrag für alle installieren: `"installation_mode": "force_installed"` und `"update_url": "https://clients2.google.com/service/update2/crx"` (Chrome Web Store).

## Prüfen

1. `chrome://policy` (bzw. `edge://policy`) öffnen, „Richtlinien neu laden“: `ExtensionSettings` muss mit Status „OK“ erscheinen.
2. Eine nicht freigegebene Website öffnen und im Feedback-Lens-Menü einen Testlauf starten: Es erscheint „Diese Domain ist für Feedback Lens durch eine Richtlinie deines Unternehmens gesperrt“.
3. Ein freigegebenes Testsystem öffnen und einen Testlauf starten: Werkzeugleiste erscheint, Anmerkung mit Screenshot funktioniert.

## Was die Richtlinie nicht abdeckt

Auf den freigegebenen Testsystemen arbeitet Feedback Lens ganz normal: Es nimmt Screenshots, HTML-Ausschnitte, Meldungen und technische Fehler auf. Deshalb dort möglichst mit Testdaten arbeiten und die Einstellung „Sensible Daten schwärzen“ eingeschaltet lassen (Standard). Vertrauliches auf einem Screenshot lässt sich im Anmerkungsdialog mit „Schwärzen“ übermalen.
