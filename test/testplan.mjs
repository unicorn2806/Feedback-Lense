// Test plans end to end: template in the dashboard (editor, import, .md
// download), start from the popup, the checkpoint list in the page (OK with a
// screenshot as proof, problem → linked annotation, not testable), the export
// (coverage, testplan.md, proof screenshots) and backup/restore.
import { startServer } from './server.mjs';
import { launch } from './launch.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.FL_OUT || '/tmp/fl-e2e-out';
mkdirSync(OUT, { recursive: true });
const PORT = 4172;
const APP = `http://localhost:${PORT}/`;
const OTHER = `http://127.0.0.1:${PORT}`;
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

const PLAN_ITEMS = `## Warenkorb
- [ ] Warenkorb ansehen
  - Start: /
  - Erwartung: Artikel und Preise sichtbar
- [ ] Gutschein einlösen
  - Erwartung: Ungültiger Code zeigt eine Fehlermeldung
## Konto
- [ ] Anmelden
  - Start: ${OTHER}/konto
- [ ] Lieferadresse ändern
  - Start: /lieferung
`;

const server = await startServer(PORT);
const { context, sw, extUrl, cleanup } = await launch();
try {
  const app = await context.newPage();
  await app.goto(APP);
  const dash = await context.newPage();
  await dash.goto(extUrl('src/dashboard/dashboard.html'));
  const storage = () => sw.evaluate(() => chrome.storage.local.get(null));

  // --- templates in the dashboard ------------------------------------------------
  await dash.click('#btn-plans');
  await dash.locator('button', { hasText: 'Neuer Testplan' }).click();
  await dash.locator('.plan-editor input[aria-label="Name des Testplans"]').fill('Checkout 2.4');
  await dash.locator('.plan-editor textarea[aria-label="Domains"]').fill(APP);
  await dash.locator('.plan-editor textarea[aria-label="Prüfpunkte"]').fill(PLAN_ITEMS);
  await dash.waitForTimeout(300);
  const preview = await dash.locator('.plan-preview').textContent();
  check(preview.includes('4 Prüfpunkte') && preview.includes('Gutschein einlösen'), 'Editor: Live-Vorschau mit 4 Prüfpunkten', preview.slice(0, 160));
  await dash.screenshot({ path: join(OUT, 'testplan-1-editor.png') });
  await dash.locator('.plan-editor .btn.primary', { hasText: 'Speichern' }).click();
  await dash.locator('.plan-tpl').first().waitFor();
  check((await dash.locator('.plan-tpl h3').first().textContent()) === 'Checkout 2.4', 'Vorlage gespeichert und angezeigt');

  const mdFile = join(OUT, 'testplan-import.md');
  writeFileSync(mdFile, '# Testplan: Konto-Release\nDomains: staging.example.com\n\n- [ ] Passwort ändern\n  - Start: /konto\n- [ ] Abmelden\n');
  await dash.locator('.plan-list ~ section, .page').first().waitFor();
  await dash.setInputFiles('.s-actions input[type=file]', mdFile);
  await dash.locator('.plan-editor').waitFor();
  check((await dash.locator('.plan-editor input[aria-label="Name des Testplans"]').inputValue()) === 'Konto-Release', 'Import: Name aus „# Testplan: …“ übernommen');
  check((await dash.locator('.plan-editor textarea[aria-label="Domains"]').inputValue()).includes('https://staging.example.com'), 'Import: Domains übernommen');
  await dash.locator('.plan-editor .btn.primary', { hasText: 'Speichern' }).click();
  await dash.waitForTimeout(400);
  check((await dash.locator('.plan-tpl').count()) === 2, 'Zwei Vorlagen');

  const card = dash.locator('.plan-tpl', { hasText: 'Checkout 2.4' });
  const [mdDl] = await Promise.all([dash.waitForEvent('download'), card.locator('button', { hasText: '.md' }).click()]);
  const mdPath = join(OUT, 'testplan-export.md');
  await mdDl.saveAs(mdPath);
  const md = readFileSync(mdPath, 'utf8');
  check(md.startsWith('# Testplan: Checkout 2.4') && md.includes('## Konto') && md.includes(`  - Start: ${OTHER}/konto`), 'Vorlage als .md: dasselbe Format wie der Import', md.slice(0, 200));

  // --- start from the popup ------------------------------------------------------
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 360, height: 640 });
  await popup.addInitScript((port) => {
    const original = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = (q) => (q && q.active ? original({ url: `http://localhost:${port}/*` }) : original(q));
  }, PORT);
  await popup.goto(extUrl('src/popup/popup.html'));
  const planSelect = popup.locator('select[aria-label="Testplan"]');
  await planSelect.waitFor();
  const selected = await planSelect.evaluate((s) => s.selectedOptions[0]?.textContent);
  check(selected?.startsWith('Checkout 2.4'), 'Menü: passender Testplan für diese Domain vorausgewählt', selected);
  await popup.screenshot({ path: join(OUT, 'testplan-2-popup.png') });
  await popup.click('button:has-text("Testlauf auf dieser Seite starten")');
  await app.bringToFront();
  await app.waitForSelector('feedback-lens-ui', { state: 'attached' });
  await app.locator('.rt').waitFor();
  let data = await storage();
  const sid = data['fl:active'];
  const meta = data['fl:sessions'].find((s) => s.id === sid);
  check(meta.testPlan?.count === 4 && meta.origins.includes(OTHER), 'Testlauf mit Plan; Domain des Login-Prüfpunkts gehört dazu', JSON.stringify({ tp: meta.testPlan, origins: meta.origins }));
  const head = await app.locator('.rt-head').textContent();
  check(head.includes('Testplan: 0 von 4 geprüft'), 'Leiste: Testplan-Liste offen', head);

  // 1: OK with proof
  await app.locator('.rt-item.sel .rt-v', { hasText: 'In Ordnung' }).click();
  await app.locator('.flm-editor').waitFor();
  check((await app.locator('.flm-title').textContent()).includes('Beleg für Prüfpunkt 1'), 'In Ordnung: Beleg-Screenshot zum Prüfen/Schwärzen');
  await app.waitForTimeout(300);
  await app.screenshot({ path: join(OUT, 'testplan-3-proof.png') });
  await app.locator('.rt-item.sel').waitFor({ state: 'attached' });
  await app.locator('.flm-done').click();
  const tDone = Date.now();
  const moved = await app.locator('.rt-item.sel', { hasText: 'Gutschein einlösen' }).waitFor({ timeout: 6000 }).then(() => Date.now() - tDone, () => null);
  console.log(`   (Fokus nach ${moved ?? 'nie'} ms weiter)`);
  data = await storage();
  let tp = data[`fl:tp:${sid}`];
  check(tp.results.c1?.status === 'ok' && tp.results.c1.image === true && data[`fl:img:${sid}.c1:full`]?.startsWith('data:image/jpeg'), 'Prüfpunkt 1: in Ordnung, Beleg gespeichert', JSON.stringify(tp.results));
  const selNow = await app.locator('.rt-item.sel').textContent().catch((e) => `ERR ${e.message}`);
  check(selNow.includes('Gutschein einlösen'), 'Weiter zum nächsten offenen Prüfpunkt', `${selNow.slice(0, 80)} | ui=${JSON.stringify(data['fl:ui'])} | hosts=${await app.evaluate(() => document.querySelectorAll('feedback-lens-ui').length)} | head=${await app.locator('.rt-head').textContent()}`);

  // 2: problem → annotation linked
  await app.locator('.rt-item.sel .rt-v', { hasText: 'Problem' }).click();
  await app.locator('.rt-item.sel button', { hasText: 'Element' }).click();
  const hint = await app.locator('.hint-text').boundingBox();
  await app.mouse.move(hint.x + 20, hint.y + 4);
  await app.mouse.click(hint.x + 20, hint.y + 4);
  await app.locator('.drawer textarea').first().waitFor();
  check((await app.locator('.drawer .plan-sel').inputValue()) === 'c2', 'Dialog: Prüfpunkt 2 vorausgewählt');
  await app.locator('.drawer textarea').first().fill('Keine Fehlermeldung bei ungültigem Code.');
  await app.locator('.drawer .btn.primary').click();
  await app.locator('.drawer').waitFor({ state: 'detached' });
  await app.waitForTimeout(800);
  data = await storage();
  tp = data[`fl:tp:${sid}`];
  const ann = (data[`fl:ann:${sid}`] || [])[0];
  check(ann?.planItem === 'c2' && tp.results.c2?.status === 'problem', 'Prüfpunkt 2: Problem, Anmerkung verknüpft', JSON.stringify({ planItem: ann?.planItem, r: tp.results.c2 }));

  // 4: open its start page, not testable
  await app.locator('.rt-item', { hasText: 'Lieferadresse ändern' }).locator('.rt-row').click();
  await app.locator('.rt-item.sel button', { hasText: 'Seite öffnen' }).click();
  await app.waitForURL(/\/lieferung$/);
  await app.waitForSelector('feedback-lens-ui', { state: 'attached' });
  await app.locator('.rt-item.sel').waitFor();
  check((await app.locator('.rt-item.sel').textContent()).includes('Startseite dieses Prüfpunkts'), '„Seite öffnen“ führt zum Start (Pfad auf dieser Domain)');
  await app.locator('.rt-item.sel .rt-v', { hasText: 'Nicht testbar' }).click();
  await app.locator('.rt-skip input').fill('Testzugang fehlt');
  await app.locator('.rt-skip button').click();
  await app.waitForTimeout(800);
  tp = (await storage())[`fl:tp:${sid}`];
  check(tp.results.c4?.status === 'skip' && tp.results.c4.note === 'Testzugang fehlt', 'Prüfpunkt 4: nicht testbar mit Grund', JSON.stringify(tp.results.c4));
  check((await app.locator('.rt-head').textContent()).includes('3 von 4 geprüft'), 'Fortschritt: 3 von 4');

  // --- dashboard: coverage, export ----------------------------------------------------
  await dash.bringToFront();
  await dash.locator('.session-item').first().click();
  await dash.locator('.plan-card').waitFor();
  const cardText = await dash.locator('.plan-card').textContent();
  check(cardText.includes('3 von 4 geprüft') && cardText.includes('#1'), 'Dashboard: Testabdeckung mit Verweis auf #1', cardText.slice(0, 200));
  await dash.locator('.plan-card .thumb-sm').first().waitFor({ timeout: 3000 }).catch(() => {});
  check((await dash.locator('.plan-card .thumb-sm').count()) === 1, 'Dashboard: Beleg-Screenshot als Vorschau');
  check((await dash.locator('.ann .tag-plan').textContent()) === 'Prüfpunkt 2', 'Anmerkung zeigt ihren Prüfpunkt');
  await dash.screenshot({ path: join(OUT, 'testplan-4-dashboard.png') });

  const [zipDl] = await dash.click('.s-actions button:has-text("Exportieren (.zip)")').then(() => Promise.all([dash.waitForEvent('download'), dash.locator('.export-dialog .modal-foot .btn.primary').click()]));
  const zipPath = join(OUT, 'testplan.zip');
  await zipDl.saveAs(zipPath);
  const root = unzip(zipPath, join(OUT, 'testplan-zip'));
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  check(/## Testabdeckung[\s\S]*3 von 4 Prüfpunkten geprüft – ✓ 1 in Ordnung · ✗ 1 mit Problemen · – 1 nicht testbar · ○ 1 nicht geprüft/.test(readme), 'README: Testabdeckung', readme.slice(readme.indexOf('## Testabdeckung'), readme.indexOf('## Testabdeckung') + 300));
  check(/- ✓ \*\*1 · Warenkorb ansehen\*\* – in Ordnung \(\d\d:\d\d:\d\d\) · \[Beleg\]\(screenshots\/testplan-01-ok\.jpg\)/.test(readme) && /- ✗ \*\*2 · Gutschein einlösen\*\* – Problem → \[#1\]\(anmerkungen\/01-/.test(readme), 'README: Zeilen mit Beleg und Verweis', readme.slice(readme.indexOf('**Warenkorb**'), readme.indexOf('**Warenkorb**') + 400));
  check(readme.includes('## Testplan für die nächste Runde') && readme.includes('testplan.md'), 'README: Anleitung für den nächsten Testplan');
  check(existsSync(join(root, 'screenshots/testplan-01-ok.jpg')), 'Beleg-Screenshot im Paket');
  const planMd = readFileSync(join(root, 'testplan.md'), 'utf8');
  check(planMd.includes('- [x] Warenkorb ansehen') && planMd.includes('Ergebnis: Problem – Anmerkung #1') && planMd.includes('Ergebnis: nicht testbar – Testzugang fehlt') && planMd.includes('Ergebnis: nicht geprüft'), 'testplan.md mit Ergebnissen', planMd);
  const issue = readFileSync(join(root, 'anmerkungen', readdirSync(join(root, 'anmerkungen'))[0]), 'utf8');
  check(issue.includes('**Prüfpunkt im Testplan:** 2 · Gutschein einlösen – erwartet: Ungültiger Code zeigt eine Fehlermeldung'), 'Anmerkungsdatei nennt den Prüfpunkt');
  const report = readFileSync(join(root, 'bericht.html'), 'utf8');
  check(report.includes('<h2>Testabdeckung</h2>') && report.includes('screenshots/testplan-01-ok.jpg'), 'Bericht: Testabdeckung mit Beleg');

  // --- backup and restore ---------------------------------------------------------------
  await dash.locator('.s-actions button', { hasText: 'Weitere Formate' }).click();
  const [bkDl] = await Promise.all([dash.waitForEvent('download'), dash.click('.menu button:has-text("Sicherung")')]);
  const bkPath = join(OUT, 'testplan-sicherung.json');
  await bkDl.saveAs(bkPath);
  await dash.setInputFiles('#import-file', bkPath);
  await dash.waitForTimeout(1200);
  data = await storage();
  const imported = data['fl:sessions'].find((s) => s.name.endsWith('(Import)'));
  const itp = imported && data[`fl:tp:${imported.id}`];
  check(itp?.items.length === 4 && itp.results.c1?.image === true && data[`fl:img:${imported.id}.c1:full`] && itp.results.c4?.note === 'Testzugang fehlt', 'Sicherung → Import: Plan, Ergebnisse und Beleg wiederhergestellt', JSON.stringify(itp?.results));
  check(data[`fl:ann:${imported?.id}`]?.[0]?.planItem === 'c2', 'Import: Anmerkung bleibt mit Prüfpunkt verknüpft');
  await sw.evaluate((id) => chrome.runtime.sendMessage({ type: 'fl:deleteSession', sessionId: id }).catch(() => null), imported.id);
  await dash.evaluate((id) => chrome.runtime.sendMessage({ type: 'fl:deleteSession', sessionId: id }), imported.id);
  data = await storage();
  check(!data[`fl:tp:${imported.id}`] && !data[`fl:img:${imported.id}.c1:full`], 'Löschen entfernt Plan und Belege');
} catch (err) {
  failures.push(String(err?.stack || err));
  console.error(err);
} finally {
  await cleanup();
  server.close();
}
console.log(failures.length ? `\n${failures.length} Prüfung(en) fehlgeschlagen` : '\nalles bestanden');
process.exit(failures.length ? 1 : 0);
