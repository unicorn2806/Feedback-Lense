// Messages of the tested application must not be listed as errors of the
// extension (chrome://extensions → „Fehler“). Our console and fetch wrappers sit
// on top of the stack when the page logs or a fetch fails; the hook script's
// sourceURL name keeps Chrome from attributing that to the extension. A control
// run without that name shows that Chrome's error collection does see them.
import { startServer } from './server.mjs';
import { createRequire } from 'node:module';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');
const PORT = 4185;
const APP = `http://localhost:${PORT}/`;
const failures = [];
const check = (cond, label, detail = '') => {
  if (!cond) failures.push(`${label} → ${detail}`);
  console.log(`${cond ? '✔' : '✘'} ${label}${!cond && detail ? ` → ${detail}` : ''}`);
};

/** Starts a run, lets the page log and fail a fetch, returns what Chrome lists for the extension. */
async function scenario({ withoutName = false } = {}) {
  const work = await mkdtemp(join(process.env.FL_TMP || tmpdir(), 'fl-attr-'));
  const ext = join(work, 'extension');
  await cp(new URL('../extension/', import.meta.url).pathname, ext, { recursive: true });
  if (withoutName) {
    const file = join(ext, 'src/content/page-hooks.js');
    const code = await readFile(file, 'utf8');
    if (!code.includes('//# sourceURL=')) throw new Error('sourceURL line missing');
    await writeFile(file, code.replace(/\/\/# sourceURL=.*\s*$/, ''));
  }
  await mkdir(join(work, 'profile', 'Default'), { recursive: true });
  await writeFile(join(work, 'profile', 'Default', 'Preferences'), JSON.stringify({ extensions: { ui: { developer_mode: true } } }));
  const context = await chromium.launchPersistentContext(join(work, 'profile'), { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    const id = sw.url().split('/')[2];
    const mgr = await context.newPage();
    await mgr.goto('chrome://extensions');
    await mgr.evaluate((id) => chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, errorCollection: true }), id);
    const app = await context.newPage();
    await app.goto(APP);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/src/popup/popup.html`);
    await popup.evaluate((m) => chrome.runtime.sendMessage(m), { type: 'fl:startSession', name: 'Zuordnung', url: APP });
    await app.reload();
    await app.waitForSelector('feedback-lens-ui', { state: 'attached' });
    await app.addScriptTag({
      content: `
        console.warn('App-Warnung: Sitzung läuft bald ab');
        console.error('App-Fehler aus dem App-Code');
        fetch('http://localhost:1/nirgends'); // unhandled rejection
        fetch('/api/secret-fail').catch(() => {});
      `,
    });
    await app.waitForTimeout(2500); // the overlay stores technical events every 1.5 s
    const info = await mgr.evaluate((id) => chrome.developerPrivate.getExtensionInfo(id), id);
    const listed = [...(info.runtimeErrors || []), ...(info.runtimeWarnings || [])].map((e) => ({ message: e.message, source: e.source }));
    const store = await sw.evaluate(() => chrome.storage.local.get(null));
    const tech = store[`fl:tech:${store['fl:active']}`] || [];
    return { collecting: info.errorCollection?.isActive, listed, tech };
  } finally {
    await context.close();
    await rm(work, { recursive: true, force: true });
  }
}

const server = await startServer(PORT);
try {
  const control = await scenario({ withoutName: true });
  check(control.collecting && control.listed.length >= 3, 'Kontrolle (ohne Namenszeile): Chrome listet die App-Meldungen als Fehler der Erweiterung', JSON.stringify(control.listed.map((e) => e.message.slice(0, 50))));

  const shipped = await scenario();
  check(shipped.collecting && shipped.listed.length === 0, 'Mit Namenszeile: keine App-Meldung bei den Fehlern der Erweiterung', JSON.stringify(shipped.listed));
  const kinds = shipped.tech.map((e) => `${e.type}:${(e.message || '').slice(0, 40)}`);
  check(['App-Warnung', 'App-Fehler', 'Failed to fetch'].every((t) => kinds.some((k) => k.includes(t))), 'Feedback Lens erfasst die Meldungen weiterhin', JSON.stringify(kinds));
  const stacks = shipped.tech.map((e) => e.stack || '').join('\n');
  check(!/page-hooks|chrome-extension:/.test(stacks), 'Eigene Wrapper-Zeilen stehen nicht in erfassten Stacktraces', stacks.slice(0, 300));
} catch (err) {
  failures.push(String(err?.stack || err));
  console.error(err);
} finally {
  server.close();
}
console.log(failures.length ? `\n${failures.length} Prüfung(en) fehlgeschlagen` : '\nalles bestanden');
process.exit(failures.length ? 1 : 0);
