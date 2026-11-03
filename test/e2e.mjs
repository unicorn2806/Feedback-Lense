// Full end-to-end test: annotate the demo app, then use the dashboard for
// editing and export the package a developer hands to Claude Code.
// Run: NODE_PATH=<dir containing playwright> node test/e2e.mjs
import { startServer } from './server.mjs';
import { launch } from './launch.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.FL_OUT || '/tmp/fl-e2e-out';
mkdirSync(OUT, { recursive: true });
const BASE = 'http://localhost:4173';

const failures = [];
const passes = [];
function check(cond, label, detail = '') {
  (cond ? passes : failures).push(cond ? label : `${label}${detail ? ` → ${detail}` : ''}`);
  console.log(`${cond ? '✔' : '✘'} ${label}${!cond && detail ? ` → ${detail}` : ''}`);
}

const server = await startServer(4173);
const { context, sw, extUrl, cleanup } = await launch();
const errors = [];
// The extension must work fully offline: no request may leave this machine.
const external = [];
context.on('request', (r) => {
  const u = new URL(r.url());
  if (['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol) && !['localhost', '127.0.0.1'].includes(u.hostname)) external.push(r.url());
});
const watch = (page, name) => {
  page.on('pageerror', (e) => errors.push(`[${name} pageerror] ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`[${name} console.error] ${m.text()}`));
};
const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`) });
const storage = () => sw.evaluate(() => chrome.storage.local.get(null));

try {
  const app = await context.newPage();
  watch(app, 'app');
  await app.goto(`${BASE}/`);

  const ext = await context.newPage();
  watch(ext, 'ext');
  await ext.goto(extUrl('src/popup/popup.html'));
  const msg = (payload) => ext.evaluate((p) => chrome.runtime.sendMessage(p), payload);
  const command = (action) =>
    sw.evaluate(async (action) => {
      const [tab] = await chrome.tabs.query({ url: 'http://localhost:4173/*' });
      await chrome.tabs.sendMessage(tab.id, { type: 'fl:command', action });
    }, action);

  const start = await msg({ type: 'fl:startSession', name: 'Bestellportal Review', url: `${BASE}/`, appContext: 'Online-Shop für Büromöbel, Zielgruppe Einkäufer in KMU. Fokus: Checkout.' });
  check(start.ok, 'Testlauf gestartet', JSON.stringify(start));

  await app.bringToFront();
  await app.waitForSelector('[data-feedback-lens]', { state: 'attached' });
  await app.waitForTimeout(400);

  const drawer = (sel) => app.locator(`.drawer ${sel}`);
  async function fillDrawer({ category, priority, title, description, expected }) {
    await drawer('textarea').first().waitFor();
    await app.waitForTimeout(150);
    if (category) await drawer(`.chip:has-text("${category}")`).click();
    if (priority) await drawer(`.seg button:has-text("${priority}")`).click();
    if (title) await drawer('input[type=text]').fill(title);
    await drawer('textarea').first().fill(description);
    if (expected) await drawer('textarea').nth(1).fill(expected);
  }
  const saveDrawer = async () => {
    await drawer('.btn.primary').click();
    await app.locator('.drawer').waitFor({ state: 'detached' });
    await app.waitForTimeout(300);
  };

  // --- #1 element: low-contrast hint text, with a pen stroke --------------
  await command('pick');
  const hint = await app.locator('.hint-text').boundingBox();
  await app.mouse.move(hint.x + 30, hint.y + hint.height / 2);
  await app.waitForTimeout(150);
  await app.mouse.click(hint.x + 30, hint.y + hint.height / 2);
  await fillDrawer({ category: 'Barrierefreiheit', priority: 'Hoch', title: 'Versandhinweis kaum lesbar', description: 'Der graue Hinweistext ist auf weißem Hintergrund kaum zu lesen.', expected: 'Dunklere Schrift, mindestens 14 px.' });
  const canvas = await drawer('canvas.preview').boundingBox();
  check(canvas && canvas.width > 100, 'Screenshot-Vorschau im Dialog sichtbar', JSON.stringify(canvas));
  await app.mouse.move(canvas.x + 40, canvas.y + 30);
  await app.mouse.down();
  await app.mouse.move(canvas.x + 140, canvas.y + 60, { steps: 6 });
  await app.mouse.up();
  await shot(app, '01-drawer-element');
  await saveDrawer();
  await shot(app, '02-after-save');

  // --- interactions: coupon (JS error), code input, Weiter (500 + slow) ----
  await app.click('#coupon');
  await app.fill('.code', 'SOMMER24');
  await app.locator('.code').blur();
  await app.click('#btn-next');
  await app.waitForURL(`${BASE}/lieferung`, { timeout: 8000 });
  await app.waitForTimeout(700);
  // submit the empty address form: the app shows a cryptic validation error
  await app.click('#address button[type=submit]');
  await app.waitForTimeout(1000);

  // --- #2 region over the address form -----------------------------------
  await command('region');
  const form = await app.locator('#address').boundingBox();
  await app.mouse.move(form.x - 10, form.y - 10);
  await app.mouse.down();
  await app.mouse.move(form.x + form.width + 10, form.y + form.height + 10, { steps: 8 });
  await shot(app, '03-region-drag');
  await app.mouse.up();
  await fillDrawer({ category: 'Bedienbarkeit', priority: 'Mittel', description: 'PLZ-Feld hat nur einen Platzhalter, keine Beschriftung. Fehlermeldung ist unverständlich.' });
  await shot(app, '04-drawer-region');
  await saveDrawer();

  // --- #3 element inside the shadow DOM banner ----------------------------
  await command('pick');
  const cta = await app.locator('promo-banner >> .promo-cta').boundingBox();
  await app.mouse.move(cta.x + 10, cta.y + 8);
  await app.waitForTimeout(150);
  await shot(app, '05-pick-shadow');
  await app.mouse.click(cta.x + 10, cta.y + 8);
  await fillDrawer({ category: 'Design / Layout', priority: 'Niedrig', description: 'Der Aktionsbanner lenkt im Checkout ab.' });
  await saveDrawer();

  // --- #4 back to cart, element with (fake) React component ---------------
  await app.click('nav a[href="/"]');
  await app.waitForURL(`${BASE}/`);
  await app.waitForTimeout(500);
  await command('pick');
  const next = await app.locator('#btn-next').boundingBox();
  await app.mouse.move(next.x + 10, next.y + 10);
  await app.keyboard.press('ArrowUp'); // parent …
  await app.keyboard.press('ArrowDown'); // … and back to the button
  await app.keyboard.press('Enter');
  await fillDrawer({ category: 'Fehler', priority: 'Kritisch', description: 'Klick auf „Weiter“ lädt ewig und dann kommt ein Serverfehler, ohne Hinweis für mich.' });
  await saveDrawer();

  // --- #5 page note --------------------------------------------------------
  await command('note');
  await fillDrawer({ category: 'Idee / Wunsch', description: 'Fortschrittsanzeige für den Checkout (Schritt 1 von 3) wäre hilfreich.' });
  await saveDrawer();
  await app.waitForTimeout(1800); // trail flush
  await shot(app, '06-pins');

  const pins = await app.locator('.pins .pin').count();
  check(pins >= 2, 'Pins für Anmerkungen auf dieser Seite angezeigt', `count=${pins}`);
  await app.locator('.pins .pin').first().click();
  await app.waitForTimeout(200);
  check(await app.locator('.popover').isVisible(), 'Pin öffnet Popover');
  await shot(app, '07-pin-popover');
  await app.mouse.click(5, 400);

  // --- storage assertions ----------------------------------------------------
  const data = await storage();
  const sid = data['fl:active'];
  const anns = data[`fl:ann:${sid}`] || [];
  const trail = data[`fl:trail:${sid}`] || [];
  const tech = data[`fl:tech:${sid}`] || [];
  writeFileSync(join(OUT, 'storage.json'), JSON.stringify({ anns, trail, tech }, null, 2));
  check(anns.length === 5, '5 Anmerkungen gespeichert', `got ${anns.length}`);
  const [a1, a2, a3, a4, a5] = anns;
  check(a1?.element?.contrast && !a1.element.contrast.passesAA, '#1 Kontrastproblem erkannt', JSON.stringify(a1?.element?.contrast));
  check(a1?.images?.drawn === true && data[`fl:img:${a1.id}:crop`]?.startsWith('data:image/'), '#1 Screenshot mit Stiftmarkierung gespeichert');
  check(a1?.priority === 'high' && a1?.category === 'a11y' && a1?.title === 'Versandhinweis kaum lesbar', '#1 Kategorie/Priorität/Titel korrekt');
  check(a2?.kind === 'region' && a2.region?.elements?.length > 0, '#2 Bereich mit enthaltenen Elementen', JSON.stringify(a2?.region?.elements?.slice(0, 3)));
  check(a2?.region?.container?.selector?.includes('address') || a2?.region?.container?.selector?.includes('form'), '#2 Container = Formular', a2?.region?.container?.selector);
  check(a3?.element?.inShadowDom && a3.element.selector.includes('>>>'), '#3 Element im Shadow DOM mit Deep-Selektor', a3?.element?.selector);
  check(a4?.component?.framework === 'React' && a4.component.components[0] === 'CheckoutButton' && a4.component.source === 'src/cart/CheckoutButton.jsx:14', '#4 React-Komponente + Quelldatei erkannt', JSON.stringify(a4?.component));
  check(a4?.element?.selector === '[data-testid="checkout-next"]', '#4 Selektor nutzt data-testid', a4?.element?.selector);
  check(a5?.kind === 'page' && data[`fl:img:${a5.id}:full`], '#5 Seitennotiz mit Vollbild');
  const net = tech.find((e) => e.type === 'network' && e.status === 500);
  check(net && net.requestUrl.includes('token=***') && !net.requestUrl.includes('geheim'), 'Netzwerkfehler 500 erfasst, Token maskiert', net?.requestUrl);
  check(tech.some((e) => e.type === 'error' && /TypeError/.test(e.message)), 'JS-Fehler (TypeError) erfasst');
  check(tech.some((e) => e.type === 'console' && /Checkout fehlgeschlagen/.test(e.message)), 'console.error erfasst');
  check(trail.some((e) => e.type === 'route' && e.url.endsWith('/lieferung')), 'SPA-Navigation im Klickpfad');
  check(trail.some((e) => e.type === 'input' && /8 Zeichen/.test(e.detail) && !JSON.stringify(e).includes('SOMMER')), 'Eingabe protokolliert ohne Inhalt');
  check(trail.some((e) => e.type === 'click' && e.label === 'Weiter'), 'Klick auf „Weiter“ protokolliert');
  check(a4?.techEvents?.some((e) => e.type === 'network'), '#4 enthält Netzwerkfehler der Seite');
  check(net?.body?.includes('payment-service unavailable') && net?.requestId === 'x-request-id: req-7f3a9c', 'Fehlerantwort: Auszug und Request-ID erfasst', JSON.stringify({ body: net?.body, id: net?.requestId }));
  check(tech.some((e) => e.type === 'console' && e.head === 'Checkout fehlgeschlagen'), 'Konsolenmeldung: Text ohne serialisierte Argumente');
  check(trail.some((e) => e.type === 'message' && e.label === 'Fehler 0x8004: Validierung fehlgeschlagen.'), 'Angezeigte Fehlermeldung im Klickpfad', JSON.stringify(trail.filter((e) => e.type === 'message')));
  check(trail.some((e) => e.type === 'submit' && e.selector === '#address'), 'Absenden mit Formular-Selektor protokolliert');
  check(a2?.page?.messages?.includes('Fehler 0x8004: Validierung fehlgeschlagen.'), '#2 sichtbare Meldung beim Anlegen erfasst', JSON.stringify(a2?.page?.messages));
  check(a1?.page?.appVersion === 'version: 2.3.1-demo', 'App-Version aus <meta> gelesen', a1?.page?.appVersion);

  // --- popup (active session) ---------------------------------------------
  await ext.setViewportSize({ width: 360, height: 520 });
  await ext.reload();
  await ext.waitForTimeout(300);
  await shot(ext, '08-popup');

  // --- dashboard -------------------------------------------------------------
  await ext.setViewportSize({ width: 1360, height: 900 });
  await ext.goto(extUrl(`src/dashboard/dashboard.html?session=${sid}&annotation=${a4.id}`));
  await ext.bringToFront();
  await ext.waitForSelector('.ann');
  await ext.waitForTimeout(800);
  check((await ext.locator('.ann').count()) === 5, 'Dashboard zeigt 5 Karten');
  await shot(ext, '09-dashboard');
  // overview from the top (used for docs/dashboard.png)
  await ext.goto(extUrl(`src/dashboard/dashboard.html?session=${sid}`));
  await ext.waitForSelector('.ann');
  await ext.waitForTimeout(600);
  await shot(ext, '09b-dashboard-top');
  await ext.locator('.ann').first().locator('details.tech summary').click();
  await ext.waitForTimeout(200);
  await ext.locator('.ann').first().screenshot({ path: join(OUT, '10-card-tech.png') });

  // edit title inline
  const titleInput = ext.locator('.ann').nth(1).locator('.ann-title');
  await titleInput.fill('PLZ-Feld ohne Label');
  await titleInput.blur();
  await ext.waitForTimeout(500);
  const afterEdit = await storage();
  check(afterEdit[`fl:ann:${sid}`][1].title === 'PLZ-Feld ohne Label', 'Titel im Dashboard bearbeitet');

  // lightbox
  await ext.locator('.ann .thumb').first().click();
  await ext.waitForSelector('.lightbox img[src^="data:image"]');
  await ext.waitForTimeout(200);
  await shot(ext, '11-lightbox');
  await ext.keyboard.press('Escape');

  // trail & tech tabs
  await ext.click('.tab:has-text("Klickpfad")');
  await ext.waitForTimeout(200);
  await shot(ext, '12-trail');
  await ext.click('.tab:has-text("Technik")');
  await ext.waitForTimeout(200);
  await shot(ext, '13-tech');
  await ext.click('.tab:has-text("Anmerkungen")');

  // --- settings: capture options only, no API key ----------------------------
  await ext.click('#btn-settings');
  await ext.waitForSelector('.modal fieldset');
  check((await ext.locator('.modal input[type=password], .modal input[type=url]').count()) === 0, 'Einstellungen ohne API-Schlüssel/Endpunkt');
  await shot(ext, '14-settings');
  await ext.click('.modal-foot .btn:has-text("Abbrechen")');

  // --- export package for developers / Claude Code ------------------------------
  await ext.click('.s-actions button:has-text("Exportieren (.zip)")');
  await ext.locator('.export-dialog textarea').waitFor();
  check((await ext.locator('.export-dialog .export-what').textContent()).includes('5 Anmerkungen'), 'Export-Dialog: was ins Paket kommt');
  await ext.locator('.export-dialog textarea').fill('Bitte zuerst #4 – blockiert die Demo am Freitag.');
  await ext.keyboard.press('Escape'); // closing without export keeps the text
  await ext.locator('.export-dialog').waitFor({ state: 'hidden' });
  await ext.waitForTimeout(300);
  await ext.click('.s-actions button:has-text("Exportieren (.zip)")');
  check((await ext.locator('.export-dialog textarea').inputValue()) === 'Bitte zuerst #4 – blockiert die Demo am Freitag.', 'Export-Dialog: Esc verwirft die Nachricht nicht');
  await ext.locator('.export-dialog textarea').fill('Bitte zuerst #4 – blockiert die Demo am Freitag.\n#3 ist Geschmackssache, gern mit Design klären.');
  await shot(ext, '15-export-dialog');
  const [zipDl] = await Promise.all([ext.waitForEvent('download'), ext.locator('.export-dialog .modal-foot .btn.primary').click()]);
  const zipPath = join(OUT, zipDl.suggestedFilename());
  await zipDl.saveAs(zipPath);
  const unzipDir = join(OUT, 'zip');
  rmSync(unzipDir, { recursive: true, force: true }); // no leftovers from earlier runs (e.g. yesterday's folder)
  execFileSync('python3', ['-c', `import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])`, zipPath, unzipDir]);
  const folder = readdirSync(unzipDir)[0];
  const root = join(unzipDir, folder);
  const files = readdirSync(root);
  check(['README.md', 'klickpfad.md', 'feedback.json', 'bericht.html', 'anmerkungen', 'screenshots'].every((f) => files.includes(f)), 'ZIP: README, Anmerkungen, Screenshots, Klickpfad, JSON, HTML', files.join(','));
  const readmeNote = readFileSync(join(root, 'README.md'), 'utf8');
  check(/## Nachricht der testenden Person\n\n> Bitte zuerst #4 – blockiert die Demo am Freitag\.\n> #3 ist Geschmackssache/.test(readmeNote) && readmeNote.indexOf('Nachricht der testenden Person') < readmeNote.indexOf('## Hinweise für Claude Code') && readmeNote.includes('- **Nachricht der testenden Person** (oben): zuerst lesen'), 'README: Nachricht ganz oben, Claude Code soll sie zuerst lesen', readmeNote.slice(0, 600));
  const htmlNote = readFileSync(join(root, 'bericht.html'), 'utf8');
  check(htmlNote.includes('<h2>Nachricht an die Entwicklung</h2><p>Bitte zuerst #4'), 'Bericht: Nachricht unter dem Kopf');
  check(JSON.parse(readFileSync(join(root, 'feedback.json'), 'utf8')).session.handoffNote.startsWith('Bitte zuerst #4'), 'JSON: Nachricht in session.handoffNote');
  const sessNote = (await sw.evaluate(() => chrome.storage.local.get('fl:sessions')))['fl:sessions'].find((x) => x.name === 'Bestellportal Review');
  check(sessNote?.handoffNote?.startsWith('Bitte zuerst #4'), 'Nachricht bleibt beim Testlauf gespeichert');
  const issues = readdirSync(join(root, 'anmerkungen')).sort();
  check(issues.length === 5 && issues[0].startsWith('01-versandhinweis-kaum-lesbar') && issues[3].startsWith('04-'), 'Eine Datei pro Anmerkung mit sprechendem Namen', issues.join(','));
  check(readdirSync(join(root, 'screenshots')).length === 9, 'ZIP enthält 9 Screenshots (4 Ausschnitte + 5 Ansichten)');
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  check(readme.includes('## Hinweise für Claude Code') && readme.includes(`Lies \`feedback/${folder}/README.md\``) && readme.includes('Online-Shop für Büromöbel'), 'README: Anleitung für Claude Code + Kontext');
  const checklist = readme.split('\n## Anmerkungen')[1].split('\n## ')[0].split('\n').filter((l) => l.startsWith('- [ ]'));
  check(checklist.length === 5 && checklist[0].includes('#4 · Kritisch') && checklist[1].includes('#1 · Hoch'), 'README: Checkliste nach Priorität sortiert', checklist[0]);
  const resolve = (base, md) => [...md.matchAll(/\]\(([^)#]+)\)/g)].map((m) => m[1]).filter((l) => !/^https?:/.test(l)).filter((l) => !existsSync(join(base, decodeURIComponent(l))));
  check(!resolve(root, readme).length, 'README: alle Links zeigen auf vorhandene Dateien', resolve(root, readme).join(','));
  check(readme.includes('## Ergebnis festhalten') && readme.includes('- App-Stand: `version: 2.3.1-demo` (aus der Seite gelesen)') && /#5 · Mittel · Idee \/ Wunsch.*Entscheidung nötig/.test(readme) && readme.includes('  - Frage: ') && readme.trimEnd().includes('## Nebenbefunde aus der Umsetzung') && readme.includes('- Geladene Skripte: `/app.js`'), 'README: Ergebnis-Format, Nebenbefunde, App-Stand, Skripte, Wunsch = Entscheidung nötig');
  const issue4 = readFileSync(join(root, 'anmerkungen', issues[3]), 'utf8');
  const section = (md, title) => md.split(`## ${title}`)[1]?.split('\n## ')[0] || '';
  const search4 = section(issue4, 'Code finden – Suchbegriffe');
  const follow4 = section(issue4, 'Was nach der Interaktion mit dem Element passierte');
  for (const [needle, label] of [
    ['- `data-testid="checkout-next"` – Test-Attribut', 'Suchbegriff data-testid'],
    ['- `/api/checkout` – API-Aufruf (POST, Status 500) nach Klick auf „Weiter“', 'Suchbegriff API-Pfad (wörtlich suchbar) mit Auslöser'],
    ['- `Checkout fehlgeschlagen` – Konsolenmeldung (error) nach Klick auf „Weiter“', 'Suchbegriff Konsolentext ohne Argumente'],
    ['- „Weiter“ – sichtbarer Text', 'Suchbegriff sichtbarer Text'],
    ['`CheckoutButton` › `CartActions` › `CartPage` – Komponenten (React, laut Entwicklungs-Build)', 'Suchbegriff Komponente'],
    ['- `src/cart/CheckoutButton.jsx:14` – Quelldatei laut Entwicklungs-Build – kann fehlen oder abweichen, im Repository nach `CheckoutButton.jsx` suchen (Zeile 14)', 'Suchbegriff Quelldatei mit Dateiname'],
  ]) check(search4.includes(needle), `Anmerkung #4: ${label}`, needle);
  const order4 = ['id="btn-next"', '/api/checkout', 'Checkout fehlgeschlagen', 'data-testid', '.btn-primary', 'CheckoutButton.jsx'].map((t) => search4.indexOf(t));
  check(order4.every((v, i) => v >= 0 && (i === 0 || v > order4[i - 1])), 'Anmerkung #4 (Fehler): ID und Folgen des Klicks vor Markup, Klassen und Dev-Build-Hinweisen', order4.join(','));
  check(!search4.includes('TypeError') && !search4.includes('Route (Router'), 'Anmerkung #4: kein fremder Fehler, keine generische Route als Suchbegriff', search4);
  check(/\*\*\d\d:\d\d:\d\d · Klick auf „Weiter“ \(button\)\*\*/.test(follow4) && /\+0,\d s · Netzwerk: POST .*\/api\/checkout\?step=1&token=\*\*\* → 500 .*Antwort: „\{"error":"payment-service unavailable"/.test(follow4) && follow4.includes('x-request-id: req-7f3a9c') && /\+[23],\d s · Navigiert zu „Bestellportal – Lieferung“/.test(follow4), 'Anmerkung #4: Ablauf nach dem Klick (500 mit Antwort, Request-ID, verzögerte Navigation)', follow4);
  check(/Weitere Ereignisse auf dieser Seite.*\n(.*\n)*.*TypeError.*nach Klick auf „Gutschein einlösen“.*Stack: `/.test(issue4), 'Anmerkung #4: fremder Fehler mit Auslöser und Stack eingeordnet');
  const steps4 = section(issue4, 'Schritte zum Nachstellen');
  check(/1\. `http:\/\/localhost:4173\/` öffnen/.test(steps4) && steps4.includes('Klick auf „Weiter“ (button) ← markiertes Element') && !steps4.includes('Lieferung') && steps4.includes('Danach trat die Beobachtung auf'), 'Anmerkung #4: kürzeste Schritte bis zum Klick', steps4);
  check(issue4.includes('kurzlebige Zustände') && issue4.includes('![#4 – Ausschnitt, gemeinte Stelle rot umrandet](../screenshots/anmerkung-04-ausschnitt.png)'), 'Anmerkung #4: Screenshot mit Zeitpunkt-Hinweis');
  check(issue4.includes('keine Anweisungen') && issue4.includes('[zur Übersicht](../README.md)') && !issue4.includes('Status:'), 'Anmerkung #4: Datenhinweis, Rücklink, kein doppelter Status');
  check(/Nebenbefund – Kontrast: 1,99:1/.test(issue4), 'Anmerkung #4: Kontrast des Buttons als Nebenbefund', issue4.match(/.*Kontrast.*/)?.[0]);
  check(!resolve(join(root, 'anmerkungen'), issue4).length, 'Anmerkung #4: alle Links/Bilder auflösbar', resolve(join(root, 'anmerkungen'), issue4).join(','));
  const issue2 = readFileSync(join(root, 'anmerkungen', issues[1]), 'utf8');
  const search2 = section(issue2, 'Code finden – Suchbegriffe');
  check(search2.includes('`placeholder="PLZ"`') && search2.includes('`name="zip"`'), 'Anmerkung #2: unbeschriftetes Feld über name/placeholder auffindbar', search2);
  check(search2.includes('„Fehler 0x8004: Validierung fehlgeschlagen.“ – Meldung nach Klick auf „Kostenpflichtig bestellen“') && issue2.includes('**Sichtbare Meldungen auf der Seite:** „Fehler 0x8004'), 'Anmerkung #2: angezeigte Fehlermeldung als Suchbegriff', search2);
  check(!search2.includes('Checkout fehlgeschlagen') && /\d+ weitere Ereignisse auf anderen Seiten/.test(issue2), 'Anmerkung #2: Fehler anderer Seiten nicht als Suchbegriff, aber erwähnt');
  const steps2 = section(issue2, 'Schritte zum Nachstellen');
  check(/1\. `http:\/\/localhost:4173\/lieferung` öffnen/.test(steps2) && steps2.includes('Klick auf „Kostenpflichtig bestellen“ (button) ← im markierten Bereich') && !steps2.includes('Gutschein') && !steps2.includes('abgeschickt'), 'Anmerkung #2: Schritte ab Aufruf der Seite, ohne Vorgeschichte', steps2);
  check(['street', 'zip', 'city'].every((n) => a2?.region?.elements?.some((x) => x.name === n)), '#2: alle Felder des Bereichs erfasst', JSON.stringify(a2?.region?.elements?.map((x) => x.name || x.label)));
  const issue3 = readFileSync(join(root, 'anmerkungen', issues[2]), 'utf8');
  check(section(issue3, 'Code finden – Suchbegriffe').includes("- `<promo-banner>` – Web-Komponente") && issue3.includes('(im Shadow DOM von `<promo-banner>`)'), 'Anmerkung #3: Host der Web-Komponente als Suchbegriff');
  check(!section(issue3, 'Code finden – Suchbegriffe').includes('0x8004') && !issue3.includes('Sichtbare Meldungen'), 'Anmerkung #3: fremde Meldung auf der Seite weder Suchbegriff noch Kontext');
  const issue1md = readFileSync(join(root, 'anmerkungen', issues[0]), 'utf8');
  check(/^- `\.hint-text` – CSS-Klassen/.test(section(issue1md, 'Code finden – Suchbegriffe').split('\n').find((l) => l.startsWith('- ')) || ''), 'Anmerkung #1 (Barrierefreiheit): CSS-Klasse als erster Suchbegriff', section(issue1md, 'Code finden – Suchbegriffe'));
  // #4 was captured while the toast "Anmerkung #3 gespeichert" was still showing: it must not be in the screenshot.
  const darkShare = execFileSync('python3', ['-c', `import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('L')
w, h = im.size
box = im.crop((w // 2 - 120, h - 70, w // 2 + 120, h - 20))
px = box.tobytes()
print(sum(1 for p in px if p < 60) / len(px))`, join(root, 'screenshots', 'anmerkung-04-ansicht.jpg')]).toString().trim();
  check(Number(darkShare) < 0.05, 'Screenshot ohne eigenen Toast der Erweiterung', `dunkler Anteil ${darkShare}`);
  const issue5 = readFileSync(join(root, 'anmerkungen', issues[4]), 'utf8');
  check(issue5.includes('**Idee / Wunsch – Entscheidung nötig:**') && !/API-Aufruf|JS-Fehler|Konsolenmeldung/.test(section(issue5, 'Code finden – Suchbegriffe')) && !issue5.includes('Ereignisse'), 'Anmerkung #5: Wunsch ohne Fehler-Suchbegriffe und fremde Ereignisse', section(issue5, 'Code finden – Suchbegriffe'));
  check(folder === `bestellportal-review-${new Date().toISOString().slice(0, 10)}` && zipDl.suggestedFilename() === `feedback-${folder}.zip`, 'Ordner-/Dateiname des Pakets', `${folder} / ${zipDl.suggestedFilename()}`);
  const issue1 = readFileSync(join(root, 'anmerkungen', issues[0]), 'utf8');
  check(issue1.includes('> Dunklere Schrift, mindestens 14 px.') && issue1.includes('- Kontrast: 1,74:1') && issue1.includes('erfüllt WCAG AA NICHT') && issue1.includes('Farbige Rahmen, Pfeile und Striche'), 'Anmerkung #1: Erwartung, Kontrast (kein Nebenbefund), Hinweis auf Zeichnung');
  const trailMd = readFileSync(join(root, 'klickpfad.md'), 'utf8');
  check(trailMd.includes('Navigiert zu „Bestellportal – Lieferung“') && trailMd.includes('⚠ Netzwerk') && trailMd.includes('Meldung angezeigt: „Fehler 0x8004') && trailMd.includes(`](${'anmerkungen/' + issues[3]})`), 'klickpfad.md: Navigation, Meldungen, Fehler, Links zu Anmerkungen');
  const json = JSON.parse(readFileSync(join(root, 'feedback.json'), 'utf8'));
  check(json.schema === 'feedback-lens/v1' && json.annotations.length === 5 && json.annotations[3].files.issue === `anmerkungen/${issues[3]}` && json.annotations[3].searchTerms.some((t) => t.term === 'data-testid="checkout-next"' && t.hint === 'Test-Attribut') && json.session.appVersionFromPage === 'version: 2.3.1-demo', 'feedback.json mit Dateiverweisen und Suchbegriffen');
  const html = readFileSync(join(root, 'bericht.html'), 'utf8');
  check(html.includes('src="screenshots/anmerkung-01-ausschnitt.png"') && !html.includes('data:image'), 'bericht.html verweist relativ auf Screenshots');
  writeFileSync(join(OUT, 'export-tree.txt'), execFileSync('find', [root, '-type', 'f']).toString());

  // copy everything / a single annotation as Markdown
  await ext.evaluate(() => {
    navigator.clipboard.writeText = async (text) => void (window.__copied = text);
  });
  await ext.click('button:has-text("Weitere Formate")');
  await ext.click('.menu button:has-text("Als Markdown kopieren")');
  await ext.waitForTimeout(500);
  const clip = (await ext.evaluate(() => window.__copied)) || '';
  check(clip.startsWith('# Feedback: Bestellportal Review') && clip.includes('## #4 · Fehler · Kritisch'), 'Alle Anmerkungen als Markdown kopiert', clip.slice(0, 80));
  await ext.locator('.ann').first().locator('button[aria-label$="als Markdown kopieren"]').click();
  await ext.waitForTimeout(400);
  const one = (await ext.evaluate(() => window.__copied)) || '';
  check(one.startsWith('## #1 · Barrierefreiheit · Hoch – Versandhinweis kaum lesbar') && one.includes('Screenshots im Export-Paket') && !one.includes('Nachricht der testenden Person'), 'Einzelne Anmerkung als Markdown kopiert', one.slice(0, 80));
  await ext.locator('.ann').filter({ has: ext.locator('span.num', { hasText: /^#4$/ }) }).locator('button[aria-label$="als Markdown kopieren"]').click();
  await ext.waitForTimeout(400);
  const four = (await ext.evaluate(() => window.__copied)) || '';
  check(four.startsWith('## #4 ·') && four.includes('**Nachricht der testenden Person zu #4**') && four.includes('> Bitte zuerst #4 – blockiert die Demo am Freitag.') && !four.includes('#3 ist Geschmackssache'), 'Einzelne Anmerkung: was die Nachricht zu #4 sagt, steht dabei', four.slice(0, 300));

  // backup → import
  await ext.click('button:has-text("Weitere Formate")');
  const [bkDl] = await Promise.all([ext.waitForEvent('download'), ext.click('.menu button:has-text("Sicherung")')]);
  const bkPath = join(OUT, bkDl.suggestedFilename());
  await bkDl.saveAs(bkPath);
  await ext.setInputFiles('#import-file', bkPath);
  await ext.waitForTimeout(1500);
  const afterImport = await storage();
  const imported = afterImport['fl:sessions'].find((s) => s.name.endsWith('(Import)'));
  check(imported && afterImport[`fl:ann:${imported.id}`]?.length === 5, 'Sicherung importiert (5 Anmerkungen)');
  const impImgs = Object.keys(afterImport).filter((k) => afterImport[`fl:ann:${imported?.id}`]?.some((a) => k.startsWith(`fl:img:${a.id}`)));
  check(impImgs.length === 9, 'Import: alle 9 Bilder wiederhergestellt', String(impImgs.length));
  await shot(ext, '18-after-import');

  // dark mode rendering of the dashboard
  await ext.click(`.session-item:has-text("Bestellportal Review"):not(:has-text("Import"))`);
  await ext.waitForTimeout(400);
  await ext.emulateMedia({ colorScheme: 'dark' });
  await ext.waitForTimeout(200);
  await shot(ext, '18b-dashboard-dark');
  await ext.emulateMedia({ colorScheme: 'light' });
  console.log('shortcuts:', JSON.stringify(await sw.evaluate(() => chrome.commands.getAll())));

  // --- stop session from dashboard: overlay must disappear ------------------
  await ext.click(`.session-item:has-text("Bestellportal Review"):not(:has-text("Import"))`);
  await ext.waitForTimeout(400);
  await ext.click('.s-actions button:has-text("Beenden")');
  await ext.waitForTimeout(800);
  const hostCount = await app.locator('[data-feedback-lens]').count();
  check(hostCount === 0, 'Overlay nach Beenden entfernt', String(hostCount));
  const headText = await ext.locator('.s-head').textContent();
  check(/Beendet/.test(headText) && /Fortsetzen/.test(headText) && !/Läuft gerade/.test(headText), 'Dashboard-Kopf zeigt „Beendet“ und „Fortsetzen“', headText.slice(0, 120));
  const registered = await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts());
  check(registered.length === 0, 'Content-Scripts nach Beenden abgemeldet', JSON.stringify(registered.map((r) => r.id)));
  await app.reload();
  await app.waitForTimeout(600);
  check((await app.locator('[data-feedback-lens]').count()) === 0, 'Nach Reload kein Overlay mehr');
  await shot(ext, '19-dashboard-ended');
} catch (err) {
  failures.push(`Exception: ${err.stack || err}`);
  console.error(err);
} finally {
  const relevant = errors.filter((e) => !/favicon|status of 404|status of 500|Checkout fehlgeschlagen|reading 'bar'|Cannot read properties of undefined/.test(e));
  if (relevant.length) {
    console.log('\nUnerwartete Fehlermeldungen in Seiten:');
    relevant.forEach((e) => console.log('  ' + e));
  }
  console.log(`\n${passes.length} bestanden, ${failures.length} fehlgeschlagen`);
  failures.forEach((f) => console.log('  ✘ ' + f));
  check(!external.length, 'Keine Netzwerkzugriffe nach außen (alles lokal)', external.slice(0, 5).join(', '));
  process.exitCode = failures.length || relevant.length ? 1 : 0;
  await cleanup();
  server.close();
}
