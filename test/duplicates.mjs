// The same spot twice: the dialog points to the earlier annotation and can add
// the new observation to it instead of creating a duplicate; in a re-test it
// points to the earlier item in the re-test list.
import { startServer } from './server.mjs';
import { launch } from './launch.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.FL_OUT || '/tmp/fl-e2e-out';
mkdirSync(OUT, { recursive: true });
const PORT = 4174;
const APP = `http://localhost:${PORT}/`;
const failures = [];
const check = (cond, label, detail = '') => {
  if (!cond) failures.push(`${label} → ${detail}`);
  console.log(`${cond ? '✔' : '✘'} ${label}${!cond && detail ? ` → ${detail}` : ''}`);
};

const server = await startServer(PORT);
const { context, sw, extUrl, cleanup } = await launch();
try {
  const app = await context.newPage();
  await app.goto(APP);
  const ext = await context.newPage();
  await ext.goto(extUrl('src/popup/popup.html'));
  const send = (msg) => ext.evaluate((m) => chrome.runtime.sendMessage(m), msg);
  await send({ type: 'fl:startSession', name: 'Doppelte', url: APP });
  await app.bringToFront();
  await app.waitForSelector('feedback-lens-ui', { state: 'attached' });
  await app.waitForTimeout(400);
  const command = (action) =>
    sw.evaluate(async ({ action, port }) => {
      const [tab] = await chrome.tabs.query({ url: `http://localhost:${port}/*` });
      await chrome.tabs.sendMessage(tab.id, { type: 'fl:command', action });
    }, { action, port: PORT });
  const pickElement = async (selector) => {
    await command('pick');
    const box = await app.locator(selector).first().boundingBox();
    await app.mouse.move(box.x + 12, box.y + box.height / 2);
    await app.mouse.click(box.x + 12, box.y + box.height / 2);
    await app.locator('.drawer textarea').first().waitFor();
  };
  const drawRegion = async (selector) => {
    await command('region');
    const box = await app.locator(selector).first().boundingBox();
    await app.mouse.move(box.x - 4, box.y - 4);
    await app.mouse.down();
    await app.mouse.move(box.x + box.width + 4, box.y + box.height + 4, { steps: 6 });
    await app.mouse.up();
    await app.locator('.drawer textarea').first().waitFor();
  };
  const saveDrawer = async () => {
    await app.locator('.drawer .btn.primary').click();
    await app.locator('.drawer').waitFor({ state: 'detached' });
    await app.waitForTimeout(700);
  };
  const stored = async () => {
    const data = await sw.evaluate(() => chrome.storage.local.get(null));
    const sid = data['fl:active'];
    return { sid, anns: data[`fl:ann:${sid}`] || [], trail: data[`fl:trail:${sid}`] || [] };
  };

  // first annotation on the hint text
  await pickElement('.hint-text');
  check((await app.locator('.drawer .dup').count()) === 0, 'Erste Anmerkung: kein Hinweis');
  await app.locator('.drawer input[type=text]').first().fill('Hinweis kaum lesbar');
  await app.locator('.drawer textarea').first().fill('Grau auf Weiß.');
  await saveDrawer();

  // the same element again: add to #1
  await pickElement('.hint-text');
  const dup = app.locator('.drawer .dup');
  check((await dup.count()) === 1 && (await dup.textContent()).includes('#1') && (await dup.textContent()).includes('Hinweis kaum lesbar'), 'Gleiches Element: Hinweis auf #1', await dup.textContent().catch(() => ''));
  await dup.locator('button', { hasText: 'Zu #1 hinzufügen' }).click();
  check(await app.locator('.drawer input[type=text]').first().isHidden(), 'Beim Hinzufügen: Titel, Kategorie, Screenshot ausgeblendet');
  check((await app.locator('.drawer .btn.primary').textContent()).includes('Zu #1 hinzufügen'), 'Speichern-Knopf heißt „Zu #1 hinzufügen“');
  await app.screenshot({ path: join(OUT, 'dup-1-dialog.png') });
  await app.locator('.drawer textarea').first().fill('Auch auf dem Handy kaum zu sehen.');
  await saveDrawer();
  let s = await stored();
  check(s.anns.length === 1 && /Grau auf Weiß\.\n\nNachtrag \([^)]+\): Auch auf dem Handy kaum zu sehen\./.test(s.anns[0].description), 'Keine zweite Anmerkung – Nachtrag an #1 angehängt', JSON.stringify(s.anns.map((a) => a.description)));
  check(s.trail.some((e) => e.type === 'annotation' && e.label === 'Nachtrag zu #1'), 'Klickpfad: „Nachtrag zu #1“');

  // the same element, but really a new point
  await pickElement('.hint-text');
  await app.locator('.drawer input[type=text]').first().fill('Rechtschreibung im Hinweis');
  await app.locator('.drawer textarea').first().fill('„Rabatte“ ohne Komma.');
  await saveDrawer();
  s = await stored();
  check(s.anns.length === 2, 'Trotzdem neu anlegen bleibt möglich (Standard)', String(s.anns.length));

  // another element: no hint
  await pickElement('h1');
  check((await app.locator('.drawer .dup').count()) === 0, 'Anderes Element: kein Hinweis');
  await app.keyboard.press('Escape');
  await app.locator('.drawer').waitFor({ state: 'detached' }).catch(() => app.keyboard.press('Escape'));
  await app.waitForTimeout(300);

  // areas: mostly the same area
  await drawRegion('.items');
  await app.locator('.drawer textarea').first().fill('Liste zu eng.');
  await saveDrawer();
  await drawRegion('.items');
  const dupRegion = await app.locator('.drawer .dup').textContent().catch(() => '');
  check(dupRegion.includes('#3 Liste zu eng'), 'Fast gleicher Bereich: Hinweis auf #3', dupRegion);
  await app.keyboard.press('Escape');
  await app.waitForTimeout(300);
  if (await app.locator('.drawer').count()) await app.keyboard.press('Escape');

  // re-test: the earlier item is pointed out
  const sid = (await stored()).sid;
  await send({ type: 'fl:stopSession' });
  await app.waitForSelector('feedback-lens-ui', { state: 'detached' });
  await send({ type: 'fl:startRetest', baseSessionId: sid, url: APP });
  await app.reload();
  await app.waitForSelector('feedback-lens-ui', { state: 'attached' });
  await app.waitForTimeout(500);
  await send({ type: 'fl:saveUi', patch: { retestOpen: false } });
  await pickElement('.hint-text');
  const planHint = await app.locator('.drawer .dup').textContent().catch(() => '');
  check(/#1 „Hinweis kaum lesbar“ aus dem früheren Test/.test(planHint), 'Nachtest: Hinweis auf #1 aus dem früheren Test', planHint);
  await app.locator('.drawer .dup button', { hasText: 'Zur Nachtest-Liste' }).click();
  await app.waitForTimeout(300);
  check((await app.locator('.drawer').count()) === 0 && (await app.locator('.rt-item.sel').count()) === 1 && (await app.locator('.rt-item.sel').textContent()).includes('#1'), '„Zur Nachtest-Liste“ öffnet die Liste bei #1');
} catch (err) {
  failures.push(String(err?.stack || err));
  console.error(err);
} finally {
  await cleanup();
  server.close();
}
console.log(failures.length ? `\n${failures.length} Prüfung(en) fehlgeschlagen` : '\nalles bestanden');
process.exit(failures.length ? 1 : 0);
