// Drives the real popup UI: start a session from the start view, then use the
// action buttons. chrome.tabs.query is pointed at the demo tab, because a
// popup opened as a normal page would otherwise see itself as the active tab.
import { startServer } from './server.mjs';
import { launch } from './launch.mjs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const OUT = process.env.FL_OUT || '/tmp/fl-e2e-out';
mkdirSync(OUT, { recursive: true });
const failures = [];
const check = (cond, label, detail = '') => {
  if (!cond) failures.push(label);
  console.log(`${cond ? '✔' : '✘'} ${label}${!cond && detail ? ` → ${detail}` : ''}`);
};

/** „Beenden & exportieren“ leads to the export dialog in the dashboard; confirm it there. */
async function confirmExport(context) {
  for (let i = 0; i < 60; i++) {
    for (const p of context.pages()) {
      if (await p.locator('.export-dialog').count().catch(() => 0)) {
        await p.locator('.export-dialog .modal-foot .btn.primary').click();
        return p;
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Export-Dialog nicht gefunden');
}

const server = await startServer(4173);
const { context, sw, extUrl, cleanup } = await launch();
try {
  const app = await context.newPage();
  await app.goto('http://localhost:4173/');
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 360, height: 600 });
  await popup.addInitScript(() => {
    const original = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = (q) => (q && q.active ? original({ url: 'http://localhost:4173/*' }) : original(q));
    window.close = () => (window.__closed = true);
    // German Windows names the keys in full („Alt+Umschalttaste+E“) – the longest variant
    const names = { 'pick-element': 'Alt+Umschalttaste+E', 'select-region': 'Alt+Umschalttaste+D', 'page-note': 'Alt+Umschalttaste+S' };
    const getAll = chrome.commands.getAll.bind(chrome.commands);
    chrome.commands.getAll = async () => (await getAll()).map((c) => ({ ...c, shortcut: names[c.name] || c.shortcut }));
  });
  await popup.goto(extUrl('src/popup/popup.html'));
  await popup.waitForSelector('button:has-text("Testlauf auf dieser Seite starten")');
  await popup.fill('input[aria-label="Name des Testlaufs"]', 'Popup-Test');
  await popup.click('summary:has-text("Kontext zum Test")');
  await popup.fill('details.ctx textarea', 'Testkontext aus dem Popup');
  await popup.fill('details.ctx input[aria-label="Version, Build oder Commit"]', 'Build 2.3.1');
  await popup.screenshot({ path: join(OUT, 'popup-start.png') });
  await popup.click('button:has-text("Testlauf auf dieser Seite starten")');
  await popup.waitForFunction(() => window.__closed === true);
  const data = await sw.evaluate(() => chrome.storage.local.get(null));
  const session = data['fl:sessions']?.[0];
  check(session?.name === 'Popup-Test' && session.appContext === 'Testkontext aus dem Popup' && session.appVersion === 'Build 2.3.1' && data['fl:active'] === session.id, 'Start über Popup legt Testlauf mit Kontext und Version an', JSON.stringify(session));
  await app.bringToFront();
  await app.waitForSelector('feedback-lens-ui', { state: 'attached', timeout: 5000 });
  check(true, 'Overlay erscheint im Tab');

  await popup.reload();
  await popup.waitForSelector('.action');
  await popup.screenshot({ path: join(OUT, 'popup-active.png') });
  const caps = await popup.locator('.action .keys').evaluateAll((els) => els.map((e) => [...e.querySelectorAll('kbd')].map((k) => k.textContent).join(' ')));
  check(caps.join(' | ') === 'Alt ⇧ E | Alt ⇧ D | Alt ⇧ S', 'Alle drei Aktionen zeigen ihr Tastenkürzel als einzelne Tasten', caps.join(' | '));
  const fit = await popup.evaluate(() => {
    const body = document.body.getBoundingClientRect();
    const cards = [...document.querySelectorAll('.action')].map((a) => a.getBoundingClientRect());
    return { scroll: document.documentElement.scrollWidth, body: body.width, right: Math.max(...cards.map((r) => r.right)), widths: cards.map((r) => Math.round(r.width)) };
  });
  check(fit.scroll <= 360 && fit.right <= fit.body - 10 && new Set(fit.widths).size === 1, 'Popup bleibt 360 px breit, drei gleich breite Kacheln (auch mit „Umschalttaste“)', JSON.stringify(fit));
  await popup.evaluate(() => (window.__closed = false));
  await popup.click('.action:has-text("Seiten-Notiz")');
  await popup.waitForFunction(() => window.__closed === true);
  await app.bringToFront();
  await app.locator('.drawer textarea').first().waitFor({ timeout: 5000 });
  check(true, 'Aktion „Seiten-Notiz“ aus dem Popup öffnet den Dialog');
  await app.locator('.drawer textarea').first().fill('Fortschrittsanzeige fehlt');
  await app.locator('.drawer .btn.primary').click();
  await app.locator('.drawer').waitFor({ state: 'detached' });

  // "Beenden & exportieren": stops the session, opens the dashboard and downloads the package.
  const downloads = [];
  context.on('page', (p) => p.on('download', (d) => downloads.push(d)));
  await popup.reload();
  await popup.evaluate(() => (window.__closed = false));
  await popup.click('button:has-text("Beenden & exportieren")');
  await popup.waitForFunction(() => window.__closed === true);
  await confirmExport(context);
  check(true, '„Beenden & exportieren“ öffnet den Export-Dialog im Dashboard');
  for (let i = 0; i < 40 && !downloads.length; i++) await popup.waitForTimeout(250);
  check(downloads.length === 1 && /^feedback-popup-test-\d{4}-\d{2}-\d{2}\.zip$/.test(downloads[0].suggestedFilename()), '„Beenden & exportieren“ lädt das Paket herunter', downloads[0]?.suggestedFilename());
  const state = await sw.evaluate(() => chrome.storage.local.get('fl:active'));
  check(!state['fl:active'], 'Testlauf ist beendet');
  if (downloads[0]) {
    const zipPath = join(OUT, downloads[0].suggestedFilename());
    await downloads[0].saveAs(zipPath);
    const names = execFileSync('python3', ['-c', 'import zipfile,sys; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', zipPath]).toString();
    check(/\/README\.md/.test(names) && /\/anmerkungen\/01-fortschrittsanzeige-fehlt\.md/.test(names), 'Paket enthält README und Anmerkungsdatei', names.split('\n').slice(0, 4).join(' | '));
  }
} catch (err) {
  failures.push(String(err));
  console.error(err);
} finally {
  console.log(failures.length ? `${failures.length} fehlgeschlagen` : 'alles bestanden');
  process.exitCode = failures.length ? 1 : 0;
  await cleanup();
  server.close();
}
