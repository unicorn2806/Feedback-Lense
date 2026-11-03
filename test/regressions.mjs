// Regression tests for the issues found in the code review: storage access
// from page context, modal dialogs and focus traps of the tested app,
// re-injection with an open drawer, malicious backups, wiping all data.
import { startServer } from './server.mjs';
import { launch } from './launch.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.FL_OUT || '/tmp/fl-e2e-out';
mkdirSync(OUT, { recursive: true });
const BASE = 'http://localhost:4173';
const failures = [];
const check = (cond, label, detail = '') => {
  if (!cond) failures.push(`${label} → ${detail}`);
  console.log(`${cond ? '✔' : '✘'} ${label}${!cond && detail ? ` → ${detail}` : ''}`);
};

const server = await startServer(4173);
const { context, sw, extUrl, cleanup } = await launch();
const pageErrors = [];
try {
  const app = await context.newPage();
  app.on('pageerror', (e) => pageErrors.push(`app: ${e.message}`));
  await app.goto(`${BASE}/`);
  const ext = await context.newPage();
  ext.on('pageerror', (e) => pageErrors.push(`ext: ${e.message}`));
  await ext.goto(extUrl('src/popup/popup.html'));
  const msg = (payload) => ext.evaluate((p) => chrome.runtime.sendMessage(p), payload);
  const command = (action) =>
    sw.evaluate(async (action) => {
      const [tab] = await chrome.tabs.query({ url: 'http://localhost:4173/*' });
      await chrome.tabs.sendMessage(tab.id, { type: 'fl:command', action });
    }, action);
  const storage = () => sw.evaluate(() => chrome.storage.local.get(null));

  await msg({ type: 'fl:startSession', name: 'Regression', url: `${BASE}/` });
  await app.bringToFront();
  await app.waitForSelector('feedback-lens-ui', { state: 'attached' });
  await app.waitForTimeout(300);

  // --- storage is not readable from content-script context ------------------
  const access = await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://localhost:4173/*' });
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        try {
          await chrome.storage.local.get(null);
          return 'lesbar';
        } catch (e) {
          return `gesperrt: ${e.message}`;
        }
      },
    });
    return res.result;
  });
  check(String(access).startsWith('gesperrt'), 'Content-Scripts können chrome.storage nicht lesen', access);
  const forged = await msg({ type: 'fl:deleteSession', sessionId: 'x' });
  check(forged.ok, 'Privilegierte Nachrichten aus Erweiterungsseiten erlaubt');

  // --- failed XHR: status, start of the response and request id ------------------
  await app.evaluate(() => new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/checkout?via=xhr');
    xhr.onloadend = resolve;
    xhr.send();
  }));
  await app.waitForTimeout(2200);
  const xhrEvent = ((await storage())[`fl:tech:${(await storage())['fl:active']}`] || []).find((e) => e.requestUrl?.includes('via=xhr'));
  check(xhrEvent?.status === 500 && xhrEvent.body?.includes('payment-service unavailable') && xhrEvent.requestId === 'x-request-id: req-7f3a9c', 'XHR-Fehler mit Antwortauszug und Request-ID erfasst', JSON.stringify(xhrEvent));

  // --- native modal dialog of the app -------------------------------------------
  await app.click('#btn-help');
  await app.waitForTimeout(1200);
  const parentTag = await app.evaluate(() => document.querySelector('feedback-lens-ui')?.parentElement?.tagName);
  check(parentTag === 'DIALOG', 'Overlay wandert in den offenen modalen Dialog', parentTag);
  await command('pick');
  const helpText = await app.locator('.help-text').boundingBox();
  await app.mouse.move(helpText.x + 20, helpText.y + 5);
  await app.mouse.click(helpText.x + 20, helpText.y + 5);
  await app.locator('.drawer textarea').first().waitFor({ timeout: 5000 });
  await app.locator('.drawer textarea').first().fill('Hilfetext im Dialog ist zu blass.');
  await app.screenshot({ path: join(OUT, 'reg-1-dialog.png') });
  await app.locator('.drawer .btn.primary').click();
  await app.locator('.drawer').waitFor({ state: 'detached' });
  await app.click('#help-close');
  await app.waitForTimeout(1300);
  const backTag = await app.evaluate(() => document.querySelector('feedback-lens-ui')?.parentElement?.tagName);
  check(backTag === 'HTML', 'Nach Schließen des Dialogs zurück unter <html>', backTag);
  let data = await storage();
  let anns = data[`fl:ann:${data['fl:active']}`] || [];
  check(anns[0]?.element?.selector === 'p.help-text' && anns[0]?.element?.location?.landmarks?.some((l) => l.includes('Dialog')), 'Anmerkung im Dialog mit Kontext gespeichert', JSON.stringify(anns[0]?.element?.location));

  // --- JS focus trap of the app ---------------------------------------------------
  await app.click('#btn-news');
  await app.waitForTimeout(200);
  await command('note');
  await app.locator('.drawer textarea').first().waitFor();
  await app.waitForTimeout(200);
  await app.keyboard.type('Fokusfalle getestet');
  const pageInput = await app.inputValue('#news-mail');
  const ours = await app.locator('.drawer textarea').first().inputValue();
  check(ours === 'Fokusfalle getestet' && pageInput === '', 'Tippen landet trotz Fokusfalle der App im Anmerkungsdialog', `drawer="${ours}" page="${pageInput}"`);

  // --- re-injection must not destroy an open drawer -----------------------------
  await msg({ type: 'fl:addOrigin', sessionId: data['fl:active'], url: 'http://127.0.0.1:4173/' });
  await app.waitForTimeout(800);
  const still = await app.locator('.drawer textarea').first().inputValue().catch(() => null);
  check(still === 'Fokusfalle getestet', 'Offener Dialog überlebt Domain-Hinzufügen (keine Neuinjektion)', String(still));
  check((await app.locator('feedback-lens-ui').count()) === 1, 'Weiterhin genau ein Overlay');
  await app.locator('.drawer .btn.primary').click();
  await app.locator('.drawer').waitFor({ state: 'detached' });
  await app.click('#news-close');

  // --- forged page events are clipped and rate-limited ---------------------------
  await app.evaluate(() => {
    for (let i = 0; i < 500; i++) {
      document.dispatchEvent(new CustomEvent('__fl_from_page', { detail: JSON.stringify({ kind: 'tech', event: { type: 'console', level: 'error', message: 'x'.repeat(100000) } }) }));
    }
  });
  await app.waitForTimeout(2000);
  data = await storage();
  const tech = data[`fl:tech:${data['fl:active']}`] || [];
  const longest = Math.max(0, ...tech.map((e) => (e.message || '').length));
  check(tech.length <= 80 && longest <= 1500, 'Gefälschte Riesen-Ereignisse werden gekürzt und gedrosselt', `count=${tech.length}, longest=${longest}`);

  // --- malicious backup -------------------------------------------------------------
  const evil = {
    schema: 'feedback-lens/v1',
    kind: 'backup',
    session: { name: '<img src=x onerror=alert(1)>', origins: ['javascript:alert(1)', 'https://ok.example.com'], createdAt: '2024-13-45', appContext: 42 },
    annotations: [
      {
        id: 'old1',
        number: '1"><img src=x onerror=alert(1)>',
        title: '<script>alert(1)</script>',
        description: { not: 'a string' },
        category: 'nonsense',
        createdAt: 'gestern',
        page: { url: 'javascript:alert(1)', title: 7 },
        element: { selector: 'div', hints: 'kein Array', contrast: { ratio: 'abc' } },
        imageData: { crop: 'data:image/png;base64,AA" onerror="alert(1)', full: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
      },
      { id: 'old2', number: '/../../evil', description: 'zweite', kind: 'page', techEvents: 'x', imageData: null },
    ],
    trail: [null, { t: 'kaputt', type: 'click' }, { t: '2026-01-01T10:00:00Z', type: 'click', label: 'ok' }],
    techEvents: [{ type: 'console', message: 'ok' }, { type: 'evil' }],
  };
  const evilPath = join(OUT, 'evil-backup.json');
  writeFileSync(evilPath, JSON.stringify(evil));
  await ext.setViewportSize({ width: 1360, height: 900 });
  await ext.goto(extUrl('src/dashboard/dashboard.html'));
  await ext.waitForSelector('.session-item');
  await ext.setInputFiles('#import-file', evilPath);
  await ext.waitForTimeout(1500);
  data = await storage();
  const imported = (data['fl:sessions'] || []).find((s) => s.name.includes('(Import)'));
  const impAnns = imported ? data[`fl:ann:${imported.id}`] : [];
  check(imported && JSON.stringify(imported.origins) === '["https://ok.example.com"]', 'Import: ungültige Domains verworfen', JSON.stringify(imported?.origins));
  check(impAnns.map((a) => a.number).join(',') === '1,2', 'Import: ungültige Nummern neu vergeben', impAnns.map((a) => a.number).join(','));
  check(impAnns[0]?.category === 'other' && impAnns[0]?.description === '' && typeof impAnns[0]?.createdAt === 'string', 'Import: Felder typgeprüft');
  check(!data[`fl:img:${impAnns[0]?.id}:crop`] && data[`fl:img:${impAnns[0]?.id}:full`], 'Import: manipuliertes Bild verworfen, gültiges übernommen');
  check((data[`fl:trail:${imported?.id}`] || []).length === 1 && (data[`fl:tech:${imported?.id}`] || []).length === 1, 'Import: Klickpfad/Technik bereinigt');
  await ext.waitForTimeout(300);
  check((await ext.locator('.ann').count()) === 2, 'Dashboard rendert die importierte Sitzung ohne Absturz');
  await ext.screenshot({ path: join(OUT, 'reg-2-evil-import.png') });
  await ext.click('button:has-text("Weitere Formate")');
  const [dl] = await Promise.all([ext.waitForEvent('download'), ext.click('.menu button:has-text("HTML-Bericht")')]);
  const htmlPath = join(OUT, 'evil-report.html');
  await dl.saveAs(htmlPath);
  const html = readFileSync(htmlPath, 'utf8');
  check(!/<img src=x/i.test(html) && !/<script>alert/i.test(html) && !html.includes('href="javascript:'), 'HTML-Bericht enthält keine ausführbaren Fragmente', html.match(/.{40}(onerror|<script|javascript:).{40}/i)?.[0]);

  // --- wipe all data ------------------------------------------------------------------
  await ext.click('#btn-settings');
  await ext.click('button:has-text("Alle Daten löschen")');
  await ext.waitForSelector('.modal .btn.danger:has-text("Löschen")');
  await ext.click('.modal .btn.danger:has-text("Löschen")');
  await ext.waitForTimeout(1200);
  data = await storage();
  check(!Object.keys(data).length, '„Alle Daten löschen“ entfernt alles', Object.keys(data).join(','));
  check((await app.locator('feedback-lens-ui').count()) === 0, 'Overlay nach dem Löschen entfernt');
  check(await ext.locator('.welcome').isVisible(), 'Dashboard zeigt Willkommensseite');
} catch (err) {
  failures.push(String(err.stack || err));
  console.error(err);
} finally {
  const relevant = pageErrors.filter((e) => !/reading 'bar'/.test(e));
  if (relevant.length) {
    failures.push('Seitenfehler');
    console.log('Seitenfehler:', relevant.join(' | '));
  }
  console.log(failures.length ? `\n${failures.length} fehlgeschlagen` : '\nalles bestanden');
  process.exitCode = failures.length ? 1 : 0;
  await cleanup();
  server.close();
}
