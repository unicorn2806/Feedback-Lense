// Dictation in the annotation dialog: the real path up to "language pack
// missing" (headless Chromium has no local language pack), then the full round
// trip dialog → service worker → recognition page → dialog with a simulated
// on-device recogniser.
import { startServer } from './server.mjs';
import { launch } from './launch.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.FL_OUT || '/tmp/fl-e2e-out';
mkdirSync(OUT, { recursive: true });
const BASE = 'http://localhost:4173';
const failures = [];
const check = (cond, label, detail = '') => {
  if (!cond) failures.push(label);
  console.log(`${cond ? '✔' : '✘'} ${label}${!cond && detail ? ` → ${String(detail).slice(0, 400)}` : ''}`);
};

const server = await startServer(4173);
const { context, sw, extUrl, cleanup } = await launch();
const pageErrors = [];
try {
  const app = await context.newPage();
  app.on('pageerror', (e) => pageErrors.push(`app: ${e.message}`));
  await app.goto(`${BASE}/`);
  const ext = await context.newPage();
  await ext.goto(extUrl('src/popup/popup.html'));
  await ext.evaluate((url) => chrome.runtime.sendMessage({ type: 'fl:startSession', name: 'Diktat', url }), `${BASE}/`);
  await app.bringToFront();
  await app.waitForSelector('feedback-lens-ui', { state: 'attached' });
  await app.waitForTimeout(300);
  const openNote = async () => {
    await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'http://localhost:4173/*' });
      await chrome.tabs.sendMessage(tab.id, { type: 'fl:command', action: 'note' });
    });
    await app.locator('.drawer textarea').first().waitFor();
  };

  // --- real path: no local language pack → explanation instead of dictation ------
  await openNote();
  check((await app.locator('.drawer .mic').count()) === 2, 'Mikrofon-Knopf an Beschreibung und Erwartung');
  await app.locator('.drawer .mic').first().click();
  const hint = app.locator('.drawer .dict-hint').first();
  await hint.waitFor({ state: 'visible', timeout: 8000 });
  const hintText = await hint.textContent();
  check(/Sprachpaket/.test(hintText) && /Win\+H/.test(hintText) && (await app.locator('.drawer .mic.on').count()) === 0, 'Ohne lokales Sprachpaket: Hinweis statt Diktat (kein Server)', hintText);
  await app.screenshot({ path: join(OUT, 'dict-1-hint.png') });
  const pagesBefore = context.pages().length;
  await hint.locator('button:has-text("Diktat einrichten")').click();
  let dash = null;
  for (let i = 0; i < 30 && !dash; i++) {
    await app.waitForTimeout(200);
    dash = context.pages().find((p) => p.url().includes('dashboard.html'));
  }
  check(context.pages().length === pagesBefore + 1 && dash, '„Diktat einrichten“ öffnet das Dashboard');
  await dash.waitForSelector('#settings-dictation .dict-status li', { timeout: 8000 });
  await dash.waitForTimeout(400);
  const setup = await dash.locator('#settings-dictation').textContent();
  check(/Sprachpaket Deutsch noch nicht installiert/.test(setup) && /Mikrofon für Feedback Lens noch nicht freigegeben/.test(setup) && (await dash.locator('#settings-dictation button:has-text("Sprachpaket installieren")').count()) === 1 && (await dash.locator('#settings-dictation button:has-text("Mikrofon erlauben")').count()) === 1, 'Einstellungen zeigen Status und Einrichtungsschritte', setup);
  await dash.screenshot({ path: join(OUT, 'dict-2-settings.png') });
  await dash.selectOption('#settings-dictation select', 'en-US');
  await dash.click('.modal-foot .btn.primary');
  const lang = await sw.evaluate(async () => (await chrome.storage.local.get('fl:settings'))['fl:settings']?.dictationLang);
  check(lang === 'en-US', 'Sprache fürs Diktat wird gespeichert', lang);
  await dash.close();

  // --- simulated on-device recogniser in place of the offscreen document -------------
  await sw.evaluate(async () => {
    await chrome.offscreen.closeDocument().catch(() => {});
    const original = chrome.runtime.getContexts.bind(chrome.runtime);
    chrome.runtime.getContexts = async (filter) => (filter?.contextTypes?.includes('OFFSCREEN_DOCUMENT') ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : original(filter));
  });
  const fake = await context.newPage();
  await fake.addInitScript(() => {
    const result = (transcript, isFinal) => ({ resultIndex: 0, results: [Object.assign([{ transcript }], { isFinal })] });
    class FakeRecognition {
      start() {
        window.__started = { processLocally: this.processLocally, lang: this.lang, continuous: this.continuous };
        setTimeout(() => this.onresult?.(result('der button', false)), 100);
        setTimeout(() => this.onresult?.(result('der button reagiert nicht', false)), 250);
        setTimeout(() => this.onresult?.(result('der Button reagiert nicht.', true)), 400);
      }
      stop() {
        window.__stopped = true;
        setTimeout(() => this.onend?.(), 10);
      }
    }
    FakeRecognition.prototype.processLocally = false;
    FakeRecognition.available = async ({ processLocally }) => (processLocally ? 'available' : 'unavailable');
    window.SpeechRecognition = FakeRecognition;
    window.webkitSpeechRecognition = FakeRecognition;
  });
  await fake.goto(extUrl('src/offscreen/dictation.html'));
  await app.bringToFront();
  const field = app.locator('.drawer textarea').first();
  await field.fill('Auf der Startseite:');
  await app.locator('.drawer .mic').first().click();
  await app.locator('.drawer .mic.on').waitFor({ timeout: 5000 });
  await app.waitForTimeout(180);
  const interim = await field.inputValue();
  await app.waitForTimeout(500);
  const final = await field.inputValue();
  check(interim === 'Auf der Startseite: der button' || interim === 'Auf der Startseite: der button reagiert nicht', 'Zwischenergebnis erscheint sofort im Textfeld', interim);
  check(final === 'Auf der Startseite: der Button reagiert nicht.', 'Endergebnis ersetzt das Zwischenergebnis', final);
  const started = await fake.evaluate(() => window.__started);
  check(started?.processLocally === true && started.lang === 'en-US' && started.continuous === true, 'Erkennung nur auf dem Gerät (processLocally) in der gewählten Sprache', JSON.stringify(started));
  await app.screenshot({ path: join(OUT, 'dict-3-listening.png') });
  await app.locator('.drawer .mic.on').click();
  await app.waitForTimeout(300);
  check((await app.locator('.drawer .mic.on').count()) === 0 && (await fake.evaluate(() => window.__stopped)) === true, 'Zweiter Klick beendet das Diktat');

  // a page load in the tab ends the dictation (the dialog is gone)
  await fake.evaluate(() => (window.__stopped = false));
  await app.locator('.drawer .mic').first().click();
  await app.locator('.drawer .mic.on').waitFor({ timeout: 5000 });
  const runBefore = await sw.evaluate(async () => (await chrome.storage.session.get('fl:dictationRun'))['fl:dictationRun']);
  await app.reload();
  await app.waitForTimeout(800);
  const runAfter = await sw.evaluate(async () => (await chrome.storage.session.get('fl:dictationRun'))['fl:dictationRun']);
  check(runBefore?.runId && !runAfter && (await fake.evaluate(() => window.__stopped)) === true, 'Neu laden der Seite beendet das Diktat (Mikrofon aus)', JSON.stringify({ runBefore, runAfter }));
  await app.waitForSelector('feedback-lens-ui', { state: 'attached' });
  await app.waitForTimeout(400);
  await openNote();

  // closing the dialog while the dictation is still starting must not switch the mic on
  await fake.evaluate(() => {
    window.__stopped = false;
    const original = window.SpeechRecognition.available;
    window.SpeechRecognition.available = async (o) => (await new Promise((r) => setTimeout(r, 600)), original(o));
  });
  await app.locator('.drawer .mic').first().click();
  await app.keyboard.press('Escape');
  await app.locator('.drawer').waitFor({ state: 'detached' });
  await app.waitForTimeout(1200);
  const late = await sw.evaluate(async () => (await chrome.storage.session.get('fl:dictationRun'))['fl:dictationRun']);
  check(!late && (await fake.evaluate(() => window.__stopped)) === true, 'Dialog während des Starts geschlossen: Diktat wird sofort wieder beendet', JSON.stringify(late));
  await fake.evaluate(() => (window.SpeechRecognition.available = async ({ processLocally }) => (processLocally ? 'available' : 'unavailable')));
  await openNote();
  await app.locator('.drawer textarea').first().fill('Auf der Startseite: der Button reagiert nicht.');

  // dictation into an empty field starts with a capital letter; closing the dialog stops it
  await app.locator('.drawer textarea').nth(1).fill('');
  await app.locator('.drawer .mic').nth(1).click();
  await app.waitForTimeout(700);
  check((await app.locator('.drawer textarea').nth(1).inputValue()) === 'Der Button reagiert nicht.', 'Leeres Feld: Satzanfang groß', await app.locator('.drawer textarea').nth(1).inputValue());

  // a note to a number on the screenshot can be dictated too
  await app.locator('.drawer .shot-bar button[aria-label="Nummern"]').click();
  const preview = await app.locator('.drawer canvas.preview').boundingBox();
  await app.mouse.click(preview.x + preview.width * 0.5, preview.y + preview.height * 0.5);
  const noteField = app.locator('.drawer .flm-notes input[aria-label="Notiz zu Nummer 1"]');
  await noteField.waitFor();
  await app.locator('.drawer .flm-notes .mic').click();
  await app.waitForTimeout(700);
  check((await noteField.inputValue()) === 'Der Button reagiert nicht.', 'Notiz zu einer Nummer im Screenshot lässt sich diktieren', await noteField.inputValue());
  await fake.evaluate(() => (window.__stopped = false));
  await app.locator('.drawer .btn.primary').click();
  await app.locator('.drawer').waitFor({ state: 'detached' });
  await app.waitForTimeout(300);
  check((await fake.evaluate(() => window.__stopped)) === true, 'Speichern beendet ein laufendes Diktat');
  const saved = await sw.evaluate(async () => {
    const s = await chrome.storage.local.get(null);
    return s[`fl:ann:${s['fl:active']}`]?.[0];
  });
  check(saved?.description === 'Auf der Startseite: der Button reagiert nicht.' && saved.expected === 'Der Button reagiert nicht.' && saved.images?.numbers?.[0]?.note === 'Der Button reagiert nicht.', 'Diktierter Text wird gespeichert (auch die Notiz zur Nummer)', JSON.stringify({ d: saved?.description, e: saved?.expected, n: saved?.images?.numbers }));
} catch (err) {
  failures.push(String(err.stack || err));
  console.error(err);
} finally {
  if (pageErrors.length) {
    failures.push('Seitenfehler');
    console.log('Seitenfehler:', pageErrors.join(' | '));
  }
  console.log(failures.length ? `\n${failures.length} fehlgeschlagen` : '\nalles bestanden');
  process.exitCode = failures.length ? 1 : 0;
  await cleanup();
  server.close();
}
