// Test time: sections from start/resume to stop, breaks (no activity for more
// than 30 minutes) left out – first the calculation, then the sections the
// service worker records and what the dashboard and the export show.
import { startServer } from './server.mjs';
import { launch } from './launch.mjs';
import { fileURLToPath } from 'node:url';

const failures = [];
const check = (cond, label, detail = '') => {
  if (!cond) failures.push(`${label} → ${detail}`);
  console.log(`${cond ? '✔' : '✘'} ${label}${!cond && detail ? ` → ${detail}` : ''}`);
};

// --- the calculation -------------------------------------------------------
await import(fileURLToPath(new URL('../extension/src/shared/constants.js', import.meta.url)));
const { testTime, testTimeText } = await import(fileURLToPath(new URL('../extension/src/lib/util.js', import.meta.url)));
const T0 = Date.parse('2026-10-29T09:00:00Z');
const at = (min) => new Date(T0 + min * 60_000).toISOString();
const every = (from, to, step = 5, type = 'click') => {
  const out = [];
  for (let m = from; m <= to; m += step) out.push({ t: at(m), type });
  return out;
};
const min = (tt) => Math.round(tt.ms / 60_000);

let tt = testTime({ createdAt: at(0), endedAt: at(330), runs: [{ from: at(0), to: at(60) }, { from: at(300), to: at(330) }] }, { trail: [...every(0, 60), ...every(300, 330)] });
check(min(tt) === 90 && tt.sections.length === 2 && !tt.estimated, 'Zwei Abschnitte: nur die Abschnitte zählen (60 + 30 Min.)', JSON.stringify(tt));

tt = testTime({ createdAt: at(0), endedAt: at(180), runs: [{ from: at(0), to: at(180) }] }, { trail: [...every(0, 40), ...every(150, 180)] });
check(min(tt) === 70 && Math.round(tt.idle / 60_000) === 110, 'Leerlauf über 30 Min. im Abschnitt zählt als Pause', JSON.stringify(tt));
check(testTimeText(tt) === '1 Std. 10 Min. (ohne 1 Std. 50 Min. Pause)', 'Text: Testzeit mit Pause', testTimeText(tt));

tt = testTime({ createdAt: at(0), endedAt: at(180) }, { trail: [...every(0, 40), ...every(150, 180, 5, 'message')], annotations: [{ createdAt: at(170), updatedAt: at(180) }] });
check(min(tt) === 50 && tt.estimated, 'Meldungen der App sind keine Aktivität, Anmerkungen schon (alter Lauf: geschätzt)', JSON.stringify(tt));

tt = testTime({ createdAt: at(0), endedAt: at(24 * 60 + 60) }, { trail: [...every(0, 50), ...every(24 * 60 + 20, 24 * 60 + 60)] });
check(min(tt) === 90, 'Alter, schon fortgesetzter Lauf ohne Abschnitte: Pause über Nacht wird erkannt', String(min(tt)));

tt = testTime({ createdAt: at(0), endedAt: null, runs: [{ from: at(0), to: null }] }, { trail: every(0, 20) }, T0 + 20 * 60_000);
check(min(tt) === 20, 'Laufender Test: bis jetzt', String(min(tt)));

const full = Array.from({ length: 3000 }, (_, i) => ({ t: new Date(T0 + 120 * 60_000 + i * 1000).toISOString(), type: 'click' }));
tt = testTime({ createdAt: at(0), endedAt: at(170), runs: [{ from: at(0), to: at(170) }] }, { trail: full });
check(min(tt) === 170, 'Gekürzter Klickpfad: vor dem ersten Eintrag wird nichts als Pause gewertet', String(min(tt)));

tt = testTime({ createdAt: at(0), endedAt: at(60), runs: [{ from: at(0), to: at(60) }] }, { results: { c1: { status: 'ok', t: at(30) } } });
check(min(tt) === 60, 'Prüfpunkt-Ergebnisse zählen als Aktivität', String(min(tt)));

// --- sections recorded by the extension ------------------------------------
const PORT = 4179;
const APP = `http://localhost:${PORT}/`;
const server = await startServer(PORT);
const { context, sw, extUrl, cleanup } = await launch();
try {
  const ext = await context.newPage();
  await ext.goto(extUrl('src/popup/popup.html'));
  const send = (msg) => ext.evaluate((m) => chrome.runtime.sendMessage(m), msg);
  const sessions = () => sw.evaluate(async () => (await chrome.storage.local.get('fl:sessions'))['fl:sessions']);

  const started = await send({ type: 'fl:startSession', name: 'Dauer', url: APP });
  const sid = started.data.id;
  let s = (await sessions()).find((x) => x.id === sid);
  check(s.runs?.length === 1 && s.runs[0].from === s.createdAt && s.runs[0].to === null, 'Start öffnet den ersten Abschnitt', JSON.stringify(s.runs));
  await send({ type: 'fl:stopSession' });
  s = (await sessions()).find((x) => x.id === sid);
  check(s.runs.length === 1 && s.runs[0].to === s.endedAt, 'Beenden schließt ihn', JSON.stringify(s));
  await send({ type: 'fl:resumeSession', sessionId: sid });
  await send({ type: 'fl:resumeSession', sessionId: sid });
  s = (await sessions()).find((x) => x.id === sid);
  check(s.runs.length === 2 && s.runs[1].to === null && !s.endedAt, 'Fortsetzen öffnet einen zweiten Abschnitt (doppelt ausgelöst: nur einen)', JSON.stringify(s.runs));
  await send({ type: 'fl:startSession', name: 'Anderer', url: APP });
  s = (await sessions()).find((x) => x.id === sid);
  check(s.runs.length === 2 && s.runs[1].to === s.endedAt, 'Neuer Testlauf beendet den alten Abschnitt', JSON.stringify(s.runs));
  await send({ type: 'fl:stopSession' });

  // a run from before 1.7 (no sections), resumed the next day; plus a crafted run with a break
  const legacyId = 's_legacy';
  const craftedId = 's_crafted';
  await sw.evaluate(({ legacyId, craftedId, at, trail }) => {
    const base = { origins: ['http://localhost:4179'], appContext: '', appVersion: '', count: 0, lastNumber: 0 };
    return chrome.storage.local.get('fl:sessions').then(({ 'fl:sessions': list }) =>
      chrome.storage.local.set({
        'fl:sessions': [
          { ...base, id: legacyId, name: 'Alt', createdAt: at.a, updatedAt: at.b, endedAt: at.b },
          { ...base, id: craftedId, name: 'Mit Pause', createdAt: at.c0, updatedAt: at.c2, endedAt: at.c2, runs: [{ from: at.c0, to: at.c1 }, { from: at.c1b, to: at.c2 }] },
          ...list,
        ],
        [`fl:trail:${craftedId}`]: trail,
      }),
    );
  }, {
    legacyId,
    craftedId,
    at: { a: at(-3000), b: at(-2940), c0: at(0), c1: at(60), c1b: at(300), c2: at(400) },
    trail: [...every(0, 60), ...every(300, 330)].map((e) => ({ ...e, url: APP, label: 'x' })),
  });
  await send({ type: 'fl:resumeSession', sessionId: legacyId });
  s = (await sessions()).find((x) => x.id === legacyId);
  check(s.runs?.length === 2 && s.runs[0].from === at(-3000) && s.runs[0].to === at(-2940) && s.runs[1].to === null, 'Alter Testlauf: Fortsetzen ergänzt Start–Ende als ersten Abschnitt', JSON.stringify(s.runs));
  await send({ type: 'fl:stopSession' });

  const dash = await context.newPage();
  await dash.goto(extUrl('src/dashboard/dashboard.html'));
  await dash.locator('.session-item', { hasText: 'Mit Pause' }).click();
  await dash.waitForFunction(() => document.querySelector('.title-input')?.value === 'Mit Pause');
  const metaText = await dash.locator('.s-meta').textContent();
  const metaTitle = await dash.locator('.s-meta span', { hasText: 'Testzeit' }).getAttribute('title');
  check(metaText.includes('Testzeit 1 Std. 30 Min. (2 Abschnitte, ohne 1 Std. 10 Min. Pause)'), 'Dashboard: Testzeit mit Abschnitten und Pause', metaText);
  check(/Abschnitte:\n.+\n.+/.test(metaTitle || '') && metaTitle.includes('30 Min. ohne Aktivität'), 'Dashboard: Abschnitte im Tooltip', metaTitle);

  const exported = await dash.evaluate(async (id) => {
    const r = await import('../lib/report.js');
    const bundle = await r.loadBundle(id);
    return { md: r.buildMarkdown(bundle), json: r.buildJson(bundle) };
  }, craftedId);
  check(/- Testzeit: 1 Std\. 30 Min\. \(2 Abschnitte, ohne 1 Std\. 10 Min\. Pause\); Abschnitte: .+ – .+, .+ – .+ – Lücken über 30 Min\./.test(exported.md), 'Export: Zeile „Testzeit“ mit Abschnitten', exported.md.split('\n').find((l) => l.includes('Testzeit')));
  check(exported.json.session.testMinutes === 90 && exported.json.session.runs.length === 2, 'JSON: testMinutes und Abschnitte', JSON.stringify(exported.json.session));

  // backup round trip keeps the sections (clamped to the session)
  const imported = await dash.evaluate(async (id) => {
    const r = await import('../lib/report.js');
    const bundle = await r.loadBundle(id);
    const data = r.buildJson(bundle, { embed: true, images: new Map() });
    data.session.runs.push({ from: '2099-01-01T00:00:00Z', to: '2099-01-02T00:00:00Z' }, { from: 'kaputt' });
    const res = await chrome.runtime.sendMessage({ type: 'fl:importSession', data });
    return res.data?.meta || res;
  }, craftedId);
  check(imported?.runs?.length === 2 && imported.runs.every((x) => x.to <= imported.endedAt), 'Sicherung: Abschnitte werden übernommen, ungültige verworfen', JSON.stringify(imported?.runs));
} catch (err) {
  failures.push(String(err?.stack || err));
  console.error(err);
} finally {
  await cleanup();
  server.close();
}
console.log(failures.length ? `\n${failures.length} Prüfung(en) fehlgeschlagen` : '\nalles bestanden');
process.exit(failures.length ? 1 : 0);
