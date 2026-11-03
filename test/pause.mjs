// A click beside the annotation dialog sets it aside instead of discarding
// it; the popup can pause and end a run without exporting, a dialog that is
// open at that moment becomes a draft, and a paused run is offered first.
import { startServer } from './server.mjs';
import { launch } from './launch.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.FL_OUT || '/tmp/fl-e2e-out';
mkdirSync(OUT, { recursive: true });
const PORT = 4184;
const APP = `http://localhost:${PORT}/`;
const failures = [];
const check = (cond, label, detail = '') => {
  if (!cond) failures.push(`${label} → ${detail}`);
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

const server = await startServer(PORT);
const { context, sw, extUrl, cleanup } = await launch({ viewport: { width: 1280, height: 800 } });
const errors = [];
try {
  const app = await context.newPage();
  app.on('pageerror', (e) => !/reading '(foo|bar)'/.test(e.message) && errors.push(e.message));
  await app.goto(APP);
  const popup = await context.newPage();
  popup.on('pageerror', (e) => errors.push(e.message));
  await popup.setViewportSize({ width: 360, height: 640 });
  await popup.addInitScript((port) => {
    const original = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = (q) => (q && q.active ? original({ url: `http://localhost:${port}/*` }) : original(q));
    window.close = () => (window.__closed = true);
  }, PORT);
  await popup.goto(extUrl('src/popup/popup.html'));
  await popup.fill('input[aria-label="Name des Testlaufs"]', 'Pause-Test');
  await popup.click('button:has-text("Testlauf auf dieser Seite starten")');
  await popup.waitForFunction(() => window.__closed === true);
  await app.bringToFront();
  await app.waitForSelector('feedback-lens-ui', { state: 'attached' });
  await app.waitForTimeout(500);
  const storage = () => sw.evaluate(() => chrome.storage.local.get(null));
  const sid = (await storage())['fl:active'];
  const session = async () => (await storage())['fl:sessions'].find((s) => s.id === sid);
  const drafts = async () => (await storage())[`fl:drafts:${sid}`] || [];
  const command = (action) =>
    sw.evaluate(async ({ action, url }) => {
      const [tab] = (await chrome.tabs.query({})).filter((t) => t.url === url);
      await chrome.tabs.sendMessage(tab.id, { type: 'fl:command', action });
    }, { action, url: app.url() });
  const pick = async (selector) => {
    await command('pick');
    const box = await app.locator(selector).first().boundingBox();
    await app.mouse.move(box.x + 10, box.y + box.height / 2);
    await app.mouse.click(box.x + 10, box.y + box.height / 2);
    await app.locator('.drawer textarea').first().waitFor();
  };

  // --- a click beside the dialog keeps it --------------------------------------------------
  await pick('h1');
  await app.locator('.drawer textarea').first().fill('Überschrift zu groß');
  await app.mouse.click(200, 600); // on the dimmed page
  await app.locator('.drawer').waitFor({ state: 'detached' });
  let d = await drafts();
  check(d.length === 1 && d[0].label === 'Überschrift zu groß' && !(await storage())[`fl:ann:${sid}`]?.length, 'Klick daneben: Dialog wird zur Seite gelegt, nicht verworfen', JSON.stringify(d));
  check(await app.locator('.toolbar .tb-draft').isVisible(), 'Leiste zeigt „Entwurf“');
  // also without any input: the screenshot of that moment is kept
  await pick('.hint-text');
  await app.mouse.click(200, 600);
  await app.locator('.drawer').waitFor({ state: 'detached' });
  check((await drafts()).length === 2, 'Auch ein Dialog ohne Eingaben wird zur Seite gelegt');
  // discarding stays possible on purpose: „Abbrechen“ twice
  await app.locator('.toolbar .tb-draft').click();
  await app.locator('.draft-menu button').nth(1).click();
  await app.locator('.drawer').waitFor();
  await app.locator('.drawer textarea').first().fill('doch nicht');
  await app.locator('.drawer .d-foot .btn', { hasText: 'Abbrechen' }).click();
  check((await app.locator('.drawer').count()) === 1, '„Abbrechen“ mit Eingaben fragt erst nach');
  await app.locator('.drawer .d-foot .btn', { hasText: 'Abbrechen' }).click();
  await app.locator('.drawer').waitFor({ state: 'detached' });
  check((await drafts()).length === 1, 'Zweites „Abbrechen“ verwirft');

  // --- popup: pause, end, export ------------------------------------------------------------
  await popup.reload();
  await popup.waitForSelector('.action');
  const labels = await popup.locator('.foot .btn, .btn.primary.block').allTextContents();
  check(['Dashboard', 'Pausieren', 'Beenden', 'Beenden & exportieren'].every((l) => labels.map((x) => x.trim()).includes(l)), 'Popup: Dashboard, Pausieren, Beenden und Beenden & exportieren', JSON.stringify(labels));
  const fit = await popup.evaluate(() => ({ scroll: document.documentElement.scrollWidth, cut: [...document.querySelectorAll('.foot .btn')].some((b) => b.scrollWidth > b.clientWidth + 1) }));
  check(fit.scroll <= 360 && !fit.cut, 'Knöpfe passen in das Popup', JSON.stringify(fit));
  await popup.screenshot({ path: join(OUT, 'pause-1-popup.png') });

  // pause while a dialog is open: it becomes a draft
  await app.bringToFront();
  await pick('.items');
  await app.locator('.drawer textarea').first().fill('Liste zu eng');
  await popup.bringToFront();
  await popup.click('.foot button:has-text("Pausieren")');
  await popup.waitForSelector('.session.paused');
  let s = await session();
  const st = await storage();
  check(!st['fl:active'] && s.pausedAt && s.endedAt && s.runs.every((r) => r.to), 'Pausiert: nicht mehr aktiv, Abschnitt geschlossen', JSON.stringify({ active: st['fl:active'], pausedAt: s.pausedAt, runs: s.runs }));
  await app.waitForSelector('feedback-lens-ui', { state: 'detached', timeout: 5000 });
  d = await drafts();
  check(d.some((x) => x.label === 'Liste zu eng'), 'Beim Pausieren offener Dialog als Entwurf gesichert', JSON.stringify(d.map((x) => x.label)));
  check((await popup.locator('.session.paused').textContent()).includes('Pause-Test') && (await popup.locator('details.new-run').getAttribute('open')) === null, 'Popup: pausierter Testlauf oben, neuer Testlauf eingeklappt');
  check(!(await popup.locator('.recent').textContent().catch(() => '')).includes('Pause-Test'), 'Pausierter Lauf steht nicht doppelt in „Letzte Testläufe“');
  const fit2 = await popup.evaluate(() => ({ scroll: document.documentElement.scrollWidth, cut: [...document.querySelectorAll('.foot .btn')].some((b) => b.scrollWidth > b.clientWidth + 1 || b.getBoundingClientRect().right > document.body.clientWidth - 8) }));
  check(fit2.scroll <= 360 && !fit2.cut, 'Pausiert: Knöpfe passen in das Popup', JSON.stringify(fit2));
  await popup.screenshot({ path: join(OUT, 'pause-2-paused.png') });

  // continue
  await popup.click('.session.paused ~ button:has-text("Fortsetzen")');
  await popup.waitForSelector('.action');
  s = await session();
  check((await storage())['fl:active'] === sid && !s.pausedAt && !s.endedAt && s.runs.length === 2, 'Fortsetzen: aktiv, zweiter Abschnitt', JSON.stringify(s.runs));
  await app.bringToFront();
  await app.waitForSelector('feedback-lens-ui', { state: 'attached', timeout: 5000 });
  await app.locator('.toolbar .tb-draft', { hasText: '2 Entwürfe' }).waitFor({ timeout: 5000 });
  check(true, 'Overlay wieder da, mit beiden Entwürfen');

  // end without export
  await popup.bringToFront();
  await popup.click('.foot button:has-text("Beenden")');
  await popup.waitForSelector('button:has-text("Testlauf auf dieser Seite starten")');
  s = await session();
  check(!(await storage())['fl:active'] && !s.pausedAt && s.endedAt && (await popup.locator('.session.paused').count()) === 0, 'Beenden: kein Export, kein „pausiert“', JSON.stringify(s));
  check((await popup.locator('.recent').textContent()).includes('Pause-Test'), 'Steht unter „Letzte Testläufe“ (fortsetzbar)');

  // paused, then ended and exported from the paused card
  await popup.locator('.recent li', { hasText: 'Pause-Test' }).locator('button').click();
  await popup.waitForSelector('.action');
  await popup.click('.foot button:has-text("Pausieren")');
  await popup.waitForSelector('.session.paused');
  const downloads = [];
  context.on('page', (p) => p.on('download', (x) => downloads.push(x)));
  await popup.evaluate(() => (window.__closed = false));
  await popup.click('.session.paused ~ .foot button:has-text("Beenden & exportieren")');
  await popup.waitForFunction(() => window.__closed === true);
  await confirmExport(context);
  for (let i = 0; i < 40 && !downloads.length; i++) await popup.waitForTimeout(250);
  s = await session();
  check(downloads.length === 1 && !s.pausedAt, 'Pausierter Lauf: „Beenden & exportieren“ lädt das Paket', downloads[0]?.suggestedFilename());

  const dash = await context.newPage();
  await dash.goto(extUrl('src/dashboard/dashboard.html'));
  await dash.waitForSelector('.s-meta');
  check((await dash.locator('.s-meta').textContent()).includes('Beendet'), 'Dashboard: beendet');
  check(errors.length === 0, 'Keine Fehler', errors.join(' | '));
} catch (err) {
  failures.push(String(err?.stack || err));
  console.error(err);
} finally {
  await cleanup();
  server.close();
}
console.log(failures.length ? `\n${failures.length} Prüfung(en) fehlgeschlagen` : '\nalles bestanden');
process.exit(failures.length ? 1 : 0);
