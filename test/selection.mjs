// Choosing a part of the feedback: partial export from the dashboard, and the
// decisions in the package's bericht.html (ticks, or per finding „anders /
// nicht umsetzen / zurückstellen“ with comment, a message of the product
// owner; task text for Claude Code, entscheidungen.md, remembered choice) –
// with a CSP that lets only our scripts run.
import { startServer } from './server.mjs';
import { launch } from './launch.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const OUT = process.env.FL_OUT || '/tmp/fl-e2e-out';
mkdirSync(OUT, { recursive: true });
const PORT = 4175;
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
const { context, sw, extUrl, cleanup } = await launch();
try {
  const app = await context.newPage();
  await app.goto(APP);
  const ext = await context.newPage();
  await ext.goto(extUrl('src/popup/popup.html'));
  await ext.evaluate((url) => chrome.runtime.sendMessage({ type: 'fl:startSession', name: 'Auswahl', url }), APP);
  await app.bringToFront();
  await app.waitForSelector('feedback-lens-ui', { state: 'attached' });
  await app.waitForTimeout(400);
  const note = async (title, priority, description) => {
    await sw.evaluate(async (port) => {
      const [tab] = await chrome.tabs.query({ url: `http://localhost:${port}/*` });
      await chrome.tabs.sendMessage(tab.id, { type: 'fl:command', action: 'note' });
    }, PORT);
    await app.locator('.drawer input[type=text]').first().waitFor();
    await app.locator('.drawer .seg button', { hasText: priority }).click();
    await app.locator('.drawer input[type=text]').first().fill(title);
    await app.locator('.drawer textarea').first().fill(description);
    await app.locator('.drawer .btn.primary').click();
    await app.locator('.drawer').waitFor({ state: 'detached' });
    await app.waitForTimeout(700); // captureVisibleTab rate limit
  };
  await note('Erster Punkt', 'Hoch', 'Beschreibung eins');
  await note('Zweiter Punkt', 'Niedrig', 'Text mit <img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>');
  await note('Dritter Punkt', 'Kritisch', 'Beschreibung drei');

  // --- dashboard: partial export ---------------------------------------------------
  await ext.goto(extUrl('src/dashboard/dashboard.html'));
  await ext.bringToFront();
  await ext.locator('.ann').first().waitFor();
  check(await ext.locator('#pickbar').isHidden(), 'Auswahlleiste erst sichtbar, wenn etwas angehakt ist');
  await ext.locator('input[data-pick="1"]').check();
  await ext.locator('input[data-pick="3"]').check();
  const bar = await ext.locator('#pickbar').textContent();
  check(bar.includes('2 von 3 ausgewählt'), 'Auswahlleiste zählt mit', bar);
  const [partial] = await Promise.all([ext.waitForEvent('download'), ext.locator('#pickbar button', { hasText: 'Nur Auswahl exportieren' }).click().then(() => ext.locator('.export-dialog .modal-foot .btn.primary').click())]);
  const partialZip = join(OUT, 'auswahl-teil.zip');
  await partial.saveAs(partialZip);
  const pRoot = unzip(partialZip, join(OUT, 'auswahl-teil'));
  const pFiles = readdirSync(join(pRoot, 'anmerkungen'));
  check(pFiles.length === 2 && pFiles.some((f) => f.startsWith('01-')) && pFiles.some((f) => f.startsWith('03-')), 'Teil-Export enthält nur #1 und #3', pFiles.join(', '));
  const pReadme = readFileSync(join(pRoot, 'README.md'), 'utf8');
  check(/Teil-Export:\*\* Die testende Person hat 2 von 3 Anmerkungen/.test(pReadme) && !pReadme.includes('Zweiter Punkt'), 'README: Hinweis auf Teil-Export, #2 fehlt', pReadme.slice(0, 400));

  // --- full export: selection in bericht.html ---------------------------------------
  await ext.locator('#pickbar button', { hasText: 'Auswahl aufheben' }).click();
  await ext.click('.s-actions button:has-text("Exportieren (.zip)")');
  await ext.locator('.export-dialog textarea').fill('Bitte zuerst #3.\nDer Rest kann warten.');
  const [full] = await Promise.all([ext.waitForEvent('download'), ext.locator('.export-dialog .modal-foot .btn.primary').click()]);
  const fullZip = join(OUT, 'auswahl-voll.zip');
  await full.saveAs(fullZip);
  const root = unzip(fullZip, join(OUT, 'auswahl-voll'));
  const folder = root.split('/').pop();
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  check(readme.includes('`entscheidungen.md`') && readme.includes('**gehen sie vor**') && readme.includes('im Ergebnis `abgelehnt` mit der angegebenen Begründung'), 'README erklärt Claude Code die Entscheidungen (Vorrang, abgelehnt mit Begründung)');
  const fileOf = (n) => readFileSync(join(root, 'anmerkungen', readdirSync(join(root, 'anmerkungen')).find((x) => x.startsWith(`0${n}-`))), 'utf8');
  check(fileOf(3).includes('**Nachricht der testenden Person zu #3**') && fileOf(3).includes('> Bitte zuerst #3.') && !fileOf(3).includes('Der Rest kann warten'), 'Anmerkungsdatei #3: die Zeile der Nachricht, die #3 nennt', fileOf(3).slice(0, 500));
  check(!fileOf(1).includes('Nachricht der testenden Person zu') && /in der \[README\]\(\.\.\/README\.md\) lesen\. Liegt im Paketordner eine `entscheidungen\.md`.*gilt sie für #1 vorrangig/.test(fileOf(1)), 'Jede Anmerkungsdatei verweist auf Nachricht und entscheidungen.md', fileOf(1).slice(0, 500));

  const report = await context.newPage();
  const dialogs = [];
  report.on('dialog', (d) => (dialogs.push(d.message()), d.dismiss()));
  const cspErrors = [];
  report.on('console', (m) => /Content Security Policy/.test(m.text()) && cspErrors.push(m.text()));
  await report.goto(pathToFileURL(join(root, 'bericht.html')).href);
  await report.waitForTimeout(300);
  // --- one list of findings: rows that open, search, filters, links -----------------
  const items = report.locator('#anmerkungen .item');
  const order = await items.evaluateAll((els) => els.map((el) => el.dataset.n).join(','));
  check(order === '3,1,2' && (await report.locator('#anmerkungen .item > details[open]').count()) === 0, 'Eine Liste, nach Priorität sortiert, alle zugeklappt', order);
  check((await report.locator('table').count()) === 0 && (await report.locator('header a, #anmerkungen a').evaluateAll((els) => els.filter((a) => /^#a\d+$/.test(a.getAttribute('href'))).length)) === 0, 'Keine Übersichtstabelle mit Sprungmarken mehr');
  const thumbsOk = await report.locator('#anmerkungen img[data-thumb]').evaluateAll((els) => els.every((el) => !el.hidden && el.getAttribute('src')));
  check(thumbsOk, 'Jede Zeile zeigt ein Vorschaubild');
  await items.nth(1).locator(':scope > details > summary').click();
  check((await items.nth(1).locator(':scope > details').getAttribute('open')) !== null && (await items.nth(1).locator('.gallery img').first().isVisible()) && (await items.nth(1).locator('blockquote').first().textContent()) === 'Beschreibung eins', 'Klick auf eine Zeile klappt die Details auf (Text und Bilder)');
  await report.screenshot({ path: join(OUT, 'bericht-liste.png') });
  await items.nth(1).locator(':scope > details > summary').click();
  const search = report.locator('.toolbar input[type=search]');
  await search.fill('dritter');
  check((await items.evaluateAll((els) => els.filter((el) => !el.hidden).map((el) => el.dataset.n).join(','))) === '3' && (await report.locator('.toolbar .shown').textContent()) === '1 von 3', 'Suche filtert die Liste', await report.locator('.toolbar .shown').textContent());
  await search.fill('');
  await report.locator('.fchip', { hasText: 'Niedrig' }).click();
  check((await items.evaluateAll((els) => els.filter((el) => !el.hidden).map((el) => el.dataset.n).join(','))) === '2', 'Filter „Niedrig“ zeigt nur #2');
  await report.locator('.fchip', { hasText: 'Niedrig' }).click();
  await report.locator('.toolbar select').selectOption('number');
  check((await items.evaluateAll((els) => els.map((el) => el.dataset.n).join(','))) === '1,2,3', 'Sortierung nach Nummer');
  await report.locator('.tbtn[data-open="all"]').click();
  check((await report.locator('#anmerkungen .item > details[open]').count()) === 3, '„Alle“ klappt alle auf');
  await report.locator('.tbtn[data-open="none"]').click();
  await report.goto(`${pathToFileURL(join(root, 'bericht.html')).href}#a2`);
  await report.waitForTimeout(400);
  check((await report.locator('#a2 > details').getAttribute('open')) !== null, 'Link auf #a2 öffnet diese Anmerkung');
  await report.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  check((await report.locator('#anmerkungen .item > details:not([open])').count()) === 0, 'Drucken: alle Anmerkungen aufgeklappt');
  await report.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  check((await report.locator('#anmerkungen .item > details[open]').count()) === 1, 'Nach dem Drucken wie vorher');

  // --- selection --------------------------------------------------------------------
  check((await report.locator('#sel-count').textContent()) === 'Nichts entschieden', 'Bericht: Auswahl-Skript läuft (trotz Sicherheitsrichtlinie)');
  check(await report.locator('#sel-copy').isDisabled(), 'Ohne Auswahl: Knöpfe gesperrt');
  check(!(await report.locator('.selbar').getAttribute('class')).includes('show'), 'Auswahlleiste erst sichtbar, wenn etwas angehakt ist');
  await report.locator('.fchip', { hasText: 'Kritisch' }).click();
  await report.locator('[data-pick-all]').check();
  check((await report.locator('#sel-count').textContent()) === '1 von 3 umsetzen', '„Alle angezeigten“ wählt bei Filter „Kritisch“ nur #3');
  await report.locator('.fchip', { hasText: 'Kritisch' }).click();
  check(await report.locator('[data-pick-all]').evaluate((el) => el.indeterminate), 'Ohne Filter: „Alle“ zeigt „teilweise“');
  await report.locator('[data-pick-all]').check();
  check((await report.locator('#sel-count').textContent()) === '3 von 3 umsetzen' && (await report.locator('.selbar').getAttribute('class')).includes('show'), '„Alle angezeigten“ wählt alle 3, Leiste erscheint');
  await report.locator('.item input[data-n="2"]').uncheck();
  check(!(await report.locator('#a2').getAttribute('class')).includes('picked') && (await report.locator('#a1').getAttribute('class')).includes('picked'), 'Angehakte Zeilen sind hervorgehoben');
  await report.evaluate(() => {
    window.__copied = null;
    navigator.clipboard.writeText = async (text) => (window.__copied = text);
  });
  await report.locator('#sel-copy').click();
  const copied = await report.evaluate(() => window.__copied);
  check(copied?.includes(`Lies zuerst \`${folder}/README.md\``) && /#1 · Erster Punkt → `[^`]+\/anmerkungen\/01-/.test(copied) && copied.includes('#3 · Dritter Punkt') && !copied.includes('#2'), 'Auftrag für Claude Code mit #1 und #3 und Dateipfaden', copied);

  await report.evaluate(() => (window.showSaveFilePicker = undefined)); // fallback: download
  const [selDl] = await Promise.all([report.waitForEvent('download'), report.locator('#sel-save').click()]);
  const selPath = join(OUT, 'entscheidungen-auswahl.md');
  await selDl.saveAs(selPath);
  const selMd = readFileSync(selPath, 'utf8');
  check(selDl.suggestedFilename() === 'entscheidungen.md' && /## Umsetzen\n\n- #3 · \[Dritter Punkt\][^\n]+\n- #1 · \[Erster Punkt\]\(anmerkungen\/01-[^)]+\.md\)/.test(selMd) && !selMd.includes('#2 ·') && selMd.includes('## Alle anderen Anmerkungen'), 'entscheidungen.md mit Links in den Paket-Ordner, nach Priorität', selMd);

  await report.reload();
  await report.waitForTimeout(300);
  check((await report.locator('#sel-count').textContent()) === '2 von 3 umsetzen', 'Auswahl bleibt beim erneuten Öffnen erhalten');

  // large pictures: click a screenshot, actual size, browse, close
  await report.locator('.tbtn[data-open="all"]').click();
  const thumbs = report.locator('.gallery img');
  const nShots = await thumbs.count();
  const thumbW = (await thumbs.first().boundingBox()).width;
  await thumbs.first().click();
  const zoom = report.locator('.zoom');
  await zoom.waitFor();
  const big = report.locator('.zoom-stage img');
  await report.waitForFunction(() => document.querySelector('.zoom-stage img')?.complete);
  const fitW = (await big.boundingBox()).width;
  check(nShots >= 3 && (await report.locator('.zoom-count').textContent()) === `1 / ${nShots}` && /^#\d+ .+ – /.test(await report.locator('.zoom-title').textContent()) && fitW > thumbW * 1.5, 'Klick auf einen Screenshot: groß, mit Titel und Zähler', JSON.stringify({ nShots, thumbW, fitW, title: await report.locator('.zoom-title').textContent() }));
  await report.screenshot({ path: join(OUT, 'bericht-zoom.png') });
  await big.click();
  const actual = await big.evaluate((img) => ({ w: img.getBoundingClientRect().width, natural: img.naturalWidth }));
  check((await zoom.getAttribute('class')).includes('actual') && Math.abs(actual.w - actual.natural) < 2, 'Klick ins Bild: Originalgröße', JSON.stringify(actual));
  await report.keyboard.press('ArrowRight');
  check((await report.locator('.zoom-count').textContent()) === `2 / ${nShots}` && !(await zoom.getAttribute('class')).includes('actual'), '→ blättert zum nächsten Bild');
  await report.keyboard.press('Escape');
  check(await zoom.isHidden(), 'Esc schließt');
  await thumbs.nth(1).focus();
  await report.keyboard.press('Enter');
  check(await zoom.isVisible() && (await report.locator('.zoom-count').textContent()) === `2 / ${nShots}`, 'Per Tastatur: Enter auf einem Bild öffnet es');
  await report.mouse.click(5, 400); // beside the picture
  check(await zoom.isHidden(), 'Klick daneben schließt');
  await report.locator('.selbar #sel-clear').click();
  check((await report.locator('#sel-count').textContent()) === 'Nichts entschieden' && !(await report.locator('.selbar').getAttribute('class')).includes('show'), '„Zurücksetzen“ leert die Auswahl (ohne Rückfrage, nichts getippt), Leiste verschwindet');

  // CSP: markup from the tested page cannot run, inline handlers are blocked
  await report.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<img src="x" onerror="window.__pwned=3">'));
  await report.waitForTimeout(300);
  check((await report.evaluate(() => window.__pwned)) === undefined && dialogs.length === 0, 'Fremde Skripte im Bericht laufen nicht', JSON.stringify({ pwned: await report.evaluate(() => window.__pwned), dialogs }));
  check(cspErrors.length > 0, 'Sicherheitsrichtlinie greift (blockierter Inline-Handler gemeldet)');
  await report.screenshot({ path: join(OUT, 'auswahl-bericht.png') });

  // --- decisions of the product owner -------------------------------------------------
  const po = await context.newPage();
  const poDialogs = [];
  po.on('dialog', (d) => (poDialogs.push(d.message()), d.accept()));
  await po.goto(pathToFileURL(join(root, 'bericht.html')).href);
  await po.waitForTimeout(300);
  await po.evaluate(() => {
    window.__copied = null;
    navigator.clipboard.writeText = async (text) => (window.__copied = text);
    window.showSaveFilePicker = undefined;
  });
  const copyTask = async () => {
    await po.locator('#sel-copy').click();
    return po.evaluate(() => window.__copied);
  };
  check((await po.locator('#a3 .said').textContent()).includes('Bitte zuerst #3.'), 'Bericht: Nachricht der testenden Person zu #3 steht bei #3');
  await po.locator('#produkt summary').click();
  await po.locator('#produkt textarea').fill('Erst #3, dann #1.');
  await po.locator('#a1 > details > summary').click();
  check(await po.locator('#a1 .decide').isVisible(), 'Jede Anmerkung hat „Entscheidung zur Umsetzung“');
  await po.locator('#a1 .decide [data-d="change"]').click();
  check(await po.locator('#a1 .decide textarea').evaluate((el) => el === document.activeElement), '„Anders umsetzen“ setzt den Cursor ins Kommentarfeld');
  await po.keyboard.type('Nur den Text ändern, Layout bleibt.');
  await po.locator('#a2 > details > summary').click();
  await po.locator('#a2 .decide [data-d="reject"]').click();
  await po.keyboard.type('Ist so gewollt.');
  await po.locator('.item input[data-n="3"]').check();
  const rowState = (n) => po.locator(`#a${n}`).evaluate((el) => ({ picked: el.classList.contains('picked'), dim: el.classList.contains('dim'), chip: el.querySelector('.dchip:not([hidden])')?.textContent || '' }));
  const r1 = await rowState(1);
  const r2 = await rowState(2);
  check(r1.picked && r1.chip === 'Anders umsetzen' && !r2.picked && r2.dim && r2.chip === 'Nicht umsetzen', 'Zeilen zeigen die Entscheidung (Haken, Hinweis, abgeblendet)', JSON.stringify({ r1, r2 }));
  check((await po.locator('#sel-count').textContent()) === '2 von 3 umsetzen · 1 nicht umsetzen' && (await po.locator('#sel-rest').textContent()) === '', 'Leiste fasst zusammen', await po.locator('.sel-sum').textContent());
  await po.screenshot({ path: join(OUT, 'entscheidungen-bericht.png') });
  let task = await copyTask();
  const at = (t) => task.indexOf(t);
  check(
    at('Entscheidungen zur Umsetzung – sie gehen vor Beobachtung, Erwartung und Nachricht der testenden Person') > 0 &&
      at('Nachricht der Produktverantwortung:\n> Erst #3, dann #1.') > 0 &&
      at('Umsetzen:\n- #3 · Dritter Punkt') > 0 &&
      at('#3 · Dritter Punkt') < at('#1 · Erster Punkt') &&
      at('- #1 · Erster Punkt → `') > 0 &&
      at('  - Anders umsetzen: Nur den Text ändern, Layout bleibt.') > at('- #1 · Erster Punkt') &&
      at('Nicht umsetzen – keinen Code ändern, im Ergebnis als `abgelehnt` mit dieser Begründung eintragen:\n- #2 · Zweiter Punkt') > 0 &&
      at('  - Begründung: Ist so gewollt.') > 0 &&
      at('Alle anderen') < 0,
    'Auftrag: Nachricht, Umsetzen (nach Priorität, mit „anders“), Nicht umsetzen mit Begründung',
    task,
  );
  await po.locator('.item input[data-n="3"]').uncheck();
  check((await po.locator('#sel-rest').textContent()) === '1 übrige: nicht anfassen' && (await copyTask()).includes('Alle anderen Anmerkungen nicht anfassen und nicht eintragen – sie bleiben offen.'), 'Mit Auswahl: übrige nicht anfassen');
  await po.locator('#a1 .decide [data-d="change"]').click(); // pressed again: no decision, the comment stays
  task = await copyTask();
  check(
    (await po.locator('#sel-rest').textContent()) === '2 übrige: wie gewohnt bearbeiten' && task.includes('Alle übrigen Anmerkungen wie in der README beschrieben bearbeiten. Kommentare dazu:\n- #1 · Erster Punkt') && task.includes('  - Kommentar: Nur den Text ändern'),
    'Nur „nicht umsetzen“: alle übrigen wie gewohnt, Kommentar bleibt',
    task,
  );
  const [poDl] = await Promise.all([po.waitForEvent('download'), po.locator('#sel-save').click()]);
  const poPath = join(OUT, 'entscheidungen.md');
  await poDl.saveAs(poPath);
  const poMd = readFileSync(poPath, 'utf8');
  check(
    poDl.suggestedFilename() === 'entscheidungen.md' && poMd.startsWith('# Entscheidungen zur Umsetzung\n') && poMd.includes('**Diese Entscheidungen gehen vor**') && poMd.includes('## Nachricht der Produktverantwortung\n\n> Erst #3, dann #1.') && /## Nicht umsetzen\n\n_Keinen Code ändern.*_\n\n- #2 · \[Zweiter Punkt\]\(anmerkungen\/02-[^)]+\.md\) – Niedrig, [^\n]+\n  - Begründung: Ist so gewollt\./.test(poMd) && poMd.includes('## Alle übrigen Anmerkungen\n\n_Wie in der README beschrieben bearbeiten._'),
    'entscheidungen.md: Vorrang, Nachricht, Begründung, übrige',
    poMd,
  );
  await po.reload();
  await po.waitForTimeout(300);
  check(
    (await po.locator('#produkt textarea').inputValue()) === 'Erst #3, dann #1.' && (await po.locator('#a2 .decide [data-d="reject"]').getAttribute('aria-pressed')) === 'true' && (await po.locator('#a2 .decide textarea').inputValue()) === 'Ist so gewollt.' && (await po.locator('#a1 .decide textarea').inputValue()).startsWith('Nur den Text'),
    'Entscheidungen, Kommentare und Nachricht bleiben beim erneuten Öffnen erhalten',
  );
  await po.locator('#sel-clear').click();
  check(poDialogs.length === 1 && (await po.locator('#sel-count').textContent()) === 'Nichts entschieden' && (await po.locator('#produkt textarea').inputValue()) === '' && (await po.locator('#a2 .decide textarea').inputValue()) === '', '„Zurücksetzen“ fragt bei getippten Kommentaren nach und leert alles', JSON.stringify(poDialogs));
} catch (err) {
  failures.push(String(err?.stack || err));
  console.error(err);
} finally {
  await cleanup();
  server.close();
}
console.log(failures.length ? `\n${failures.length} Prüfung(en) fehlgeschlagen` : '\nalles bestanden');
process.exit(failures.length ? 1 : 0);
