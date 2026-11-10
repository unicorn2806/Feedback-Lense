// Security checks (Paket A): only tabs of the running test run may talk to the
// extension, the page-world hooks are switched off when the run ends, a
// screenshot is discarded if the tab changed meanwhile, secrets and personal
// data are redacted before storing, "Schwärzen" burns into the saved image,
// and the company policy template really locks the extension out of domains.
import { startServer } from './server.mjs';
import { launch } from './launch.mjs';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { accessSync, constants, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.FL_OUT || '/tmp/fl-e2e-out';
mkdirSync(OUT, { recursive: true });
const PORT = 4176;
const APP = `http://localhost:${PORT}/secrets/`;
const OTHER = `http://127.0.0.1:${PORT}/secrets/`; // same server, different origin: not part of the run
const failures = [];
const check = (cond, label, detail = '') => {
  if (!cond) failures.push(`${label} → ${detail}`);
  console.log(`${cond ? '✔' : '✘'} ${label}${!cond && detail ? ` → ${detail}` : ''}`);
};

const SECRETS = ['geheim123', 'max.mustermann@firma.de', 'DE89 3704', 'DE02 1203', '4111 1111', 'sk_live_51Hx', 'eyJhbGci', 'Zq8LmP2wR5tY1uI3oK7jH6gF4dS0aQ9e', 'abcdef1234567890ghijkl', 'abc123', 'MeinGeheimesPasswort'];
const leaks = (value) => {
  const text = JSON.stringify(value);
  return SECRETS.filter((s) => text.includes(s));
};

const server = await startServer(PORT);
const { context, sw, extUrl, cleanup } = await launch();
try {
  const app = await context.newPage();
  await app.goto(APP);
  const ext = await context.newPage();
  await ext.goto(extUrl('src/popup/popup.html'));
  const send = (msg) => ext.evaluate((m) => chrome.runtime.sendMessage(m), msg);
  await send({ type: 'fl:startSession', name: 'Sicherheit', url: APP });
  await app.bringToFront();
  await app.waitForSelector('feedback-lens-ui', { state: 'attached' });
  await app.waitForTimeout(400);
  const sid = await sw.evaluate(async () => (await chrome.storage.local.get('fl:active'))['fl:active']);

  const tabId = (url) => sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id, url);
  /** Runs chrome.runtime.sendMessage in the content-script world of a tab, as an overlay would. */
  const fromTab = (id, msg, frames = false) =>
    sw.evaluate(
      async ({ id, msg, frames }) => {
        const results = await chrome.scripting.executeScript({
          target: { tabId: id, allFrames: frames },
          func: (m) => chrome.runtime.sendMessage(m),
          args: [msg],
        });
        return results.map((r) => ({ frameId: r.frameId, res: r.result }));
      },
      { id, msg, frames },
    );

  // --- only tabs of the running test run --------------------------------
  const other = await context.newPage();
  await other.goto(OTHER);
  const otherId = await tabId(`${OTHER}*`);
  const appId = await tabId(`${APP}*`);
  const annotation = { kind: 'page', title: 'Gefälscht', description: 'von einer fremden Seite', page: { url: OTHER, title: 'x' } };
  const attempts = {
    'fl:saveAnnotation': { sessionId: sid, annotation },
    'fl:updateAnnotation': { sessionId: sid, id: 'a1', patch: { title: 'x' } },
    'fl:trail': { sessionId: sid, entries: [{ t: new Date().toISOString(), type: 'click', label: 'Fremd' }] },
    'fl:tech': { sessionId: sid, events: [{ type: 'console', level: 'error', message: 'Fremd' }] },
    'fl:capture': {},
    'fl:saveUi': { patch: { retestOpen: true } },
    'fl:openDashboard': {},
    'fl:dictation': { action: 'start' },
  };
  const rejected = [];
  for (const [type, payload] of Object.entries(attempts)) {
    const [{ res }] = await fromTab(otherId, { type, ...payload });
    if (res && res.ok === false && /gehört nicht zum laufenden Testlauf/.test(res.error)) rejected.push(type);
  }
  check(rejected.length === Object.keys(attempts).length, 'Fremde Domain: alle Aktionen abgelehnt', `abgelehnt: ${rejected.join(', ')}`);
  const [{ res: state }] = await fromTab(otherId, { type: 'fl:getState', url: OTHER });
  check(state?.ok && state.data.inSession === false && state.data.annotations.length === 0, 'Fremde Domain: getState verrät keine Anmerkungen', JSON.stringify(state).slice(0, 200));

  const [{ res: forged }] = await fromTab(appId, { type: 'fl:saveAnnotation', sessionId: 'erfunden', annotation });
  check(forged?.ok === false, 'Eigene Domain, aber fremde Testlauf-ID: abgelehnt', JSON.stringify(forged));
  const inFrame = (await fromTab(appId, { type: 'fl:trail', sessionId: sid, entries: [] }, true)).find((r) => r.frameId !== 0);
  check(inFrame?.res?.ok === false, 'Eingebetteter Frame (auch gleiche Domain): abgelehnt', JSON.stringify(inFrame));
  const frameState = (await fromTab(appId, { type: 'fl:getState', url: APP }, true)).find((r) => r.frameId !== 0);
  check(frameState?.res?.ok && frameState.res.data.inSession === false, 'getState aus einem Frame: keine Daten (auch nicht mit fremder URL im Auftrag)', JSON.stringify(frameState).slice(0, 160));
  const [{ res: dashForged }] = await fromTab(appId, { type: 'fl:openDashboard', sessionId: 'fremd' });
  check(dashForged?.ok === false, 'Dashboard aus der Seite für einen fremden Testlauf: abgelehnt', JSON.stringify(dashForged));
  const dashRes = await fromTab(appId, { type: 'fl:openDashboard', exportZip: true });
  const dash = await sw.evaluate(async () => {
    const base = chrome.runtime.getURL('src/dashboard/dashboard.html');
    for (let i = 0; i < 50; i++) {
      // (tabs.query does not show the URLs of extension pages; getContexts does)
      const ctx = (await chrome.runtime.getContexts({ contextTypes: ['TAB'] })).find((c) => c.documentUrl?.startsWith(base));
      if (ctx) {
        await chrome.tabs.remove(ctx.tabId);
        return ctx.documentUrl;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  });
  check(dash && dash.includes(`session=${sid}`) && !dash.includes('export'), 'Dashboard aus der Seite: nur eigener Testlauf, kein Export', `${dash} ${JSON.stringify(dashRes)}`);
  const stored = await sw.evaluate(async (sid) => (await chrome.storage.local.get(`fl:ann:${sid}`))[`fl:ann:${sid}`] || [], sid);
  check(stored.length === 0, 'Nichts von fremden Seiten gespeichert', String(stored.length));
  await other.close();

  // --- screenshot only of the tab that asked for it ------------------------
  await app.bringToFront();
  const swapped = await sw.evaluate(async ({ appId, OTHER }) => {
    const helper = await chrome.tabs.create({ url: OTHER, active: false });
    const original = chrome.tabs.captureVisibleTab;
    // simulates a tab switch that happens while the image is taken
    chrome.tabs.captureVisibleTab = async (...args) => {
      const image = await original.apply(chrome.tabs, args);
      await chrome.tabs.update(helper.id, { active: true });
      return image;
    };
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId: appId }, func: () => chrome.runtime.sendMessage({ type: 'fl:capture' }) });
      return r.result;
    } finally {
      chrome.tabs.captureVisibleTab = original;
      await chrome.tabs.update(appId, { active: true });
      await chrome.tabs.remove(helper.id);
    }
  }, { appId, OTHER });
  check(swapped?.ok === false && /Tab gewechselt/.test(swapped.error), 'Tab-Wechsel während des Screenshots: Bild verworfen', JSON.stringify(swapped).slice(0, 160));
  const background = await sw.evaluate(async ({ appId }) => {
    const front = await chrome.tabs.create({ url: 'about:blank', active: true });
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId: appId }, func: () => chrome.runtime.sendMessage({ type: 'fl:capture' }) });
      return r.result;
    } finally {
      await chrome.tabs.remove(front.id);
      await chrome.tabs.update(appId, { active: true });
    }
  }, { appId });
  check(background?.ok === false && /nicht mehr im Vordergrund/.test(background.error), 'Tab im Hintergrund: kein Screenshot', JSON.stringify(background).slice(0, 160));
  await app.bringToFront();
  await app.waitForTimeout(600); // captureVisibleTab rate limit

  // --- redaction --------------------------------------------------------------
  const command = (action) =>
    sw.evaluate(async ({ action, appId }) => chrome.tabs.sendMessage(appId, { type: 'fl:command', action }), { action, appId });
  await app.selectOption('#konto', { index: 1 });
  await app.fill('#note', 'MeinGeheimesPasswort');
  await app.locator('#note').dispatchEvent('change');
  await app.click('#note');
  await app.fill('#msgbox', 'Vertraulicher Entwurf an Max');
  await app.click('#msgbox');
  await app.locator('#editor').click();
  await app.keyboard.type('Geheime Notiz im Editor');
  await app.locator('#editor').click();
  await app.click('.gear');
  await app.click('#load');
  await app.waitForSelector('[role=alert]');
  await app.waitForTimeout(800);

  await command('pick');
  const card = await app.locator('#card').boundingBox();
  await app.mouse.move(card.x + card.width - 30, card.y + 8);
  await app.mouse.click(card.x + card.width - 30, card.y + 8);
  await app.locator('.drawer textarea').first().waitFor();
  const target = await app.locator('.drawer .d-target').textContent();
  check(/div#card/.test(target), 'Karte mit Geheimnissen markiert', target);
  await app.locator('.drawer textarea').first().fill('Kontodaten werden vollständig angezeigt.');
  await app.locator('.drawer .btn.primary').click();
  await app.locator('.drawer').waitFor({ state: 'detached' });
  await app.waitForTimeout(2000); // trail/tech flush

  let data = await sw.evaluate(() => chrome.storage.local.get(null));
  const ann = (data[`fl:ann:${sid}`] || [])[0];
  const trail = data[`fl:trail:${sid}`] || [];
  const tech = data[`fl:tech:${sid}`] || [];
  check(ann?.element, 'Anmerkung mit Element-Kontext gespeichert');
  const leaked = leaks({ element: ann?.element, page: ann?.page, techEvents: ann?.techEvents, trail, tech });
  check(leaked.length === 0, 'Keine Geheimnisse in HTML, Texten, Meldungen, Konsole, Fehlerantwort und Klickpfad', leaked.join(', '));
  const all = JSON.stringify({ ann, trail, tech });
  for (const marker of ['[E-Mail entfernt]', '[IBAN entfernt]', '[Kartennummer entfernt]', '[Schlüssel entfernt]', 'password: ***']) {
    check(all.includes(marker), `Ersetzt durch „${marker}“`);
  }
  check(/data-api-token="\*\*\*"/.test(ann?.element?.html || ''), 'Sensibles Attribut (data-api-token) im HTML maskiert', (ann?.element?.html || '').slice(0, 200));
  const body = [...tech, ...(ann?.techEvents || [])].find((e) => e.type === 'network' && e.method === 'POST')?.body || '';
  check(body.includes('invalid credentials') && body.includes('"access_token":"***"'), 'Fehlerantwort: Hinweis bleibt, Token maskiert', `${body} | ${JSON.stringify(tech.filter((e) => e.type === 'network'))}`);
  check(trail.some((e) => e.type === 'input' && e.detail === 'Option 2 von 3 gewählt'), 'Auswahlliste: nur Position der Option, nicht ihr Text', JSON.stringify(trail.filter((e) => e.type === 'input')));
  const fieldClick = trail.find((e) => e.type === 'click' && e.role === 'textbox' && !/Nachricht/.test(e.label || ''));
  check(fieldClick && !fieldClick.label, 'Klick ins Textfeld: getippter Wert nicht als Beschriftung', JSON.stringify(fieldClick));
  const typedLabels = trail.filter((e) => /Vertraulicher Entwurf|Geheime Notiz/.test(e.label || ''));
  check(typedLabels.length === 0, 'Klick in Textbereich und Editor: getippter Text nicht als Beschriftung', JSON.stringify(typedLabels));
  check(trail.some((e) => e.type === 'click' && e.label === 'Nachricht an den Support'), 'Textbereich stattdessen über seinen Platzhalter beschriftet', JSON.stringify(trail.filter((e) => e.type === 'click').map((e) => e.label)));
  const gear = trail.find((e) => e.type === 'click' && /Einstellungen für/.test(e.label || ''));
  check(gear && gear.label.includes('[E-Mail entfernt]') && gear.selector && !/firma/.test(gear.selector), 'Selektor ohne E-Mail aus dem aria-label', JSON.stringify(gear));
  const allTech = [...tech, ...(ann?.techEvents || [])];
  check(allTech.some((e) => e.message === 'at useAuth (http://localhost:4176/src/hooks/useAuth.ts:12:5)'), 'Stack-Zeile mit „Auth“ im Dateinamen bleibt vollständig', allTech.map((e) => e.message).join(' | ').slice(0, 300));
  check(allTech.some((e) => (e.message || '').includes('tokenExpiry: 3600') && e.message.includes('sessionTimeout: 1800')), 'Konfigurationswerte (tokenExpiry, sessionTimeout) bleiben');
  const xhrEvents = tech.filter((e) => e.type === 'network' && (e.requestUrl || '').includes('xhr=1'));
  check(xhrEvents.length === 2 && xhrEvents.every((e) => e.status === 401 && e.body?.includes('invalid credentials')), 'Wiederverwendetes XHR: jede Anfrage genau einmal und mit richtigem Status gemeldet', JSON.stringify(xhrEvents.map((e) => [e.status, e.statusText])));
  check((ann?.page?.title || '').includes('[E-Mail entfernt]'), 'Seitentitel geschwärzt', ann?.page?.title);
  const link = (ann?.element?.html || '').match(/href="([^"]*)"/)?.[1] || '';
  check(link.includes('token=***') && !link.includes('eyJ'), 'Adresse im HTML: Token im Pfad und Parameter maskiert', link);

  // --- stripUrlQuery -----------------------------------------------------------------
  await send({ type: 'fl:saveSettings', patch: { stripUrlQuery: true } });
  await app.waitForTimeout(400);
  await app.evaluate(() => history.pushState({}, '', '/secrets/liste?kunde=4711&q=max#/detail?tab=2'));
  await app.waitForTimeout(1200);
  await command('note');
  await app.locator('.drawer textarea').first().waitFor();
  await app.locator('.drawer textarea').first().fill('Seite ohne Parameter');

  // --- Schwärzen: drag a box on the preview, check the stored image ------------------
  await app.locator('.drawer .shot-bar button[aria-label="Schwärzen"]').click();
  const canvas = await app.locator('.drawer canvas.preview').boundingBox();
  const box = { x0: 0.2, y0: 0.2, x1: 0.5, y1: 0.45 };
  await app.mouse.move(canvas.x + canvas.width * box.x0, canvas.y + canvas.height * box.y0);
  await app.mouse.down();
  await app.mouse.move(canvas.x + canvas.width * box.x1, canvas.y + canvas.height * box.y1, { steps: 6 });
  await app.mouse.up();
  await app.mouse.click(canvas.x + canvas.width * 0.8, canvas.y + canvas.height * 0.8); // a click is no box
  await app.screenshot({ path: join(OUT, 'security-1-redact.png') });
  await app.locator('.drawer .btn.primary').click();
  await app.locator('.drawer').waitFor({ state: 'detached' });
  await app.waitForTimeout(1500);

  data = await sw.evaluate(() => chrome.storage.local.get(null));
  const note = (data[`fl:ann:${sid}`] || []).find((a) => a.kind === 'page');
  check(note && !note.page.url.includes('?') && note.page.url.endsWith('/secrets/liste#/detail'), 'Alle URL-Parameter entfernt (auch im Hash)', note?.page?.url);
  const route = (data[`fl:trail:${sid}`] || []).filter((e) => e.type === 'route').pop();
  check(route && !route.url.includes('?'), 'Klickpfad: Adresse ohne Parameter', route?.url);
  check(note?.images?.redacted === true && note.images.drawn === false, 'Bild als geschwärzt gekennzeichnet (keine Markierung)', JSON.stringify(note?.images));
  const pixels = await ext.evaluate(
    async ({ src, box }) => {
      const img = await createImageBitmap(await (await fetch(src)).blob());
      const c = new OffscreenCanvas(img.width, img.height);
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const at = (fx, fy) => Array.from(ctx.getImageData(Math.round(img.width * fx), Math.round(img.height * fy), 1, 1).data.slice(0, 3));
      return { inside: [at((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2), at(box.x0 + 0.02, box.y0 + 0.02), at(box.x1 - 0.02, box.y1 - 0.02)], outside: at(0.8, 0.8) };
    },
    { src: data[`fl:img:${note?.id}:full`], box },
  );
  check(pixels.inside.every((p) => p.every((v) => v < 16)), 'Geschwärzte Fläche im gespeicherten Bild schwarz', JSON.stringify(pixels.inside));
  check(pixels.outside.some((v) => v > 200), 'Rest des Bildes unverändert', JSON.stringify(pixels.outside));
  await send({ type: 'fl:saveSettings', patch: { stripUrlQuery: false } });

  // --- hooks off when the run ends, back on when it resumes ---------------------
  await app.evaluate(() => {
    // the page wraps replaceState itself after us: that wrapper must survive
    const ours = history.replaceState;
    window.__pageWrapper = function (...args) {
      window.__pageWrapperCalls = (window.__pageWrapperCalls || 0) + 1;
      return ours.apply(this, args);
    };
    history.replaceState = window.__pageWrapper;
  });
  const hooks = () =>
    app.evaluate(() => {
      const native = (fn) => Function.prototype.toString.call(fn).includes('[native code]');
      return {
        flag: Boolean(window[Symbol.for('feedback-lens.hooks')]),
        fetch: native(window.fetch),
        consoleError: native(console.error),
        xhrOpen: native(XMLHttpRequest.prototype.open),
        xhrSend: native(XMLHttpRequest.prototype.send),
        pushState: native(history.pushState),
        pageWrapperKept: history.replaceState === window.__pageWrapper,
      };
    });
  const before = await hooks();
  check(before.flag && !before.fetch && !before.consoleError && !before.pushState, 'Während des Testlaufs: Hooks aktiv', JSON.stringify(before));
  await command('pick'); // ending the run while picking must not leave listeners in the iframe
  await app.waitForTimeout(200);
  await send({ type: 'fl:stopSession' });
  await app.waitForSelector('feedback-lens-ui', { state: 'detached' });
  await app.waitForTimeout(300);
  await app.frameLocator('#frame').locator('#framebtn').click();
  check((await app.evaluate(() => window.__frameClicks)) === 1, 'Beenden während der Elementauswahl: Klicks im iframe kommen wieder bei der Seite an');
  const after = await hooks();
  check(!after.flag && after.fetch && after.consoleError && after.xhrOpen && after.xhrSend && after.pushState, 'Nach dem Beenden: Originalfunktionen wiederhergestellt', JSON.stringify(after));
  check(after.pageWrapperKept, 'Eigener Wrapper der Seite bleibt erhalten', JSON.stringify(after));
  const silent = await app.evaluate(async () => {
    const seen = [];
    document.addEventListener('__fl_from_page', (e) => seen.push(e.detail));
    document.dispatchEvent(new CustomEvent('__fl_to_page', { detail: JSON.stringify({ kind: 'hello' }) }));
    console.error('nach dem Ende');
    history.replaceState({}, '', location.href);
    await fetch('/api/secret-fail', { method: 'POST' }).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 300));
    return { seen, wrapperWorks: window.__pageWrapperCalls > 0 };
  });
  check(silent.seen.length === 0, 'Nach dem Beenden: Hooks schweigen (kein Replay, keine Ereignisse)', JSON.stringify(silent.seen).slice(0, 200));
  check(silent.wrapperWorks, 'Seite funktioniert weiter (Wrapper, fetch)');

  await send({ type: 'fl:resumeSession', sessionId: sid });
  await app.waitForSelector('feedback-lens-ui', { state: 'attached' });
  await app.waitForTimeout(300);
  const resumed = await hooks();
  check(resumed.flag && !resumed.fetch && !resumed.consoleError, 'Fortsetzen: Hooks neu installiert', JSON.stringify(resumed));
  await app.evaluate(() => console.error('nach dem Fortsetzen'));
  await app.waitForTimeout(1900);
  const techAfter = await sw.evaluate(async (sid) => (await chrome.storage.local.get(`fl:tech:${sid}`))[`fl:tech:${sid}`] || [], sid);
  check(techAfter.some((e) => e.message === 'nach dem Fortsetzen') && !techAfter.some((e) => e.message === 'nach dem Ende'), 'Erfasst wird nur, während der Testlauf läuft', techAfter.map((e) => e.message).join(' | '));

  // --- Re-test of a page whose address was redacted ----------------------------------
  const PERSONAL = `${APP}kunde/max.mustermann@firma.de/`;
  await app.goto(PERSONAL);
  await app.waitForSelector('feedback-lens-ui', { state: 'attached' });
  await app.waitForTimeout(500);
  await command('note');
  await app.locator('.drawer textarea').first().waitFor();
  await app.locator('.drawer textarea').first().fill('Kundenseite');
  await app.locator('.drawer .btn.primary').click();
  await app.locator('.drawer').waitFor({ state: 'detached' });
  await app.waitForTimeout(400);
  data = await sw.evaluate(() => chrome.storage.local.get(null));
  const personal = (data[`fl:ann:${sid}`] || []).find((a) => a.description === 'Kundenseite');
  check(personal?.page?.url.endsWith('/secrets/kunde/***/'), 'E-Mail im Pfad gespeichert als ***', personal?.page?.url);
  await send({ type: 'fl:stopSession' });
  await app.waitForSelector('feedback-lens-ui', { state: 'detached' });
  const retest = await send({ type: 'fl:startRetest', baseSessionId: sid, url: PERSONAL });
  check(retest?.ok, 'Nachtest gestartet', JSON.stringify(retest).slice(0, 200));
  const plan = await sw.evaluate(async (id) => (await chrome.storage.local.get(`fl:plan:${id}`))[`fl:plan:${id}`] || [], retest?.data?.id);
  const blackedOut = plan.find((p) => p.description === 'Seite ohne Parameter');
  check(blackedOut?.images?.redacted === true && blackedOut.images.full === true, 'Nachtest-Plan behält die Kennzeichnung „geschwärzt“', JSON.stringify(blackedOut?.images));
  await send({ type: 'fl:saveUi', patch: { retestOpen: true, retestFocus: personal?.number, retestCollapsed: false } });
  await app.reload();
  await app.waitForSelector('feedback-lens-ui', { state: 'attached' });
  await app.locator('.rt-item.sel').waitFor({ timeout: 5000 });
  const here = await app.locator('.rt-item.sel').textContent();
  check(/richtigen Seite/.test(here), 'Nachtest erkennt die Seite trotz geschwärzter Adresse', here.slice(0, 200));
  await app.goto(APP);
  await app.waitForSelector('feedback-lens-ui', { state: 'attached' });
  await app.locator('.rt-item.sel').waitFor({ timeout: 5000 });
  const away = await app.locator('.rt-item.sel').textContent();
  check(/geschwärzte Teile/.test(away), 'Von anderer Seite: Hinweis auf geschwärzte Adresse', away.slice(0, 200));
  await app.locator('.rt-item.sel .rt-where button', { hasText: 'Seite öffnen' }).click();
  await app.waitForURL(/\/secrets\/kunde\/$/, { timeout: 5000 }).catch(() => {});
  check(app.url().endsWith('/secrets/kunde/'), '„Seite öffnen“ führt bis zum geschwärzten Teil', app.url());
} catch (err) {
  failures.push(String(err?.stack || err));
  console.error(err);
} finally {
  await cleanup();
}

// --- Company policy template: ExtensionSettings / runtime_blocked_hosts -------------
// Needs a writable managed-policy directory (root on Linux); skipped otherwise.
// Playwright's "Chrome for Testing" reads its own directory, Chromium and Chrome theirs.
const POLICY_DIRS = (process.env.FL_POLICY_DIR ? [process.env.FL_POLICY_DIR] : ['/etc/opt/chrome_for_testing/policies/managed', '/etc/chromium/policies/managed', '/etc/opt/chrome/policies/managed']).filter((dir) => {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
});
if (!POLICY_DIRS.length) console.log('– Richtlinien-Test übersprungen (kein beschreibbares Richtlinien-Verzeichnis, Root nötig)');
else {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const id = [...createHash('sha256').update(der).digest('hex').slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
  const policyFiles = POLICY_DIRS.map((dir) => join(dir, 'zz-feedback-lens-test.json'));
  // as in UNTERNEHMEN.md: block everything, allow the test systems
  for (const file of policyFiles) writeFileSync(file, JSON.stringify({ ExtensionSettings: { [id]: { runtime_blocked_hosts: ['*://*'], runtime_allowed_hosts: ['*://127.0.0.1'] } } }));
  const run = await launch({ manifestPatch: { key: der.toString('base64') } }).catch((err) => ({ err }));
  try {
    if (run.err) throw run.err;
    check(run.extensionId === id, 'Richtlinie: Erweiterungs-ID wie berechnet', `${run.extensionId} vs ${id}`);
    const blocked = await run.context.newPage();
    await blocked.goto(APP);
    const allowed = await run.context.newPage();
    await allowed.goto(OTHER);
    const ext = await run.context.newPage();
    await ext.goto(run.extUrl('src/popup/popup.html'));
    const start = (url) => ext.evaluate((url) => chrome.runtime.sendMessage({ type: 'fl:startSession', name: 'Richtlinie', url }), url);
    const denied = await start(APP);
    check(denied?.ok === false && /Richtlinie/.test(denied.error), 'Gesperrte Domain: Start mit klarer Meldung abgelehnt', JSON.stringify(denied));
    const blockedTab = await run.sw.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url?.startsWith('http://localhost:4176/'))?.id);
    const quickDenied = await ext.evaluate((tabId) => chrome.runtime.sendMessage({ type: 'fl:quick', action: 'pick', tabId }), blockedTab);
    check(quickDenied?.ok === false && /Richtlinie/.test(quickDenied.error), 'Gesperrte Domain: auch keine Schnell-Anmerkung', JSON.stringify(quickDenied));
    const ok = await start(OTHER);
    check(ok?.ok === true, 'Freigegebene Domain: Testlauf startet', JSON.stringify(ok));
    await allowed.bringToFront();
    await allowed.waitForSelector('feedback-lens-ui', { state: 'attached', timeout: 5000 });
    check(true, 'Freigegebene Domain: Overlay geladen');
    const capture = await run.sw.evaluate(async () => {
      const tab = (await chrome.tabs.query({})).find((t) => t.url?.startsWith('http://localhost:4176/'));
      await chrome.tabs.update(tab.id, { active: true });
      try {
        await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        return 'captured';
      } catch (err) {
        return err.message;
      }
    });
    check(capture !== 'captured', 'Gesperrte Domain: auch kein Screenshot möglich', capture);

    // re-test from the dashboard with a typed address: the tab is created only then
    await run.sw.evaluate(async () => {
      const tab = (await chrome.tabs.query({})).find((t) => t.url?.startsWith('http://127.0.0.1:4176/'));
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.tabs.sendMessage(tab.id, { type: 'fl:command', action: 'note' });
    });
    await allowed.bringToFront();
    await allowed.locator('.drawer textarea').first().waitFor();
    await allowed.locator('.drawer textarea').first().fill('Notiz für den Nachtest');
    await allowed.locator('.drawer .btn.primary').click();
    await allowed.locator('.drawer').waitFor({ state: 'detached' });
    await ext.evaluate(() => chrome.runtime.sendMessage({ type: 'fl:stopSession' }));
    await blocked.close();
    const viaDashboard = await ext.evaluate(({ url, base }) => chrome.runtime.sendMessage({ type: 'fl:startRetest', baseSessionId: base, url, openTab: true }), { url: APP, base: ok.data.id });
    check(viaDashboard?.ok === false && /Richtlinie/.test(viaDashboard.error), 'Nachtest mit eingetippter gesperrter Adresse: abgelehnt', JSON.stringify(viaDashboard).slice(0, 200));
    const left = await run.sw.evaluate(async () => (await chrome.storage.local.get('fl:sessions'))['fl:sessions'] || []);
    check(!left.some((s) => s.retestOf) && !(await run.sw.evaluate(async () => (await chrome.storage.local.get('fl:active'))['fl:active'])), 'Kein halber Nachtest zurückgeblieben', JSON.stringify(left.map((s) => s.name)));
  } catch (err) {
    failures.push(`Richtlinien-Test: ${err?.stack || err}`);
    console.error(err);
  } finally {
    await run.cleanup?.();
    for (const file of policyFiles) rmSync(file, { force: true });
  }
}

server.close();
console.log(failures.length ? `\n${failures.length} Prüfung(en) fehlgeschlagen` : '\nAlle Sicherheitsprüfungen bestanden');
process.exit(failures.length ? 1 : 0);
