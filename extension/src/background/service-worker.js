// Feedback Lens service worker: owns all writes to chrome.storage (serialized),
// manages test sessions, registers the in-page scripts for the origins under
// test, takes screenshots and routes keyboard commands.
import { C, uid, nowIso, originOf, matchPatternFor, isInjectableUrl, formatDateTime } from '../lib/util.js';
import '../shared/sanitize.js';
import { loadBundle, retestPlan } from '../lib/report.js';

const K = C.KEYS;
const S = globalThis.FL_SAN;
const HOOK_FILES = ['src/content/page-hooks.js'];
const OVERLAY_FILES = ['src/shared/constants.js', 'src/shared/sanitize.js', 'src/shared/marks.js', 'src/content/context.js', 'src/content/overlay.js'];
const DASHBOARD = 'src/dashboard/dashboard.html';

// Content scripts run inside the tested (untrusted) pages. They get what they
// need through messages; the storage itself is only readable by the
// extension's own pages and this worker.
chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })?.catch(() => {});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

async function get(key, fallback) {
  const result = await chrome.storage.local.get(key);
  return result[key] === undefined ? fallback : result[key];
}

const set = (items) => chrome.storage.local.set(items);
const remove = (keys) => chrome.storage.local.remove(keys);

// Every read-modify-write goes through this queue so concurrent messages from
// several tabs cannot overwrite each other.
let queue = Promise.resolve();
function locked(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function getSettings() {
  return { ...C.DEFAULT_SETTINGS, ...(await get(K.settings, {})) };
}

const getSessions = () => get(K.sessions, []);

/** Storage keys of all screenshots of an annotation: crop, full view and the further ones (x1 …). */
const imageKeys = (a) => [K.img(a.id, 'crop'), K.img(a.id, 'full'), ...(a.images?.extra || []).filter((x) => x.id).map((x) => K.img(a.id, x.id))];

/**
 * Adds further screenshots to an annotation (in place) and returns the
 * storage writes. images: [{ dataUrl, meta }] – meta as S.extraImage.
 */
function addExtras(a, images, writes) {
  const extra = [...(a.images?.extra || [])];
  let next = Math.max(0, ...extra.map((x) => Number(x.id?.slice(1)) || 0)) + 1;
  for (const img of images) {
    if (extra.length >= C.LIMITS.extraImages) break;
    if (!S.isImage(img?.dataUrl)) continue;
    const meta = S.extraImage(img.meta || {}) || { caption: '', kind: 'page', clicks: [], numbers: [] };
    const id = `x${next++}`;
    writes[K.img(a.id, id)] = img.dataUrl;
    extra.push({ ...meta, id });
  }
  a.images = { ...a.images, extra };
  return extra.length;
}

async function getActiveSession() {
  const activeId = await get(K.active, null);
  if (!activeId) return null;
  const sessions = await getSessions();
  return sessions.find((s) => s.id === activeId) || null;
}

async function sessionExists(sid) {
  return (await getSessions()).some((s) => s.id === sid);
}

async function patchSession(sid, patch) {
  const sessions = await getSessions();
  const idx = sessions.findIndex((s) => s.id === sid);
  if (idx < 0) throw new Error('Testlauf nicht gefunden.');
  sessions[idx] = { ...sessions[idx], ...patch, updatedAt: nowIso() };
  await set({ [K.sessions]: sessions });
  return sessions[idx];
}

// ---------------------------------------------------------------------------
// Script registration: the overlay only exists on the origins under test.
// ---------------------------------------------------------------------------

let registration = Promise.resolve();
/** Serialized: concurrent runs would race between unregister and register. */
function syncRegistration() {
  const run = registration.then(doSyncRegistration, doSyncRegistration);
  registration = run.catch((e) => console.warn('[Feedback Lens] registration', e));
  return run;
}

async function doSyncRegistration() {
  const active = await getActiveSession();
  const registered = await chrome.scripting.getRegisteredContentScripts();
  const ours = registered.map((s) => s.id).filter((id) => id.startsWith('fl-'));
  if (ours.length) await chrome.scripting.unregisterContentScripts({ ids: ours });
  const origins = (active?.origins || []).filter((o) => originOf(o.endsWith('/') ? o : `${o}/`) === o);
  if (!origins.length) return;
  const matches = origins.map(matchPatternFor);
  await chrome.scripting.registerContentScripts([
    { id: 'fl-hooks', matches, js: HOOK_FILES, runAt: 'document_start', world: 'MAIN', allFrames: false, persistAcrossSessions: true },
    { id: 'fl-overlay', matches, js: OVERLAY_FILES, runAt: 'document_idle', allFrames: false, persistAcrossSessions: true },
  ]);
}

/** The promise's result – or `fallback` once `ms` have passed (the promise itself keeps running). */
function within(promise, ms, fallback) {
  let timer;
  const late = new Promise((resolve) => (timer = setTimeout(() => resolve(fallback), ms)));
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// Scripts reach a page only when it can run them: a page that is still loading,
// busy or showing a dialog (alert, confirm, "Leave site?") makes us wait – so
// nothing a user waits for may depend on it.

/** true: overlay there, false: none, null: no answer in time (page busy, e.g. a dialog is open). */
const ping = (tabId) => within(chrome.tabs.sendMessage(tabId, { type: 'fl:ping' }).then((r) => r === true, () => false), 1000, null);

const injecting = new Set();
/** Injects the overlay unless a live one is already there (it would lose unsaved input). */
async function injectIntoTab(tabId, attempt = 0) {
  if (injecting.has(tabId)) return;
  injecting.add(tabId);
  try {
    const alive = await ping(tabId);
    if (alive === null) {
      // busy: try again a little later (and whenever the tab comes to the front)
      if (attempt < 10) setTimeout(() => injectIntoTab(tabId, attempt + 1), 3000);
      return;
    }
    if (alive) {
      chrome.tabs.sendMessage(tabId, { type: 'fl:changed' }).catch(() => {});
      return;
    }
    const target = { tabId };
    await within(chrome.scripting.executeScript({ target, files: HOOK_FILES, world: 'MAIN', injectImmediately: true }).catch(() => {}), 5000);
    await within(chrome.scripting.executeScript({ target, files: OVERLAY_FILES }).catch(() => {}), 30_000);
  } finally {
    injecting.delete(tabId);
  }
}

async function injectIntoSessionTabs() {
  const active = await getActiveSession();
  if (!active?.origins.length) return;
  const tabs = await chrome.tabs.query({ url: active.origins.map(matchPatternFor) }).catch(() => []);
  await Promise.all(tabs.map((tab) => injectIntoTab(tab.id)));
}

// A tab of the run that was busy at the start gets its overlay when it comes to the front.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && (await tabInSession(tab))) injectIntoTab(tabId);
});

// Overlays learn about changes through a small message instead of
// storage.onChanged (which would ship whole annotation lists and images into
// every tested page).
let notifyTimer = null;
function notifyTabs() {
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(async () => {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*', 'file:///*'] }).catch(() => []);
    for (const tab of tabs) chrome.tabs.sendMessage(tab.id, { type: 'fl:changed' }).catch(() => {});
  }, 60);
}

async function refreshBadge() {
  const active = await getActiveSession();
  await chrome.action.setBadgeBackgroundColor({ color: '#4f46e5' });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  await chrome.action.setBadgeText({ text: active ? String(active.count || '●') : '' });
  await chrome.action.setTitle({
    title: active ? `Feedback Lens – Testlauf „${active.name}“ (${active.count} Anmerkungen)` : 'Feedback Lens',
  });
}

/** After any change to sessions or settings: scripts, badge, open overlays. */
async function afterChange({ registration: reg = false, inject = false } = {}) {
  if (reg) await syncRegistration();
  // not awaited: the popup closes right away, the toolbar appears as soon as each page can take it
  if (inject) injectIntoSessionTabs().catch(() => {});
  await refreshBadge();
  notifyTabs();
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function newSessionMeta({ name, origins, appContext = '', appVersion = '' }) {
  const now = nowIso();
  return {
    id: uid('s'),
    name: name || 'Testlauf',
    origins,
    appContext,
    appVersion,
    createdAt: now,
    updatedAt: now,
    endedAt: null,
    // sections of actual testing: start or resume → stop (the test time leaves out the pauses)
    runs: [{ from: now, to: null }],
    count: 0,
    lastNumber: 0,
  };
}

/** The session stopped at `now`: its open section is closed. A pause is kept only when asked for. */
function ended(s, now, { pause = false } = {}) {
  const runs = Array.isArray(s.runs) && s.runs.length ? s.runs.map((r) => (r.to ? r : { ...r, to: now })) : s.runs;
  return { ...s, endedAt: now, updatedAt: now, runs, pausedAt: pause ? now : null };
}

async function checkFileAccess(url) {
  if (originOf(url) !== 'file://') return;
  const allowed = await chrome.extension.isAllowedFileSchemeAccess();
  if (!allowed) {
    throw new Error('Für lokale Dateien bitte unter chrome://extensions → Feedback Lens → Details „Zugriff auf Datei-URLs zulassen“ aktivieren.');
  }
}

/** Ends the running session (if any) and makes the new one active. Call inside locked(). */
async function activateNewSession(session, extra = {}) {
  const sessions = await getSessions();
  const now = nowIso();
  const previous = await get(K.active, null);
  if (previous) {
    const i = sessions.findIndex((s) => s.id === previous);
    if (i >= 0) sessions[i] = ended(sessions[i], now);
  }
  sessions.unshift(session);
  await set({
    ...extra,
    [K.sessions]: sessions,
    [K.active]: session.id,
    [K.ann(session.id)]: [],
    [K.trail(session.id)]: [],
    [K.tech(session.id)]: [],
  });
  return session;
}

async function checkStartUrl(url, tabId) {
  const origin = originOf(url);
  if (!origin || !isInjectableUrl(url)) throw new Error('Auf dieser Seite kann kein Testlauf gestartet werden.');
  await checkFileAccess(url);
  await checkPolicy(origin, tabId);
  return origin;
}

/** Company policy (ExtensionSettings → runtime_blocked_hosts) can lock the extension out of a domain. */
const POLICY_BLOCKED = 'Diese Domain ist für Feedback Lens durch eine Richtlinie deines Unternehmens gesperrt. Freigegebene Domains legt die IT fest (siehe „Einsatz im Unternehmen“ in der Anleitung).';

// The browser refuses a blocked host at once; a page that does not answer quickly is not blocked, just busy.
const policyBlocks = (tabId) =>
  within(
    chrome.scripting.executeScript({ target: { tabId }, func: () => true, injectImmediately: true }).then(
      () => false,
      (err) => /policy/i.test(err?.message || ''),
    ),
    1500,
    false,
  );

/** Checks a tab of the origin – preferably the one the run is started from – if there is one. */
async function checkPolicy(origin, tabId) {
  // (a query by URL pattern would leave out exactly the blocked tabs)
  const tabs = (await chrome.tabs.query({}).catch(() => [])).filter((t) => originOf(t.url || '') === origin);
  const tab = tabs.find((t) => t.id === tabId) || tabs.find((t) => t.active) || tabs[0];
  if (tab && (await policyBlocks(tab.id))) throw new Error(POLICY_BLOCKED);
}

/** Waits until a new tab shows a page of `origin` (navigation committed, not loaded), at most a few seconds. */
function tabOnOrigin(tabId, origin, timeout = 5000) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const check = (t) => originOf(t?.url || '') === origin && done();
    const listener = (id, info, t) => id === tabId && check(t);
    const timer = setTimeout(done, timeout);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(check, done);
  });
}

async function startSession({ name, url, tabId, appContext, appVersion, templateId }) {
  const origin = await checkStartUrl(url, tabId);
  const template = templateId ? (await get(K.templates, [])).find((t) => t.id === templateId) : null;
  if (templateId && !template) throw new Error('Testplan nicht gefunden.');
  // Checkpoints that start on another domain of the app (e.g. the login) belong to the run.
  const extra = [];
  for (const item of template?.items || []) {
    const o = /^https?:/i.test(item.start) ? originOf(item.start) : null;
    if (o && o !== origin && !extra.includes(o)) extra.push(o);
  }
  for (const o of extra) await checkPolicy(o);
  const meta = await locked(() => {
    const session = newSessionMeta({ name: S.str(name, 200), origins: [origin, ...extra], appContext: S.str(appContext, 5000) || '', appVersion: S.str(appVersion, 200) || '' });
    if (!template) return activateNewSession(session);
    const snapshot = { templateId: template.id, name: template.name, items: template.items.map((it, i) => ({ ...S.checkpoint(it, i), id: `c${i + 1}` })), results: {} };
    session.testPlan = { templateId: template.id, name: template.name, count: snapshot.items.length };
    return get(K.ui, {}).then((ui) => activateNewSession(session, { [K.testPlan(session.id)]: snapshot, [K.ui]: { ...ui, retestOpen: true, retestFocus: 1 } }));
  });
  await afterChange({ registration: true, inject: true });
  return meta;
}

/**
 * Re-test: a new session that goes through the annotations of an earlier one
 * (in a newer version of the app). The plan is a snapshot incl. screenshots,
 * so the re-test stays complete even if the earlier session is deleted.
 * Checks keep the earlier numbers; new findings continue after them.
 */
async function startRetest({ baseSessionId, url, tabId, name, appContext, appVersion, openTab = false }) {
  const origin = await checkStartUrl(url, tabId);
  const meta = await locked(async () => {
    const base = await loadBundle(baseSessionId);
    const items = retestPlan(base);
    if (!items.length) throw new Error('Dieser Testlauf hat keine offenen Anmerkungen zum Nachtesten.');
    const sources = await chrome.storage.local.get(items.flatMap((it) => [K.img(it.imageFrom, 'crop'), K.img(it.imageFrom, 'full')]));
    const images = {};
    const plan = items.map((it) => {
      const id = uid('p');
      const has = {};
      for (const variant of ['crop', 'full']) {
        const data = sources[K.img(it.imageFrom, variant)];
        if (S.isImage(data)) {
          images[K.img(id, variant)] = data;
          has[variant] = true;
        }
      }
      return S.planItem({ ...it, id, images: { ...has, redacted: it.redactedImages === true } });
    }).filter(Boolean);
    const detected = base.annotations.find((a) => a.page?.appVersion)?.page.appVersion;
    const b = base.session;
    const session = newSessionMeta({
      name: S.str(name, 200) || `Nachtest: ${b.name}`.slice(0, 200),
      origins: [...new Set([origin])],
      appContext: S.str(appContext, 5000) || b.appContext || '',
      appVersion: S.str(appVersion, 200) || '',
    });
    session.retestOf = { sessionId: b.id, name: b.name, appVersion: b.appVersion || detected || '', createdAt: b.createdAt, count: plan.length };
    session.lastNumber = Math.max(b.lastNumber || 0, ...plan.map((p) => p.number));
    // Open the re-test list on the first item when the overlay appears.
    const ui = { ...(await get(K.ui, {})), retestOpen: true, retestFocus: plan[0]?.number ?? null };
    return activateNewSession(session, { ...images, [K.plan(session.id)]: plan, [K.ui]: ui });
  });
  await afterChange({ registration: true, inject: true });
  if (openTab) {
    const tab = await chrome.tabs.create({ url });
    await tabOnOrigin(tab.id, origin);
    if (await policyBlocks(tab.id)) {
      await deleteSession({ sessionId: meta.id }); // never really started
      throw new Error(POLICY_BLOCKED);
    }
  }
  return meta;
}

// ---------------------------------------------------------------------------
// Test plans: templates (dashboard) and results of a run's checkpoints
// ---------------------------------------------------------------------------

const toOrigin = (o) => {
  const s = String(o || '').trim();
  const url = /^[a-z]+:\/\//i.test(s) ? s : `https://${s}`;
  const origin = originOf(url.endsWith('/') ? url : `${url}/`);
  return origin && isInjectableUrl(`${origin}/`) ? origin : null;
};

async function saveTemplate({ template }) {
  const t = template && typeof template === 'object' ? template : {};
  const name = S.str(String(t.name || '').trim(), 200);
  if (!name) throw new Error('Bitte dem Testplan einen Namen geben.');
  const items = (Array.isArray(t.items) ? t.items : []).slice(0, 300).map(S.checkpoint).filter(Boolean).map((it, i) => ({ ...it, id: `c${i + 1}` }));
  if (!items.length) throw new Error('Der Testplan braucht mindestens einen Prüfpunkt (eine Zeile „- …“).');
  const domains = [...new Set((Array.isArray(t.domains) ? t.domains : []).map(toOrigin).filter(Boolean))].slice(0, 20);
  return locked(async () => {
    const list = await get(K.templates, []);
    const now = nowIso();
    const i = list.findIndex((x) => x.id === t.id);
    const saved = { id: i >= 0 ? list[i].id : uid('tpl'), name, domains, items, createdAt: i >= 0 ? list[i].createdAt : now, updatedAt: now };
    if (i >= 0) list[i] = saved;
    else list.push(saved);
    await set({ [K.templates]: list });
    return saved;
  });
}

async function deleteTemplate({ id }) {
  await locked(async () => set({ [K.templates]: (await get(K.templates, [])).filter((t) => t.id !== id) }));
}

/** OK (with screenshot), not testable (with reason) or reset – from the list in the page. */
async function planResult({ sessionId, itemId, status, note, image, url }) {
  const result = await locked(async () => {
    const tp = await get(K.testPlan(sessionId), null);
    const item = tp?.items.find((it) => it.id === itemId);
    if (!item) throw new Error('Prüfpunkt nicht gefunden.');
    const now = nowIso();
    const imgKey = K.planImg(sessionId, itemId);
    const writes = {};
    let label;
    if (!status) {
      delete tp.results[itemId];
      label = 'zurückgesetzt';
    } else {
      if (!['ok', 'skip'].includes(status)) throw new Error('Unbekanntes Ergebnis.');
      const withImage = status === 'ok' && S.isImage(image);
      if (withImage) writes[imgKey] = image;
      tp.results[itemId] = S.checkResult({ status, t: now, note, url, image: withImage });
      label = status === 'ok' ? 'in Ordnung' : 'nicht testbar';
    }
    if (!writes[imgKey]) await remove(imgKey);
    const trail = await get(K.trail(sessionId), []);
    trail.push({ t: now, type: 'annotation', url: S.str(url, 2000), label: `Prüfpunkt ${item.id.slice(1)} „${item.title.slice(0, 60)}“: ${label}` });
    await set({ ...writes, [K.testPlan(sessionId)]: tp, [K.trail(sessionId)]: trail.slice(-C.LIMITS.trailPerSession) });
    return tp.results[itemId] || null;
  });
  notifyTabs();
  return result;
}

/** Results the development wrote into the package README (parsed by the dashboard). */
/** Marks added in the dashboard: the stored images are replaced by versions with the new marks burnt in. */
async function updateImages({ sessionId, id, images, marks, extraId }) {
  await locked(async () => {
    const list = await get(K.ann(sessionId), []);
    const i = list.findIndex((a) => a.id === id);
    if (i < 0) throw new Error('Anmerkung nicht gefunden.');
    const a = list[i];
    const writes = {};
    if (extraId) {
      // a further screenshot: one image, its own marks
      const x = (a.images?.extra || []).find((e) => e.id === extraId);
      if (!x || !S.isImage(images?.image)) throw new Error('Ungültiges Bild.');
      const m = S.extraImage(marks || {});
      writes[K.img(id, extraId)] = images.image;
      const extra = a.images.extra.map((e) => (e === x ? { ...e, drawn: e.drawn || m.drawn, redacted: e.redacted || m.redacted, clicks: m.clicks, numbers: m.numbers } : e));
      list[i] = { ...a, images: { ...a.images, extra }, updatedAt: nowIso() };
      await set({ ...writes, [K.ann(sessionId)]: list });
      return;
    }
    for (const variant of ['crop', 'full']) {
      const data = images?.[variant];
      if (data === undefined) continue;
      if (!a.images?.[variant] || !S.isImage(data)) throw new Error('Ungültiges Bild.');
      writes[K.img(id, variant)] = data;
    }
    const m = S.annotation({ images: marks }).images;
    list[i] = { ...a, images: { ...a.images, drawn: a.images.drawn || m.drawn, redacted: a.images.redacted || m.redacted, clicks: m.clicks, numbers: m.numbers }, updatedAt: nowIso() };
    await set({ ...writes, [K.ann(sessionId)]: list });
  });
  notifyTabs();
}

async function applyDevResults({ sessionId, results }) {
  if (!Array.isArray(results)) throw new Error('Keine Ergebnisse gefunden.');
  const byNumber = new Map();
  for (const r of results.slice(0, 2000)) {
    const clean = S.devResult({ ...r, importedAt: nowIso() });
    if (clean && Number.isInteger(r?.number)) byNumber.set(r.number, clean);
  }
  const matched = await locked(async () => {
    const list = await get(K.ann(sessionId), []);
    let n = 0;
    for (const a of list) {
      const r = byNumber.get(a.number);
      if (!r) continue;
      a.devResult = r;
      a.updatedAt = nowIso();
      n++;
    }
    if (n) await set({ [K.ann(sessionId)]: list });
    return n;
  });
  notifyTabs();
  return { matched, total: byNumber.size };
}

/**
 * Stops the running session – as a pause (the popup offers to continue it
 * first) or for good. A paused session that is not running can be ended too.
 */
async function stopSession({ pause = false, sessionId = null } = {}) {
  await locked(async () => {
    const active = await getActiveSession();
    if (active) {
      const { endedAt, runs, pausedAt } = ended(active, nowIso(), { pause });
      await patchSession(active.id, { endedAt, runs, pausedAt });
    } else if (sessionId && !pause) {
      const paused = (await getSessions()).find((s) => s.id === sessionId && s.pausedAt);
      if (paused) await patchSession(paused.id, { pausedAt: null });
    }
    await set({ [K.active]: null });
  });
  await afterChange({ registration: true });
}

/** Resumes with the session's own domains; adding a domain is a separate, explicit step. */
async function resumeSession({ sessionId }) {
  const target = (await getSessions()).find((s) => s.id === sessionId);
  for (const origin of target?.origins || []) await checkPolicy(origin);
  const session = await locked(async () => {
    const sessions = await getSessions();
    if (!sessions.some((s) => s.id === sessionId)) throw new Error('Testlauf nicht gefunden.');
    const now = nowIso();
    const previous = await get(K.active, null);
    if (previous && previous !== sessionId) {
      const i = sessions.findIndex((s) => s.id === previous);
      if (i >= 0) sessions[i] = ended(sessions[i], now);
      await set({ [K.sessions]: sessions });
    }
    // a new section begins; runs from before 1.7 get their first one from start and end
    const s = sessions.find((x) => x.id === sessionId);
    const runs = Array.isArray(s.runs) && s.runs.length ? s.runs : [{ from: s.createdAt, to: s.endedAt || now }];
    const open = !s.endedAt && !runs[runs.length - 1].to;
    const updated = await patchSession(sessionId, { endedAt: null, pausedAt: null, runs: open ? runs : [...runs, { from: now, to: null }].slice(-500) });
    await set({ [K.active]: sessionId });
    return updated;
  });
  await afterChange({ registration: true, inject: true });
  return session;
}

async function addOrigin({ sessionId, url, tabId }) {
  const origin = originOf(url);
  if (!origin || !isInjectableUrl(url)) throw new Error('Diese Seite kann nicht hinzugefügt werden.');
  await checkFileAccess(url);
  await checkPolicy(origin, tabId);
  let changed = false;
  const session = await locked(async () => {
    const target = (await getSessions()).find((s) => s.id === sessionId);
    if (!target) throw new Error('Testlauf nicht gefunden.');
    if (target.origins.includes(origin)) return target;
    changed = true;
    return patchSession(sessionId, { origins: [...target.origins, origin] });
  });
  if (changed) await afterChange({ registration: true, inject: true });
  return session;
}

async function updateSession({ sessionId, patch = {} }) {
  const allowed = {};
  if ('name' in patch) allowed.name = S.str(patch.name, 200) || 'Testlauf';
  if ('appContext' in patch) allowed.appContext = S.str(patch.appContext, 5000) || '';
  if ('appVersion' in patch) allowed.appVersion = S.str(patch.appVersion, 200) || '';
  if ('handoffNote' in patch) allowed.handoffNote = S.str(patch.handoffNote, 5000) || '';
  if (Array.isArray(patch.origins)) {
    allowed.origins = [...new Set(patch.origins.map((o) => String(o)).filter((o) => isInjectableUrl(o.endsWith('/') ? o : `${o}/`)).map((o) => originOf(o.endsWith('/') ? o : `${o}/`)))];
  }
  const session = await locked(() => patchSession(sessionId, allowed));
  await afterChange({ registration: Boolean(allowed.origins), inject: Boolean(allowed.origins) });
  return session;
}

async function deleteSession({ sessionId }) {
  const wasActive = await locked(async () => {
    const sessions = await getSessions();
    const annotations = await get(K.ann(sessionId), []);
    const plan = await get(K.plan(sessionId), []);
    const tp = await get(K.testPlan(sessionId), null);
    const images = [...annotations, ...plan].flatMap(imageKeys);
    const planImages = (tp?.items || []).map((it) => K.planImg(sessionId, it.id));
    const drafts = (await get(K.drafts(sessionId), [])).map((d) => K.draft(d.id));
    await remove([K.ann(sessionId), K.trail(sessionId), K.tech(sessionId), K.plan(sessionId), K.testPlan(sessionId), K.drafts(sessionId), ...images, ...planImages, ...drafts]);
    const activeId = await get(K.active, null);
    await set({ [K.sessions]: sessions.filter((s) => s.id !== sessionId) });
    if (activeId === sessionId) {
      await set({ [K.active]: null });
      return true;
    }
    return false;
  });
  await afterChange({ registration: wasActive });
}

async function wipeAll() {
  await locked(() => chrome.storage.local.clear());
  await afterChange({ registration: true });
}

/**
 * Restores a backup (step 1: metadata). Everything is validated, because the
 * file may come from anywhere. Images follow in batches via fl:importImages.
 */
async function importSession({ data }) {
  if (!data || data.schema !== C.SCHEMA || typeof data.session !== 'object' || !Array.isArray(data.annotations)) {
    throw new Error('Unbekanntes Dateiformat – erwartet wird eine Feedback-Lens-Sicherung (.json).');
  }
  if (data.kind !== 'backup') throw new Error('Diese Datei ist ein Export ohne Bilder. Bitte eine „Sicherung“ importieren.');
  if (data.annotations.length > 5000) throw new Error('Die Sicherung enthält zu viele Anmerkungen.');
  return locked(async () => {
    const src = data.session || {};
    const origins = (Array.isArray(src.origins) ? src.origins : [])
      .map((o) => String(o))
      .filter((o) => isInjectableUrl(o.endsWith('/') ? o : `${o}/`))
      .map((o) => originOf(o.endsWith('/') ? o : `${o}/`));
    const meta = {
      ...newSessionMeta({ name: `${S.str(src.name, 180) || 'Import'} (Import)`, origins: [...new Set(origins)], appContext: S.str(src.appContext, 5000) || '', appVersion: S.str(src.appVersion, 200) || '' }),
      createdAt: S.iso(src.createdAt) || nowIso(),
      // imported runs are finished – an end date from the file (future, just now) must not open the late-flush window
      endedAt: new Date(Math.min(Date.parse(S.iso(src.endedAt) || '') || Infinity, Date.now() - 60_000)).toISOString(),
    };
    meta.runs = S.runs(src.runs, meta.createdAt, meta.endedAt);
    meta.handoffNote = S.str(src.handoffNote, 5000) || '';
    const idMap = {};
    const planNumbers = new Set();
    const plan = (Array.isArray(data.plan) ? data.plan : []).slice(0, 5000).map((raw) => {
      const item = S.planItem(raw);
      if (!item || planNumbers.has(item.number)) return null;
      planNumbers.add(item.number);
      const id = uid('p');
      if (typeof raw.id === 'string') idMap[raw.id] = id;
      return { ...item, id, images: { ...item.images, crop: false, full: false } };
    }).filter(Boolean);
    const numbers = data.annotations.map((a) => a?.number);
    const keepNumbers = numbers.every((n) => Number.isInteger(n) && n > 0 && n < 1e6) && new Set(numbers).size === numbers.length;
    // Renumbered annotations lose their re-test link and start after the plan's numbers.
    const firstFree = Math.max(0, ...planNumbers) + 1;
    const annotations = data.annotations.map((raw, i) => {
      const id = uid('a');
      if (typeof raw?.id === 'string') idMap[raw.id] = id;
      const ann = { ...S.annotation(raw), id, sessionId: meta.id, number: keepNumbers ? numbers[i] : firstFree + i };
      if (ann.retest && (!keepNumbers || ann.retest.number !== ann.number || !planNumbers.has(ann.number))) delete ann.retest;
      return ann;
    });
    // test plan: checkpoints with their results; annotations keep their link only to known checkpoints
    let testPlan = null;
    const tpSrc = data.testPlan && typeof data.testPlan === 'object' ? data.testPlan : null;
    if (tpSrc && Array.isArray(tpSrc.items)) {
      const items = tpSrc.items.slice(0, 300).map(S.checkpoint).filter(Boolean);
      if (items.length && new Set(items.map((it) => it.id)).size === items.length) {
        const results = {};
        for (const it of items) {
          const res = S.checkResult(tpSrc.results?.[it.id]);
          if (res) results[it.id] = { ...res, image: undefined };
          if (res) idMap[`tp:${it.id}`] = `${meta.id}.${it.id}`;
        }
        testPlan = { templateId: null, name: S.str(tpSrc.name, 200) || 'Testplan', items, results: JSON.parse(JSON.stringify(results)) };
        meta.testPlan = { templateId: null, name: testPlan.name, count: items.length };
      }
    }
    for (const a of annotations) if (a.planItem && !testPlan?.items.some((it) => it.id === a.planItem)) delete a.planItem;
    const r = src.retestOf && typeof src.retestOf === 'object' ? src.retestOf : null;
    if (plan.length && r) {
      meta.retestOf = { sessionId: null, name: S.str(r.name, 200) || '', appVersion: S.str(r.appVersion, 200) || '', createdAt: S.iso(r.createdAt) || null, count: plan.length };
    }
    meta.count = annotations.length;
    meta.lastNumber = [...annotations, ...plan].reduce((m, a) => Math.max(m, a.number), 0);
    const sessions = await getSessions();
    sessions.unshift(meta);
    await set({
      ...(meta.retestOf ? { [K.plan(meta.id)]: plan } : {}),
      ...(testPlan ? { [K.testPlan(meta.id)]: testPlan } : {}),
      [K.sessions]: sessions,
      [K.ann(meta.id)]: annotations,
      [K.trail(meta.id)]: (Array.isArray(data.trail) ? data.trail : []).slice(-C.LIMITS.trailPerSession).map(S.trailEntry).filter(Boolean),
      [K.tech(meta.id)]: (Array.isArray(data.techEvents) ? data.techEvents : []).slice(-C.LIMITS.techPerSession).map(S.techEvent).filter(Boolean),
    });
    return { meta, idMap };
  });
}

/** Restores a backup (step 2, repeated): a batch of screenshots. */
async function importImages({ sessionId, images }) {
  if (!Array.isArray(images)) return 0;
  return locked(async () => {
    const list = await get(K.ann(sessionId), []);
    const plan = await get(K.plan(sessionId), []);
    const tp = await get(K.testPlan(sessionId), null);
    const byId = new Map([...list, ...plan].map((a) => [a.id, a]));
    const items = {};
    let stored = 0;
    for (const img of images) {
      // screenshot of a checkpoint found OK: id "<session>.<checkpoint>"
      const checkpointId = typeof img?.id === 'string' && img.id.startsWith(`${sessionId}.`) ? img.id.slice(sessionId.length + 1) : null;
      if (checkpointId) {
        const res = tp?.results[checkpointId];
        if (res?.status === 'ok' && img.variant === 'full' && S.isImage(img.dataUrl)) {
          items[K.planImg(sessionId, checkpointId)] = img.dataUrl;
          res.image = true;
          items[K.testPlan(sessionId)] = tp;
          stored++;
        }
        continue;
      }
      const ann = byId.get(img?.id);
      if (!ann || !S.isImage(img.dataUrl)) continue;
      if (['crop', 'full'].includes(img.variant)) ann.images = { ...ann.images, [img.variant]: true };
      else if (!(ann.images?.extra || []).some((x) => x.id === img.variant)) continue;
      items[K.img(ann.id, img.variant)] = img.dataUrl;
      stored++;
    }
    if (stored) {
      items[K.ann(sessionId)] = list;
      if (plan.length) items[K.plan(sessionId)] = plan;
      await set(items);
    }
    return stored;
  });
}

// ---------------------------------------------------------------------------
// Annotations, trail and technical events
// ---------------------------------------------------------------------------

async function resolveSessionId(sessionId) {
  if (sessionId) return sessionId;
  const active = await getActiveSession();
  if (!active) throw new Error('Kein aktiver Testlauf.');
  return active.id;
}

async function saveAnnotation({ sessionId, annotation, images }) {
  const result = await locked(async () => {
    const sid = await resolveSessionId(sessionId);
    const sessions = await getSessions();
    const meta = sessions.find((s) => s.id === sid);
    if (!meta) throw new Error('Testlauf nicht gefunden.');
    let list = await get(K.ann(sid), []);
    const id = uid('a');
    const now = nowIso();
    const ann = { ...S.annotation(annotation), id, sessionId: sid, status: 'open', updatedAt: now };
    delete ann.devResult;
    // A re-test check takes the number of the earlier annotation and replaces an earlier check of it.
    const item = ann.retest && meta.retestOf ? (await get(K.plan(sid), [])).find((p) => p.number === ann.retest.number) : null;
    let number;
    const stale = [];
    if (item) {
      number = item.number;
      // A re-check keeps what was edited or imported for the earlier check.
      const prev = list.find((a) => a.retest?.number === number);
      Object.assign(ann, { title: prev?.title || item.title, category: prev?.category || item.category, priority: prev?.priority || item.priority });
      if (prev?.devResult) ann.devResult = prev.devResult;
      for (const old of list.filter((a) => a.retest?.number === number)) stale.push(...imageKeys(old));
      list = list.filter((a) => a.retest?.number !== number);
    } else {
      delete ann.retest;
      number = (meta.lastNumber || 0) + 1;
    }
    ann.number = number;
    const items = {};
    // A finding for a checkpoint of the test plan marks it as a problem.
    const tp = ann.planItem && meta.testPlan ? await get(K.testPlan(sid), null) : null;
    if (tp?.items.some((it) => it.id === ann.planItem)) {
      if (tp.results[ann.planItem]?.status !== 'skip') tp.results[ann.planItem] = { status: 'problem', t: now };
      items[K.testPlan(sid)] = tp;
    } else delete ann.planItem;
    for (const variant of ['crop', 'full']) {
      if (S.isImage(images?.[variant])) {
        items[K.img(id, variant)] = images[variant];
        ann.images[variant] = true;
      }
    }
    // further screenshots: the metadata comes with the annotation, the images in the same order
    const extraMeta = ann.images.extra;
    ann.images.extra = [];
    addExtras(ann, extraMeta.map((meta, i) => ({ meta, dataUrl: Array.isArray(images?.extras) ? images.extras[i] : null })), items);
    list.push(ann);
    items[K.ann(sid)] = list;
    const trail = await get(K.trail(sid), []);
    const label = item ? `Nachtest: ${C.VERDICTS.find((v) => v.id === ann.retest.verdict)?.label}` : (ann.title || ann.description).slice(0, 80);
    trail.push({ t: now, type: 'annotation', url: ann.page?.url, number, label });
    items[K.trail(sid)] = trail.slice(-C.LIMITS.trailPerSession);
    const idx = sessions.findIndex((s) => s.id === sid);
    sessions[idx] = { ...meta, count: list.length, lastNumber: Math.max(meta.lastNumber || 0, number), updatedAt: now };
    items[K.sessions] = sessions;
    await set(items);
    if (stale.length) await remove(stale); // after the new check is stored
    return { id, number, sessionId: sid };
  });
  await afterChange();
  return result;
}

const EDITABLE = {
  category: (v) => (C.CATEGORIES.some((c) => c.id === v) ? v : undefined),
  priority: (v) => (C.PRIORITIES.some((p) => p.id === v) ? v : undefined),
  status: (v) => (C.STATUSES.some((s) => s.id === v) ? v : undefined),
  title: (v) => S.str(v, 300),
  description: (v) => S.str(v, 10000),
  expected: (v) => S.str(v, 10000),
};
const VERDICT_IDS = C.VERDICTS.map((v) => v.id);

async function updateAnnotation({ sessionId, id, patch = {} }, { fromPage = false } = {}) {
  const result = await locked(async () => {
    const list = await get(K.ann(sessionId), []);
    const idx = list.findIndex((a) => a.id === id);
    if (idx < 0) throw new Error('Anmerkung nicht gefunden.');
    const clean = {};
    // From a tested page only the status can change (pin popover).
    for (const [key, check] of Object.entries(EDITABLE)) {
      if (!(key in patch) || (fromPage && key !== 'status')) continue;
      const v = check(patch[key]);
      if (v !== undefined) clean[key] = v;
    }
    if (!fromPage && list[idx].retest && VERDICT_IDS.includes(patch.verdict)) clean.retest = { ...list[idx].retest, verdict: patch.verdict };
    // notes to the numbers on the screenshot (dashboard): { "<number>": "note" }
    if (!fromPage && patch.numberNotes && typeof patch.numberNotes === 'object') {
      const note = (n) => (String(n) in patch.numberNotes ? S.str(String(patch.numberNotes[n] ?? '').trim(), 300) || undefined : undefined);
      const has = (n) => String(n) in patch.numberNotes;
      const img = list[idx].images || {};
      clean.images = {
        ...img,
        clicks: (img.clicks || []).map((c) => (c.n && has(c.n) ? S.clean({ ...c, note: note(c.n) }) : c)),
        numbers: (img.numbers || []).map((x) => (typeof x === 'number' ? { n: x } : x)).map((x) => (has(x.n) ? S.clean({ ...x, note: note(x.n) }) : x)),
      };
    }
    list[idx] = { ...list[idx], ...clean, updatedAt: nowIso() };
    await set({ [K.ann(sessionId)]: list });
    return list[idx];
  });
  notifyTabs();
  return result;
}

/** A later observation on the same spot, appended to the earlier annotation instead of a duplicate. */
// ---------------------------------------------------------------------------
// Parked drafts: an annotation set aside to look at the application again.
// They survive reloads and page changes; continuing takes the draft out of
// storage, so two tabs cannot both finish it.
// ---------------------------------------------------------------------------

const MAX_DRAFTS = 5;

async function parkDraft({ sessionId, draft }) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new Error('Ungültiger Entwurf.');
  if (draft.shot !== undefined && draft.shot !== null && !S.isImage(draft.shot)) throw new Error('Ungültiges Bild.');
  const json = JSON.stringify(draft);
  if (json.length > 25e6) throw new Error('Der Entwurf ist zu groß.');
  const summary = {
    id: uid('d'),
    parkedAt: nowIso(),
    label: S.str(String(draft.label || ''), 120) || 'Anmerkung',
    url: S.str(String(draft.page?.url || ''), 2000) || '',
    retest: Number.isInteger(draft.retest?.number) ? draft.retest.number : undefined,
    awaitShot: draft.awaitShot === true || undefined, // the next capture goes to this draft
  };
  for (const x of Array.isArray(draft.extras) ? draft.extras : []) if (!S.isImage(x?.shot)) throw new Error('Ungültiges Bild.');
  await locked(async () => {
    let list = await get(K.drafts(sessionId), []);
    if (list.length >= MAX_DRAFTS) throw new Error(`Höchstens ${MAX_DRAFTS} Entwürfe gleichzeitig – bitte erst einen abschließen.`);
    if (summary.awaitShot) list = list.map(({ awaitShot, ...d }) => d); // only one draft waits for a screenshot
    await set({ [K.draft(summary.id)]: JSON.parse(json), [K.drafts(sessionId)]: [...list, summary] });
  });
  notifyTabs();
  return summary;
}

async function takeDraft({ sessionId, id }) {
  const data = await locked(async () => {
    const list = await get(K.drafts(sessionId), []);
    if (!list.some((d) => d.id === id)) throw new Error('Diesen Entwurf gibt es nicht mehr – vielleicht wurde er in einem anderen Tab fortgesetzt.');
    const content = await get(K.draft(id), null);
    await remove([K.draft(id)]);
    await set({ [K.drafts(sessionId)]: list.filter((d) => d.id !== id) });
    return content;
  });
  notifyTabs();
  if (!data) throw new Error('Der Entwurf ist leer.');
  return data;
}

async function appendToAnnotation({ sessionId, id, description, expected, images }) {
  const text = S.str(String(description || '').trim(), 4000);
  const wish = S.str(String(expected || '').trim(), 4000);
  const shots = Array.isArray(images) ? images.slice(0, C.LIMITS.extraImages) : [];
  if (!text && !wish && !shots.length) throw new Error('Bitte beschreiben, was du ergänzen möchtest.');
  const result = await locked(async () => {
    const list = await get(K.ann(sessionId), []);
    const idx = list.findIndex((a) => a.id === id);
    if (idx < 0) throw new Error('Anmerkung nicht gefunden.');
    const a = list[idx];
    if (a.retest) throw new Error('Nachtest-Bewertungen lassen sich nicht ergänzen.');
    const now = nowIso();
    const add = (old, extra) => (extra ? S.str(`${old ? `${old}\n\n` : ''}Nachtrag (${formatDateTime(now)}): ${extra}`, 10000) : old);
    const next = { ...a, description: add(a.description, text), expected: add(a.expected, wish), updatedAt: now };
    // the screenshots of the addition become further screenshots of the annotation
    const writes = {};
    const before = a.images?.extra?.length || 0;
    if (shots.length) addExtras(next, shots, writes);
    const added = (next.images?.extra?.length || 0) - before;
    if (shots.length && !added && !text && !wish) throw new Error(`#${a.number} hat schon ${C.LIMITS.extraImages + 1} Screenshots.`);
    list[idx] = next;
    const trail = await get(K.trail(sessionId), []);
    trail.push({ t: now, type: 'annotation', url: a.page?.url, number: a.number, label: `Nachtrag zu #${a.number}` });
    await set({ ...writes, [K.ann(sessionId)]: list, [K.trail(sessionId)]: trail.slice(-C.LIMITS.trailPerSession) });
    return { number: a.number, added, skipped: shots.length - added };
  });
  notifyTabs();
  return result;
}

/** Dashboard: a picture pasted or chosen as a file becomes a further screenshot. */
async function addImages({ sessionId, id, images }) {
  const result = await locked(async () => {
    const list = await get(K.ann(sessionId), []);
    const i = list.findIndex((a) => a.id === id);
    if (i < 0) throw new Error('Anmerkung nicht gefunden.');
    const a = { ...list[i] };
    const before = a.images?.extra?.length || 0;
    if (before >= C.LIMITS.extraImages) throw new Error(`Höchstens ${C.LIMITS.extraImages + 1} Screenshots pro Anmerkung.`);
    const writes = {};
    addExtras(a, (Array.isArray(images) ? images : []).map((img) => ({ dataUrl: img?.dataUrl, meta: { ...img?.meta, kind: 'file', t: nowIso() } })), writes);
    list[i] = { ...a, updatedAt: nowIso() };
    await set({ ...writes, [K.ann(sessionId)]: list });
    return { added: a.images.extra.length - before };
  });
  notifyTabs();
  return result;
}

/** Dashboard: caption, order or removal of a further screenshot. */
async function editExtra({ sessionId, id, extraId, caption, move, remove: drop }) {
  await locked(async () => {
    const list = await get(K.ann(sessionId), []);
    const i = list.findIndex((a) => a.id === id);
    const a = list[i];
    const extra = [...(a?.images?.extra || [])];
    const at = extra.findIndex((x) => x.id === extraId);
    if (at < 0) throw new Error('Screenshot nicht gefunden.');
    if (drop) {
      extra.splice(at, 1);
      await remove([K.img(id, extraId)]);
    } else if (move === -1 || move === 1) {
      const to = at + move;
      if (to >= 0 && to < extra.length) [extra[at], extra[to]] = [extra[to], extra[at]];
    } else if (caption !== undefined) {
      extra[at] = { ...extra[at], caption: S.str(String(caption), 300) || '' };
    }
    list[i] = { ...a, images: { ...a.images, extra }, updatedAt: nowIso() };
    await set({ [K.ann(sessionId)]: list });
  });
  notifyTabs();
}

async function deleteAnnotation({ sessionId, id }) {
  await locked(async () => {
    const list = await get(K.ann(sessionId), []);
    const next = list.filter((a) => a.id !== id);
    const gone = list.find((a) => a.id === id);
    if (gone?.planItem && !next.some((a) => a.planItem === gone.planItem)) {
      const tp = await get(K.testPlan(sessionId), null);
      if (tp?.results[gone.planItem]?.status === 'problem') {
        delete tp.results[gone.planItem];
        await set({ [K.testPlan(sessionId)]: tp });
      }
    }
    const sessions = await getSessions();
    const idx = sessions.findIndex((s) => s.id === sessionId);
    if (idx >= 0) sessions[idx] = { ...sessions[idx], count: next.length, updatedAt: nowIso() };
    await set({ [K.ann(sessionId)]: next, [K.sessions]: sessions });
    if (gone) await remove(imageKeys(gone));
  });
  await afterChange();
}

async function appendList(sessionId, key, entries, limit) {
  if (!entries.length) return;
  await locked(async () => {
    if (!(await sessionExists(sessionId))) return; // deleted meanwhile
    const list = await get(key, []);
    list.push(...entries);
    await set({ [key]: list.length > limit ? list.slice(-limit) : list });
  });
}

async function saveUi(patch) {
  const allowed = {};
  for (const key of ['x', 'y']) if (key in patch) allowed[key] = typeof patch[key] === 'number' && Number.isFinite(patch[key]) ? Math.round(patch[key]) : null;
  for (const key of ['minimized', 'pins', 'retestOpen', 'retestCollapsed', 'showClicks']) if (key in patch) allowed[key] = patch[key] === true;
  if ('retestDock' in patch) allowed.retestDock = patch.retestDock === 'left' ? 'left' : 'right';
  if ('retestFocus' in patch) allowed.retestFocus = Number.isInteger(patch.retestFocus) && patch.retestFocus > 0 ? patch.retestFocus : null;
  if (C.CATEGORIES.some((c) => c.id === patch.lastCategory)) allowed.lastCategory = patch.lastCategory;
  await locked(async () => set({ [K.ui]: { ...(await get(K.ui, {})), ...allowed } }));
}

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

async function captureTab(tab) {
  let lastError;
  // captureVisibleTab is rate limited (about two calls per second).
  // captureVisibleTab takes whatever tab is in front: check before and after.
  const inFront = async () => (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0]?.id === tab.id;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!(await inFront())) throw new Error('Der Tab ist nicht mehr im Vordergrund – Screenshot abgebrochen.');
    let image;
    try {
      image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 400 + attempt * 300));
      continue;
    }
    if (!(await inFront())) throw new Error('Während des Screenshots wurde der Tab gewechselt – Screenshot verworfen.');
    return image;
  }
  throw new Error(`Screenshot fehlgeschlagen: ${lastError?.message || lastError}`);
}

// ---------------------------------------------------------------------------
// Dictation: local speech recognition in an offscreen document
// ---------------------------------------------------------------------------

const OFFSCREEN = 'src/offscreen/dictation.html';
const DICTATION = 'fl:dictationRun'; // {runId, tabId} – in session storage: survives a worker restart

const currentRun = async () => (await chrome.storage.session.get(DICTATION).catch(() => ({})))[DICTATION] || null;
const setRun = (run) => (run ? chrome.storage.session.set({ [DICTATION]: run }) : chrome.storage.session.remove(DICTATION)).catch(() => {});

async function ensureOffscreen() {
  const url = chrome.runtime.getURL(OFFSCREEN);
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] }).catch(() => []);
  if (existing.length) return;
  await chrome.offscreen.createDocument({ url: OFFSCREEN, reasons: ['USER_MEDIA'], justification: 'Lokale Spracherkennung (auf dem Gerät) für das Diktat im Anmerkungsdialog.' }).catch((err) => {
    if (!/single offscreen|already/i.test(String(err?.message))) throw err;
  });
}

async function toOffscreen(payload) {
  // The document may still be starting up: retry until its listener answers.
  for (let i = 0; i < 20; i++) {
    const res = await chrome.runtime.sendMessage({ target: 'fl-dictation', ...payload }).catch(() => undefined);
    if (res) return res;
    await new Promise((r) => setTimeout(r, 100));
  }
  return { ok: false, status: 'error', error: 'Spracherkennung reagiert nicht.' };
}

/** Ends the running dictation (if any) and tells its dialog. */
async function stopDictation(reason = 'stop') {
  const run = await currentRun();
  await setRun(null);
  if (chrome.offscreen) await chrome.runtime.sendMessage({ target: 'fl-dictation', action: 'stop' }).catch(() => {});
  if (run && reason !== 'stop') chrome.tabs.sendMessage(run.tabId, { type: 'fl:dictation', event: { kind: 'end', runId: run.runId } }).catch(() => {});
}

async function dictation({ action }, sender, trusted = false) {
  if (action === 'stop') {
    // a tab may only end its own dictation
    if (trusted || (await currentRun())?.tabId === sender.tab?.id) await stopDictation();
    return { ok: true };
  }
  if (!['start', 'status'].includes(action)) return { ok: false, status: 'error' };
  // Only the overlay in the top frame of a tab under test may use the microphone.
  if (!sender.tab || sender.frameId !== 0 || !(await tabInSession(sender.tab))) return { ok: false, status: 'error' };
  if (!chrome.offscreen) return { ok: false, status: 'unsupported' };
  const lang = (await getSettings()).dictationLang;
  if (action === 'start') await stopDictation('replaced'); // one dictation at a time; the other dialog is told
  await ensureOffscreen();
  const runId = action === 'start' ? uid('d') : undefined;
  const res = await toOffscreen({ action, lang, runId });
  if (action === 'start' && res.ok) await setRun({ runId, tabId: sender.tab.id });
  return { ...res, lang, runId };
}

// Closing the tab or loading another document in it ends its dictation (the dialog is gone).
// Same-document navigation (single-page apps) keeps the dialog and the dictation.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if ((await currentRun())?.tabId === tabId) stopDictation('gone');
});
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status === 'loading' && (await currentRun())?.tabId === tabId) stopDictation('gone');
});

// ---------------------------------------------------------------------------
// Dashboard & commands
// ---------------------------------------------------------------------------

async function openDashboard({ sessionId, annotationId, exportZip = false, settings = null } = {}) {
  const base = chrome.runtime.getURL(DASHBOARD);
  const contexts = chrome.runtime.getContexts ? await chrome.runtime.getContexts({ contextTypes: ['TAB'] }).catch(() => []) : [];
  const existing = contexts.find((c) => c.tabId >= 0 && c.documentUrl?.startsWith(base));
  if (existing) {
    // Focus and tell it what to show; reloading would lose unsaved edits.
    await chrome.tabs.update(existing.tabId, { active: true });
    if (existing.windowId >= 0) await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
    chrome.runtime.sendMessage({ type: 'fl:show', sessionId, annotationId, exportZip, settings }).catch(() => {});
    return;
  }
  const params = new URLSearchParams();
  if (sessionId) params.set('session', sessionId);
  if (annotationId) params.set('annotation', annotationId);
  if (exportZip) params.set('export', 'zip');
  if (settings === 'dictation') params.set('settings', 'dictation');
  await chrome.tabs.create({ url: base + (params.size ? `?${params}` : '') });
}

async function tabInSession(tab) {
  const active = await getActiveSession();
  if (!active || !tab?.url) return false;
  return active.origins.includes(originOf(tab.url));
}

async function sendCommandToTab(tabId, action) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'fl:command', action });
  } catch {
    // The overlay is not loaded (e.g. the page was opened before the session
    // started and injection failed): inject and retry once.
    await injectIntoTab(tabId);
    await new Promise((r) => setTimeout(r, 400));
    await chrome.tabs.sendMessage(tabId, { type: 'fl:command', action }).catch(() => {});
  }
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  const actions = { 'pick-element': 'pick', 'select-region': 'region', 'page-note': 'note' };
  const action = actions[command];
  if (!action) return;
  const target = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (target && (await tabInSession(target))) {
    await sendCommandToTab(target.id, action);
  } else if (chrome.action.openPopup) {
    chrome.action.openPopup().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

const MAX_BATCH = 300;

/**
 * Messages from content scripts (the overlay in a tested page) are only
 * accepted from the top frame of a tab whose origin belongs to the test run
 * they refer to – normally the running one. Trail and technical events may
 * still arrive for a few seconds after the run ended (last flush).
 */
async function pageScope(sender, msg, { recentlyEnded = false } = {}) {
  const origin = originOf(sender.url || '');
  if (!sender.tab || sender.frameId !== 0 || !origin) throw new Error('Nicht erlaubt.');
  const active = await getActiveSession();
  let session = active;
  if (msg.sessionId !== undefined && msg.sessionId !== active?.id) {
    const ended = recentlyEnded ? (await getSessions()).find((s) => s.id === msg.sessionId) : null;
    const age = ended?.endedAt ? Date.now() - Date.parse(ended.endedAt) : NaN;
    session = age >= 0 && age < 10_000 ? ended : null;
  }
  if (!session || !session.origins.includes(origin)) throw new Error('Diese Seite gehört nicht zum laufenden Testlauf.');
  return session;
}

// page: callable from the overlay inside tested pages – 'scoped' only from a
// tab of the test run (see pageScope); everything else only from the
// extension's own pages (popup, dashboard, offscreen document).
const handlers = {
  'fl:getState': {
    page: true,
    run: async (msg, sender, trusted) => {
      const settings = await getSettings();
      const active = await getActiveSession();
      // pages ask for themselves (top frame only); extension pages may name a URL
      const url = trusted ? sender.tab?.url || msg.url : sender.frameId === 0 ? sender.url : null;
      const inSession = Boolean(active && url && active.origins.includes(originOf(url)));
      const annotations = inSession ? await get(K.ann(active.id), []) : [];
      const plan = inSession && active.retestOf ? await get(K.plan(active.id), []) : [];
      const testPlan = inSession && active.testPlan ? await get(K.testPlan(active.id), null) : null;
      const drafts = inSession ? await get(K.drafts(active.id), []) : [];
      const shortcuts = {};
      for (const cmd of await chrome.commands.getAll()) shortcuts[cmd.name] = cmd.shortcut || '';
      return { session: active, inSession, settings, annotations, plan, testPlan, drafts, shortcuts, ui: await get(K.ui, {}) };
    },
  },
  'fl:saveAnnotation': { page: 'scoped', run: (msg, sender, trusted, scope) => saveAnnotation({ ...msg, sessionId: scope?.id ?? msg.sessionId }) },
  'fl:updateAnnotation': { page: 'scoped', run: (msg, sender, trusted, scope) => updateAnnotation({ ...msg, sessionId: scope?.id ?? msg.sessionId }, { fromPage: !trusted }) },
  'fl:planResult': { page: 'scoped', run: (msg, sender, trusted, scope) => planResult({ ...msg, sessionId: scope?.id ?? msg.sessionId }) },
  'fl:saveTemplate': { run: (msg) => saveTemplate(msg) },
  'fl:deleteTemplate': { run: (msg) => deleteTemplate(msg) },
  // recentlyEnded: a dialog open while the run is stopped or paused is parked, not lost
  'fl:parkDraft': { page: 'scoped', recentlyEnded: true, run: (msg, sender, trusted, scope) => parkDraft({ ...msg, sessionId: scope?.id ?? msg.sessionId }) },
  'fl:takeDraft': { page: 'scoped', run: (msg, sender, trusted, scope) => takeDraft({ ...msg, sessionId: scope?.id ?? msg.sessionId }) },
  'fl:appendToAnnotation': { page: 'scoped', run: (msg, sender, trusted, scope) => appendToAnnotation({ ...msg, sessionId: scope?.id ?? msg.sessionId }) },
  'fl:trail': {
    page: 'scoped',
    recentlyEnded: true,
    run: async (msg, sender, trusted, scope) => {
      const sid = scope?.id ?? (await resolveSessionId(msg.sessionId).catch(() => null));
      const entries = (Array.isArray(msg.entries) ? msg.entries : []).slice(0, MAX_BATCH).map(S.trailEntry).filter(Boolean);
      if (sid) await appendList(sid, K.trail(sid), entries, C.LIMITS.trailPerSession);
    },
  },
  'fl:tech': {
    page: 'scoped',
    recentlyEnded: true,
    run: async (msg, sender, trusted, scope) => {
      const sid = scope?.id ?? (await resolveSessionId(msg.sessionId).catch(() => null));
      const events = (Array.isArray(msg.events) ? msg.events : []).slice(0, MAX_BATCH).map(S.techEvent).filter(Boolean);
      if (sid) await appendList(sid, K.tech(sid), events, C.LIMITS.techPerSession);
    },
  },
  'fl:capture': {
    page: 'scoped',
    run: (msg, sender) => {
      if (!sender.tab) throw new Error('Screenshot nur aus einem Tab möglich.');
      return captureTab(sender.tab);
    },
  },
  'fl:saveUi': { page: 'scoped', run: (msg) => saveUi(msg.patch || {}) },
  'fl:openDashboard': {
    page: 'scoped',
    // from a page: its own run only, and never an export
    run: (msg, sender, trusted, scope) => openDashboard(trusted ? msg : { sessionId: scope.id, annotationId: S.str(msg.annotationId, 80), settings: msg.settings === 'dictation' ? 'dictation' : null }),
  },
  'fl:dictation': { page: 'scoped', run: (msg, sender, trusted) => dictation(msg, sender, trusted) },
  'fl:dictationEvent': {
    // from the offscreen document: hand the recognised text to the dialog of the current run only
    run: async (msg) => {
      const run = await currentRun();
      if (!run || msg.event?.runId !== run.runId) return;
      chrome.tabs.sendMessage(run.tabId, { type: 'fl:dictation', event: msg.event }).catch(() => stopDictation());
      if (msg.event.kind === 'end') await setRun(null);
    },
  },
  'fl:startSession': { run: (msg) => startSession(msg) },
  'fl:startRetest': { run: (msg) => startRetest(msg) },
  'fl:applyDevResults': { run: (msg) => applyDevResults(msg) },
  'fl:updateImages': { run: (msg) => updateImages(msg) },
  'fl:addImages': { run: (msg) => addImages(msg) },
  'fl:editExtra': { run: (msg) => editExtra(msg) },
  'fl:stopSession': { run: (msg) => stopSession({ pause: msg.pause === true, sessionId: typeof msg.sessionId === 'string' ? msg.sessionId : null }) },
  'fl:stopAndExport': {
    run: async (msg) => {
      // the running session – or a paused one
      const active = await getActiveSession();
      const target = active || (await getSessions()).find((s) => s.id === msg.sessionId && s.pausedAt);
      if (!target) throw new Error('Kein laufender Testlauf.');
      await stopSession({ sessionId: target.id });
      await openDashboard({ sessionId: target.id, exportZip: true });
    },
  },
  'fl:resumeSession': { run: (msg) => resumeSession(msg) },
  'fl:addOrigin': { run: (msg) => addOrigin(msg) },
  'fl:updateSession': { run: (msg) => updateSession(msg) },
  'fl:deleteSession': { run: (msg) => deleteSession(msg) },
  'fl:importSession': { run: (msg) => importSession(msg) },
  'fl:importImages': { run: (msg) => importImages(msg) },
  'fl:deleteAnnotation': { run: (msg) => deleteAnnotation(msg) },
  'fl:wipe': { run: () => wipeAll() },
  'fl:command': {
    run: async (msg) => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !(await tabInSession(tab))) throw new Error('Dieser Tab gehört nicht zum Testlauf.');
      await sendCommandToTab(tab.id, msg.action);
    },
  },
  'fl:saveSettings': {
    run: async (msg) => {
      const patch = {};
      for (const [key, def] of Object.entries(C.DEFAULT_SETTINGS)) {
        if (!(key in (msg.patch || {}))) continue;
        const v = msg.patch[key];
        if (typeof def === 'boolean') patch[key] = v === true;
        else if (typeof def === 'number') patch[key] = Number.isFinite(Number(v)) ? Number(v) : def;
        else if (key === 'dictationLang') patch[key] = C.DICTATION_LANGS.some((l) => l.id === v) ? v : def;
        else patch[key] = S.str(v, 300) ?? def;
      }
      await locked(async () => set({ [K.settings]: { ...(await get(K.settings, {})), ...patch } }));
      notifyTabs();
    },
  },
};

const isExtensionPage = (sender) => sender.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && typeof msg.type === 'string' ? handlers[msg.type] : null;
  if (!handler || sender.id !== chrome.runtime.id) return false;
  const trusted = isExtensionPage(sender);
  if (!handler.page && !trusted) {
    sendResponse({ ok: false, error: 'Nicht erlaubt.' });
    return false;
  }
  Promise.resolve()
    .then(async () => {
      const scope = !trusted && handler.page === 'scoped' ? await pageScope(sender, msg, handler) : null;
      return handler.run(msg, sender, trusted, scope);
    })
    .then(
      (data) => sendResponse({ ok: true, data }),
      (err) => sendResponse({ ok: false, error: err?.message || String(err) }),
    );
  return true;
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  await syncRegistration().catch(() => {});
  // After an update, overlays from the previous version are orphaned; replace them.
  await injectIntoSessionTabs().catch(() => {});
  await refreshBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  await syncRegistration().catch(() => {});
  await refreshBadge();
});
