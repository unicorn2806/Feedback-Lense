// Several screenshots per annotation: „Weiteren Screenshot aufnehmen“ parks
// the dialog until the next capture (also on another page), the pictures get
// captions, order and marks; an addition brings its screenshot along; in the
// dashboard pictures can be pasted, captioned, moved, redrawn and removed;
// export and backup carry them.
import { startServer } from './server.mjs';
import { launch } from './launch.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.FL_OUT || '/tmp/fl-e2e-out';
mkdirSync(OUT, { recursive: true });
const PORT = 4183;
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
  ext.on('pageerror', (e) => errors.push(e.message));
  await ext.goto(extUrl('src/popup/popup.html'));
  const send = (msg) => ext.evaluate((m) => chrome.runtime.sendMessage(m), msg);
  await send({ type: 'fl:startSession', name: 'Mehrere Bilder', url: APP });
  await app.bringToFront();
  await app.waitForSelector('feedback-lens-ui', { state: 'attached' });
  await app.waitForTimeout(500);
  const sid = await sw.evaluate(async () => (await chrome.storage.local.get('fl:active'))['fl:active']);
  const storage = () => sw.evaluate(() => chrome.storage.local.get(null));
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
  const region = async (selector) => {
    await command('region');
    const box = await app.locator(selector).first().boundingBox();
    await app.mouse.move(box.x - 4, box.y - 4);
    await app.mouse.down();
    await app.mouse.move(box.x + box.width + 4, box.y + box.height + 4, { steps: 6 });
    await app.mouse.up();
  };
  const rows = app.locator('.drawer .x-row');
  const awaitBar = app.locator('.await-bar');

  // --- first screenshot, then a further one on another page ----------------------------------
  await pick('.hint-text');
  await app.locator('.drawer textarea').first().fill('Rabatt wird auf der Lieferseite nicht übernommen.');
  check((await rows.count()) === 0 && (await app.locator('.drawer .x-add').isVisible()), 'Dialog: „Weiteren Screenshot aufnehmen“');
  await app.locator('.drawer .x-add').click();
  await app.locator('.drawer').waitFor({ state: 'detached' });
  await awaitBar.waitFor();
  check((await awaitBar.textContent()).includes('Weiterer Screenshot für „Rabatt wird'), 'Hinweisleiste: wofür der nächste Screenshot ist', await awaitBar.textContent());
  await app.screenshot({ path: join(OUT, 'extras-1-await.png') });

  await app.goto(`${APP}lieferung`);
  await app.waitForSelector('feedback-lens-ui', { state: 'attached' });
  await awaitBar.waitFor({ timeout: 5000 });
  check(true, 'Auf einer anderen Seite wartet die Leiste weiter');
  await region('main');
  await app.locator('.drawer').waitFor();
  check((await rows.count()) === 1 && (await app.locator('.drawer textarea').first().inputValue()).startsWith('Rabatt wird'), 'Bereich aufgenommen: zurück im Dialog, als Bild 2', String(await rows.count()));
  check((await rows.first().locator('.x-meta').textContent()).includes('/lieferung'), 'Bild 2 zeigt, auf welcher Seite es entstand', await rows.first().locator('.x-meta').textContent());
  check(await awaitBar.isHidden(), 'Hinweisleiste wieder weg');
  await rows.first().locator('input').fill('Lieferseite ohne Rabatt');

  // a third one: the visible area via the bar
  await app.locator('.drawer .x-add').click();
  await app.locator('.drawer').waitFor({ state: 'detached' });
  await awaitBar.locator('button', { hasText: 'Sichtbaren Bereich aufnehmen' }).click();
  await app.locator('.drawer').waitFor();
  check((await rows.count()) === 2 && (await rows.nth(1).locator('.x-meta').textContent()).startsWith('Seite'), 'Sichtbarer Bereich als Bild 3', await rows.nth(1).locator('.x-meta').textContent());
  await rows.nth(1).locator('input').fill('Ganze Lieferseite');
  // order: bring the visible area to the front
  await rows.nth(1).locator('button[aria-label="Nach vorn"]').click();
  check((await rows.nth(0).locator('input').inputValue()) === 'Ganze Lieferseite' && (await rows.nth(0).locator('.x-num').textContent()) === 'Bild 2', 'Umsortiert: Bild 2 und 3 getauscht');
  // marks on a further screenshot in the large editor
  await rows.nth(1).locator('canvas').click();
  await app.locator('.flm-editor').waitFor();
  const big = await app.locator('.flm-canvas').boundingBox();
  await app.mouse.move(big.x + big.width * 0.3, big.y + big.height * 0.3);
  await app.mouse.down();
  await app.mouse.move(big.x + big.width * 0.6, big.y + big.height * 0.6, { steps: 5 });
  await app.mouse.up();
  await app.locator('.flm-done').click();
  await app.screenshot({ path: join(OUT, 'extras-2-dialog.png') });
  await app.locator('.drawer .btn.primary').click();
  await app.locator('.drawer').waitFor({ state: 'detached' });
  await app.waitForTimeout(500);

  let data = await storage();
  let ann = data[`fl:ann:${sid}`][0];
  const ex = ann.images?.extra || [];
  check(ex.length === 2 && ex[0].caption === 'Ganze Lieferseite' && ex[0].kind === 'page' && ex[1].caption === 'Lieferseite ohne Rabatt' && ex[1].kind === 'region', 'Gespeichert: zwei weitere Bilder mit Beschriftung und Reihenfolge', JSON.stringify(ex.map((x) => [x.id, x.caption, x.kind])));
  check(ex[1].url?.endsWith('/lieferung') && ann.page.url === APP && ex[1].drawn === true && !ex[0].drawn, 'Seite je Bild, Markierung nur auf dem bearbeiteten', JSON.stringify(ex.map((x) => [x.url, x.drawn])));
  check(ex.every((x) => data[`fl:img:${ann.id}:${x.id}`]?.startsWith('data:image/')) && data[`fl:img:${ann.id}:crop`], 'Bilder liegen im Speicher', Object.keys(data).filter((k) => k.startsWith('fl:img:')).join(','));

  // --- addition with its screenshot ------------------------------------------------------------
  await app.goto(APP);
  await app.waitForSelector('feedback-lens-ui', { state: 'attached' });
  await app.waitForTimeout(400);
  await pick('.hint-text');
  await app.locator('.drawer .dup button', { hasText: 'Zu #1 hinzufügen' }).click();
  const include = app.locator('.drawer .shot-foot label', { hasText: 'Als weiteres Bild an #1 anhängen' });
  check(await include.isVisible() && (await include.locator('input').isChecked()), 'Nachtrag: Screenshot wird als weiteres Bild an #1 angehängt');
  await app.locator('.drawer textarea').first().fill('Auch nach dem Neuladen.');
  await app.locator('.drawer .btn.primary').click();
  await app.locator('.drawer').waitFor({ state: 'detached' });
  await app.waitForTimeout(500);
  data = await storage();
  ann = data[`fl:ann:${sid}`][0];
  check(data[`fl:ann:${sid}`].length === 1 && ann.images.extra.length === 3 && ann.images.extra[2].caption === 'Nachtrag' && /Nachtrag \([^)]+\): Auch nach dem Neuladen/.test(ann.description), 'Nachtrag: Text angehängt, Screenshot als Bild 4', JSON.stringify(ann.images.extra.map((x) => x.caption)));

  // --- export -----------------------------------------------------------------------------------
  const exported = await ext.evaluate(async (sid) => {
    const r = await import(chrome.runtime.getURL('src/lib/report.js'));
    const bundle = await r.loadBundle(sid);
    const images = await r.loadImages(bundle.annotations);
    const md = r.issueMarkdown(bundle.annotations[0], bundle, { images });
    const html = r.buildHtml(bundle, images);
    const json = r.buildJson(bundle, { images });
    return { md, html, files: json.annotations[0].files };
  }, sid);
  check(/!\[#1 – Bild 2: Ganze Lieferseite\]\(screenshots\/anmerkung-01-bild-2\.(png|jpg)\)/.test(exported.md) && exported.md.includes('**Bild 3: Lieferseite ohne Rabatt** · aufgenommen auf http://localhost:4183/lieferung') && exported.md.includes('Bild 4: Nachtrag'), 'Aufgabendatei: Bilder 2–4 mit Beschriftung und Seite', exported.md.slice(exported.md.indexOf('Screenshots'), exported.md.indexOf('Schritte zum')));
  check(exported.md.includes('Farbige Rahmen, Pfeile und Striche'), 'Hinweis auf eingezeichnete Formen beim bearbeiteten Bild');
  check(exported.files.extra?.length === 3 && exported.files.extra[0].caption === 'Ganze Lieferseite', 'JSON: Dateien der weiteren Bilder', JSON.stringify(exported.files));
  check((exported.html.match(/<figcaption>Bild \d/g) || []).length === 3, 'Bericht: weitere Bilder als Abbildungen');

  // --- dashboard -------------------------------------------------------------------------------
  const dash = await context.newPage();
  dash.on('pageerror', (e) => errors.push(e.message));
  await dash.goto(extUrl('src/dashboard/dashboard.html'));
  await dash.locator('.ann .x-grid').waitFor();
  check((await dash.locator('.ann .x-tile:not(.x-plus)').count()) === 3, 'Karte: drei weitere Bilder als Kacheln');
  await dash.locator('.ann .x-plus').click();
  await dash.locator('.x-drop').waitFor();
  // paste a picture (e.g. from a phone)
  await dash.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 390;
    c.height = 844;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fef3c7';
    ctx.fillRect(0, 0, 390, 844);
    ctx.fillStyle = '#0f172a';
    ctx.font = '28px sans-serif';
    ctx.fillText('Handy-Ansicht', 40, 120);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'handy.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  });
  await dash.locator('.x-preview img').waitFor();
  await dash.locator('.modal input[placeholder^="Was zeigt"]').fill('Handy');
  await dash.screenshot({ path: join(OUT, 'extras-3-paste.png') });
  await dash.locator('.modal .btn.primary').click();
  await dash.waitForTimeout(800);
  data = await storage();
  ann = data[`fl:ann:${sid}`][0];
  const pasted = ann.images.extra[3];
  check(pasted?.kind === 'file' && pasted.caption === 'Handy' && data[`fl:img:${ann.id}:${pasted.id}`]?.startsWith('data:image/png'), 'Eingefügtes Bild als Bild 5 gespeichert', JSON.stringify(pasted));
  check((await dash.locator('.ann .x-tile:not(.x-plus)').count()) === 4, 'Karte zeigt es sofort');
  await dash.waitForTimeout(300);
  await dash.locator('.ann').first().screenshot({ path: join(OUT, 'extras-4-card.png') });

  // open, caption, move, redraw, remove
  await dash.locator('.ann .x-tile:not(.x-plus)').nth(3).click();
  await dash.locator('.x-captionbar input').waitFor();
  check((await dash.locator('.modal-head h2').textContent()) === '#1 – Bild 5 von 5', 'Einzelansicht „Bild 5 von 5“', await dash.locator('.modal-head h2').textContent());
  await dash.locator('.x-captionbar input').fill('Handy, iOS');
  await dash.locator('.x-captionbar input').press('Tab');
  await dash.locator('.modal-head button', { hasText: 'Nach vorn' }).click();
  await dash.waitForTimeout(700);
  data = await storage();
  ann = data[`fl:ann:${sid}`][0];
  check(ann.images.extra[2].caption === 'Handy, iOS' && ann.images.extra[3].caption === 'Nachtrag', 'Beschriftung geändert und nach vorn verschoben', JSON.stringify(ann.images.extra.map((x) => x.caption)));
  await dash.locator('.modal-head button', { hasText: 'Nachzeichnen' }).click();
  await dash.locator('.flm-editor').waitFor();
  const ed = await dash.locator('.flm-canvas').boundingBox();
  await dash.mouse.move(ed.x + ed.width * 0.2, ed.y + ed.height * 0.1);
  await dash.mouse.down();
  await dash.mouse.move(ed.x + ed.width * 0.8, ed.y + ed.height * 0.2, { steps: 5 });
  await dash.mouse.up();
  await dash.locator('.flm-done').click();
  await dash.waitForTimeout(900);
  data = await storage();
  ann = data[`fl:ann:${sid}`][0];
  check(ann.images.extra[2].drawn === true, 'Nachzeichnen eines weiteren Bildes', JSON.stringify(ann.images.extra[2]));
  const removedId = ann.images.extra[3].id;
  await dash.locator('.ann .x-tile:not(.x-plus)').nth(3).click();
  await dash.locator('.modal-head button', { hasText: 'Entfernen' }).click();
  await dash.locator('.modal .btn.danger, dialog .btn.danger', { hasText: 'Entfernen' }).last().click();
  await dash.waitForTimeout(700);
  data = await storage();
  ann = data[`fl:ann:${sid}`][0];
  check(ann.images.extra.length === 3 && !ann.images.extra.some((x) => x.id === removedId) && !data[`fl:img:${ann.id}:${removedId}`], 'Entfernt: Eintrag und Bild gelöscht', JSON.stringify(ann.images.extra.map((x) => x.id)));

  // --- backup round trip, then delete ----------------------------------------------------------------
  const restored = await dash.evaluate(async (sid) => {
    const r = await import(chrome.runtime.getURL('src/lib/report.js'));
    const bundle = await r.loadBundle(sid);
    const data = r.buildJson(bundle, { embed: true, images: await r.loadImages(bundle.annotations) });
    const res = await chrome.runtime.sendMessage({ type: 'fl:importSession', data: { ...data, annotations: data.annotations.map(({ imageData, ...a }) => a) } });
    const { meta, idMap } = res.data;
    const images = [];
    for (const a of data.annotations) {
      for (const [variant, dataUrl] of Object.entries(a.imageData.extra || {})) images.push({ id: idMap[a.id], variant, dataUrl });
    }
    await chrome.runtime.sendMessage({ type: 'fl:importImages', sessionId: meta.id, images });
    const back = await r.loadBundle(meta.id);
    const imgs = await r.loadImages(back.annotations);
    return { extra: back.annotations[0].images.extra.map((x) => x.caption), stored: Object.keys(imgs.get(back.annotations[0].id).extra).length, newSid: meta.id };
  }, sid);
  check(restored.extra.join('|') === 'Ganze Lieferseite|Lieferseite ohne Rabatt|Handy, iOS' && restored.stored === 3, 'Sicherung: weitere Bilder samt Beschriftung wiederhergestellt', JSON.stringify(restored));
  await send({ type: 'fl:stopSession' });
  await send({ type: 'fl:deleteSession', sessionId: sid });
  await send({ type: 'fl:deleteSession', sessionId: restored.newSid });
  data = await storage();
  check(!Object.keys(data).some((k) => k.startsWith('fl:img:')), 'Testläufe gelöscht: alle Bilder gelöscht', Object.keys(data).filter((k) => k.startsWith('fl:img:')).join(','));
  check(errors.length === 0, 'Keine Fehler auf den Seiten', errors.join(' | '));
} catch (err) {
  failures.push(String(err?.stack || err));
  console.error(err);
} finally {
  await cleanup();
  server.close();
}
console.log(failures.length ? `\n${failures.length} Prüfung(en) fehlgeschlagen` : '\nalles bestanden');
process.exit(failures.length ? 1 : 0);
