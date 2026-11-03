// Robustness test on a page with strict CSP + Trusted Types, aggressive global
// CSS, a max z-index sticky header and a same-origin iframe.
import { startServer } from './server.mjs';
import { launch } from './launch.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.FL_OUT || '/tmp/fl-e2e-out';
mkdirSync(OUT, { recursive: true });
const URL_ = 'http://localhost:4173/hostile/';
const failures = [];
const check = (cond, label, detail = '') => {
  if (!cond) failures.push(`${label} → ${detail}`);
  console.log(`${cond ? '✔' : '✘'} ${label}${!cond && detail ? ` → ${detail}` : ''}`);
};

const server = await startServer(4173);
const { context, sw, extUrl, cleanup } = await launch();
const errors = [];
try {
  const app = await context.newPage();
  app.on('pageerror', (e) => errors.push(e.message));
  app.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await app.goto(URL_);
  const ext = await context.newPage();
  await ext.goto(extUrl('src/popup/popup.html'));
  await ext.evaluate((url) => chrome.runtime.sendMessage({ type: 'fl:startSession', name: 'Hostile', url }), URL_);
  await app.bringToFront();
  await app.waitForSelector('feedback-lens-ui', { state: 'attached' });
  await app.waitForTimeout(400);
  const toolbar = await app.locator('feedback-lens-ui .toolbar').boundingBox();
  check(toolbar && toolbar.width > 200, 'Toolbar trotz CSP/aggressivem CSS sichtbar', JSON.stringify(toolbar));
  const style = await app.locator('feedback-lens-ui .toolbar').evaluate((el) => getComputedStyle(el).backgroundColor);
  check(style === 'rgb(15, 23, 42)', 'Overlay-Styles greifen (adoptedStyleSheets)', style);

  const command = (action) =>
    sw.evaluate(async (action) => {
      const [tab] = await chrome.tabs.query({ url: 'http://localhost:4173/*' });
      await chrome.tabs.sendMessage(tab.id, { type: 'fl:command', action });
    }, action);
  const save = async (text) => {
    await app.locator('.drawer textarea').first().waitFor();
    await app.locator('.drawer textarea').first().fill(text);
    await app.locator('.drawer .btn.primary').click();
    await app.locator('.drawer').waitFor({ state: 'detached' });
  };

  await app.click('#api');
  await app.waitForTimeout(600);

  // element on the CSP page
  await command('pick');
  const lead = await app.locator('#lead').boundingBox();
  await app.mouse.move(lead.x + 40, lead.y + 5);
  await app.mouse.click(lead.x + 40, lead.y + 5);
  await app.locator('.drawer canvas.preview').waitFor();
  await app.waitForTimeout(200);
  await app.screenshot({ path: join(OUT, 'hostile-1-drawer.png') });
  await save('Grauer Text schwer lesbar (CSP-Seite).');

  // element inside the same-origin iframe
  await command('pick');
  const frameBox = await app.locator('#frame').boundingBox();
  const sendBox = await app.frameLocator('#frame').locator('#send').boundingBox();
  await app.mouse.move(sendBox.x + 5, sendBox.y + 5);
  await app.waitForTimeout(200);
  await app.screenshot({ path: join(OUT, 'hostile-2-iframe-pick.png') });
  const hl = await app.locator('feedback-lens-ui .hl').boundingBox();
  check(hl && Math.abs(hl.x - sendBox.x) < 4 && Math.abs(hl.y - sendBox.y) < 4, 'Hervorhebung sitzt exakt auf dem iframe-Element', `${JSON.stringify(hl)} vs ${JSON.stringify(sendBox)} (frame ${JSON.stringify(frameBox)})`);
  await app.mouse.click(sendBox.x + 5, sendBox.y + 5);
  await save('Absenden-Button im eingebetteten Formular kaum sichtbar.');
  await app.waitForTimeout(1800);

  const data = await sw.evaluate(() => chrome.storage.local.get(null));
  const sid = data['fl:active'];
  const anns = data[`fl:ann:${sid}`] || [];
  const tech = data[`fl:tech:${sid}`] || [];
  check(anns.length === 2, '2 Anmerkungen gespeichert', String(anns.length));
  check(anns[0]?.element?.contrast && data[`fl:img:${anns[0]?.id}:crop`], 'CSP-Seite: Kontext + Screenshot erfasst');
  const fr = anns[1]?.element;
  check(fr?.inIframe && fr.selector.startsWith('#frame >>> ') && fr.selector.endsWith('#send'), 'iframe-Element mit Deep-Selektor', fr?.selector);
  check(fr?.contrast && !fr.contrast.passesAA, 'iframe-Element: Kontrast gemessen', JSON.stringify(fr?.contrast));
  check(tech.some((e) => e.type === 'network' && e.requestUrl.includes('apiKey=***')), 'Netzwerkfehler unter CSP erfasst, apiKey maskiert', JSON.stringify(tech.map((e) => e.requestUrl || e.message)));
  check(tech.some((e) => e.type === 'console' && /Trusted Types/.test(e.message)), 'console.error unter CSP erfasst');
  const pinCount = await app.locator('feedback-lens-ui .pin').count();
  check(pinCount === 2, 'Pins auf CSP-Seite (inkl. iframe-Element)', String(pinCount));
  await app.screenshot({ path: join(OUT, 'hostile-3-pins.png') });
  const ours = errors.filter((e) => /feedback|lens|chrome-extension/i.test(e));
  check(!ours.length, 'Keine Fehler der Erweiterung in der Seite', ours.join(' | '));
} catch (err) {
  failures.push(String(err.stack || err));
  console.error(err);
} finally {
  console.log(`\n${failures.length ? `${failures.length} fehlgeschlagen` : 'alles bestanden'}`);
  console.log('Seitenfehler (erwartet: TT/500):', errors.join(' | '));
  process.exitCode = failures.length ? 1 : 0;
  await cleanup();
  server.close();
}
