// When the extension goes away while a session runs (disabled, removed or
// reloaded), the orphaned overlay must remove itself from the page.
// Note: in Playwright, chrome.runtime.reload() unloads a command-line loaded
// extension without bringing it back, which is exactly the orphan case.
import { startServer } from './server.mjs';
import { launch } from './launch.mjs';

const failures = [];
const check = (cond, label, detail = '') => {
  if (!cond) failures.push(label);
  console.log(`${cond ? '✔' : '✘'} ${label}${!cond && detail ? ` → ${detail}` : ''}`);
};

const server = await startServer(4173);
const { context, sw, extUrl, cleanup } = await launch();
try {
  const app = await context.newPage();
  await app.goto('http://localhost:4173/');
  const ext = await context.newPage();
  await ext.goto(extUrl('src/popup/popup.html'));
  await ext.evaluate(() => chrome.runtime.sendMessage({ type: 'fl:startSession', name: 'Orphan', url: 'http://localhost:4173/' }));
  await app.bringToFront();
  await app.waitForSelector('feedback-lens-ui', { state: 'attached' });
  check((await app.locator('feedback-lens-ui').count()) === 1, 'Overlay aktiv');
  await sw.evaluate(() => chrome.runtime.reload()).catch(() => {});
  await app.waitForTimeout(2000);
  check((await app.locator('feedback-lens-ui').count()) === 0, 'Verwaistes Overlay entfernt sich selbst');
  const ok = await app.evaluate(() => document.querySelector('#btn-next') !== null);
  check(ok, 'Seite bleibt intakt');
} catch (err) {
  failures.push(String(err));
  console.error(err);
} finally {
  console.log(failures.length ? `${failures.length} fehlgeschlagen` : 'alles bestanden');
  process.exitCode = failures.length ? 1 : 0;
  await cleanup();
  server.close();
}
