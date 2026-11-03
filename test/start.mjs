// Starting a test run must not wait for pages: not for one that is still
// loading, not for another tab of the app that shows a dialog (alert, confirm,
// "Leave site?"). The popup gets its answer at once; each toolbar appears as
// soon as its page can take it.
import { launch } from './launch.mjs';
import http from 'node:http';

const PORT = 4178;
const failures = [];
const check = (cond, label, detail = '') => {
  if (!cond) failures.push(`${label} → ${detail}`);
  console.log(`${cond ? '✔' : '✘'} ${label}${!cond && detail ? ` → ${detail}` : ''}`);
};

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/slow.js')) {
    await new Promise((r) => setTimeout(r, 5000));
    res.writeHead(200, { 'content-type': 'text/javascript' });
    return res.end('window.loaded = true;');
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  if (req.url.startsWith('/loading')) return res.end('<!doctype html><title>Lädt</title><h1>Lädt noch</h1><script src="/slow.js"></script><p>Rest</p>');
  res.end('<!doctype html><title>App</title><h1>App</h1><button>Ok</button>');
});
await new Promise((r) => server.listen(PORT, r));
const { context, extUrl, cleanup } = await launch();
try {
  const pop = await context.newPage();
  await pop.goto(extUrl('src/popup/popup.html'));
  /** Starts a run like the popup does; returns ms until the answer (null: none within 10 s). */
  const start = async (url) => {
    await pop.evaluate(() => chrome.runtime.sendMessage({ type: 'fl:stopSession' }));
    const t0 = Date.now();
    const res = await Promise.race([pop.evaluate((url) => chrome.runtime.sendMessage({ type: 'fl:startSession', name: 'Start', url }), url), new Promise((r) => setTimeout(() => r(null), 10_000))]);
    return { ms: res ? Date.now() - t0 : null, ok: res?.ok, t0 };
  };
  const toolbarAfter = (page, t0, timeout = 10_000) => page.waitForSelector('feedback-lens-ui', { state: 'attached', timeout }).then(() => Date.now() - t0, () => null);

  // 1) normal start
  const app = await context.newPage();
  await app.goto(`http://localhost:${PORT}/app`);
  await app.bringToFront();
  let r = await start(`http://localhost:${PORT}/app`);
  let ui = await toolbarAfter(app, r.t0);
  check(r.ok && r.ms < 1000 && ui !== null && ui < 2000, 'Normaler Start: Antwort und Leiste in unter 2 s', `Antwort ${r.ms} ms, Leiste ${ui} ms`);

  // 2) another tab of the app shows an alert()
  let dialog = null;
  const other = await context.newPage();
  other.on('dialog', (d) => (dialog = d)); // left open
  await other.goto(`http://localhost:${PORT}/app?tab=2`);
  other.evaluate(() => setTimeout(() => alert('Ihre Sitzung läuft bald ab'), 10)).catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  await app.reload();
  await app.bringToFront();
  r = await start(`http://localhost:${PORT}/app`);
  ui = await toolbarAfter(app, r.t0);
  check(r.ok && r.ms !== null && r.ms < 2500, 'Anderer Tab mit offenem alert(): Start antwortet trotzdem sofort', `Antwort ${r.ms ?? '> 10000'} ms`);
  check(ui !== null && ui < 3000, 'Leiste im aktiven Tab erscheint trotzdem', `${ui ?? 'nie'} ms`);
  await dialog?.accept();
  const t1 = Date.now();
  const late = await toolbarAfter(other, t1);
  check(late !== null, 'Nach dem Schließen des alert() bekommt auch der andere Tab seine Leiste', `${late ?? 'nie'} ms`);
  await other.close();

  // 3) the page is still loading (a script holds up the document for 5 s)
  const loading = await context.newPage();
  loading.goto(`http://localhost:${PORT}/loading`).catch(() => {});
  await new Promise((r) => setTimeout(r, 400));
  await loading.bringToFront();
  r = await start(`http://localhost:${PORT}/loading`);
  check(r.ok && r.ms !== null && r.ms < 2500, 'Seite lädt noch: Start antwortet sofort (Popup schließt)', `Antwort ${r.ms ?? '> 10000'} ms`);
  ui = await toolbarAfter(loading, r.t0, 15_000);
  check(ui !== null, 'Leiste erscheint, sobald die Seite geladen ist', `${ui ?? 'nie'} ms`);
} catch (err) {
  failures.push(String(err?.stack || err));
  console.error(err);
} finally {
  await cleanup();
  server.close();
}
console.log(failures.length ? `\n${failures.length} Prüfung(en) fehlgeschlagen` : '\nalles bestanden');
process.exit(failures.length ? 1 : 0);
