// Screenshot marks: the large editor in the annotation dialog, the tester's
// last clicks as numbered circles, numbers set by hand, blacking out in the
// large editor, adding marks later in the dashboard, and the legend in the export.
import { startServer } from './server.mjs';
import { launch } from './launch.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.FL_OUT || '/tmp/fl-e2e-out';
mkdirSync(OUT, { recursive: true });
const PORT = 4177;
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
  app.on('pageerror', (e) => !/reading '(foo|bar)'/.test(e.message) && errors.push(e.message)); // the demo's coupon link throws on purpose
  await app.goto(APP);
  const ext = await context.newPage();
  ext.on('pageerror', (e) => errors.push(e.message));
  await ext.goto(extUrl('src/popup/popup.html'));
  const send = (msg) => ext.evaluate((m) => chrome.runtime.sendMessage(m), msg);
  await send({ type: 'fl:startSession', name: 'Markierungen', url: APP });
  await app.bringToFront();
  await app.waitForSelector('feedback-lens-ui', { state: 'attached' });
  await app.waitForTimeout(500);
  const sid = await sw.evaluate(async () => (await chrome.storage.local.get('fl:active'))['fl:active']);
  const stored = async () => {
    const data = await sw.evaluate(() => chrome.storage.local.get(null));
    const ann = (data[`fl:ann:${sid}`] || [])[0];
    return { ann, crop: ann && data[`fl:img:${ann.id}:crop`], full: ann && data[`fl:img:${ann.id}:full`] };
  };
  /** RGB at CSS-px positions of the viewport, read from a stored image covering `area` (CSS px). */
  const pixels = (src, area, points) =>
    ext.evaluate(
      async ({ src, area, points }) => {
        const img = await createImageBitmap(await (await fetch(src)).blob());
        const c = new OffscreenCanvas(img.width, img.height);
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const k = img.width / area.width;
        return points.map(([x, y]) => Array.from(ctx.getImageData(Math.round((x - area.x) * k), Math.round((y - area.y) * k), 1, 1).data.slice(0, 3)));
      },
      { src, area, points },
    );
  const isBlue = ([r, g, b]) => b > 180 && r < 120 && g < 150;
  const ring = ([x, y]) => [x - 7, y]; // inside the circle, beside the digit
  const isBlack = (p) => p.every((v) => v < 20);

  // two clicks the screenshot can show
  const code = await app.locator('.code').boundingBox();
  const click1 = [Math.round(code.x + 30), Math.round(code.y + code.height / 2)];
  await app.mouse.click(...click1);
  const coupon = await app.locator('#coupon').boundingBox();
  const click2 = [Math.round(coupon.x + coupon.width / 2), Math.round(coupon.y + coupon.height / 2)];
  await app.mouse.click(...click2);
  await app.waitForTimeout(300);

  await sw.evaluate(async (port) => {
    const [tab] = await chrome.tabs.query({ url: `http://localhost:${port}/*` });
    await chrome.tabs.sendMessage(tab.id, { type: 'fl:command', action: 'pick' });
  }, PORT);
  const hint = await app.locator('.hint-text').boundingBox();
  await app.mouse.move(hint.x + 20, hint.y + 4);
  await app.mouse.click(hint.x + 20, hint.y + 4);
  await app.locator('.drawer canvas.preview').waitFor();
  const toggle = app.locator('.drawer .shot-foot label', { hasText: 'Letzte Klicks einzeichnen' });
  check((await toggle.textContent())?.includes('(2)'), 'Dialog bietet die letzten 2 Klicks an', await toggle.textContent());
  check(!(await toggle.locator('input').isChecked()), 'Klicks standardmäßig nicht eingezeichnet');
  await toggle.locator('input').check();

  // --- large editor ----------------------------------------------------------------
  await app.locator('.drawer .shot-expand').click();
  await app.locator('.flm-editor').waitFor();
  await app.waitForTimeout(200);
  const big = await app.locator('.flm-canvas').boundingBox();
  check(big.width > 900, 'Großer Editor nutzt das Fenster (neben der Notizspalte)', `${Math.round(big.width)}×${Math.round(big.height)} px`);
  const chips = await app.locator('.flm-chip').allTextContents();
  check(chips.length === 2 && chips[0].startsWith('①') && chips[1].startsWith('②'), 'Klicks als ① ② in ihrer Reihenfolge', JSON.stringify(chips));
  await app.locator('.flm-seg button', { hasText: 'Ganze Ansicht' }).click();
  await app.waitForTimeout(100);
  const full = await app.locator('.flm-canvas').boundingBox();
  const vp = await app.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const toScreen = ([x, y]) => [full.x + (x / vp.width) * full.width, full.y + (y / vp.height) * full.height];
  const manual = [900, 600];
  await app.locator('.flm-seg button[data-tool=num]').click();
  await app.mouse.click(...toScreen(manual));

  // notes: one field per number, next to the picture
  const side = app.locator('.flm-side');
  const note = (where, n) => where.locator(`input[aria-label="Notiz zu Nummer ${n}"]`);
  const noteRow = (where, n) => where.locator('.flm-note', { has: app.locator(`input[aria-label="Notiz zu Nummer ${n}"]`) });
  check(await side.isVisible() && (await side.locator('.flm-note').count()) === 3, 'Großer Editor: Notizfeld je Nummer (① ② ③)', await side.textContent().catch(() => ''));
  check((await side.locator('.flm-note-label').first().textContent()).includes('Klick auf'), 'Bei Klicks steht dabei, worauf geklickt wurde');
  await note(side, 1).fill('Fokus springt nicht ins Feld');
  await note(side, 3).fill('Preis abgeschnitten');
  await app.mouse.click(...toScreen([1000, 680]));
  await note(side, 4).fill('Weg damit');
  await noteRow(side, 3).locator('.flm-note-x').click();
  check((await note(side, 3).inputValue()) === 'Weg damit' && (await note(side, 4).count()) === 0, 'Nummer entfernt: aus ④ wird ③, die Notiz wandert mit', await note(side, 3).inputValue());
  await app.locator('.flm-icon[aria-label="Rückgängig"]').click();
  check((await note(side, 3).inputValue()) === 'Preis abgeschnitten' && (await note(side, 4).inputValue()) === 'Weg damit', 'Rückgängig holt die Nummer samt Notiz zurück');
  await noteRow(side, 4).locator('.flm-note-x').click();
  const h1 = await app.locator('h1').boundingBox();
  const box = [Math.round(h1.x), Math.round(h1.y), Math.round(h1.x + 120), Math.round(h1.y + h1.height)];
  await app.locator('.flm-seg button[data-tool=box]').click();
  await app.mouse.move(...toScreen([box[0], box[1]]));
  await app.mouse.down();
  await app.mouse.move(...toScreen([box[2], box[3]]), { steps: 5 });
  await app.mouse.up();
  await app.screenshot({ path: join(OUT, 'marks-1-editor.png') });
  await app.keyboard.press('Escape');
  await app.waitForTimeout(150);
  check((await app.locator('.flm-editor').count()) === 0 && (await app.locator('.drawer').count()) === 1, 'Esc schließt nur den Editor, der Dialog bleibt offen');
  const dialogNotes = app.locator('.drawer .flm-notes');
  check((await note(dialogNotes, 1).inputValue()) === 'Fokus springt nicht ins Feld' && (await note(dialogNotes, 3).inputValue()) === 'Preis abgeschnitten', 'Dialog zeigt dieselben Notizen unter dem Screenshot');
  await note(dialogNotes, 2).fill('Link reagiert nicht');
  await dialogNotes.scrollIntoViewIfNeeded();
  await app.screenshot({ path: join(OUT, 'marks-3-notes.png') });
  await app.locator('.drawer textarea').first().fill('Hinweistext kaum lesbar');
  await app.locator('.drawer .btn.primary').click();
  await app.locator('.drawer').waitFor({ state: 'detached' });
  await app.waitForTimeout(400);

  let s = await stored();
  const imgs = s.ann?.images || {};
  check(JSON.stringify(imgs.clicks?.map((c) => c.n)) === '[1,2]' && JSON.stringify(imgs.numbers?.map((x) => x.n)) === '[3]', 'Gespeichert: Klicks ① ② und Nummer ③ von Hand', JSON.stringify({ clicks: imgs.clicks, numbers: imgs.numbers }));
  check(imgs.clicks?.[0]?.note === 'Fokus springt nicht ins Feld' && imgs.clicks?.[1]?.note === 'Link reagiert nicht' && imgs.numbers?.[0]?.note === 'Preis abgeschnitten', 'Notizen gespeichert', JSON.stringify(imgs));
  check(imgs.redacted === true && imgs.drawn === false, 'Kennzeichnung: geschwärzt, keine Freihand-Striche', JSON.stringify(imgs));
  const fullArea = { x: 0, y: 0, width: vp.width };
  const [p1, p2, p3] = await pixels(s.full, fullArea, [click1, click2, manual].map(ring));
  check(isBlue(p1) && isBlue(p2) && isBlue(p3), 'Blaue Nummernkreise an Klickstellen und gesetzter Stelle', JSON.stringify([p1, p2, p3]));
  const mid = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
  const [fb] = await pixels(s.full, fullArea, [mid]);
  const [cb] = await pixels(s.crop, imgs.cropRect, [mid]);
  check(isBlack(fb) && isBlack(cb), 'Im großen Editor Geschwärztes ist in ganzer Ansicht und Ausschnitt schwarz', JSON.stringify([fb, cb]));

  // --- dashboard: add marks later ----------------------------------------------------
  await ext.goto(extUrl('src/dashboard/dashboard.html'));
  await ext.bringToFront();
  await ext.locator('.media-links a', { hasText: 'nachzeichnen' }).first().click();
  await ext.locator('.flm-editor').waitFor();
  await ext.waitForTimeout(200);
  check((await ext.locator('.flm-check').count()) === 0, 'Bereits eingezeichnete Klicks werden nicht erneut angeboten');
  // Esc = cancel: nothing changes
  await ext.locator('.flm-seg button[data-tool=num]').click();
  let canvas = await ext.locator('.flm-canvas').boundingBox();
  await ext.mouse.click(canvas.x + 20, canvas.y + 20);
  await ext.keyboard.press('Escape');
  await ext.waitForTimeout(400);
  check((await stored()).ann.updatedAt === s.ann.updatedAt, 'Abbrechen (Esc) im Dashboard ändert nichts');

  await ext.locator('.media-links a', { hasText: 'nachzeichnen' }).first().click();
  await ext.locator('.flm-editor').waitFor();
  await ext.waitForTimeout(200);
  // crop view first: its marks must reach the full view too
  const cr = imgs.cropRect;
  canvas = await ext.locator('.flm-canvas').boundingBox();
  const inCrop = ([x, y]) => [canvas.x + ((x - cr.x) / cr.width) * canvas.width, canvas.y + ((y - cr.y) / cr.height) * canvas.height];
  const box2 = [cr.x + cr.width - 160, cr.y + 10, cr.x + cr.width - 40, cr.y + 40];
  await ext.locator('.flm-seg button[data-tool=box]').click();
  await ext.mouse.move(...inCrop([box2[0], box2[1]]));
  await ext.mouse.down();
  await ext.mouse.move(...inCrop([box2[2], box2[3]]), { steps: 5 });
  await ext.mouse.up();
  const manual2 = [cr.x + 40, cr.y + cr.height - 30];
  await ext.locator('.flm-seg button[data-tool=num]').click();
  await ext.mouse.click(...inCrop(manual2));
  await note(ext.locator('.flm-side'), 4).fill('Neue Stelle');
  await ext.screenshot({ path: join(OUT, 'marks-2-dashboard.png') });
  await ext.locator('.flm-done').click();
  await ext.waitForTimeout(1200);

  s = await stored();
  check(JSON.stringify(s.ann.images.numbers.map((x) => x.n)) === '[3,4]' && s.ann.images.numbers[1].note === 'Neue Stelle', 'Dashboard: neue Nummer zählt weiter (④), mit Notiz', JSON.stringify(s.ann.images.numbers));
  const mid2 = [(box2[0] + box2[2]) / 2, (box2[1] + box2[3]) / 2];
  const [f2, fOld, fNum] = await pixels(s.full, fullArea, [mid2, mid, ring(manual2)]);
  const [c2, cOld] = await pixels(s.crop, cr, [mid2, mid]);
  check(isBlack(f2) && isBlack(c2), 'Dashboard: im Ausschnitt Geschwärztes ist auch in der ganzen Ansicht schwarz', JSON.stringify([f2, c2]));
  check(isBlack(fOld) && isBlack(cOld) && isBlue(fNum), 'Früheres bleibt, neue Nummer ist eingezeichnet', JSON.stringify([fOld, cOld, fNum]));
  await ext.waitForTimeout(300);
  const meta = await ext.locator('.media-meta span').first().textContent();
  check(/4 Nummern/.test(meta) && /geschwärzt/.test(meta), 'Karte zeigt „4 Nummern · geschwärzt“', meta);

  // notes are editable on the card
  const cardNotes = ext.locator('.ann .num-notes');
  check((await cardNotes.locator('.num-note').count()) === 4, 'Karte: Notizen zu allen 4 Nummern', await cardNotes.textContent().catch(() => ''));
  await note(cardNotes, 3).fill('Preis rechts abgeschnitten');
  await ext.locator('.ann .ann-title').click(); // blur saves
  await ext.waitForTimeout(800);
  s = await stored();
  check(s.ann.images.numbers[0].note === 'Preis rechts abgeschnitten', 'Notiz im Dashboard geändert und gespeichert', JSON.stringify(s.ann.images.numbers));

  // --- legend in the export ------------------------------------------------------------
  const md = await ext.evaluate(async (sid) => {
    const r = await import(chrome.runtime.getURL('src/lib/report.js'));
    const bundle = await r.loadBundle(sid);
    const images = await r.loadImages(bundle.annotations);
    return r.issueMarkdown(bundle.annotations[0], bundle, { images });
  }, sid);
  const observation = md.slice(md.indexOf('Beobachtung'), md.indexOf('Erwartung / Vorschlag'));
  check(
    observation.includes('**Zu den Nummern im Screenshot**') &&
      /\*\*①\*\* Klick auf „Code“ \(`[^`]*`\), \d\d:\d\d:\d\d – Fokus springt nicht ins Feld/.test(observation) &&
      /\*\*②\*\* Klick auf .* – Link reagiert nicht/.test(observation) &&
      observation.includes('**③** Preis rechts abgeschnitten') &&
      observation.includes('**④** Neue Stelle'),
    'Export: Notizen zu ①–④ direkt unter der Beobachtung',
    observation,
  );
  check(md.includes('_Die blauen Nummern sind unter „Beobachtung“ erklärt._'), 'Unter den Screenshots: Verweis auf die Erklärung');
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
