// The report shows the click path (with the technical errors where they
// happened) and the technical errors grouped; the dashboard previews the
// report in a sandboxed frame – the report's own scripts run there, extension
// APIs do not exist there.
import { startServer } from './server.mjs';
import { launch } from './launch.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.FL_OUT || '/tmp/fl-e2e-out';
mkdirSync(OUT, { recursive: true });
const PORT = 4186;
const APP = `http://localhost:${PORT}/`;
const failures = [];
const check = (cond, label, detail = '') => {
  if (!cond) failures.push(`${label} → ${detail}`);
  console.log(`${cond ? '✔' : '✘'} ${label}${!cond && detail ? ` → ${detail}` : ''}`);
};

const server = await startServer(PORT);
const { context, sw, extUrl, cleanup } = await launch({ viewport: { width: 1280, height: 860 } });
try {
  const app = await context.newPage();
  await app.goto(APP);
  const ext = await context.newPage();
  await ext.goto(extUrl('src/popup/popup.html'));
  await ext.evaluate((m) => chrome.runtime.sendMessage(m), { type: 'fl:startSession', name: 'Bericht', url: APP });
  await app.bringToFront();
  await app.waitForSelector('feedback-lens-ui', { state: 'attached' });
  await app.waitForTimeout(500);

  // a JS error, a failed request with console error, then an annotation on the button
  await app.locator('#coupon').click();
  await app.locator('.code').fill('SOMMER10');
  await app.locator('[data-testid="checkout-next"]').click();
  await app.waitForTimeout(1200);
  await sw.evaluate(async (port) => {
    const [tab] = await chrome.tabs.query({ url: `http://localhost:${port}/*` });
    await chrome.tabs.sendMessage(tab.id, { type: 'fl:command', action: 'pick' });
  }, PORT);
  const btn = await app.locator('[data-testid="checkout-next"]').boundingBox();
  await app.mouse.move(btn.x + 10, btn.y + 5);
  await app.mouse.click(btn.x + 10, btn.y + 5);
  await app.locator('.drawer textarea').first().fill('Weiter zeigt keinen Fehler, obwohl der Server 500 liefert.');
  await app.locator('.drawer .btn.primary').click();
  await app.locator('.drawer').waitFor({ state: 'detached' });
  await app.waitForTimeout(2000); // technical events are stored every 1.5 s

  // --- dashboard: preview -------------------------------------------------------------
  const dash = await context.newPage();
  await dash.goto(extUrl('src/dashboard/dashboard.html'));
  await dash.locator('.s-actions button', { hasText: 'Bericht ansehen' }).click();
  await dash.locator('dialog.preview-dialog').waitFor();
  const frameEl = dash.locator('iframe.preview-frame');
  await frameEl.waitFor();
  let frame = null;
  for (let i = 0; i < 40 && !frame; i++) {
    frame = dash.frames().find((f) => f.url().endsWith('/src/preview/preview.html'));
    if (frame && !(await frame.evaluate(() => Boolean(document.querySelector('.hero'))).catch(() => false))) frame = null;
    if (!frame) await dash.waitForTimeout(150);
  }
  check(Boolean(frame), 'Vorschau zeigt den Bericht im Dashboard');
  const env = await frame.evaluate(() => ({ origin: window.origin, chrome: typeof globalThis.chrome?.runtime?.sendMessage, storage: typeof globalThis.chrome?.storage, toolbar: !document.querySelector('.toolbar').hidden, title: document.querySelector('h1').textContent }));
  check(env.origin === 'null' && env.chrome !== 'function' && env.storage === 'undefined', 'Vorschau ist abgeschottet: eigener Ursprung, keine Erweiterungs-Schnittstellen', JSON.stringify(env));
  check(env.toolbar && env.title === 'Bericht', 'Skripte des Berichts laufen in der Vorschau (Suche/Filter aktiv)', JSON.stringify(env));
  check(await frame.locator('.item input[data-n="1"]').count() === 1, 'Vorschau entspricht bericht.html im Paket (mit Auswahl)');
  await dash.screenshot({ path: join(OUT, 'vorschau-1.png') });

  // technical errors: grouped, details, link to the finding
  const tech = frame.locator('#technik');
  const rows = await tech.locator('.tech-row > summary').allTextContents();
  check(rows.length >= 3 && rows.some((t) => /Netzwerk 500/.test(t) && /POST \/api\/checkout/.test(t)) && rows.some((t) => /JS-Fehler/.test(t)) && rows.some((t) => /Konsole · Fehler/.test(t)), 'Technische Fehler: Netzwerk 500, JS-Fehler, Konsole', JSON.stringify(rows));
  check(/^Netzwerk|^JS|^Konsole · Fehler/.test(rows[0]) && !(await tech.locator(':scope > details.panel').getAttribute('open') === null), 'Schwere Fehler zuerst, Abschnitt offen');
  const net = tech.locator('.tech-row', { hasText: 'Netzwerk 500' });
  await net.locator('summary').click();
  const det = await net.locator('.tdet').textContent();
  check(/payment-service unavailable|PAY_503/.test(det) && /bei #1/.test(det), 'Details: Antwort des Servers und betroffene Anmerkung', det.slice(0, 300));

  // click path: timeline with the errors in place, link from the finding
  const trail = frame.locator('#klickpfad');
  check((await trail.locator(':scope > details').getAttribute('open')) === null, 'Klickpfad zunächst zugeklappt');
  await frame.locator('#a1 > details > summary').click();
  await frame.locator('#a1 a.chip', { hasText: 'Im Klickpfad' }).click();
  await dash.waitForTimeout(400);
  check((await trail.locator(':scope > details').getAttribute('open')) !== null && (await frame.locator('#k1').isVisible()), '„Im Klickpfad“ öffnet den Klickpfad an der Anmerkung');
  const steps = await trail.locator('.timeline li').evaluateAll((els) => els.map((el) => `${el.className}|${el.textContent}`));
  const iClick = steps.findIndex((t) => /Klick auf „Weiter“/.test(t));
  const iNet = steps.findIndex((t) => t.startsWith('t-tech') && /Netzwerk 500/.test(t));
  const iAnn = steps.findIndex((t) => t.startsWith('t-annotation') && /Anmerkung #1/.test(t));
  check(iClick >= 0 && iNet > iClick && iAnn > iNet, 'Zeitleiste: Klick → Fehler 500 → Anmerkung, in dieser Reihenfolge', JSON.stringify({ iClick, iNet, iAnn }));
  await trail.locator('[data-trail-tech]').uncheck();
  check(await trail.locator('.t-tech').first().isHidden(), 'Fehler im Ablauf lassen sich ausblenden');
  await trail.locator('[data-trail-tech]').check();
  await frame.locator('#k1 a').click();
  await dash.waitForTimeout(300);
  check((await frame.locator('#a1 > details').getAttribute('open')) !== null, 'Vom Klickpfad zurück zur Anmerkung');
  await frame.locator('#a1 .decide [data-d="reject"]').click();
  check((await frame.locator('#a1 .dchip').textContent()) === 'Nicht umsetzen' && (await frame.locator('#sel-count').textContent()) === '1 nicht umsetzen', 'Entscheidungen funktionieren auch in der Vorschau (ohne Speicher)', await frame.locator('#sel-count').textContent());
  await frame.locator('#a1 .decide [data-d="reject"]').click();
  await frame.evaluate(() => document.getElementById('klickpfad').scrollIntoView());
  await dash.screenshot({ path: join(OUT, 'vorschau-2-klickpfad.png') });

  // links to the app open outside the sandbox
  const pageLink = await frame.locator('#a1 a.chip[target="_blank"]').count();
  check(pageLink === 1, 'Link zur Seite öffnet in einem neuen Tab');

  // Esc: first the large picture, then the preview
  await frame.locator('#a1 .gallery img').first().click();
  await frame.locator('.zoom').waitFor();
  await dash.keyboard.press('Escape');
  await dash.waitForTimeout(300);
  check((await frame.locator('.zoom').isHidden()) && (await dash.locator('dialog.preview-dialog').count()) === 1, 'Esc schließt zuerst die Großansicht, die Vorschau bleibt');
  await dash.keyboard.press('Escape');
  await dash.locator('dialog.preview-dialog').waitFor({ state: 'detached' });
  check(true, 'Zweites Esc schließt die Vorschau');

  // „Aktualisieren“ shows changes without export
  const title = dash.locator('.ann .ann-title').first();
  await title.fill('Fehler 500 wird nicht angezeigt');
  await title.blur();
  await dash.waitForTimeout(800);
  await dash.locator('.s-actions button', { hasText: 'Bericht ansehen' }).click();
  await dash.locator('dialog.preview-dialog').waitFor();
  await dash.waitForTimeout(800);
  frame = dash.frames().find((f) => f.url().endsWith('/src/preview/preview.html'));
  check((await frame.locator('#a1 .ttl').textContent()) === 'Fehler 500 wird nicht angezeigt', 'Vorschau zeigt Änderungen sofort (ohne Export)');
} catch (err) {
  failures.push(String(err?.stack || err));
  console.error(err);
} finally {
  await cleanup();
  server.close();
}
console.log(failures.length ? `\n${failures.length} Prüfung(en) fehlgeschlagen` : '\nalles bestanden');
process.exit(failures.length ? 1 : 0);
