// The overlay as shipped: its shadow root is closed, so the page – and our own
// listeners on window – cannot look inside. Playwright cannot either, so the
// positions come from a run with an open root and are clicked in a closed one.
// Covered: continuing one of two parked drafts from the list.
import { startServer } from './server.mjs';
import { launch } from './launch.mjs';

const PORT = 4190;
const APP = `http://localhost:${PORT}/`;
const failures = [];
const check = (cond, label, detail = '') => {
  if (!cond) failures.push(`${label} → ${detail}`);
  console.log(`${cond ? '✔' : '✘'} ${label}${!cond && detail ? ` → ${detail}` : ''}`);
};

/** Two parked drafts (written to storage), the page reloaded with the toolbar showing „2 Entwürfe“. */
async function setup(openShadow) {
  const run = await launch({ viewport: { width: 1280, height: 800 }, openShadow });
  const app = await run.context.newPage();
  await app.goto(APP);
  const ext = await run.context.newPage();
  await ext.goto(run.extUrl('src/popup/popup.html'));
  await ext.evaluate((url) => chrome.runtime.sendMessage({ type: 'fl:startSession', name: 'Geschlossen', url }), APP);
  await ext.close();
  await app.bringToFront();
  await app.waitForSelector('feedback-lens-ui', { state: 'attached' });
  const sid = await run.sw.evaluate(async (url) => {
    const sid = (await chrome.storage.local.get('fl:active'))['fl:active'];
    const draft = (n) => ({ label: `Entwurf ${n}`, kind: 'page', page: { url, title: 'Bestellportal', viewport: { width: 1280, height: 800 }, dpr: 1 }, techEvents: [], shot: null, includeShot: false, marks: { items: [], clicks: [], tool: 'rect', view: 'full' }, extras: [], values: { category: 'bug', priority: 'medium', title: `Entwurf ${n}`, description: `Text ${n}`, expected: '' } });
    const now = new Date().toISOString();
    await chrome.storage.local.set({
      'fl:draft:d1': draft(1),
      'fl:draft:d2': draft(2),
      [`fl:drafts:${sid}`]: [{ id: 'd1', parkedAt: now, label: 'Entwurf 1', url }, { id: 'd2', parkedAt: now, label: 'Entwurf 2', url }],
    });
    return sid;
  }, APP);
  await app.reload();
  await app.waitForSelector('feedback-lens-ui', { state: 'attached' });
  await app.waitForTimeout(800);
  const drafts = () => run.sw.evaluate(async (sid) => ((await chrome.storage.local.get(`fl:drafts:${sid}`))[`fl:drafts:${sid}`] || []).map((d) => d.label), sid);
  return { ...run, app, drafts };
}

const server = await startServer(PORT);
let spots = null;
try {
  // --- open root: where things are, and that the list closes when clicking beside it -----
  const open = await setup(true);
  try {
    const { app } = open;
    const box = (sel) => app.locator(sel).first().boundingBox();
    check((await app.locator('.toolbar .tb-draft').textContent()).trim() === '2 Entwürfe', 'Leiste zeigt „2 Entwürfe“');
    const button = await box('.toolbar .tb-draft');
    await app.mouse.click(button.x + button.width / 2, button.y + button.height / 2);
    await app.locator('.draft-menu').waitFor();
    const item = await box('.draft-menu button');
    spots = { button, item };
    await app.mouse.click(400, 300); // on the page
    check((await app.locator('.draft-menu').count()) === 0, 'Klick auf die Seite schließt die Liste');
    await app.mouse.click(button.x + button.width / 2, button.y + button.height / 2);
    await app.locator('.draft-menu').waitFor();
    const pins = await box('.toolbar button[aria-label="Markierungen ein-/ausblenden"]');
    await app.mouse.click(pins.x + pins.width / 2, pins.y + pins.height / 2);
    check((await app.locator('.draft-menu').count()) === 0, 'Klick auf einen anderen Knopf der Leiste schließt die Liste');
  } finally {
    await open.cleanup();
  }

  // --- closed root, as shipped: a click on a draft in the list continues it --------------------
  const closed = await setup(false);
  try {
    const { app, drafts } = closed;
    check((await app.locator('.draft-menu').count()) === 0 && (await app.evaluate(() => document.querySelector('feedback-lens-ui')?.shadowRoot)) === null, 'Geschlossenes Shadow-DOM: von außen nicht einsehbar');
    await app.mouse.click(spots.button.x + spots.button.width / 2, spots.button.y + spots.button.height / 2);
    await app.waitForTimeout(400);
    await app.mouse.click(spots.item.x + spots.item.width / 2, spots.item.y + spots.item.height / 2);
    let left = [];
    for (let i = 0; i < 20; i++) {
      left = await drafts();
      if (left.length === 1) break;
      await app.waitForTimeout(150);
    }
    check(JSON.stringify(left) === '["Entwurf 2"]', 'Klick auf „Entwurf 1“ in der Liste setzt ihn fort (wie in der veröffentlichten Erweiterung)', JSON.stringify(left));
  } finally {
    await closed.cleanup();
  }
} catch (err) {
  failures.push(String(err?.stack || err));
  console.error(err);
} finally {
  server.close();
}
console.log(failures.length ? `\n${failures.length} Prüfung(en) fehlgeschlagen` : '\nalles bestanden');
process.exit(failures.length ? 1 : 0);
