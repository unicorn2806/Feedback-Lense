// „Kurz zur Seite“: an annotation in progress is parked, the application is
// usable again, and the draft survives reloads and page changes until it is
// continued and saved – also several drafts, auto-parking when the page is
// left with an open dialog, and continuing in one tab removes it everywhere.
import { startServer } from './server.mjs';
import { launch } from './launch.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.FL_OUT || '/tmp/fl-e2e-out';
mkdirSync(OUT, { recursive: true });
const PORT = 4181;
const APP = `http://localhost:${PORT}/`;
const failures = [];
const check = (cond, label, detail = '') => {
  if (!cond) failures.push(`${label} → ${detail}`);
  console.log(`${cond ? '✔' : '✘'} ${label}${!cond && detail ? ` → ${detail}` : ''}`);
};

const server = await startServer(PORT);
const { context, sw, extUrl, cleanup } = await launch({ viewport: { width: 1280, height: 800 } });
const errors = [];
try {
  const app = await context.newPage();
  app.on('pageerror', (e) => !/reading '(foo|bar)'/.test(e.message) && errors.push(e.message));
  await app.goto(APP);
  const ext = await context.newPage();
  await ext.goto(extUrl('src/popup/popup.html'));
  const send = (msg) => ext.evaluate((m) => chrome.runtime.sendMessage(m), msg);
  await send({ type: 'fl:startSession', name: 'Entwürfe', url: APP });
  await app.bringToFront();
  await app.waitForSelector('feedback-lens-ui', { state: 'attached' });
  await app.waitForTimeout(500);
  const sid = await sw.evaluate(async () => (await chrome.storage.local.get('fl:active'))['fl:active']);
  const storage = () => sw.evaluate(() => chrome.storage.local.get(null));
  const command = (page, action) =>
    sw.evaluate(async ({ action, url }) => {
      const [tab] = (await chrome.tabs.query({})).filter((t) => t.url === url);
      await chrome.tabs.sendMessage(tab.id, { type: 'fl:command', action });
    }, { action, url: page.url() });
  const pick = async (page, selector) => {
    await command(page, 'pick');
    const box = await page.locator(selector).first().boundingBox();
    await page.mouse.move(box.x + 10, box.y + box.height / 2);
    await page.mouse.click(box.x + 10, box.y + box.height / 2);
    await page.locator('.drawer textarea').first().waitFor();
  };
  const draftButton = (page) => page.locator('.toolbar .tb-draft');

  // --- park an annotation in progress ------------------------------------------------
  await pick(app, '.hint-text');
  await app.locator('.drawer .chip', { hasText: 'Fehler' }).click();
  await app.locator('.drawer input[type=text]').first().fill('Rabatt-Hinweis');
  await app.locator('.drawer textarea').first().fill('Erst nachsehen, ob der Rabatt im Warenkorb ankommt.');
  await app.locator('.drawer canvas.preview').scrollIntoViewIfNeeded();
  const preview = await app.locator('.drawer canvas.preview').boundingBox();
  await app.mouse.move(preview.x + 30, preview.y + 30);
  await app.mouse.down();
  await app.mouse.move(preview.x + 120, preview.y + 80, { steps: 4 });
  await app.mouse.up();
  await app.locator('.drawer .d-aside').click();
  await app.locator('.drawer').waitFor({ state: 'detached' });
  check((await app.locator('.backdrop').count()) === 0, 'Kurz zur Seite: Dialog und Abdunkelung sind weg');
  await draftButton(app).waitFor();
  check((await draftButton(app).textContent()).trim() === 'Entwurf', 'Leiste zeigt „Entwurf“');
  await app.getByPlaceholder('Code').fill('SOMMER10');
  check((await app.getByPlaceholder('Code').inputValue()) === 'SOMMER10', 'Die Anwendung ist wieder bedienbar');
  await app.screenshot({ path: join(OUT, 'drafts-1-parked.png') });
  let data = await storage();
  const parked = data[`fl:drafts:${sid}`] || [];
  check(parked.length === 1 && parked[0].label === 'Rabatt-Hinweis' && data[`fl:draft:${parked[0].id}`]?.shot?.startsWith('data:image/'), 'Gespeichert: Entwurf mit Screenshot', JSON.stringify(parked));
  check(!(data[`fl:ann:${sid}`] || []).length, 'Noch keine Anmerkung angelegt');

  // --- reload and another page ----------------------------------------------------------
  await app.reload();
  await app.waitForSelector('feedback-lens-ui', { state: 'attached' });
  await draftButton(app).waitFor({ timeout: 5000 });
  check(true, 'Nach dem Neuladen ist der Entwurf noch da');
  await app.goto(`${APP}lieferung`);
  await app.waitForSelector('feedback-lens-ui', { state: 'attached' });
  await draftButton(app).waitFor({ timeout: 5000 });
  check(true, 'Auf einer anderen Seite ebenfalls');

  // --- continue and save ------------------------------------------------------------------
  await draftButton(app).click();
  await app.locator('.drawer').waitFor();
  check((await app.locator('.drawer input[type=text]').first().inputValue()) === 'Rabatt-Hinweis' && (await app.locator('.drawer textarea').first().inputValue()).startsWith('Erst nachsehen'), 'Weiter: Titel und Beschreibung sind wieder da');
  check((await app.locator('.drawer .chip.sel').textContent()).includes('Fehler'), 'Kategorie ist wieder gewählt');
  check(await app.locator('.drawer canvas.preview').isVisible(), 'Screenshot ist wieder da');
  check((await draftButton(app).isHidden()), 'Beim Weitermachen verschwindet „Entwurf“ aus der Leiste');
  await app.locator('.drawer textarea').nth(1).fill('Rabatt wird angezeigt.');
  await app.locator('.drawer .btn.primary').click();
  await app.locator('.drawer').waitFor({ state: 'detached' });
  await app.waitForTimeout(500);
  data = await storage();
  const ann = (data[`fl:ann:${sid}`] || [])[0];
  check(ann?.title === 'Rabatt-Hinweis' && ann.category === 'bug' && ann.expected === 'Rabatt wird angezeigt.', 'Gespeichert mit allen Angaben', JSON.stringify(ann && { title: ann.title, category: ann.category, expected: ann.expected }));
  check(ann?.page?.url === APP && ann.element?.selector && ann.images?.drawn === true && data[`fl:img:${ann.id}:full`], 'Seite, Element, Markierung und Screenshot vom Zeitpunkt der Aufnahme', JSON.stringify(ann && { url: ann.page?.url, drawn: ann.images?.drawn }));
  check(!(data[`fl:drafts:${sid}`] || []).length && !Object.keys(data).some((k) => k.startsWith('fl:draft:')), 'Entwurf danach aus dem Speicher entfernt');

  // --- several drafts and the list ----------------------------------------------------------
  await app.goto(APP);
  await app.waitForSelector('feedback-lens-ui', { state: 'attached' });
  await app.waitForTimeout(400);
  await pick(app, 'h1');
  await app.locator('.drawer textarea').first().fill('Überschrift zu groß');
  await app.locator('.drawer .d-aside').click();
  await app.locator('.drawer').waitFor({ state: 'detached' });
  await command(app, 'note');
  await app.locator('.drawer textarea').first().waitFor();
  await app.locator('.drawer textarea').first().fill('Seite lädt langsam');
  await app.locator('.drawer .d-aside').click();
  await app.locator('.drawer').waitFor({ state: 'detached' });
  await app.waitForTimeout(300);
  check((await draftButton(app).textContent()).trim() === '2 Entwürfe', 'Leiste zeigt „2 Entwürfe“', await draftButton(app).textContent());
  await draftButton(app).click();
  const items = app.locator('.draft-menu button');
  check((await items.count()) === 2 && (await items.nth(1).textContent()).includes('Seite lädt langsam') && (await items.nth(0).textContent()).includes('diese Seite'), 'Liste der Entwürfe mit Uhrzeit und Seite', await app.locator('.draft-menu').textContent());
  await app.screenshot({ path: join(OUT, 'drafts-2-menu.png') });
  await items.nth(1).click();
  await app.locator('.drawer').waitFor();
  check((await app.locator('.drawer textarea').first().inputValue()) === 'Seite lädt langsam' && (await draftButton(app).textContent()).trim() === 'Entwurf', 'Gewählter Entwurf geöffnet, einer bleibt geparkt');

  // --- second tab: continuing takes the draft away everywhere ---------------------------------
  const tab2 = await context.newPage();
  await tab2.goto(APP);
  await tab2.waitForSelector('feedback-lens-ui', { state: 'attached' });
  await draftButton(tab2).waitFor({ timeout: 5000 });
  await app.bringToFront();
  await app.locator('.drawer .btn.primary').click(); // save the page note
  await app.locator('.drawer').waitFor({ state: 'detached' });
  await draftButton(app).click();
  await app.locator('.drawer').waitFor();
  await tab2.waitForTimeout(800);
  check(await draftButton(tab2).isHidden(), 'Im anderen Tab verschwindet der Entwurf, sobald er hier fortgesetzt wird');

  // --- leaving the page with an open, filled-in dialog parks it ----------------------------------
  await app.locator('.drawer textarea').first().fill('Überschrift zu groß – auch mobil');
  await app.reload();
  await app.waitForSelector('feedback-lens-ui', { state: 'attached' });
  await draftButton(app).waitFor({ timeout: 5000 });
  await draftButton(app).click();
  await app.locator('.drawer').waitFor();
  check((await app.locator('.drawer textarea').first().inputValue()) === 'Überschrift zu groß – auch mobil', 'Neuladen mit offenem Dialog: Eingaben als Entwurf gesichert');
  await app.locator('.drawer .d-aside').click();
  await app.locator('.drawer').waitFor({ state: 'detached' });

  // --- deleting the run removes its drafts --------------------------------------------------------
  await send({ type: 'fl:stopSession' });
  await send({ type: 'fl:deleteSession', sessionId: sid });
  data = await storage();
  check(!Object.keys(data).some((k) => k.startsWith('fl:draft')), 'Testlauf gelöscht: Entwürfe mit gelöscht', Object.keys(data).join(','));
  check(errors.length === 0, 'Keine Fehler auf der Seite', errors.join(' | '));
} catch (err) {
  failures.push(String(err?.stack || err));
  console.error(err);
} finally {
  await cleanup();
  server.close();
}
console.log(failures.length ? `\n${failures.length} Prüfung(en) fehlgeschlagen` : '\nalles bestanden');
process.exit(failures.length ? 1 : 0);
