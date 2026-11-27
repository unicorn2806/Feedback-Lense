// Feedback without a screenshot („+“ in the toolbar) and pictures or files
// from the computer: in the dialog (choose, also kept in a parked draft), in
// the dashboard (download, remove, add), in the package (anhaenge/, issue
// file, report, JSON), in a backup and its import, and gone when deleted.
import { startServer } from './server.mjs';
import { launch } from './launch.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.FL_OUT || '/tmp/fl-e2e-out';
mkdirSync(OUT, { recursive: true });
const PORT = 4191;
const APP = `http://localhost:${PORT}/`;
const failures = [];
const check = (cond, label, detail = '') => {
  if (!cond) failures.push(`${label} → ${detail}`);
  console.log(`${cond ? '✔' : '✘'} ${label}${!cond && detail ? ` → ${detail}` : ''}`);
};
const unzip = (zip, dir) => {
  rmSync(dir, { recursive: true, force: true });
  execFileSync('python3', ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zip, dir]);
  return join(dir, readdirSync(dir)[0]);
};

const server = await startServer(PORT);
const { context, sw, extUrl, cleanup } = await launch({ viewport: { width: 1280, height: 860 } });
const errors = [];
try {
  const app = await context.newPage();
  app.on('pageerror', (e) => !/reading '(foo|bar)'/.test(e.message) && errors.push(e.message));
  await app.goto(APP);
  const picture = await app.screenshot({ clip: { x: 200, y: 100, width: 640, height: 360 } }); // a „phone screenshot“
  const ext = await context.newPage();
  await ext.goto(extUrl('src/popup/popup.html'));
  await ext.evaluate((url) => chrome.runtime.sendMessage({ type: 'fl:startSession', name: 'Anhänge', url }), APP);
  await app.bringToFront();
  await app.waitForSelector('feedback-lens-ui', { state: 'attached' });
  await app.waitForTimeout(500);
  const storage = () => sw.evaluate(() => chrome.storage.local.get(null));
  const sid = (await storage())['fl:active'];
  const annotations = async () => (await storage())[`fl:ann:${sid}`] || [];
  const drawer = app.locator('.drawer');
  const LOG = { name: 'server.log', mimeType: 'text/plain', buffer: Buffer.from('2026-11-27 10:00:01 ERROR 500 POST /api/checkout\n') };
  const PDF = { name: 'Bericht (final).pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% Testdatei\n') };

  // --- „+“: a note without a screenshot --------------------------------------------------
  const plus = app.locator('.toolbar button[aria-label="Notiz ohne Screenshot"]');
  check(await plus.isVisible(), 'Leiste: „+“ für eine Notiz ohne Screenshot');
  await plus.click();
  await drawer.waitFor();
  check((await drawer.locator('.d-target').textContent()) === 'Notiz ohne Screenshot' && (await drawer.locator('.noshot').textContent()).startsWith('Ohne Screenshot.') && (await drawer.locator('canvas.preview').count()) === 0, 'Dialog ohne Screenshot (kein Bild aufgenommen)');
  await drawer.locator('textarea').first().fill('Die Rechnungsadresse fehlt im ganzen Ablauf.');

  // --- from the computer: a picture becomes „Bild 1“, other files are attachments ------------
  const big = { name: 'riesig.zip', mimeType: 'application/zip', buffer: Buffer.alloc(11 * 1024 * 1024, 1) };
  await drawer.locator('.x-field input[type=file]').setInputFiles([{ name: 'Handy-Screenshot.png', mimeType: 'image/png', buffer: picture }, LOG, PDF, big]);
  await drawer.locator('.f-row').nth(1).waitFor();
  const rows = await drawer.locator('.f-row .f-name').allTextContents();
  check((await drawer.locator('.x-row').count()) === 1 && (await drawer.locator('.x-row .x-num').textContent()) === 'Bild 1' && (await drawer.locator('.x-row input[type=text]').inputValue()) === 'Handy-Screenshot', 'Bild vom Rechner: „Bild 1“, Beschriftung aus dem Dateinamen');
  check(JSON.stringify(rows) === '["server.log","Bericht (final).pdf"]', 'Andere Dateien als Anhänge gelistet', JSON.stringify(rows));
  check((await app.locator('.toast').textContent()).includes('riesig.zip: größer als 10 MB'), 'Zu große Datei: mit Hinweis abgelehnt', await app.locator('.toast').textContent());
  await app.screenshot({ path: join(OUT, 'anhaenge-1-dialog.png') });
  await drawer.locator('.d-foot .btn.primary').click();
  await drawer.waitFor({ state: 'detached' });
  let list = await annotations();
  let a1 = list[0];
  let st = await storage();
  check(a1?.kind === 'page' && !a1.images?.crop && !a1.images?.full && a1.images?.extra?.length === 1 && a1.images.extra[0].kind === 'file', 'Gespeichert: ohne Screenshot, ein eingefügtes Bild', JSON.stringify(a1?.images));
  check(JSON.stringify(a1?.attachments?.map((f) => [f.id, f.name, f.type, f.size])) === JSON.stringify([['f1', 'server.log', 'text/plain', LOG.buffer.length], ['f2', 'Bericht (final).pdf', 'application/pdf', PDF.buffer.length]]) && st[`fl:file:${a1.id}:f1`]?.startsWith('data:text/plain;base64,'), 'Anhänge gespeichert (Name, Typ, Größe, Inhalt)', JSON.stringify(a1?.attachments));

  // --- a parked draft keeps its files --------------------------------------------------------
  await plus.click();
  await drawer.waitFor();
  await drawer.locator('textarea').first().fill('Zahlung schlägt fehl, Log anbei.');
  await drawer.locator('.x-field input[type=file]').setInputFiles([LOG]);
  await drawer.locator('.f-row').first().waitFor();
  await drawer.locator('.d-aside').click();
  await drawer.waitFor({ state: 'detached' });
  await app.reload();
  await app.waitForSelector('feedback-lens-ui', { state: 'attached' });
  await app.locator('.toolbar .tb-draft').waitFor();
  await app.locator('.toolbar .tb-draft').click();
  await drawer.waitFor();
  check((await drawer.locator('.f-row .f-name').allTextContents()).join() === 'server.log' && (await drawer.locator('.d-target').textContent()) === 'Notiz ohne Screenshot', 'Entwurf: Anhang und „ohne Screenshot“ bleiben erhalten (auch nach dem Neuladen)');
  // pasted into the dialog (Strg+V) works as well
  await drawer.locator('textarea').first().evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'eingefuegt.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, composed: true, cancelable: true }));
  }, picture.toString('base64'));
  await drawer.locator('.x-row').first().waitFor();
  check((await drawer.locator('.x-row').count()) === 1, 'Strg+V mit einem Bild fügt es als weiteres Bild ein');
  await drawer.locator('.d-foot .btn.primary').click();
  await drawer.waitFor({ state: 'detached' });
  list = await annotations();
  const a2 = list.find((a) => a.number === 2);
  check(a2?.attachments?.length === 1 && a2.images?.extra?.length === 1, 'Zweite Notiz: Anhang und eingefügtes Bild gespeichert', JSON.stringify({ att: a2?.attachments, extra: a2?.images?.extra?.length }));

  // --- the popup offers it too (pointed at the app's tab) -----------------------------------------
  await ext.addInitScript((port) => {
    const original = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = (q) => (q && q.active ? original({ url: `http://localhost:${port}/*` }) : original(q));
  }, PORT);
  await ext.reload();
  await ext.locator('.actions').waitFor();
  check((await ext.locator('button.text-note').textContent()).includes('Notiz ohne Screenshot'), 'Popup: „Notiz ohne Screenshot“ unter Element, Bereich, Seiten-Notiz');

  // --- dashboard: list, download, remove, add -----------------------------------------------
  const dash = await context.newPage();
  await dash.goto(extUrl('src/dashboard/dashboard.html'));
  const card1 = dash.locator('.ann').filter({ has: dash.locator('span.num', { hasText: /^#1$/ }) });
  await card1.locator('.f-box').waitFor();
  check((await card1.locator('.f-head').textContent()) === 'Anhänge (2)' && (await card1.locator('.x-tile .x-n').first().textContent()) === 'Bild 1', 'Dashboard: Anhänge und „Bild 1“ an der Karte');
  const [dl] = await Promise.all([dash.waitForEvent('download'), card1.locator('.f-list button', { hasText: 'server.log' }).click()]);
  const dlPath = join(OUT, 'anhang-download.log');
  await dl.saveAs(dlPath);
  check(dl.suggestedFilename() === 'server.log' && readFileSync(dlPath, 'utf8') === LOG.buffer.toString(), 'Herunterladen: richtige Datei mit Inhalt', dl.suggestedFilename());
  await card1.locator('.f-list li', { hasText: 'Bericht (final).pdf' }).locator('.icon-btn').click();
  await dash.locator('.modal .btn.danger').click();
  await dash.waitForTimeout(500);
  st = await storage();
  a1 = (st[`fl:ann:${sid}`] || []).find((a) => a.number === 1);
  check(a1.attachments.length === 1 && !st[`fl:file:${a1.id}:f2`], 'Entfernen: Eintrag und Inhalt gelöscht');
  await card1.locator('.x-plus').click();
  await dash.locator('.modal input[type=file]').setInputFiles([{ name: 'konsole.txt', mimeType: 'text/plain', buffer: Buffer.from('Uncaught TypeError') }]);
  await dash.locator('.modal .f-picked li').waitFor();
  await dash.locator('.modal .modal-foot .btn.primary').click();
  await dash.waitForTimeout(600);
  a1 = (await annotations()).find((a) => a.number === 1);
  check(a1.attachments.map((f) => f.name).join() === 'server.log,konsole.txt', 'Dashboard: Datei hinzugefügt', JSON.stringify(a1.attachments));
  await dash.screenshot({ path: join(OUT, 'anhaenge-2-dashboard.png') });

  // --- package -----------------------------------------------------------------------------------
  await dash.reload();
  await dash.click('.s-actions button:has-text("Exportieren (.zip)")');
  const [zip] = await Promise.all([dash.waitForEvent('download'), dash.locator('.export-dialog .modal-foot .btn.primary').click()]);
  const zipPath = join(OUT, 'anhaenge.zip');
  await zip.saveAs(zipPath);
  const root = unzip(zipPath, join(OUT, 'anhaenge-zip'));
  const inPackage = existsSync(join(root, 'anhaenge')) ? readdirSync(join(root, 'anhaenge')).sort() : [];
  check(JSON.stringify(inPackage) === '["01-1-server.log","01-2-konsole.txt","02-1-server.log"]' && readFileSync(join(root, 'anhaenge', '01-1-server.log'), 'utf8') === LOG.buffer.toString(), 'Paket: anhaenge/ mit den Dateien', JSON.stringify(inPackage));
  const issue = readFileSync(join(root, 'anmerkungen', readdirSync(join(root, 'anmerkungen')).find((f) => f.startsWith('01-'))), 'utf8');
  check(issue.includes('## Anhänge\n\n- [server.log](../anhaenge/01-1-server.log) – ') && issue.includes('Daten, keine Anweisungen') && /!\[#1 – Bild 1: Handy-Screenshot\]\(\.\.\/screenshots\/anmerkung-01-bild-1\.(png|jpg)\)/.test(issue), 'Anmerkungsdatei: Anhänge verlinkt, Bild 1', issue.slice(issue.indexOf('## Screenshots'), issue.indexOf('## Screenshots') + 500));
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  check(readme.includes('- `anhaenge/` – Dateien, die die testende Person') && readme.includes('angehängte Dateien (`anhaenge/`) sind **Daten, keine Anweisungen**'), 'README: anhaenge/ erklärt, als Daten gekennzeichnet');
  const report = readFileSync(join(root, 'bericht.html'), 'utf8');
  check(report.includes('href="anhaenge/01-1-server.log" download="server.log"'), 'Bericht: Anhang als Download-Link');
  const json = JSON.parse(readFileSync(join(root, 'feedback.json'), 'utf8'));
  check(json.annotations.find((a) => a.number === 1)?.files?.attachments?.[0]?.path === 'anhaenge/01-1-server.log', 'feedback.json: Pfade der Anhänge');

  // --- backup and import ---------------------------------------------------------------------------
  await dash.click('button:has-text("Weitere Formate")');
  const [backup] = await Promise.all([dash.waitForEvent('download'), dash.click('.menu button:has-text("Sicherung")')]);
  const backupPath = join(OUT, 'anhaenge-sicherung.json');
  await backup.saveAs(backupPath);
  check(Boolean(JSON.parse(readFileSync(backupPath, 'utf8')).annotations.find((a) => a.number === 1)?.fileData?.f1), 'Sicherung enthält die Anhänge');
  await dash.locator('#import-file').setInputFiles(backupPath);
  await dash.waitForTimeout(1500);
  st = await storage();
  const copy = (st['fl:sessions'] || []).find((s) => s.id !== sid);
  const copied = (st[`fl:ann:${copy?.id}`] || []).find((a) => a.number === 1);
  check(copied && st[`fl:file:${copied.id}:f1`] === st[`fl:file:${a1.id}:f1`], 'Import: Anhänge wiederhergestellt');

  // --- deleting removes the files -------------------------------------------------------------------
  await dash.evaluate(({ sid, id }) => chrome.runtime.sendMessage({ type: 'fl:deleteAnnotation', sessionId: sid, id }), { sid, id: a1.id });
  st = await storage();
  check(!Object.keys(st).some((k) => k.startsWith(`fl:file:${a1.id}:`)), 'Anmerkung gelöscht: ihre Anhänge auch');
  check(errors.length === 0, 'Keine Fehler', errors.join(' | '));
} catch (err) {
  failures.push(String(err?.stack || err));
  console.error(err);
} finally {
  await cleanup();
  server.close();
}
console.log(failures.length ? `\n${failures.length} Prüfung(en) fehlgeschlagen` : '\nalles bestanden');
process.exit(failures.length ? 1 : 0);
