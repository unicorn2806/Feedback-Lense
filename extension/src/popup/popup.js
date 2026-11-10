import { C, originOf, isInjectableUrl, hostOf, formatDateTime, formatTime, shortcutKeys } from '../lib/util.js';
import { h, icon, send } from '../lib/dom.js';

const K = C.KEYS;
const app = document.getElementById('app');

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function shortcuts() {
  const map = {};
  try {
    for (const cmd of await chrome.commands.getAll()) map[cmd.name] = cmd.shortcut || '';
  } catch {
    /* ignore */
  }
  return map;
}

function defaultName(url) {
  const date = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  return `${hostOf(url)} – ${date}`;
}

async function render() {
  const [tab, store, keys] = await Promise.all([currentTab(), chrome.storage.local.get([K.active, K.sessions, K.templates]), shortcuts()]);
  const sessions = store[K.sessions] || [];
  const active = sessions.find((s) => s.id === store[K.active]) || null;
  const url = tab?.url || '';
  const injectable = isInjectableUrl(url);
  const tabInSession = active && active.origins.includes(originOf(url));
  app.replaceChildren(active ? activeView(active, tab, injectable, tabInSession, keys) : startView(tab, injectable, sessions, store[K.templates] || [], keys));
}

/** The most recently paused run (not running): the popup offers to continue it first. */
const pausedOf = (sessions) => sessions.filter((s) => s.pausedAt).sort((a, b) => String(b.pausedAt).localeCompare(String(a.pausedAt)))[0] || null;

function pausedCard(s) {
  const status = h('div');
  const act = (btn, fn) =>
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await fn();
      } catch (err) {
        status.replaceChildren(errorBox(err));
        btn.disabled = false;
      }
    });
  const resume = h('button.btn.primary.block', { type: 'button' }, icon('play'), 'Fortsetzen');
  const end = h('button.btn', { type: 'button', title: 'Testlauf beenden, ohne zu exportieren' }, icon('stop'), 'Beenden');
  const exp = h('button.btn', { type: 'button', title: 'Testlauf beenden und das Paket für die Entwicklung herunterladen' }, icon('download'), 'Beenden & exportieren');
  act(resume, async () => {
    await send('fl:resumeSession', { sessionId: s.id });
    await render();
  });
  act(end, async () => {
    await send('fl:stopSession', { sessionId: s.id });
    await render();
  });
  act(exp, async () => {
    await send('fl:stopAndExport', { sessionId: s.id });
    window.close();
  });
  return h(
    'div.stack',
    { style: { gap: '8px' } },
    h(
      'div.session.paused',
      null,
      h('div.title', null, h('span.dot-paused', null, icon('pause', 12)), h('span', { text: s.name })),
      h('div.meta', { text: `Pausiert seit ${formatTime(s.pausedAt)} · ${s.count} Anmerkung${s.count === 1 ? '' : 'en'} · ${s.origins.map(hostOf).join(', ')}` }),
    ),
    resume,
    h('div.foot.fit', null, end, exp),
    status,
  );
}

function errorBox(err) {
  return h('div.notice.error', { text: err.message || String(err) });
}

/** Test plans for this page: those naming its domain first (preselected if it is the only one). */
function planSelect(templates, origin) {
  if (!templates.length) return null;
  const here = templates.filter((t) => t.domains.includes(origin));
  const other = templates.filter((t) => !t.domains.includes(origin));
  const option = (t) => h('option', { value: t.id, text: `${t.name} (${t.items.length} Prüfpunkte)` });
  const select = h(
    'select.input',
    { 'aria-label': 'Testplan' },
    h('option', { value: '', text: 'Ohne Testplan' }),
    here.length ? h('optgroup', { label: 'Für diese Domain' }, here.map(option)) : null,
    other.length ? h('optgroup', { label: here.length ? 'Weitere' : 'Testpläne' }, other.map(option)) : null,
  );
  if (here.length === 1) select.value = here[0].id;
  return select;
}

function startView(tab, injectable, sessions, templates = [], keys = {}) {
  const url = tab?.url || '';
  const name = h('input.input', { type: 'text', value: injectable ? defaultName(url) : '', 'aria-label': 'Name des Testlaufs' });
  const context = h('textarea', { placeholder: 'z. B. „Interne Kundenverwaltung, Staging. Fokus heute: Anlegen eines neuen Kunden.“', 'aria-label': 'Kontext zum Test' });
  const version = h('input.input', { type: 'text', placeholder: 'z. B. 2.3.1, Commit a1b2c3d', 'aria-label': 'Version, Build oder Commit' });
  const startLabel = h('span', { text: 'Testlauf auf dieser Seite starten' });
  const start = h('button.btn.primary.block', { type: 'button' }, icon('play'), startLabel);
  const status = h('div');
  const ctx = h('details.ctx', null, h('summary', { text: 'Kontext zum Test (optional)' }), context, h('label.sub', null, 'Version / Build / Commit', version));

  // Re-test: go through the annotations of an earlier test run in this (newer) version.
  const bases = sessions.filter((s) => s.count > 0 || s.retestOf).slice(0, 25);
  const kind = bases.length
    ? h('select.input', { 'aria-label': 'Art des Testlaufs' }, h('option', { value: '', text: 'Neuer Testlauf' }), bases.map((s) => h('option', { value: s.id, text: `Nachtest von „${s.name}“ (${s.count} Anm.)` })))
    : null;
  const retestHint = h('p.muted.small.hint', { text: 'Geht die Anmerkungen des früheren Testlaufs der Reihe nach durch: Du bewertest jede als behoben, besteht weiter, verändert oder nicht prüfbar. Neue Funde kannst du wie gewohnt anmerken.', hidden: true });
  // Test plan: checkpoints to go through (not combined with a re-test)
  const plan = planSelect(templates, originOf(url));
  kind?.addEventListener('change', () => {
    const base = bases.find((s) => s.id === kind.value);
    name.value = base ? `Nachtest: ${base.name}` : injectable ? defaultName(url) : '';
    startLabel.textContent = base ? 'Nachtest auf dieser Seite starten' : 'Testlauf auf dieser Seite starten';
    retestHint.hidden = !base;
    if (base) ctx.open = true;
    if (plan) {
      plan.disabled = Boolean(base);
      if (base) plan.value = '';
    }
  });

  start.disabled = !injectable;
  start.addEventListener('click', async () => {
    start.disabled = true;
    const label = startLabel.textContent;
    startLabel.textContent = 'Startet …';
    status.replaceChildren();
    try {
      const fields = { name: name.value.trim() || defaultName(url), url, tabId: tab?.id, appContext: context.value.trim(), appVersion: version.value.trim(), templateId: plan?.value || undefined };
      if (kind?.value) await send('fl:startRetest', { ...fields, baseSessionId: kind.value });
      else await send('fl:startSession', fields);
      window.close();
    } catch (err) {
      status.replaceChildren(errorBox(err));
      startLabel.textContent = label;
      start.disabled = false;
    }
  });

  const page = injectable
    ? h('div.page', null, icon('logo', 14), h('b', { text: hostOf(url) }))
    : h('div.notice.warn', { text: 'Auf dieser Seite ist kein Testlauf möglich. Öffne die zu testende Webanwendung in diesem Tab (http/https).' });

  const form = [page, kind ? h('label.field', null, 'Art', kind) : null, retestHint, plan ? h('label.field', null, 'Testplan', plan) : null, h('label.field', null, 'Name des Testlaufs', name), ctx, start, status];
  const paused = pausedOf(sessions);
  return h(
    'div.stack',
    { style: { gap: '12px' } },
    paused ? pausedCard(paused) : h('p.muted.small.pad', { text: 'Starte einen Testlauf, klicke dich durch die Anwendung und markiere alles, was besser werden kann. Am Ende exportierst du alles als Paket für die Entwicklung.' }),
    // with a paused run, a new one is the exception: folded away
    paused ? h('details.new-run', null, h('summary', { text: 'Neuen Testlauf starten' }), h('div.stack', { style: { gap: '12px' } }, form)) : form,
    quickSection(tab, injectable, keys),
    recentList(sessions.filter((s) => s !== paused), tab),
    h('div.foot', null, h('button.btn', { type: 'button', on: { click: () => openDashboard() } }, icon('dashboard'), 'Dashboard')),
  );
}

function recentList(sessions, tab) {
  if (!sessions.length) return null;
  const items = sessions.slice(0, 4).map((s) => {
    const resume = h('button.btn.sm', { type: 'button', title: 'Testlauf fortsetzen' }, 'Fortsetzen');
    resume.addEventListener('click', async () => {
      resume.disabled = true;
      try {
        // Resumes on the session's own domains; the active view then offers to
        // add the current page explicitly if it belongs to another domain.
        await send('fl:resumeSession', { sessionId: s.id });
        await render();
      } catch (err) {
        resume.replaceWith(errorBox(err));
      }
    });
    return h(
      'li',
      null,
      h('div', null, h('b', { text: s.name }), h('span', { text: `${s.count} Anmerkung${s.count === 1 ? '' : 'en'} · ${formatDateTime(s.updatedAt)}` })),
      resume,
    );
  });
  return h('section.recent', null, h('h2', { text: 'Letzte Testläufe' }), h('ul', null, items));
}

/** A large button for marking (element, area, page) with its shortcut as keycaps. */
function actionButton(name, label, onClick, shortcut, title = label) {
  const keys = shortcutKeys(shortcut);
  return h(
    'button.action',
    { type: 'button', title: shortcut ? `${title} (${shortcut})` : title, on: { click: onClick } },
    icon(name, 22),
    h('span.label', { text: label }),
    keys.length ? h('span.keys', { 'aria-label': shortcut }, ...keys.map((k) => h(/^[⇧⌥⌘⌃]$/.test(k) ? 'kbd.sym' : 'kbd', { text: k }))) : null,
  );
}

/** Schnell-Anmerkung: one annotation straight to the clipboard (for Claude, ChatGPT …), without a test run. */
function quickSection(tab, injectable, keys) {
  const status = h('div');
  const go = (action) => async () => {
    try {
      await send('fl:quick', { action, tabId: tab.id });
      window.close();
    } catch (err) {
      status.replaceChildren(errorBox(err));
    }
  };
  const tip = 'Schnell-Anmerkung ohne Testlauf: wird nicht gespeichert, sondern mit Screenshot in die Zwischenablage kopiert';
  return h(
    'section.quick',
    null,
    h('h2', null, 'Schnell-Anmerkung', h('span', { text: 'ohne Testlauf · in die Zwischenablage' })),
    injectable
      ? h(
          'div.actions.sm',
          null,
          actionButton('pick', 'Element', go('pick'), keys['pick-element'], `${tip} – Element`),
          actionButton('region', 'Bereich', go('region'), keys['select-region'], `${tip} – Bereich`),
          actionButton('note', 'Seite', go('note'), keys['page-note'], `${tip} – ganze Seite`),
        )
      : h('p.muted.small', { text: 'Auf dieser Seite nicht möglich (z. B. Browser-Seiten oder der Web Store).' }),
    status,
  );
}

function activeView(active, tab, injectable, tabInSession, keys) {
  const status = h('div');
  const run = (act) => async () => {
    try {
      await send('fl:command', { action: act });
      window.close();
    } catch (err) {
      status.replaceChildren(errorBox(err));
    }
  };
  const action = (name, label, act, shortcut) => actionButton(name, label, run(act), shortcut);

  let body;
  if (tabInSession) {
    body = h(
      'div.actions',
      null,
      action('pick', 'Element', 'pick', keys['pick-element']),
      action('region', 'Bereich', 'region', keys['select-region']),
      action('note', 'Seiten-Notiz', 'note', keys['page-note']),
    );
  } else if (injectable) {
    const add = h('button.btn.primary.block', { type: 'button' }, icon('plus'), `${hostOf(tab.url)} zum Testlauf hinzufügen`);
    add.addEventListener('click', async () => {
      try {
        await send('fl:addOrigin', { sessionId: active.id, url: tab.url, tabId: tab.id });
        await render();
      } catch (err) {
        status.replaceChildren(errorBox(err));
      }
    });
    body = h('div.stack', null, h('div.notice', { text: 'Diese Seite gehört (noch) nicht zum laufenden Testlauf.' }), add, quickSection(tab, injectable, keys));
  } else {
    body = h('div.notice', { text: 'Wechsle in einen Tab mit der getesteten Anwendung, um Anmerkungen zu machen.' });
  }

  const stop = h('button.btn.primary.block', { type: 'button', title: 'Testlauf beenden und das Paket für die Entwicklung herunterladen' }, icon('download'), 'Beenden & exportieren');
  // without export: pausing keeps the run first in this menu, ending it does not – both can be continued
  const stopWith = (pause) => async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await send('fl:stopSession', { pause });
      await render();
    } catch (err) {
      status.replaceChildren(errorBox(err));
      btn.disabled = false;
    }
  };
  const pause = h('button.btn', { type: 'button', title: 'Erfassung und Testzeit anhalten – hier im Menü geht es mit „Fortsetzen“ weiter', on: { click: stopWith(true) } }, icon('pause'), 'Pausieren');
  const end = h('button.btn', { type: 'button', title: 'Testlauf beenden, ohne zu exportieren – exportieren oder fortsetzen geht später im Dashboard', on: { click: stopWith(false) } }, icon('stop'), 'Beenden');
  stop.addEventListener('click', async () => {
    stop.disabled = true;
    try {
      await send('fl:stopAndExport');
      window.close();
    } catch (err) {
      status.replaceChildren(errorBox(err));
      stop.disabled = false;
    }
  });

  return h(
    'div.stack',
    { style: { gap: '12px' } },
    h(
      'div.session',
      null,
      h('div.title', null, h('span.dot-live'), h('span', { text: active.name })),
      h('div.meta', { text: `${active.retestOf ? `Nachtest von „${active.retestOf.name}“ · ` : ''}${active.count} Anmerkung${active.count === 1 ? '' : 'en'} · gestartet ${formatTime(active.createdAt)} · ${active.origins.map(hostOf).join(', ')}` }),
    ),
    body,
    status,
    h('div.foot', null, h('button.btn', { type: 'button', on: { click: () => openDashboard(active.id) } }, icon('dashboard'), 'Dashboard'), pause, end),
    stop,
    tabInSession ? h('p.shortcuts', { text: 'Tipp: Mit den Tastenkürzeln lassen sich auch aufgeklappte Menüs und Hover-Zustände markieren.' }) : null,
  );
}

async function openDashboard(sessionId) {
  await send('fl:openDashboard', { sessionId });
  window.close();
}

render().catch((err) => app.replaceChildren(errorBox(err)));
