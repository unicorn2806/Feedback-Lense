// Re-test round trip: test version 1, read the development's results from the
// package README, re-test in version 2 (demo server with cookie demo=v2) through
// the list in the overlay, export the before/after package, re-test the re-test.
import { startServer } from './server.mjs';
import { launch } from './launch.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.FL_OUT || '/tmp/fl-e2e-out';
mkdirSync(OUT, { recursive: true });
const BASE = 'http://localhost:4173';
const failures = [];
const check = (cond, label, detail = '') => {
  if (!cond) failures.push(label);
  console.log(`${cond ? '✔' : '✘'} ${label}${!cond && detail ? ` → ${String(detail).slice(0, 600)}` : ''}`);
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
  const storage = () => sw.evaluate(() => chrome.storage.local.get(null));
  const command = (action) =>
    sw.evaluate(async (action) => {
      const [tab] = await chrome.tabs.query({ url: 'http://localhost:4173/*' });
      await chrome.tabs.sendMessage(tab.id, { type: 'fl:command', action });
    }, action);
  const drawer = (sel) => app.locator(`.drawer ${sel}`);
  async function pick(selector) {
    await command('pick');
    const box = await app.locator(selector).first().boundingBox();
    await app.mouse.move(box.x + Math.min(20, box.width / 2), box.y + box.height / 2);
    await app.waitForTimeout(150);
    await app.mouse.click(box.x + Math.min(20, box.width / 2), box.y + box.height / 2);
    await drawer('textarea').first().waitFor();
    await app.waitForTimeout(150);
  }
  async function annotate({ category, priority, description }) {
    if (category) await drawer(`.chip:has-text("${category}")`).click();
    if (priority) await drawer(`.seg button:has-text("${priority}")`).click();
    await drawer('textarea').first().fill(description);
    await drawer('.btn.primary').click();
    await app.locator('.drawer').waitFor({ state: 'detached' });
    await app.waitForTimeout(300);
  }

  // --- version 1: the first test ------------------------------------------------
  await msg({ type: 'fl:startSession', name: 'Bestellportal v1', url: `${BASE}/` });
  await app.bringToFront();
  await app.waitForSelector('feedback-lens-ui', { state: 'attached' });
  await app.waitForTimeout(400);
  await pick('.hint-text');
  await annotate({ category: 'Barrierefreiheit', priority: 'Hoch', description: 'Versandhinweis kaum lesbar.' });
  await app.click('#btn-next');
  await app.waitForURL(`${BASE}/lieferung`, { timeout: 8000 });
  await app.waitForTimeout(800); // a visit of a few milliseconds would be merged like a redirect
  await app.click('nav a[href="/"]');
  await app.waitForURL(`${BASE}/`);
  await app.waitForTimeout(500);
  await pick('#btn-next');
  await annotate({ category: 'Fehler', priority: 'Kritisch', description: 'Weiter zeigt keinen Fehler, obwohl der Server 500 liefert.' });
  await app.click('nav a[href="/lieferung"]');
  await app.waitForURL(`${BASE}/lieferung`);
  await app.waitForTimeout(500);
  await pick('input[name=zip]');
  await annotate({ category: 'Bedienbarkeit', priority: 'Mittel', description: 'PLZ-Feld hat kein Label.' });
  await command('note');
  await drawer('textarea').first().waitFor();
  await annotate({ category: 'Idee / Wunsch', description: 'Fortschrittsanzeige im Checkout.' });
  await app.waitForTimeout(1800); // trail flush
  let data = await storage();
  const baseId = data['fl:active'];
  check((data[`fl:ann:${baseId}`] || []).map((a) => a.number).join(',') === '1,2,3,4', 'Version 1: vier Anmerkungen');

  // --- results of the development, read from the package README ---------------------
  const readme = join(OUT, 'entwicklung-readme.md');
  writeFileSync(
    readme,
    [
      '## Ergebnis festhalten',
      '```markdown',
      '- [x] **#n · …** – …',
      '  - Ergebnis: erledigt',
      '```',
      '## Anmerkungen',
      '- [x] **#2 · Kritisch · Fehler** – Weiter …',
      '  - Ergebnis: erledigt',
      '  - Umgesetzt: Fehler wird angezeigt (app.js)',
      '- [x] **#1 · Hoch · Barrierefreiheit** – Versandhinweis',
      '  - Ergebnis: erledigt – Kontrast erhöht (app.css)',
      '- [ ] **#3 · Mittel · Bedienbarkeit** – PLZ',
      '  - Ergebnis: vorläufig',
      '  - Frage: Welche PLZ-Formate sind erlaubt?',
      '- [ ] **#4 · Mittel · Idee / Wunsch** – Fortschritt',
      '',
    ].join('\n'),
  );
  await msg({ type: 'fl:stopSession' });
  await ext.goto(extUrl(`src/dashboard/dashboard.html?session=${baseId}`));
  await ext.waitForSelector('.ann');
  await ext.click('button[aria-label="Weitere Aktionen"]');
  const [chooser] = await Promise.all([ext.waitForEvent('filechooser'), ext.click('.menu button:has-text("Ergebnisse der Entwicklung einlesen")')]);
  await chooser.setFiles(readme);
  await ext.waitForTimeout(800);
  data = await storage();
  const dev = Object.fromEntries((data[`fl:ann:${baseId}`] || []).map((a) => [a.number, a.devResult]));
  check(dev[1]?.result === 'done' && dev[1].notes[0] === 'Kontrast erhöht (app.css)' && dev[2]?.result === 'done' && dev[3]?.result === 'partial' && dev[3].notes.includes('Frage: Welche PLZ-Formate sind erlaubt?') && !dev[4], 'Ergebnisse der Entwicklung aus der README übernommen', JSON.stringify(dev));
  check(await ext.locator('.dev:has-text("Entwicklung: vorläufig")').count() === 1, 'Dashboard zeigt die Rückmeldung der Entwicklung an der Karte');

  // --- version 2: re-test started from the popup -------------------------------------
  await context.addCookies([{ name: 'demo', value: 'v2', url: BASE }]);
  await app.goto(`${BASE}/`);
  const popup = await context.newPage();
  await popup.addInitScript(() => {
    const original = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = (q) => (q && q.active ? original({ url: 'http://localhost:4173/*' }) : original(q));
    window.close = () => (window.__closed = true);
  });
  await popup.goto(extUrl('src/popup/popup.html'));
  await popup.selectOption('select[aria-label="Art des Testlaufs"]', baseId);
  check((await popup.inputValue('input[aria-label="Name des Testlaufs"]')) === 'Nachtest: Bestellportal v1' && (await popup.locator('button:has-text("Nachtest auf dieser Seite starten")').count()) === 1, 'Popup: Nachtest auswählbar, Name vorbelegt');
  await popup.fill('details.ctx input[aria-label="Version, Build oder Commit"]', '2.4.0');
  await popup.screenshot({ path: join(OUT, 'retest-popup.png') });
  await popup.click('button:has-text("Nachtest auf dieser Seite starten")');
  await popup.waitForFunction(() => window.__closed === true);
  await popup.close();
  data = await storage();
  const rid = data['fl:active'];
  const session = data['fl:sessions'].find((s) => s.id === rid);
  const plan = data[`fl:plan:${rid}`] || [];
  check(session?.retestOf?.sessionId === baseId && session.retestOf.appVersion === 'version: 2.3.1-demo' && session.appVersion === '2.4.0' && session.lastNumber === 4, 'Nachtest-Lauf verweist auf Version 1', JSON.stringify(session));
  check(plan.map((p) => p.number).join(',') === '1,2,3,4' && plan.every((p) => p.images.crop || p.images.full) && plan.every((p) => data[`fl:img:${p.id}:full`]), 'Plan mit vier Anmerkungen und kopierten Screenshots');
  check(plan[0].baseline.contrast?.ratio < 2 && /Klick auf „Weiter“/.test(plan[1].baseline.interaction || '') && plan[1].baseline.after.some((x) => x.kind === 'network' && x.status === 500) && plan[2].devResult?.result === 'partial', 'Plan enthält Ausgangswerte (Kontrast, Folgen des Klicks, Entwicklung)', JSON.stringify(plan[1].baseline));

  // --- the list in the overlay ------------------------------------------------------------
  await app.bringToFront();
  await app.waitForSelector('.rt', { timeout: 8000 });
  check((await app.locator('.rt-item').count()) === 4 && (await app.locator('.rt-item.sel').count()) === 1, 'Nachtest-Liste mit vier Einträgen, erster aufgeklappt');
  check(await app.locator('.rt-item.sel .rt-where.ok:has-text("Element gefunden")').isVisible(), '#1: Element in Version 2 gefunden');
  await app.screenshot({ path: join(OUT, 'retest-1-panel.png') });
  await app.locator('.rt-item.sel .rt-v:has-text("Behoben")').click();
  await drawer('textarea').first().waitFor();
  // the overlay reloads its state (new plan objects) while the dialog is open
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://localhost:4173/*' });
    await chrome.tabs.sendMessage(tab.id, { type: 'fl:changed' });
  });
  await app.waitForTimeout(300);
  check((await app.locator('.drawer h3').textContent()) === 'Nachtest #1' && (await app.locator('.drawer .seg button.sel').textContent()) === 'Behoben', 'Dialog im Nachtest-Modus mit vorgewählter Bewertung');
  check(await app.locator('.drawer dd:has-text("✗ unter AA")').count() >= 1 && (await app.locator('.drawer dt:has-text("Kontrast vorher")').count()) === 1, 'Dialog zeigt Kontrast vorher/jetzt');
  await app.screenshot({ path: join(OUT, 'retest-2-drawer.png') });
  await drawer('textarea').first().fill('Gut lesbar.');
  await drawer('.btn.primary').click();
  await app.locator('.drawer').waitFor({ state: 'detached' });
  await app.waitForTimeout(600);
  check((await app.locator('.rt-item.sel .rt-num').textContent()) === '#2', 'Nach dem Speichern ist der nächste Eintrag aufgeklappt');

  // #2: trigger the button first (list collapsed, so it covers nothing), then judge it
  await app.click('.rt button[aria-label="Liste einklappen"]');
  check(await app.locator('.rt-list').isHidden(), 'Nachtest-Liste lässt sich einklappen');
  await app.click('#btn-next');
  await app.waitForURL(`${BASE}/lieferung`, { timeout: 8000 });
  await app.waitForTimeout(800); // a visit of a few milliseconds would be merged like a redirect
  await app.click('nav a[href="/"]');
  await app.waitForURL(`${BASE}/`);
  await app.waitForTimeout(700);
  await app.click('.rt button[aria-label="Liste ausklappen"]');
  await app.locator('.rt-item.sel .rt-v:has-text("Behoben")').click();
  await drawer('textarea').first().waitFor();
  await drawer('.btn.primary').click();
  await app.locator('.drawer').waitFor({ state: 'detached' });
  await app.waitForTimeout(600);

  // #3 lives on another page: "Seite öffnen" navigates there and keeps the list open
  check(await app.locator('.rt-item.sel .rt-where:has-text("Auf /lieferung")').isVisible(), '#3: Hinweis auf andere Seite');
  await app.locator('.rt-item.sel button:has-text("Seite öffnen")').click();
  await app.waitForURL(`${BASE}/lieferung`);
  await app.waitForSelector('.rt-item.sel', { timeout: 8000 });
  check((await app.locator('.rt-item.sel .rt-num').textContent()) === '#3' && (await app.locator('.rt-item.sel .rt-where.ok').count()) === 1, '„Seite öffnen“: Liste bleibt auf #3, Element gefunden');
  check((await app.locator('.rt-item.sel:has-text("Entwicklung: vorläufig")').count()) === 1, 'Liste zeigt die Rückmeldung der Entwicklung');
  await app.locator('.rt-item.sel .rt-v:has-text("Besteht weiter")').click();
  await drawer('textarea').first().waitFor();
  await drawer('textarea').first().fill('Immer noch nur ein Platzhalter.');
  await drawer('.btn.primary').click();
  await app.locator('.drawer').waitFor({ state: 'detached' });
  await app.waitForTimeout(500);

  // new finding during the re-test, #4 stays unchecked
  await pick('label:has-text("Expressversand")');
  await annotate({ category: 'Text / Inhalt', priority: 'Niedrig', description: 'Aufpreis für Express sollte im Button stehen.' });
  await app.waitForTimeout(1800);
  check((await app.locator('.toolbar .meta span').textContent()) === '3/4 geprüft · 1 neu', 'Leiste zeigt Fortschritt des Nachtests', await app.locator('.toolbar .meta span').textContent());
  data = await storage();
  const anns = data[`fl:ann:${rid}`] || [];
  const byNo = Object.fromEntries(anns.map((a) => [a.number, a]));
  check(byNo[1]?.retest?.verdict === 'fixed' && byNo[2]?.retest?.verdict === 'fixed' && byNo[3]?.retest?.verdict === 'open' && byNo[5] && !byNo[5].retest && !byNo[4], 'Bewertungen mit alten Nummern, neuer Fund als #5', anns.map((a) => `${a.number}:${a.retest?.verdict || 'neu'}`).join(','));
  check(byNo[1]?.title === 'Versandhinweis kaum lesbar.' && byNo[1].category === 'a11y' && byNo[1].element?.contrast?.passesAA, '#1: Titel/Kategorie übernommen, Kontrast jetzt ausreichend');
  const sizeOf = (id) =>
    sw.evaluate(async (id) => {
      const url = (await chrome.storage.local.get(`fl:img:${id}:full`))[`fl:img:${id}:full`];
      const bmp = await createImageBitmap(await (await fetch(url)).blob());
      return `${bmp.width}x${bmp.height}`;
    }, id);
  const [sizeBefore, sizeAfter] = [await sizeOf(plan[0].id), await sizeOf(byNo[1]?.id)];
  check(sizeAfter === sizeBefore && sizeAfter.startsWith('1280x'), 'Nachher-Screenshot so groß wie vorher', `${sizeBefore} / ${sizeAfter}`);

  // re-check replaces the earlier check
  await app.goto(`${BASE}/`);
  await app.waitForSelector('.rt', { timeout: 8000 });
  await app.locator('.rt-row:has-text("#2")').click();
  await app.locator('.rt-item.sel .rt-v:has-text("Verändert")').click();
  await drawer('textarea').first().waitFor();
  await drawer('.btn.primary').click();
  check((await app.locator('.drawer .err').textContent()).includes('was sich verändert hat'), '„Verändert“ verlangt einen Kommentar');
  await drawer('textarea').first().fill('Kein Fehler mehr, aber Weiter wartet weiterhin 2,5 s.');
  await drawer('.btn.primary').click();
  await app.locator('.drawer').waitFor({ state: 'detached' });
  await app.waitForTimeout(800);
  data = await storage();
  const checks2 = (data[`fl:ann:${rid}`] || []).filter((a) => a.retest?.number === 2);
  check(checks2.length === 1 && checks2[0].retest.verdict === 'changed', 'Neue Bewertung ersetzt die alte');

  // an edit in the dashboard (priority of check #3) must reach the export
  await msg({ type: 'fl:updateAnnotation', sessionId: rid, id: byNo[3].id, patch: { priority: 'critical' } });

  // --- dashboard + export -------------------------------------------------------------------
  await ext.goto(extUrl(`src/dashboard/dashboard.html?session=${rid}`));
  await ext.waitForSelector('.ann');
  await ext.waitForTimeout(600);
  const stats = await ext.locator('.stats').textContent();
  check(stats.includes('3/4') && stats.includes('nachgeprüft') && (await ext.locator('.unchecked li').count()) === 1, 'Dashboard: Fortschritt und „Noch nicht nachgeprüft“', stats);
  check((await ext.locator('.thumb.before img').count()) >= 3 && (await ext.locator('.orig').count()) === 3 && (await ext.locator('.tag-new').count()) === 1, 'Dashboard: Vorher-Bild, ursprüngliche Beobachtung, „neu im Nachtest“');
  await ext.screenshot({ path: join(OUT, 'retest-3-dashboard.png') });

  const [zipDl] = await ext.click('.s-actions button:has-text("Exportieren (.zip)")').then(() => Promise.all([ext.waitForEvent('download'), ext.locator('.export-dialog .modal-foot .btn.primary').click()]));
  const zipPath = join(OUT, 'retest.zip');
  await zipDl.saveAs(zipPath);
  const unzip = join(OUT, 'retest-zip');
  rmSync(unzip, { recursive: true, force: true });
  execFileSync('python3', ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zipPath, unzip]);
  const root = join(unzip, readdirSync(unzip)[0]);
  const readmeOut = readFileSync(join(root, 'README.md'), 'utf8');
  for (const [needle, label] of [
    ['# Nachtest: Bestellportal v1\n', 'Titel'],
    ['- ✅ behoben: 1', 'Zählung behoben'],
    ['- ⚠️ verändert, aber nicht gelöst: 1', 'Zählung verändert'],
    ['- ❌ besteht weiter: 1', 'Zählung besteht weiter'],
    ['- ⏳ nicht nachgeprüft: 1', 'Zählung nicht nachgeprüft'],
    ['- ➕ neu gefunden: 1', 'Zählung neu'],
    ['- Verglichen: `version: 2.3.1-demo` → `2.4.0`', 'Versionen'],
    ['**Nachtest:** Dieses Paket prüft', 'Hinweis für Claude Code'],
    ['## Behoben (laut Nachtest)', 'Abschnitt behoben'],
    ['## Nicht nachgeprüft', 'Abschnitt nicht nachgeprüft'],
  ]) check(readmeOut.includes(needle), `Nachtest-README: ${label}`, needle);
  const todo = readmeOut.split('\n## Anmerkungen')[1].split('\n## ')[0].split('\n').filter((l) => l.startsWith('- [ ]'));
  check(todo.length === 3 && /#2 · Kritisch.*_Nachtest: verändert_/.test(todo[0]) && /#3 · Kritisch.*_Nachtest: besteht weiter_ · Entwicklung: vorläufig/.test(todo[1]) && /#5 ·.*_neu im Nachtest_/.test(todo[2]), 'Nachtest-README: zu bearbeiten sind #2, #3 (Priorität aus dem Dashboard) und der neue Fund #5', todo.join('\n'));
  const files = readdirSync(join(root, 'anmerkungen')).sort();
  check(files.length === 3 && files[0].startsWith('02-') && files[1].startsWith('03-') && files[2].startsWith('05-'), 'Nur offene Punkte und neue Funde als Dateien', files.join(','));
  const issue3 = readFileSync(join(root, 'anmerkungen', files[1]), 'utf8');
  for (const [needle, label] of [
    ['(Nachtest: besteht weiter)', 'Titel mit Ergebnis'],
    ['## Ursprüngliche Beobachtung', 'ursprüngliche Beobachtung'],
    ['> PLZ-Feld hat kein Label.', 'Text der ersten Anmerkung'],
    ['- vorläufig – Frage: Welche PLZ-Formate sind erlaubt?', 'Rückmeldung der Entwicklung'],
    ['## Ergebnis im Nachtest: Besteht weiter', 'Ergebnis'],
    ['> Immer noch nur ein Platzhalter.', 'Kommentar im Nachtest'],
    ['- **Element:** gefunden, Selektor unverändert', 'Vergleich Element'],
    ['](../screenshots/anmerkung-03-vorher-ausschnitt.png)', 'Screenshot vorher'],
    ['](../screenshots/anmerkung-03-nachher-ausschnitt.png)', 'Screenshot nachher'],
    ['## Code finden – Suchbegriffe', 'Suchbegriffe für den aktuellen Stand'],
  ]) check(issue3.includes(needle), `Nachtest-Datei #3: ${label}`, needle);
  const issue2 = readFileSync(join(root, 'anmerkungen', files[0]), 'utf8');
  const before2 = issue2.match(/Nach der Interaktion – vorher:\*\* (.*)/)?.[1] || '';
  const after2 = issue2.match(/Nach der Interaktion – jetzt:\*\* (.*)/)?.[1] || '';
  check(/Klick auf „Weiter“.*→ 500/.test(before2) && /Klick auf „Weiter“/.test(after2) && !after2.includes('500') && /Navigiert zu/.test(after2), 'Nachtest-Datei #2: Folgen des Klicks vorher (500) und jetzt (kein Fehler)', `${before2}\n${after2}`);
  check(!after2.includes('Warenkorb'), 'Nachtest-Datei #2: Rücksprung durch den nächsten Klick zählt nicht als Folge', after2);
  const trailMd = readFileSync(join(root, 'klickpfad.md'), 'utf8');
  const deadLinks = [...trailMd.matchAll(/\]\(([^)#]+)\)/g)].map((m) => m[1]).filter((l) => !existsSync(join(root, l)));
  check(trailMd.includes('**Nachtest #1 (Behoben): Versandhinweis kaum lesbar.**') && trailMd.includes('**Nachtest #2 (Verändert):') && !deadLinks.length, 'klickpfad.md: Nachtest-Einträge mit Ergebnis, keine toten Links', deadLinks.join(','));
  const unresolved = [...issue3.matchAll(/\]\(([^)#]+)\)/g)].map((m) => m[1]).filter((l) => !/^https?:/.test(l) && !existsSync(join(root, 'anmerkungen', l)));
  check(!unresolved.length, 'Nachtest-Datei #3: alle Links auflösbar', unresolved.join(','));
  const shots = readdirSync(join(root, 'screenshots'));
  check(shots.filter((f) => f.includes('-vorher-')).length >= 4 && shots.filter((f) => f.includes('-nachher-')).length >= 3, 'Screenshots vorher (Version 1) und nachher (Version 2)', shots.join(','));
  const html = readFileSync(join(root, 'bericht.html'), 'utf8');
  check(html.includes('Nachtest: vorher / nachher') && html.includes('src="screenshots/anmerkung-01-vorher-ausschnitt.png"') && html.includes('src="screenshots/anmerkung-01-nachher-ausschnitt.png"') && /Kontrast:<\/strong> vorher 1,74:1 \(unter AA\) → jetzt [\d,]+:1 \(erfüllt AA\)/.test(html), 'bericht.html: Vorher/nachher mit Bildern und Kontrastvergleich');
  const json = JSON.parse(readFileSync(join(root, 'feedback.json'), 'utf8'));
  check(json.plan?.length === 4 && json.session.retestOf?.name === 'Bestellportal v1' && json.annotations.find((a) => a.number === 1)?.files.issue === null, 'feedback.json mit Plan und Verweisen');

  // --- re-test of the re-test: only what is not fixed, plus the new finding --------------------
  await ext.click('button[aria-label="Weitere Aktionen"]');
  await ext.click('.menu button:has-text("Nachtest starten")');
  await ext.waitForSelector('.modal input[type=url]');
  check((await ext.locator('.modal input[type=url]').inputValue()) === `${BASE}/`, 'Nachtest-Dialog mit Adresse vorbelegt');
  const tabsBefore = context.pages().length;
  await ext.click('.modal button:has-text("Nachtest starten")');
  await ext.waitForTimeout(1500);
  data = await storage();
  const rid2 = data['fl:active'];
  const plan2 = data[`fl:plan:${rid2}`] || [];
  check(rid2 !== rid && plan2.map((p) => p.number).join(',') === '2,3,4,5' && plan2.find((p) => p.number === 3)?.description === 'PLZ-Feld hat kein Label.', 'Nachtest vom Nachtest: alles außer Behobenem plus neuer Fund', plan2.map((p) => p.number).join(','));
  const p3 = plan2.find((p) => p.number === 3);
  const p4 = plan2.find((p) => p.number === 4);
  check(p3?.url.endsWith('/lieferung') && p3.selector && p3.priority === 'critical' && p4?.kind === 'page' && p4.url.endsWith('/lieferung'), 'Nachtest vom Nachtest: Ort, Selektor und geänderte Priorität bleiben erhalten', JSON.stringify({ p3: [p3?.url, p3?.selector, p3?.priority], p4: [p4?.kind, p4?.url] }));
  check(context.pages().length === tabsBefore + 1, 'Nachtest aus dem Dashboard öffnet die Anwendung in einem neuen Tab');

  // backup of a re-test survives export → import
  await ext.goto(extUrl(`src/dashboard/dashboard.html?session=${rid}`));
  await ext.waitForSelector('.ann');
  await ext.click('button:has-text("Weitere Formate")');
  const [bk] = await Promise.all([ext.waitForEvent('download'), ext.click('.menu button:has-text("Sicherung")')]);
  const bkPath = join(OUT, 'retest-backup.json');
  await bk.saveAs(bkPath);
  await ext.setInputFiles('#import-file', bkPath);
  await ext.waitForTimeout(1500);
  data = await storage();
  const imported = data['fl:sessions'].find((s) => s.name.endsWith('(Import)'));
  const impPlan = data[`fl:plan:${imported?.id}`] || [];
  check(imported?.retestOf && impPlan.length === 4 && impPlan.every((p) => data[`fl:img:${p.id}:full`]), 'Sicherung eines Nachtests: Plan und Vorher-Bilder wiederhergestellt');
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
