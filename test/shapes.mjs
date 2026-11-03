// Shapes on screenshots: frame, ellipse, arrow and line in a choice of
// colours, Shift for straight lines, selecting to move, recolour and remove
// (× and Entf), undo of a move – and that the selection never ends up in the
// saved image.
import { startServer } from './server.mjs';
import { launch } from './launch.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.FL_OUT || '/tmp/fl-e2e-out';
mkdirSync(OUT, { recursive: true });
const PORT = 4180;
const APP = `http://localhost:${PORT}/`;
const failures = [];
const check = (cond, label, detail = '') => {
  if (!cond) failures.push(`${label} → ${detail}`);
  console.log(`${cond ? '✔' : '✘'} ${label}${!cond && detail ? ` → ${detail}` : ''}`);
};
const GREEN = [22, 163, 74];
const RED = [244, 63, 94];
const ORANGE = [245, 158, 11];
const VIOLET = [124, 58, 237];
const near = (p, c, tol = 45) => p.every((v, i) => Math.abs(v - c[i]) <= tol);

const server = await startServer(PORT);
const { context, sw, extUrl, cleanup } = await launch({ viewport: { width: 1280, height: 800 } });
const errors = [];
try {
  const app = await context.newPage();
  app.on('pageerror', (e) => !/reading '(foo|bar)'/.test(e.message) && errors.push(e.message));
  await app.goto(APP);
  const ext = await context.newPage();
  await ext.goto(extUrl('src/popup/popup.html'));
  await ext.evaluate((m) => chrome.runtime.sendMessage(m), { type: 'fl:startSession', name: 'Formen', url: APP });
  await app.bringToFront();
  await app.waitForSelector('feedback-lens-ui', { state: 'attached' });
  await app.waitForTimeout(500);
  const sid = await sw.evaluate(async () => (await chrome.storage.local.get('fl:active'))['fl:active']);

  await sw.evaluate(async (port) => {
    const [tab] = await chrome.tabs.query({ url: `http://localhost:${port}/*` });
    await chrome.tabs.sendMessage(tab.id, { type: 'fl:command', action: 'pick' });
  }, PORT);
  const h1 = await app.locator('h1').boundingBox();
  await app.mouse.move(h1.x + 10, h1.y + 5);
  await app.mouse.click(h1.x + 10, h1.y + 5);
  await app.locator('.drawer canvas.preview').waitFor();

  // --- compact tools in the dialog ------------------------------------------------
  const tools = await app.locator('.drawer .shot-tools button[data-tool]').evaluateAll((els) => els.map((e) => e.dataset.tool));
  check(tools.join(',') === 'move,rect,ellipse,arrow,line,pen,num,box', 'Dialog: Werkzeuge Auswählen, Rahmen, Kreis, Pfeil, Linie, Freihand, Nummern, Schwärzen', tools.join(','));
  check((await app.locator('.drawer .shot-tools .flm-color').count()) === 4, 'Dialog: vier Farben');
  check((await app.locator('.drawer .shot-tools button[data-tool=rect]').getAttribute('aria-pressed')) === 'true', 'Rahmen ist voreingestellt (statt Freihand)');
  await app.locator('.drawer .shot-tools').screenshot({ path: join(OUT, 'shapes-0-tools.png') });

  // --- large editor ----------------------------------------------------------------
  await app.locator('.drawer .shot-expand').click();
  await app.locator('.flm-editor').waitFor();
  await app.locator('.flm-seg button', { hasText: 'Ganze Ansicht' }).click();
  await app.waitForTimeout(150);
  const full = await app.locator('.flm-canvas').boundingBox();
  const vp = await app.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const k = full.width / vp.width;
  const S = ([x, y]) => [full.x + x * k, full.y + y * k];
  const drag = async (a, b, { shift = false } = {}) => {
    await app.mouse.move(...S(a));
    await app.mouse.down();
    if (shift) await app.keyboard.down('Shift');
    await app.mouse.move(...S(b), { steps: 6 });
    await app.mouse.up();
    if (shift) await app.keyboard.up('Shift');
  };
  const tool = (id) => app.locator(`.flm-editor .flm-seg button[data-tool=${id}]`).click();
  const color = (label) => app.locator(`.flm-editor .flm-color[aria-label="Farbe ${label}"]`).click();
  check((await app.locator('.flm-editor .flm-seg button[data-tool=rect] span').isVisible()) && !(await app.locator('.flm-editor .flm-seg button[data-tool=pen] span').isVisible()), 'Editor: nur das gewählte Werkzeug zeigt seinen Namen');

  // frame (green), moved by 40, move undone, moved by 80
  const R = [[700, 420], [860, 520]];
  await color('Grün');
  await tool('rect');
  await drag(...R);
  await tool('move');
  await drag([780, 470], [820, 470]);
  await app.keyboard.press('Control+z');
  await drag([780, 470], [860, 470]);

  // ellipse (red) – removed with the × of the selection
  await tool('ellipse'); // a new tool ends the selection – the colour is for the next shape
  await color('Rot');
  const E = [[300, 420], [460, 520]];
  await drag(...E);
  await tool('move');
  await app.mouse.click(...S([380, 420])); // on its edge
  await app.mouse.click(...S([460 + 6 / k, 420 - 6 / k])); // the × at the top right of the selection
  // line – removed with Entf
  await tool('line');
  const L = [[300, 650], [500, 650]];
  await drag(...L);
  await tool('move');
  await app.mouse.click(...S([400, 650]));
  await app.keyboard.press('Delete');

  // arrow (orange) with Shift: exactly 45°, then recoloured violet while selected
  await color('Orange');
  await tool('arrow');
  const P = [520, 200];
  await drag(P, [P[0] + 100, P[1] + 90], { shift: true });
  await tool('move');
  const d = Math.hypot(100, 90) / Math.SQRT2;
  await app.mouse.click(...S([P[0] + d / 2, P[1] + d / 2]));
  await color('Violett');
  check((await app.locator('.flm-editor .flm-color[aria-label="Farbe Violett"]').getAttribute('aria-pressed')) === 'true', 'Auswahl: Farbfeld zeigt ihre neue Farbe');
  await app.screenshot({ path: join(OUT, 'shapes-1-editor.png') });
  // the arrow stays selected while saving
  await app.locator('.flm-done').click();
  await app.locator('.drawer textarea').first().fill('Formen-Test');
  await app.locator('.drawer .btn.primary').click();
  await app.locator('.drawer').waitFor({ state: 'detached' });
  await app.waitForTimeout(500);

  const data = await sw.evaluate(() => chrome.storage.local.get(null));
  const ann = data[`fl:ann:${sid}`][0];
  const px = await ext.evaluate(
    async ({ src, width, points }) => {
      const img = await createImageBitmap(await (await fetch(src)).blob());
      const c = new OffscreenCanvas(img.width, img.height);
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const f = img.width / width;
      return points.map(([x, y]) => Array.from(ctx.getImageData(Math.round(x * f), Math.round(y * f), 1, 1).data.slice(0, 3)));
    },
    {
      src: data[`fl:img:${ann.id}:full`],
      width: vp.width,
      points: [
        [R[0][0] + 80, 470], // frame, left edge after moving
        [R[0][0], 470], // where it was drawn
        [R[0][0] + 40, 470], // the undone move
        [300, 470], // ellipse edge (removed)
        [400, 650], // line (removed)
        [P[0] + d / 2, P[1] + d / 2], // arrow at 45°
        [P[0] + d + 6 / k, P[1] - 6 / k], // where the × of the selection was
      ],
    },
  );
  const [frame, origin, undone, ellipse, line, arrow, handle] = px;
  check(near(frame, GREEN), 'Grüner Rahmen, verschoben', JSON.stringify(frame));
  check(!near(origin, GREEN) && !near(undone, GREEN), 'Rückgängig nimmt das Verschieben zurück (keine Reste an alter Stelle)', JSON.stringify([origin, undone]));
  check(!near(ellipse, RED) && !near(line, RED), 'Mit × und Entf entfernte Formen sind nicht im Bild', JSON.stringify([ellipse, line]));
  check(near(arrow, VIOLET), 'Pfeil mit Umschalt genau 45°, nachträglich violett', JSON.stringify(arrow));
  check(!near(handle, [220, 38, 38], 30), 'Auswahlrahmen und × landen nicht im gespeicherten Bild', JSON.stringify(handle));
  check(ann.images?.drawn === true, 'Kennzeichnung „markiert“', JSON.stringify(ann.images));
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
