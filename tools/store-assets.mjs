// Produces the store graphics from the real extension against the demo app:
// five screenshots (1280x800), the promo tiles (440x280, 1400x560) and the
// 300x300 logo for Edge Add-ons.
// Needs Playwright (like the tests) and Pillow for the large icon:
//   NODE_PATH=… node tools/store-assets.mjs
import { startServer } from '../test/server.mjs';
import { launch } from '../test/launch.mjs';
import { renderMarkdown } from '../extension/src/lib/markdown.js';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT = join(ROOT, 'store');
const SHOTS = join(OUT, 'screenshots');
const PROMO = join(OUT, 'werbekacheln');
const WORK = mkdtempSync(join(process.env.FL_TMP || tmpdir(), 'fl-store-'));
for (const dir of [SHOTS, PROMO]) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}
const BASE = 'http://localhost:4173';
const VIEW = { width: 1280, height: 800 };

// The store wants 24-bit images without alpha channel.
const flatten = (file) => execFileSync('python3', ['-c', 'import sys\nfrom PIL import Image\nImage.open(sys.argv[1]).convert("RGB").save(sys.argv[1])', file]);
const unzip = (zip, dir) => execFileSync('python3', ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zip, dir]);

const server = await startServer(4173);
const { context, sw, extUrl, cleanup } = await launch({ viewport: VIEW });
try {
  const app = await context.newPage();
  await app.goto(`${BASE}/`);
  const ext = await context.newPage();
  await ext.goto(extUrl('src/popup/popup.html'));
  const msg = (payload) => ext.evaluate((p) => chrome.runtime.sendMessage(p), payload);
  const command = (action) =>
    sw.evaluate(async (action) => {
      const [tab] = await chrome.tabs.query({ url: 'http://localhost:4173/*' });
      await chrome.tabs.sendMessage(tab.id, { type: 'fl:command', action });
    }, action);
  const drawer = (sel) => app.locator(`.drawer ${sel}`);
  async function pick(selector) {
    await command('pick');
    const box = await app.locator(selector).first().boundingBox();
    await app.mouse.move(box.x + Math.min(30, box.width / 2), box.y + box.height / 2);
    await app.waitForTimeout(150);
    await app.mouse.click(box.x + Math.min(30, box.width / 2), box.y + box.height / 2);
    await drawer('textarea').first().waitFor();
    await app.waitForTimeout(200);
  }
  async function fill({ category, priority, title, description, expected }) {
    if (category) await drawer(`.chip:has-text("${category}")`).click();
    if (priority) await drawer(`.seg button:has-text("${priority}")`).click();
    if (title) await drawer('input[type=text]').fill(title);
    await drawer('textarea').first().fill(description);
    if (expected) await drawer('textarea').nth(1).fill(expected);
  }
  async function save() {
    await drawer('.btn.primary').click();
    await app.locator('.drawer').waitFor({ state: 'detached' });
    await app.waitForTimeout(400);
  }
  const shot = async (page, name) => {
    const file = join(SHOTS, name);
    await page.screenshot({ path: file });
    flatten(file);
    console.log('✔', name);
  };

  // --- test of version 2.3.1 ---------------------------------------------------------
  await msg({ type: 'fl:startSession', name: 'Bestellportal – Release-Test', url: `${BASE}/`, appContext: 'Online-Shop für Büromöbel, Staging. Fokus: Checkout.', appVersion: '2.3.1' });
  await app.bringToFront();
  await app.waitForSelector('feedback-lens-ui', { state: 'attached' });
  await app.waitForTimeout(500);

  await pick('.hint-text');
  await fill({ category: 'Barrierefreiheit', priority: 'Hoch', title: 'Versandhinweis kaum lesbar', description: 'Der graue Hinweistext ist auf weißem Hintergrund kaum zu lesen – gerade die Info zu den Rabatten übersieht man so.', expected: 'Dunklere Schrift, mindestens 14 px.' });
  // circle the text in the screenshot and point at it, as a tester would
  // (scrolled into view: the dialog's footer must not be under the pointer)
  await drawer('canvas.preview').scrollIntoViewIfNeeded();
  await app.waitForTimeout(300);
  const canvas = await drawer('canvas.preview').boundingBox();
  const cx = canvas.x + canvas.width / 2;
  const cy = canvas.y + canvas.height / 2 + 4;
  const dragTo = async (from, to) => {
    await app.mouse.move(...from);
    await app.mouse.down();
    await app.mouse.move(...to, { steps: 8 });
    await app.mouse.up();
  };
  await drawer('.shot-tools button[data-tool=ellipse]').click();
  await dragTo([cx - canvas.width * 0.48, cy - canvas.height * 0.2], [cx + canvas.width * 0.48, cy + canvas.height * 0.2]);
  await drawer('.shot-tools button[data-tool=arrow]').click();
  await drawer('.shot-tools .flm-color[aria-label="Farbe Orange"]').click();
  await dragTo([cx + canvas.width * 0.3, cy + canvas.height * 0.45], [cx + canvas.width * 0.12, cy + canvas.height * 0.22]);
  await app.waitForTimeout(200);
  await shot(app, '1-anmerken-am-element.png');
  await save();

  await app.click('#coupon');
  await app.fill('.code', 'SOMMER24');
  await app.locator('.code').blur();
  await app.click('#btn-next');
  await app.waitForURL(`${BASE}/lieferung`, { timeout: 8000 });
  await app.waitForTimeout(900);
  await app.click('#address button[type=submit]');
  await app.waitForTimeout(1000);
  await command('region');
  const form = await app.locator('#address').boundingBox();
  await app.mouse.move(form.x - 10, form.y - 10);
  await app.mouse.down();
  await app.mouse.move(form.x + form.width + 10, form.y + form.height + 34, { steps: 8 });
  await app.mouse.up();
  await drawer('textarea').first().waitFor();
  await fill({ category: 'Bedienbarkeit', priority: 'Mittel', title: 'PLZ-Feld ohne Beschriftung', description: 'Das PLZ-Feld hat nur einen Platzhalter. Nach dem Absenden kommt „Fehler 0x8004“ – damit kann ich nichts anfangen.' });
  await save();
  await pick('promo-banner >> .promo-cta');
  await fill({ category: 'Design / Layout', priority: 'Niedrig', title: 'Aktionsbanner lenkt im Checkout ab', description: 'Der Rabatt-Banner zieht im Checkout die Aufmerksamkeit vom eigentlichen Ziel ab.' });
  await save();
  await app.click('nav a[href="/"]');
  await app.waitForURL(`${BASE}/`);
  await app.waitForTimeout(600);
  await pick('#btn-next');
  await fill({ category: 'Fehler', priority: 'Kritisch', title: '„Weiter“: Serverfehler ohne Hinweis', description: 'Nach Klick auf „Weiter“ passiert ein paar Sekunden nichts, dann geht es trotzdem weiter – obwohl im Hintergrund ein Fehler kam. Ich bekomme keinen Hinweis.' });
  await save();
  await command('note');
  await drawer('textarea').first().waitFor();
  await fill({ category: 'Idee / Wunsch', description: 'Eine Fortschrittsanzeige im Checkout (Schritt 1 von 3) wäre hilfreich.' });
  await save();
  await app.waitForTimeout(1800);
  const baseId = (await sw.evaluate(() => chrome.storage.local.get('fl:active')))['fl:active'];

  // --- dashboard ------------------------------------------------------------------------
  await msg({ type: 'fl:stopSession' });
  await ext.goto(extUrl(`src/dashboard/dashboard.html?session=${baseId}`));
  await ext.bringToFront();
  await ext.waitForSelector('.ann');
  await ext.waitForTimeout(800);
  await shot(ext, '2-dashboard.png');

  // --- what Claude Code gets: one annotation file of the package --------------------------
  const [dl] = await ext.click('.s-actions button:has-text("Exportieren (.zip)")').then(() => Promise.all([ext.waitForEvent('download'), ext.locator('.export-dialog .modal-foot .btn.primary').click()]));
  const zip = join(WORK, 'paket.zip');
  await dl.saveAs(zip);
  const pkg = join(WORK, 'paket');
  unzip(zip, pkg);
  const folder = readdirSync(pkg)[0];
  const issues = readdirSync(join(pkg, folder, 'anmerkungen')).sort();
  const issueName = issues.find((f) => f.startsWith('04-'));
  const md = readFileSync(join(pkg, folder, 'anmerkungen', issueName), 'utf8');
  // markdown.js renders no images (reports reference them separately): put them in here.
  const images = [];
  const body = renderMarkdown(
    md.replace(/^!\[([^\]]*)\]\(([^)]+)\)$/gm, (_, alt, src) => {
      images.push(`<figure><img src="${src}" alt=""><figcaption>${alt}</figcaption></figure>`);
      return `IMAGEPLACEHOLDER${images.length - 1}`;
    }),
  ).replace(/<p>IMAGEPLACEHOLDER(\d+)<\/p>/g, (_, i) => images[+i]);
  const tree = ['README.md', 'anmerkungen/', ...issues.map((f) => `  ${f}`), 'screenshots/', 'klickpfad.md', 'feedback.json', 'bericht.html'];
  const preview = `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>
    body { margin: 0; font: 14px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #0f172a; background: #f1f5f9; display: grid; grid-template-columns: 300px 1fr; height: 100vh; }
    aside { background: #0f172a; color: #cbd5e1; padding: 22px 18px; font: 12.5px/1.9 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow: hidden; }
    aside b { display: block; color: #fff; font: 600 13px system-ui, sans-serif; margin-bottom: 12px; }
    aside div { white-space: pre; overflow: hidden; text-overflow: ellipsis; }
    aside .sel { color: #fff; background: #4f46e5; border-radius: 5px; padding: 0 6px; margin: 0 -6px; }
    aside p { font: 12px/1.5 system-ui, sans-serif; color: #94a3b8; margin-top: 18px; white-space: normal; }
    main { overflow: hidden; padding: 0 40px 26px; background: #fff; }
    .bar { position: sticky; top: 0; margin: 0 -40px 8px; padding: 12px 40px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #334155; z-index: 1; }
    main h1 { font-size: 21px; margin: 0 0 10px; } main h2 { font-size: 16px; margin: 20px 0 8px; }
    blockquote { margin: 6px 0; padding: 6px 12px; border-left: 3px solid #c7d2fe; background: #f8fafc; }
    code { font: 12.5px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #f1f5f9; padding: 1px 5px; border-radius: 4px; }
    ul, ol { padding-left: 22px; margin: 6px 0; } li { margin: 2px 0; } p { margin: 6px 0; }
    figure { display: inline-block; margin: 6px 14px 6px 0; vertical-align: top; } figure img { max-height: 150px; border: 1px solid #e2e8f0; border-radius: 6px; } figcaption { font-size: 12px; color: #64748b; }
  </style></head><body>
    <aside><b>${folder}/</b>${tree.map((t) => `<div class="${t.trim() === issueName ? 'sel' : ''}">${t}</div>`).join('')}<p>Eine Datei pro Anmerkung – so arbeitet Claude Code die Punkte ab: Beobachtung, Screenshots, kürzeste Schritte, was nach dem Klick passierte, Suchbegriffe.</p></aside>
    <main><div class="bar">${folder}/anmerkungen/${issueName}</div>${body}</main></body></html>`;
  writeFileSync(join(pkg, folder, 'anmerkungen', 'vorschau.html'), preview);
  const viewer = await context.newPage();
  await viewer.goto(pathToFileURL(join(pkg, folder, 'anmerkungen', 'vorschau.html')).href);
  await viewer.waitForTimeout(500);
  // jump to the most telling part: what happened after the click
  await viewer.evaluate(() => {
    const h = [...document.querySelectorAll('main h2')].find((x) => x.textContent.startsWith('Schritte'));
    const main = document.querySelector('main');
    if (h) main.scrollTop += h.getBoundingClientRect().top - main.getBoundingClientRect().top - 58;
  });
  await viewer.waitForTimeout(200);
  await shot(viewer, '3-paket-fuer-claude-code.png');
  await viewer.close();

  // --- re-test in version 2.4.0 ---------------------------------------------------------------
  await context.addCookies([{ name: 'demo', value: 'v2', url: BASE }]);
  await app.goto(`${BASE}/`);
  await msg({ type: 'fl:startRetest', baseSessionId: baseId, url: `${BASE}/`, name: 'Nachtest Release 2.4.0', appVersion: '2.4.0' });
  await app.bringToFront();
  await app.waitForSelector('.rt-item.sel', { timeout: 8000 });
  await app.locator('.rt-item.sel .rt-v:has-text("Behoben")').click();
  await drawer('textarea').first().waitFor();
  await drawer('textarea').first().fill('Jetzt gut lesbar.');
  await save();
  await app.mouse.move(5, 790); // no tooltip from where the save button was
  await app.waitForTimeout(800);
  await shot(app, '4-nachtest-liste.png');

  // --- before/after report ----------------------------------------------------------------------
  const retestId = (await sw.evaluate(() => chrome.storage.local.get('fl:active')))['fl:active'];
  await msg({ type: 'fl:stopSession' });
  await ext.goto(extUrl(`src/dashboard/dashboard.html?session=${retestId}`));
  await ext.waitForSelector('.ann');
  const [dl2] = await ext.click('.s-actions button:has-text("Exportieren (.zip)")').then(() => Promise.all([ext.waitForEvent('download'), ext.locator('.export-dialog .modal-foot .btn.primary').click()]));
  const zip2 = join(WORK, 'nachtest.zip');
  await dl2.saveAs(zip2);
  const pkg2 = join(WORK, 'nachtest');
  unzip(zip2, pkg2);
  const report = await context.newPage();
  await report.goto(pathToFileURL(join(pkg2, readdirSync(pkg2)[0], 'bericht.html')).href);
  await report.waitForTimeout(600);
  // open an earlier finding that still needs work: before/after side by side
  await report.evaluate(() => {
    const items = [...document.querySelectorAll('#nachtest .item')];
    const item = items.find((x) => ['changed', 'open'].includes(x.dataset.verdict)) || items[0];
    item.querySelector('details').open = true;
    window.scrollTo(0, document.getElementById('nachtest').offsetTop - 20);
  });
  await report.waitForTimeout(500);
  await shot(report, '5-vorher-nachher.png');
  await report.close();

  // --- promo tiles ----------------------------------------------------------------------------
  const icon = join(WORK, 'icon-512.png');
  execFileSync('python3', [join(ROOT, 'tools/make-icons.py'), '512', icon]);
  const iconUrl = `data:image/png;base64,${readFileSync(icon).toString('base64')}`;
  const shotUrl = `data:image/png;base64,${readFileSync(join(SHOTS, '1-anmerken-am-element.png')).toString('base64')}`;
  const tile = (w, hgt, inner) => `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; } body { margin: 0; width: ${w}px; height: ${hgt}px; overflow: hidden; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      background: radial-gradient(circle at 85% 15%, #6366f1 0, transparent 45%), linear-gradient(135deg, #312e81, #4f46e5 60%, #6366f1); color: #fff; }
    .chip { display: inline-block; background: rgba(255,255,255,.14); border: 1px solid rgba(255,255,255,.25); border-radius: 999px; padding: 4px 12px; margin: 0 6px 6px 0; }
  </style></head><body>${inner}</body></html>`;
  const promo = await context.newPage();
  await promo.setViewportSize({ width: 440, height: 280 });
  await promo.setContent(
    tile(
      440,
      280,
      `<div style="padding:30px 30px 0;display:flex;gap:18px;align-items:center"><img src="${iconUrl}" width="76" height="76" style="border-radius:18px"><div><div style="font-size:31px;font-weight:750;letter-spacing:-.5px">Feedback Lens</div><div style="font-size:16px;opacity:.9">Web-Apps testen &amp; anmerken</div></div></div>
       <div style="padding:22px 30px 0;font-size:15.5px;line-height:1.45">Probleme direkt am Element markieren – als Paket für die Entwicklung und Claude Code.</div>
       <div style="padding:16px 30px 0;font-size:12.5px"><span class="chip">Screenshot</span><span class="chip">Klickpfad</span><span class="chip">Nachtest</span><span class="chip">lokal</span></div>`,
    ),
  );
  await promo.screenshot({ path: join(PROMO, 'kachel-klein-440x280.png') });
  await promo.setViewportSize({ width: 1400, height: 560 });
  await promo.setContent(
    tile(
      1400,
      560,
      `<div style="display:grid;grid-template-columns:640px 1fr;height:100%">
        <div style="padding:70px 0 0 70px">
          <div style="display:flex;gap:22px;align-items:center"><img src="${iconUrl}" width="96" height="96" style="border-radius:22px"><div style="font-size:52px;font-weight:780;letter-spacing:-1px;white-space:nowrap">Feedback Lens</div></div>
          <div style="font-size:25px;line-height:1.4;margin-top:34px;opacity:.95">Web-Apps durchklicken, Probleme direkt am Element anmerken – und alles als sauberes Paket an die Entwicklung übergeben.</div>
          <div style="font-size:16px;margin-top:30px"><span class="chip">Screenshot &amp; Kontext</span><span class="chip">Paket für Claude Code</span><span class="chip">Nachtest</span><span class="chip">alles lokal</span></div>
        </div>
        <div style="position:relative"><img src="${shotUrl}" style="position:absolute;left:30px;top:70px;width:860px;border-radius:14px;box-shadow:0 30px 70px rgba(15,23,42,.5)"></div>
      </div>`,
    ),
  );
  await promo.screenshot({ path: join(PROMO, 'kachel-gross-1400x560.png') });
  for (const f of readdirSync(PROMO)) flatten(join(PROMO, f));
  // Edge Add-ons additionally wants a 300x300 logo.
  execFileSync('python3', [join(ROOT, 'tools/make-icons.py'), '300', join(OUT, 'edge-logo-300x300.png')]);
  console.log('✔ Werbekacheln, Edge-Logo');
} finally {
  await cleanup();
  server.close();
  rmSync(WORK, { recursive: true, force: true });
}
