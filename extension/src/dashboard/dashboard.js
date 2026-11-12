import { C, categoryOf, priorityOf, formatDateTime, formatTime, hostOf, pathOf, annotationTitle, bytesToSize, originOf, safeUrl, shortcutKeys, testTimeText, sectionsText, IDLE_MS } from '../lib/util.js';
import { h, icon, send, copyText, downloadBlob } from '../lib/dom.js';
import { renderMarkdown } from '../lib/markdown.js';
import { loadBundle, bundleTestTime, extrasOf, buildPreviewHtml, loadImages, loadPlanImages, planState, buildMarkdown, buildJson, buildHtml, buildZip, exportBaseName, issueParts, issueMarkdown, imageFiles, trailEntryText, techEventText, techEventLabel, retestState, retestIssueMarkdown, comparisonLines, verdictOf, parseDevResults } from '../lib/report.js';
import { parsePlan, serializePlan, serializeItems } from '../lib/testplan.js';

const K = C.KEYS;
const $main = document.getElementById('main');
const $sessions = document.getElementById('session-list');
const $modal = document.getElementById('modal');
const $toast = document.getElementById('toast');

const params = new URLSearchParams(location.search);
const state = {
  sessions: [],
  activeId: null,
  selectedId: params.get('session'),
  focusAnnotation: params.get('annotation'),
  exportOnLoad: params.get('export') === 'zip',
  bundle: null,
  thumbs: new Map(), // `${annotationId}@${updatedAt}` -> {crop, full}
  tab: 'annotations',
  filters: { q: '', category: '', priority: '', status: '', sort: 'number' },
  cards: new Map(), // annotationId -> {el, stamp}
  picked: new Set(), // annotation numbers chosen for a partial export
  view: 'session', // or 'plans' (test plan templates)
  templates: [],
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

let toastTimer;
function toast(text, kind = 'info', ms = 3200) {
  $toast.textContent = text;
  $toast.className = `toast show ${kind === 'error' ? 'error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($toast.className = 'toast'), ms);
}

function debounce(fn, ms) {
  let t;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.flush = (...args) => {
    clearTimeout(t);
    fn(...args);
  };
  return wrapped;
}

const pl = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function pillSelect(options, value, color, onChange, label) {
  const select = h('select', { 'aria-label': label }, options.map((o) => h('option', { value: o.id, text: o.label })));
  select.value = value;
  const wrap = h('span.pill-select', { style: { '--c': color(value) } }, select);
  select.addEventListener('change', () => {
    wrap.style.setProperty('--c', color(select.value));
    onChange(select.value);
  });
  return wrap;
}

function menuButton(label, iconName, items) {
  const wrap = h('div.menu-wrap');
  const btn = h('button.btn', { type: 'button', 'aria-haspopup': 'menu' }, icon(iconName), label);
  let menu = null;
  const close = () => {
    menu?.remove();
    menu = null;
    document.removeEventListener('pointerdown', outside, true);
  };
  const outside = (e) => {
    if (!wrap.contains(e.target)) close();
  };
  btn.addEventListener('click', () => {
    if (menu) return close();
    menu = h(
      'div.menu',
      { role: 'menu' },
      items.map((it) =>
        it === '-'
          ? h('hr')
          : h('button', { type: 'button', role: 'menuitem', on: { click: () => (close(), it.run()) } }, icon(it.icon, 18), h('b', { text: it.label }), h('span', { text: it.hint })),
      ),
    );
    wrap.append(menu);
    document.addEventListener('pointerdown', outside, true);
  });
  wrap.append(btn);
  return wrap;
}

// ---------------------------------------------------------------------------
// Modal helpers
// ---------------------------------------------------------------------------

function openModal(content, { wide = false } = {}) {
  $modal.className = `modal ${wide ? 'wide' : ''}`;
  $modal.replaceChildren(content);
  if (!$modal.open) $modal.showModal();
}

function closeModal() {
  if ($modal.open) $modal.close();
  $modal.replaceChildren();
}

$modal.addEventListener('click', (e) => {
  if (e.target === $modal) closeModal(); // click on backdrop
});

function confirmDialog({ title, text, confirm = 'Löschen', danger = true }) {
  return new Promise((resolve) => {
    const ok = h(`button.btn.${danger ? 'danger' : 'primary'}`, { type: 'button', text: confirm });
    const cancel = h('button.btn', { type: 'button', text: 'Abbrechen' });
    const done = (v) => {
      closeModal();
      resolve(v);
    };
    ok.addEventListener('click', () => done(true));
    cancel.addEventListener('click', () => done(false));
    // Ignore a close event still queued from a previous dialog: it fires while this one is already open.
    const onClose = () => {
      if ($modal.open) return;
      $modal.removeEventListener('close', onClose);
      resolve(false);
    };
    $modal.addEventListener('close', onClose);
    openModal(h('div', null, h('div.modal-head', null, h('h2', { text: title })), h('div.modal-body', null, h('p', { text, style: { margin: 0 } })), h('div.modal-foot', null, cancel, ok)));
    ok.focus();
  });
}

function modalHead(title) {
  return h('div.modal-head', null, h('h2', { text: title }), h('button.icon-btn', { type: 'button', 'aria-label': 'Schließen', on: { click: closeModal } }, icon('close', 18)));
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function loadSessions() {
  const store = await chrome.storage.local.get([K.sessions, K.active]);
  state.sessions = store[K.sessions] || [];
  state.activeId = store[K.active] || null;
  if (!state.sessions.find((s) => s.id === state.selectedId)) state.selectedId = state.sessions[0]?.id || null;
}

async function loadSelected() {
  state.bundle = state.selectedId ? await loadBundle(state.selectedId) : null;
}

async function thumbsFor(a) {
  const key = `${a.id}@${a.updatedAt}`; // images can be replaced (nachzeichnen)
  if (!state.thumbs.has(key)) {
    const imgs = await loadImages([a]);
    state.thumbs.set(key, imgs.get(a.id));
  }
  return state.thumbs.get(key);
}

const session = () => state.bundle?.session;
const isActive = () => session()?.id === state.activeId;

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function renderSidebar() {
  if (!state.sessions.length) {
    $sessions.replaceChildren(h('p.empty-side', { text: 'Noch keine Testläufe.' }));
    return;
  }
  $sessions.replaceChildren(
    ...state.sessions.map((s) =>
      h(
        `button.session-item${s.id === state.selectedId && state.view === 'session' ? '.sel' : ''}`,
        { type: 'button', on: { click: () => selectSession(s.id) } },
        h('span.name', null, s.id === state.activeId ? h('i.dot-live', { title: 'Läuft gerade' }) : null, h('span', { text: s.name })),
        h('span.sub', { text: `${pl(s.count, 'Anmerkung', 'Anmerkungen')} · ${s.pausedAt && s.id !== state.activeId ? 'pausiert' : formatDateTime(s.createdAt)}` }),
      ),
    ),
  );
  document.getElementById('btn-plans').classList.toggle('sel', state.view === 'plans');
  chrome.storage.local.getBytesInUse(null).then((bytes) => {
    document.getElementById('storage-usage').textContent = `Lokal gespeichert: ${bytesToSize(bytes)}`;
  });
}

async function selectSession(id, { annotationId } = {}) {
  state.view = 'session';
  state.selectedId = id;
  state.focusAnnotation = annotationId || null;
  state.cards.clear();
  state.picked.clear();
  state.tab = 'annotations';
  history.replaceState(null, '', `?session=${encodeURIComponent(id)}`);
  await loadSelected();
  renderSidebar();
  renderMain();
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

function renderMain() {
  if (state.view === 'plans') {
    $main.replaceChildren(plansView());
    return;
  }
  if (!state.bundle) {
    $main.replaceChildren(welcome());
    return;
  }
  const page = h('div.page', null, sessionHead(), statsRow(), state.bundle.testPlan ? planCard() : null, contextCard(), tabsBar(), h('div', { id: 'panel' }));
  $main.replaceChildren(page);
  renderPanel();
}

function welcome() {
  const step = (n, title, text) => h('div.card', null, h('b', { text: String(n) }), h('h3', { text: title }), h('p', { text }));
  return h(
    'div.welcome',
    null,
    h('h1', { text: 'Willkommen bei Feedback Lens' }),
    h('p', { text: 'Teste eine Webanwendung, halte Verbesserungspotenzial direkt am Element fest und gib das Ergebnis als sauberes Paket an die Entwicklung – bereit für Claude Code.' }),
    h(
      'div.steps',
      null,
      step(1, 'Testlauf starten', 'Öffne die Webanwendung, klicke auf das Feedback-Lens-Symbol in der Browserleiste und starte einen Testlauf.'),
      step(2, 'Anmerken', 'Markiere Elemente oder Bereiche über die Leiste oder per Tastenkürzel (Alt+Shift+E / Alt+Shift+D) und beschreibe, was dich stört. Screenshot und Technik-Kontext kommen automatisch dazu.'),
      step(3, 'Exportieren', 'Lade nach dem Testlauf das Paket (.zip) herunter: Übersicht mit Checkliste, eine Datei pro Anmerkung, Screenshots, Klickpfad – alles lokal.'),
    ),
    h('p.muted.small', { style: { marginTop: '24px' }, text: 'Tipp: Erweiterung in der Browserleiste anpinnen (Puzzle-Symbol → Pin), damit sie immer griffbereit ist.' }),
  );
}

function sessionHead() {
  const s = session();
  const title = h('input.title-input', { type: 'text', value: s.name, 'aria-label': 'Name des Testlaufs' });
  const saveName = debounce(() => {
    const name = title.value.trim();
    if (name && name !== s.name) send('fl:updateSession', { sessionId: s.id, patch: { name } }).catch((e) => toast(e.message, 'error'));
  }, 700);
  title.addEventListener('input', saveName);
  title.addEventListener('blur', () => saveName.flush());

  const tt = bundleTestTime(state.bundle);
  const ttTitle = [
    tt.sections.length > 1 ? `Abschnitte:\n${sectionsText(tt).join('\n')}` : '',
    tt.idle ? `Lücken über ${IDLE_MS / 60_000} Min. ohne Aktivität zählen als Pause.` : '',
    tt.estimated && tt.idle ? 'Ältere Testläufe: Pausen geschätzt.' : '',
  ].filter(Boolean).join('\n\n');
  const meta = h(
    'div.s-meta',
    null,
    isActive() ? h('span.live', null, h('i.dot-live'), 'Läuft gerade') : h('span', { text: s.pausedAt ? `Pausiert seit ${formatDateTime(s.pausedAt)}` : `Beendet ${formatDateTime(s.endedAt)}` }),
    h('span', { text: `Start ${formatDateTime(s.createdAt)}` }),
    h('span', { text: `Testzeit ${testTimeText(tt)}`, title: ttTitle || null }),
    h('span', { text: s.origins.map(hostOf).join(', ') }),
    s.retestOf ? retestOrigin(s.retestOf) : null,
  );

  const runToggle = isActive()
    ? [
        h('button.btn', { type: 'button', title: 'Erfassung und Testzeit anhalten – im Menü der Erweiterung geht es mit „Fortsetzen“ weiter', on: { click: () => stopSession({ pause: true }) } }, icon('pause'), 'Pausieren'),
        h('button.btn', { type: 'button', on: { click: () => stopSession() } }, icon('stop'), 'Beenden'),
      ]
    : h('button.btn', { type: 'button', on: { click: resumeSession } }, icon('play'), 'Fortsetzen');

  const exportMenu = menuButton('Weitere Formate', 'file', [
    { icon: 'copy', label: 'Als Markdown kopieren', hint: 'Alle Anmerkungen als ein Text, z. B. für ein Ticket oder Wiki (ohne Bilder)', run: copyMarkdown },
    { icon: 'file', label: 'HTML-Bericht', hint: 'Zum Lesen und Teilen, mit Bildern; im Browser als PDF druckbar', run: exportHtml },
    { icon: 'file', label: 'JSON (maschinenlesbar)', hint: 'Alle Daten ohne Bilder, z. B. für Skripte oder Ticket-Import', run: exportJson },
    '-',
    { icon: 'upload', label: 'Sicherung (.json mit Bildern)', hint: 'Vollständig, später über „Importieren“ wiederherstellbar', run: exportBackup },
  ]);

  const more = menuButton('', 'settings', [
    { icon: 'play', label: 'Nachtest starten', hint: 'Die Anmerkungen dieses Testlaufs in einer neueren Version der Anwendung prüfen', run: openRetestDialog },
    { icon: 'upload', label: 'Ergebnisse der Entwicklung einlesen', hint: 'README.md aus dem bearbeiteten Paket: zeigt je Anmerkung, was laut Entwicklung erledigt ist', run: importDevResults },
    '-',
    { icon: 'trash', label: 'Testlauf löschen', hint: 'Entfernt Anmerkungen, Screenshots und Verlauf endgültig', run: deleteSession },
  ]);
  more.querySelector('button').setAttribute('aria-label', 'Weitere Aktionen');

  return h(
    'header.s-head',
    null,
    h('div.s-title', null, title, meta),
    h(
      'div.s-actions',
      null,
      runToggle,
      h('button.btn', { type: 'button', title: 'So sieht bericht.html im Export aus – ohne zu exportieren', on: { click: () => openPreview() } }, icon('eye'), 'Bericht ansehen'),
      h('button.btn.primary', { type: 'button', title: 'README mit Checkliste, eine Datei pro Anmerkung, Screenshots, Klickpfad, JSON, HTML – mit Nachricht an die Entwicklung', on: { click: () => openExportDialog() } }, icon('download'), 'Exportieren (.zip)'),
      exportMenu,
      more,
    ),
  );
}

function retestOrigin(r) {
  const base = state.sessions.find((x) => x.id === r.sessionId);
  const label = `Nachtest von „${r.name}“${r.appVersion ? ` (${r.appVersion})` : ''}`;
  return base ? h('a.link', { href: '#', text: label, on: { click: (e) => (e.preventDefault(), selectSession(base.id)) } }) : h('span', { text: label });
}

function retestStats() {
  const st = retestState(state.bundle);
  const total = st.items.length || 1;
  const bar = h('div.bar', null, C.VERDICTS.map((v) => h('i', { title: v.label, style: { width: `${(st.items.filter((x) => x.check?.retest.verdict === v.id).length / total) * 100}%`, background: v.color } })));
  const stat = (n, label, extra = null) => h('div.card.stat', null, h('b', { text: String(n) }), h('span', { text: label }), extra);
  return h(
    'div.stats',
    null,
    stat(`${st.items.length - st.unchecked.length}/${st.items.length}`, 'nachgeprüft', bar),
    stat(st.fixed.length, 'behoben'),
    stat(st.open.length + st.changed.length, 'noch offen (besteht weiter / verändert)'),
    stat(st.fresh.length, 'neu gefunden'),
  );
}

function statsRow() {
  if (state.bundle.plan) return retestStats();
  const list = state.bundle.annotations;
  const total = list.length || 1;
  const bar = (items, colorOf, key) =>
    h(
      'div.bar',
      null,
      items.filter((it) => list.some((a) => a[key] === it.id)).map((it) => h('i', { title: it.label, style: { width: `${(list.filter((a) => a[key] === it.id).length / total) * 100}%`, background: colorOf(it) } })),
    );
  const open = list.filter((a) => a.status === 'open' || !a.status).length;
  const severe = list.filter((a) => a.priority === 'critical' || a.priority === 'high').length;
  const errors = state.bundle.tech.filter((e) => e.type !== 'slow').length;
  return h(
    'div.stats',
    null,
    h('div.card.stat', null, h('b', { text: String(list.length) }), h('span', { text: `Anmerkungen · ${open} offen` }), bar(C.CATEGORIES, (c) => c.color, 'category')),
    h('div.card.stat', null, h('b', { text: String(severe) }), h('span', { text: 'hoch / kritisch' }), bar(C.PRIORITIES.slice().reverse(), (p) => p.color, 'priority')),
    h('div.card.stat', null, h('b', { text: String(new Set(list.map((a) => a.page && pathOf(a.page.url))).size) }), h('span', { text: 'betroffene Seiten' })),
    h('div.card.stat', null, h('b', { text: String(errors) }), h('span', { text: 'technische Fehler erfasst' })),
  );
}

function contextCard() {
  const s = session();
  const ta = h('textarea', { placeholder: 'Was ist das für eine Anwendung, wer nutzt sie, was war das Ziel des Tests? Welche Umgebung (z. B. Staging)? Steht im Export ganz oben.', 'aria-label': 'Kontext zum Test' });
  ta.value = s.appContext || '';
  const version = h('input.input', { type: 'text', placeholder: 'z. B. 2.3.1, Commit a1b2c3d oder „Staging vom 28.10.“', 'aria-label': 'Version, Build oder Commit' });
  version.value = s.appVersion || '';
  const note = h('textarea', { rows: 3, placeholder: NOTE_PLACEHOLDER, 'aria-label': 'Nachricht an die Entwicklung' });
  note.value = s.handoffNote || '';
  const save = debounce(() => send('fl:updateSession', { sessionId: s.id, patch: { appContext: ta.value, appVersion: version.value, handoffNote: note.value } }).catch((e) => toast(e.message, 'error')), 800);
  for (const field of [ta, version, note]) {
    field.addEventListener('input', save);
    field.addEventListener('blur', () => save.flush());
  }

  const chips = s.origins.map((o) =>
    h(
      'span.origin-chip',
      null,
      o,
      s.origins.length > 1
        ? h('button', { type: 'button', title: 'Entfernen', 'aria-label': `${o} entfernen`, text: '×', on: { click: () => send('fl:updateSession', { sessionId: s.id, patch: { origins: s.origins.filter((x) => x !== o) } }) } })
        : null,
    ),
  );
  const add = h('button.btn.sm.ghost', { type: 'button' }, icon('plus', 14), 'Domain');
  add.addEventListener('click', () => {
    const input = h('input.input', { type: 'url', placeholder: 'https://login.example.com', style: { width: '260px', padding: '4px 8px' } });
    const commit = async () => {
      const origin = originOf(input.value.trim());
      if (origin) await send('fl:updateSession', { sessionId: s.id, patch: { origins: [...s.origins, origin] } }).catch((e) => toast(e.message, 'error'));
      else if (input.value.trim()) toast('Bitte eine vollständige Adresse mit http(s):// angeben.', 'error');
      input.replaceWith(add);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') input.replaceWith(add);
    });
    input.addEventListener('blur', commit);
    add.replaceWith(input);
    input.focus();
  });

  return h(
    'details.card.context',
    { open: !s.appContext },
    h('summary', null, 'Kontext zum Test', h('span', { text: s.appContext ? 'hinterlegt ✓' : 'empfohlen' })),
    ta,
    h('label.version', null, h('span', { text: 'Version / Build / Commit' }), version),
    h('label.handoff', null, h('span', null, 'Nachricht an die Entwicklung ', h('small', { text: '– steht im Export ganz oben, Claude Code liest sie zuerst' })), note),
    h('div.origins', null, 'Getestete Domains:', chips, add),
  );
}

function tabsBar() {
  const b = state.bundle;
  const tab = (id, label, count, iconName) =>
    h(`button.tab${state.tab === id ? '.sel' : ''}`, { type: 'button', role: 'tab', 'aria-selected': String(state.tab === id), on: { click: () => switchTab(id) } }, icon(iconName, 15), label, count !== null ? h('span.count', { text: String(count) }) : null);
  return h(
    'nav.tabs',
    { role: 'tablist' },
    tab('annotations', 'Anmerkungen', b.annotations.length, 'note'),
    tab('trail', 'Klickpfad', b.trail.length, 'route'),
    tab('tech', 'Technik', b.tech.length, 'alert'),
  );
}

function switchTab(id) {
  state.tab = id;
  const page = $main.querySelector('.page');
  if (!page) return;
  page.querySelector('.tabs').replaceWith(tabsBar());
  renderPanel();
}

function renderPanel() {
  const panel = document.getElementById('panel');
  if (!panel) return;
  state.cards.clear();
  const views = { annotations: annotationsPanel, trail: trailPanel, tech: techPanel };
  panel.replaceChildren(views[state.tab]());
  if (state.tab === 'annotations') refreshCards();
}

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

function annotationsPanel() {
  const f = state.filters;
  const search = h('input.input', { type: 'search', placeholder: 'Suchen in Titel, Beschreibung, Seite, Selektor …', value: f.q });
  search.addEventListener('input', debounce(() => ((f.q = search.value.trim().toLowerCase()), refreshCards()), 200));
  const sel = (key, label, options) => {
    const s = h('select', { 'aria-label': label }, h('option', { value: '', text: label }), options.map((o) => h('option', { value: o.id, text: o.label })));
    s.value = f[key];
    s.addEventListener('change', () => ((f[key] = s.value), refreshCards()));
    return s;
  };
  const sort = h('select', { 'aria-label': 'Sortierung' }, h('option', { value: 'number', text: 'Reihenfolge' }), h('option', { value: 'priority', text: 'Priorität' }), h('option', { value: 'category', text: 'Kategorie' }), h('option', { value: 'page', text: 'Seite' }));
  sort.value = f.sort;
  sort.addEventListener('change', () => ((f.sort = sort.value), refreshCards()));
  return h(
    'div',
    null,
    h('div.filters', null, h('div.search', null, icon('search', 15), search), sel('category', 'Alle Kategorien', C.CATEGORIES), sel('priority', 'Alle Prioritäten', C.PRIORITIES.slice().reverse()), sel('status', 'Alle Status', C.STATUSES), sort),
    h('div.pickbar', { id: 'pickbar', hidden: true }),
    h('div.ann-list', { id: 'ann-list' }),
    h('div', { id: 'unchecked' }),
  );
}

/** Partial export: the bar appears as soon as one annotation is ticked. */
function renderPickbar() {
  const bar = document.getElementById('pickbar');
  if (!bar) return;
  const numbers = new Set(state.bundle.annotations.map((a) => a.number));
  for (const n of [...state.picked]) if (!numbers.has(n)) state.picked.delete(n);
  bar.hidden = !state.picked.size;
  if (bar.hidden) return bar.replaceChildren();
  const visible = filteredAnnotations();
  bar.replaceChildren(
    h('b', { text: `${state.picked.size} von ${state.bundle.annotations.length} ausgewählt` }),
    visible.some((a) => !state.picked.has(a.number))
      ? h('button.btn.sm.ghost', { type: 'button', text: `Alle angezeigten (${visible.length})`, on: { click: () => (visible.forEach((a) => state.picked.add(a.number)), syncPicks()) } })
      : null,
    h('button.btn.sm.ghost', { type: 'button', text: 'Auswahl aufheben', on: { click: () => (state.picked.clear(), syncPicks()) } }),
    h('span.grow'),
    h('button.btn.sm.primary', { type: 'button', title: 'Paket nur mit den ausgewählten Anmerkungen', on: { click: () => openExportDialog({ only: [...state.picked] }) } }, icon('download', 15), 'Nur Auswahl exportieren (.zip)'),
  );
}

function syncPicks() {
  for (const box of document.querySelectorAll('#ann-list input[data-pick]')) box.checked = state.picked.has(Number(box.dataset.pick));
  renderPickbar();
}

/** Re-test: earlier annotations nobody has looked at yet. */
function renderUnchecked() {
  const box = document.getElementById('unchecked');
  if (!box) return;
  const items = state.bundle.plan ? retestState(state.bundle).unchecked : [];
  if (!items.length) return box.replaceChildren();
  box.replaceChildren(
    h(
      'section.card.unchecked',
      null,
      h('h3', { text: `Noch nicht nachgeprüft (${items.length})` }),
      h('p.small.muted', { text: 'Im Nachtest über die Liste in der Leiste bewerten (Symbol mit Häkchen).' }),
      h('ul', null, items.map(({ item }) => h('li', null, h('span.num', { text: `#${item.number}` }), h('span', { text: item.title }), h('code', { text: pathOf(item.url || '') })))),
    ),
  );
}

function filteredAnnotations() {
  const f = state.filters;
  const list = state.bundle.annotations.filter((a) => {
    if (f.category && a.category !== f.category) return false;
    if (f.priority && a.priority !== f.priority) return false;
    if (f.status && (a.status || 'open') !== f.status) return false;
    if (f.q) {
      const hay = [a.title, a.description, a.expected, a.page?.url, a.page?.title, a.element?.selector, a.element?.text, `#${a.number}`].join(' ').toLowerCase();
      if (!hay.includes(f.q)) return false;
    }
    return true;
  });
  const rank = (a) => -priorityOf(a.priority).rank;
  const sorters = {
    number: (a, b) => a.number - b.number,
    priority: (a, b) => rank(a) - rank(b) || a.number - b.number,
    category: (a, b) => C.CATEGORIES.indexOf(categoryOf(a.category)) - C.CATEGORIES.indexOf(categoryOf(b.category)) || a.number - b.number,
    page: (a, b) => (a.page?.url || '').localeCompare(b.page?.url || '') || a.number - b.number,
  };
  return list.sort(sorters[f.sort] || sorters.number);
}

const cardStamp = (a) => a.updatedAt;

/** Keyed re-render that keeps the card the user is typing in untouched. */
function refreshCards() {
  const listEl = document.getElementById('ann-list');
  if (!listEl) return;
  renderUnchecked();
  renderPickbar();
  const list = filteredAnnotations();
  if (!list.length) {
    state.cards.clear();
    listEl.replaceChildren(
      h('div.card.empty', null, icon('note', 40), h('p', { text: state.bundle.annotations.length ? 'Keine Anmerkung passt zu den Filtern.' : 'Noch keine Anmerkungen. Öffne die Anwendung und markiere Elemente über die Feedback-Lens-Leiste.' })),
    );
    return;
  }
  // only typing protects a card from being redrawn (a focused button, e.g. after a dialog, does not)
  const focused = document.activeElement?.matches?.('input:not([type=checkbox]), textarea, select, [contenteditable]') ? document.activeElement : null;
  const next = new Map();
  const els = list.map((a) => {
    const cached = state.cards.get(a.id);
    const stamp = cardStamp(a);
    if (cached && (cached.stamp === stamp || (focused && cached.el.contains(focused)))) {
      next.set(a.id, cached);
      return cached.el;
    }
    const el = annotationCard(a);
    next.set(a.id, { el, stamp });
    if (cached) cached.el.replaceWith(el);
    return el;
  });
  state.cards = next;
  const current = Array.from(listEl.children);
  if (current.length !== els.length || current.some((el, i) => el !== els[i])) listEl.replaceChildren(...els);

  if (state.focusAnnotation) {
    const target = next.get(state.focusAnnotation)?.el;
    state.focusAnnotation = null;
    if (target) {
      requestAnimationFrame(() => {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        target.classList.add('flash');
        setTimeout(() => target.classList.remove('flash'), 2200);
      });
    }
  }
}

function annotationCard(a) {
  const s = session();
  const update = (patch) => trackSave(send('fl:updateAnnotation', { sessionId: s.id, id: a.id, patch }).catch((e) => toast(e.message, 'error')));

  // media
  const thumb = h('button.thumb', { type: 'button', 'aria-label': `Screenshot zu #${a.number} vergrößern` });
  const media = h('div.ann-media', null, thumb);
  if (a.images?.crop || a.images?.full) {
    thumbsFor(a).then((imgs) => {
      const src = imgs?.crop || imgs?.full;
      if (src) thumb.append(h('img', { src, alt: `Screenshot zu #${a.number}`, loading: 'lazy' }), a.retest ? h('span.tag', { text: 'nachher' }) : null);
    });
    thumb.addEventListener('click', () => openLightbox(a.id));
    const numbers = (a.images?.clicks || []).filter((c) => c.n).length + (a.images?.numbers || []).length;
    media.append(
      h(
        'div.media-meta',
        null,
        h('span', { text: [a.kind === 'page' ? 'gesamte Ansicht' : 'Ausschnitt', a.images?.drawn && 'mit Markierungen', numbers && `${numbers} ${numbers === 1 ? 'Nummer' : 'Nummern'}`, a.images?.redacted && 'geschwärzt'].filter(Boolean).join(' · ') }),
        h('span.media-links', null, h('a', { href: '#', text: 'vergrößern', on: { click: (e) => (e.preventDefault(), openLightbox(a.id)) } }), h('a', { href: '#', text: 'nachzeichnen', title: 'Markieren, nummerieren, schwärzen', on: { click: (e) => (e.preventDefault(), editShot(a)) } })),
      ),
    );
  } else {
    thumb.classList.add('empty');
    thumb.textContent = 'Kein Screenshot';
  }
  if (!a.retest) media.append(extrasGrid(a));

  // header row
  const pick = h('input', { type: 'checkbox', 'aria-label': `Anmerkung #${a.number} für einen Teil-Export auswählen`, checked: state.picked.has(a.number) });
  pick.dataset.pick = a.number;
  pick.addEventListener('change', () => {
    if (pick.checked) state.picked.add(a.number);
    else state.picked.delete(a.number);
    renderPickbar();
  });
  const top = h(
    'div.ann-top',
    null,
    h('label.pick', { title: 'Für einen Teil-Export auswählen' }, pick),
    h('span.num', { text: `#${a.number}`, title: `erfasst ${formatDateTime(a.createdAt)}` }),
    pillSelect(C.CATEGORIES, a.category, (id) => categoryOf(id).color, (v) => update({ category: v }), 'Kategorie'),
    pillSelect(C.PRIORITIES, a.priority, (id) => priorityOf(id).color, (v) => update({ priority: v }), 'Priorität'),
    a.retest
      ? pillSelect(C.VERDICTS, a.retest.verdict, (id) => verdictOf(id).color, (v) => update({ verdict: v }), 'Ergebnis im Nachtest')
      : pillSelect(C.STATUSES, a.status || 'open', (id) => (id === 'done' ? '#16a34a' : id === 'wontfix' ? '#64748b' : '#4f46e5'), (v) => update({ status: v }), 'Status'),
    state.bundle.plan && !a.retest ? h('span.tag-new', { text: 'neu im Nachtest' }) : null,
    a.planItem && state.bundle.testPlan ? h('span.tag-plan', { text: `Prüfpunkt ${a.planItem.slice(1)}`, title: state.bundle.testPlan.items.find((it) => it.id === a.planItem)?.title || '' }) : null,
    h(
      'span.ann-tools',
      null,
      h('span.when', { text: formatDateTime(a.createdAt) }),
      h('button.icon-btn', { type: 'button', title: 'Als Markdown kopieren (z. B. für ein Ticket)', 'aria-label': `Anmerkung #${a.number} als Markdown kopieren`, on: { click: () => copyAnnotation(a) } }, icon('copy', 16)),
      h('button.icon-btn', { type: 'button', title: 'Anmerkung löschen', 'aria-label': `Anmerkung #${a.number} löschen`, on: { click: () => deleteAnnotation(a) } }, icon('trash', 16)),
    ),
  );

  // editable text
  const title = h('input.ann-title', { type: 'text', value: a.title || '', placeholder: annotationTitle(a), 'aria-label': 'Titel' });
  const desc = h('textarea', { 'aria-label': 'Beschreibung' });
  desc.value = a.description || '';
  const exp = h('textarea', { 'aria-label': 'Erwartung', placeholder: '–' });
  exp.value = a.expected || '';
  const saveText = debounce(() => update({ title: title.value.trim(), description: desc.value, expected: exp.value }), 700);
  for (const el of [title, desc, exp]) {
    el.addEventListener('input', saveText);
    el.addEventListener('blur', () => saveText.flush());
  }

  // notes to the numbers on the screenshot (editable; they travel with the export)
  const marks = [
    ...(a.images?.clicks || []).filter((c) => c.n).map((c) => ({ n: c.n, label: `Klick auf ${c.label ? `„${c.label}“` : c.role || 'ein Element'}`, note: c.note || '' })),
    ...(a.images?.numbers || []).map((x) => (typeof x === 'number' ? { n: x } : x)).map((x) => ({ n: x.n, label: '', note: x.note || '' })),
  ].sort((x, y) => x.n - y.n);
  let numberNotes = null;
  if (marks.length) {
    const pending = {};
    const saveNotes = debounce(() => {
      const patch = { numberNotes: { ...pending } };
      for (const k of Object.keys(pending)) delete pending[k];
      update(patch);
    }, 700);
    numberNotes = h(
      'div.num-notes',
      null,
      h('div.num-notes-head', { text: 'Zu den Nummern im Screenshot' }),
      marks.map((m) => {
        const input = h('input.input', { type: 'text', value: m.note, maxlength: '300', placeholder: m.label ? 'Kommentar dazu (optional)' : 'Was ist hier?', 'aria-label': `Notiz zu Nummer ${m.n}` });
        input.addEventListener('input', () => {
          pending[m.n] = input.value;
          saveNotes();
        });
        input.addEventListener('blur', () => saveNotes.flush());
        return h('div.num-note', null, h('b', { text: Marks.ordinal(m.n) }), h('div', null, m.label ? h('small', { text: m.label }) : null, input));
      }),
    );
  }

  // where
  const where = h('div.where');
  if (a.page?.url) where.append(h('a', { href: safeUrl(a.page.url), target: '_blank', rel: 'noopener', title: a.page.url }, icon('link', 14), a.page.title ? `${a.page.title} (${pathOf(a.page.url)})` : pathOf(a.page.url)));
  const selector = a.element?.selector || a.region?.container?.selector;
  if (selector) {
    where.append(
      h('span', null, icon(a.kind === 'region' ? 'region' : 'pick', 14), h('code', { text: selector, title: selector }), h('button.copy-btn', { type: 'button', title: 'Selektor kopieren', on: { click: async () => (await copyText(selector), toast('Selektor kopiert')) } }, icon('copy', 13))),
    );
  }
  if (a.component?.framework) where.append(h('span', { title: a.component.source || '' }, icon('file', 14), `${a.component.components?.[0] || a.component.framework}${a.component.source ? ` · ${a.component.source.split('/').slice(-2).join('/')}` : ''}`));

  // re-test: the earlier observation and what the browser measured before/after
  const item = a.retest ? state.bundle.plan?.find((p) => p.number === a.retest.number) : null;
  const origin = item
    ? h(
        'div.orig',
        null,
        h('b', { text: 'Ursprünglich: ' }),
        item.description || item.title,
        ...comparisonLines(a, item, state.bundle).map((l) => h('div.cmp', { text: l.replace(/^- /, '').replace(/\*\*/g, '').replace(/`/g, '') })),
      )
    : null;
  if (item && (item.images?.crop || item.images?.full)) {
    const before = h('button.thumb.before', { type: 'button', 'aria-label': `Screenshot vorher zu #${a.number}` });
    thumbsFor(item).then((imgs) => {
      const src = imgs?.crop || imgs?.full;
      if (src) before.append(h('img', { src, alt: `Vorher #${a.number}` }), h('span.tag', { text: 'vorher' }));
      before.addEventListener('click', () => src && openImage(src, `#${a.number} – vorher`));
    });
    media.prepend(before);
  }
  const dev = a.devResult || item?.devResult;
  const devChip = dev
    ? h('div.dev', null, h('b', { text: `Entwicklung: ${C.DEV_RESULTS.find((r) => r.id === dev.result)?.label || dev.result}` }), dev.notes?.length ? h('span', { text: ` – ${dev.notes.join(' · ')}` }) : null)
    : null;

  // warnings
  const warns = [];
  if (a.element?.contrast && !a.element.contrast.passesAA) warns.push(`Kontrast ${a.element.contrast.ratio.toLocaleString('de-DE')}:1`);
  for (const hint of a.element?.hints || []) if (!hint.startsWith('Kontrast')) warns.push(hint.replace(/\s*\(.*\)\.?$/, '').replace(/\.$/, ''));
  const errs = (a.techEvents || []).filter((e) => e.type !== 'slow').length;
  if (errs) warns.push(`${pl(errs, 'technischer Fehler', 'technische Fehler')} auf der Seite`);

  // technical details (rendered lazily)
  const techBody = h('div.tech-body.md');
  const tech = h('details.tech', null, h('summary', { text: 'Schritte, Suchbegriffe & technischer Kontext (so steht es im Export)' }), techBody);
  tech.addEventListener('toggle', () => {
    if (!tech.open || techBody.childElementCount) return;
    if (item) {
      techBody.innerHTML = renderMarkdown(retestIssueMarkdown(a, item, state.bundle, { level: 3 }));
      return;
    }
    const parts = issueParts(a, state.bundle, { level: 3 });
    techBody.innerHTML = renderMarkdown([...parts.where, ...parts.steps, ...parts.followup, ...parts.search, ...parts.auto].join('\n'));
  });

  const card = h(
    `article.card.ann${a.status && a.status !== 'open' ? '.done' : ''}`,
    { id: `ann-${a.id}` },
    media,
    h(
      'div.ann-body',
      null,
      top,
      title,
      origin,
      h('div.ann-text', null, h('label', null, a.retest ? 'Kommentar im Nachtest' : 'Beobachtung', desc), h('label', null, 'Erwartung / Idee', exp)),
      numberNotes,
      devChip,
      where,
      warns.length ? h('div.warns', null, warns.slice(0, 5).map((w) => h('span.warn-chip', { text: w }))) : null,
      tech,
    ),
  );
  return card;
}

async function copyAnnotation(a) {
  await flushEdits();
  const bundle = await loadBundle(a.sessionId);
  const fresh = bundle.annotations.find((x) => x.id === a.id) || a;
  const item = fresh.retest ? bundle.plan?.find((p) => p.number === fresh.retest.number) : null;
  const files = imageFiles(fresh, await loadImages([fresh]), item ? 'nachher' : '');
  const shots = [files.crop, files.full].filter(Boolean);
  const body = item ? retestIssueMarkdown(fresh, item, bundle, { level: 2, noteExcerpt: true }) : issueMarkdown(fresh, bundle, { level: 2, noteExcerpt: true });
  const md = body + (shots.length ? `\n_Screenshots im Export-Paket: ${shots.map((f) => `\`${f}\``).join(', ')}_\n` : '');
  await copyText(md);
  toast(`Anmerkung #${fresh.number} als Markdown kopiert`);
}

async function deleteAnnotation(a) {
  const ok = await confirmDialog({ title: `Anmerkung #${a.number} löschen?`, text: 'Die Anmerkung und ihre Screenshots werden endgültig entfernt.' });
  if (!ok) return;
  await send('fl:deleteAnnotation', { sessionId: session().id, id: a.id }).catch((e) => toast(e.message, 'error'));
  state.thumbs.delete(`${a.id}@${a.updatedAt}`);
}

// ---------------------------------------------------------------------------
// Test plans: templates and the outcome of a run
// ---------------------------------------------------------------------------

const PLAN_EXAMPLE = `## Bestellung
- [ ] Als Gast bestellen
  - Start: /warenkorb
  - Erwartung: Bestätigung mit Bestellnummer
- [ ] Gutschein einlösen (gültig und ungültig)
  - Erwartung: Ungültiger Code zeigt eine Fehlermeldung am Feld

## Konto
- [ ] Passwort ändern
`;

async function openPlans() {
  state.view = 'plans';
  state.templates = (await chrome.storage.local.get(K.templates))[K.templates] || [];
  renderSidebar();
  renderMain();
}

function plansView() {
  const importInput = h('input', { type: 'file', accept: '.md,.markdown,.txt,text/markdown,text/plain', hidden: true });
  importInput.addEventListener('change', async () => {
    const file = importInput.files?.[0];
    importInput.value = '';
    if (!file) return;
    const parsed = parsePlan(await file.text());
    if (!parsed.items.length) return toast('Keine Prüfpunkte gefunden – erwartet wird eine Liste mit „- …“ pro Prüfpunkt.', 'error', 6000);
    openPlanEditor({ name: parsed.name || file.name.replace(/\.(md|markdown|txt)$/i, ''), domains: parsed.domains, items: parsed.items }, { imported: file.name });
  });
  const list = state.templates.slice().sort((a, b) => a.name.localeCompare(b.name, 'de'));
  return h(
    'div.page',
    null,
    h(
      'header.s-head',
      null,
      h('div.s-title', null, h('h1.plans-title', { text: 'Testpläne' }), h('div.s-meta', null, h('span', { text: 'Vorlagen mit Prüfpunkten – beim Start eines Testlaufs im Menü auswählen.' }))),
      h(
        'div.s-actions',
        null,
        h('button.btn', { type: 'button', title: 'testplan.md einlesen – z. B. von der Entwicklung oder aus einem Export-Paket', on: { click: () => importInput.click() } }, icon('upload'), 'Importieren (.md)'),
        h('button.btn.primary', { type: 'button', on: { click: () => openPlanEditor(null) } }, icon('plus'), 'Neuer Testplan'),
        importInput,
      ),
    ),
    list.length ? h('div.plan-list', null, list.map(templateCard)) : h('div.card.empty', null, icon('checklist', 40), h('p', { text: 'Noch keine Testpläne. Lege einen an oder importiere eine testplan.md.' })),
    h(
      'section.card.plan-help',
      null,
      h('h3', { text: 'So funktioniert’s' }),
      h(
        'ol',
        null,
        h('li', { text: 'Testplan anlegen: ein Prüfpunkt pro Zeile („- …“), darunter eingerückt „Start:“ (Pfad oder Adresse) und „Erwartung:“. Mit „## Bereich“ lässt er sich gliedern.' }),
        h('li', { text: 'Im Feedback-Lens-Menü beim Start „Testplan“ wählen. In der Leiste erscheint die Liste: Seite öffnen, durchspielen, dann „In Ordnung“ (mit Screenshot), „Problem“ (Anmerkung) oder „Nicht testbar“.' }),
        h('li', { text: 'Der Export zeigt die Testabdeckung und enthält testplan.md mit den Ergebnissen – Claude Code kann daraus den Plan für die nächste Runde schreiben, den du hier wieder importierst.' }),
      ),
      h('p.small.muted', { text: 'Startadressen als Pfad (/warenkorb) gelten auf jeder Domain – derselbe Plan passt für Staging und Produktion. Volle Adressen (z. B. für einen Login auf einer anderen Domain) nimmt Feedback Lens beim Start mit in den Testlauf auf. „Domains“ bestimmt nur, wo der Plan im Menü vorgeschlagen wird.' }),
    ),
  );
}

function templateCard(t) {
  const groups = [...new Set(t.items.map((it) => it.group).filter(Boolean))];
  const download = () => downloadBlob(new Blob([serializePlan(t)], { type: 'text/markdown' }), `testplan-${t.name.toLowerCase().replace(/[^a-z0-9äöüß]+/g, '-').replace(/^-|-$/g, '') || 'plan'}.md`);
  const remove = async () => {
    if (!(await confirmDialog({ title: `Testplan „${t.name}“ löschen?`, text: 'Die Vorlage wird entfernt. Testläufe, die mit ihr gemacht wurden, behalten ihre Kopie des Plans.' }))) return;
    await send('fl:deleteTemplate', { id: t.id }).catch((e) => toast(e.message, 'error'));
    await openPlans();
  };
  return h(
    'div.card.plan-tpl',
    null,
    h('div.plan-tpl-main', null, h('h3', { text: t.name }), h('p.small.muted', { text: `${pl(t.items.length, 'Prüfpunkt', 'Prüfpunkte')}${groups.length ? ` in ${pl(groups.length, 'Bereich', 'Bereichen')}` : ''} · geändert ${formatDateTime(t.updatedAt)}` }), t.domains.length ? h('div.chips', null, t.domains.map((d) => h('code', { text: hostOf(d) }))) : h('p.small.muted', { text: 'Für alle Domains' })),
    h(
      'div.plan-tpl-actions',
      null,
      h('button.btn.sm', { type: 'button', on: { click: () => openPlanEditor(t) } }, icon('edit', 14), 'Bearbeiten'),
      h('button.btn.sm', { type: 'button', title: 'Als testplan.md speichern – z. B. für die Entwicklung oder Claude Code', on: { click: download } }, icon('download', 14), '.md'),
      h('button.icon-btn', { type: 'button', title: 'Testplan löschen', 'aria-label': `Testplan ${t.name} löschen`, on: { click: remove } }, icon('trash', 16)),
    ),
  );
}

function openPlanEditor(t, { imported = null } = {}) {
  const name = h('input.input', { type: 'text', value: t?.name || '', placeholder: 'z. B. Checkout 2.4', 'aria-label': 'Name des Testplans' });
  const domains = h('textarea.input', { rows: '2', placeholder: 'https://staging.shop.de\nhttps://login.shop.de', 'aria-label': 'Domains' });
  domains.value = (t?.domains || []).join('\n');
  const items = h('textarea.input.mono', { rows: '18', spellcheck: 'false', 'aria-label': 'Prüfpunkte' });
  items.value = t ? serializeItems(t.items) : PLAN_EXAMPLE;
  const preview = h('div.plan-preview', { 'aria-live': 'polite' });
  const error = h('p.small', { style: { color: 'var(--danger)', margin: 0 } });
  const update = () => {
    const parsed = parsePlan(items.value);
    let group = null;
    const rows = [];
    parsed.items.forEach((it, i) => {
      if (it.group !== group) {
        group = it.group;
        if (group) rows.push(h('li.grp', { text: group }));
      }
      rows.push(h('li', null, h('span.n', { text: `${i + 1}` }), h('div', null, h('b', { text: it.title }), it.start ? h('code', { text: it.start }) : null, it.expected ? h('div.small.muted', { text: `Erwartung: ${it.expected}` }) : null, it.notes.length ? h('div.small.muted', { text: it.notes.join(' · ') }) : null)));
    });
    preview.replaceChildren(...[h('div.small.muted', { text: `Vorschau: ${pl(parsed.items.length, 'Prüfpunkt', 'Prüfpunkte')}` }), parsed.warnings.length ? h('ul.plan-warn', null, parsed.warnings.map((w) => h('li', { text: w }))) : null, h('ul.plan-items', null, rows)].filter(Boolean));
  };
  items.addEventListener('input', debounce(update, 150));
  update();
  const save = h('button.btn.primary', { type: 'button', text: 'Speichern' });
  save.addEventListener('click', async () => {
    const parsed = parsePlan(items.value);
    save.disabled = true;
    try {
      await send('fl:saveTemplate', { template: { id: t?.id, name: name.value.trim() || parsed.name, domains: domains.value.split(/[\s,;]+/).filter(Boolean), items: parsed.items } });
      closeModal();
      toast('Testplan gespeichert');
      await openPlans();
    } catch (err) {
      error.textContent = err.message;
      save.disabled = false;
    }
  });
  openModal(
    h(
      'div.plan-editor',
      null,
      modalHead(t?.id ? 'Testplan bearbeiten' : imported ? `Testplan importieren: ${imported}` : 'Neuer Testplan'),
      h(
        'div.modal-body',
        null,
        h('div.plan-grid', null,
          h('div.plan-form', null,
            h('label.field', null, 'Name', name),
            h('label.field', null, h('span', null, 'Domains ', h('small', { text: '– wo der Plan im Menü vorgeschlagen wird (optional, eine pro Zeile)' })), domains),
            h('label.field', null, h('span', null, 'Prüfpunkte ', h('small', { text: '– „- Prüfpunkt“, darunter eingerückt „Start: /pfad“, „Erwartung: …“; „## Bereich“ gliedert' })), items),
          ),
          preview,
        ),
        error,
      ),
      h('div.modal-foot', null, h('button.btn', { type: 'button', text: 'Abbrechen', on: { click: closeModal } }), save),
    ),
    { wide: true },
  );
  name.focus();
}

/** The run's test plan: what was checked, how, and the screenshots of checkpoints found OK. */
function planCard() {
  const st = planState(state.bundle);
  const box = h('section.card.plan-card');
  const total = st.rows.length || 1;
  const bar = h('div.bar', null, C.PLAN_STATUSES.map((x) => h('i', { title: x.label, style: { width: `${(st[x.id] / total) * 100}%`, background: x.color } })));
  const list = h('ul.plan-rows');
  const proofs = new Map();
  for (const r of st.rows) {
    const status = C.PLAN_STATUSES.find((x) => x.id === r.status);
    const proof = h('span.proof');
    list.append(
      h(
        'li',
        null,
        h('span.mark', { text: status?.mark || '○', style: { color: status?.color || '#94a3b8' }, title: status?.label || 'nicht geprüft' }),
        h('span.n', { text: String(r.n) }),
        h('span.t', null, h('b', { text: r.item.title }), r.item.group ? h('small', { text: ` · ${r.item.group}` }) : null, r.status === 'skip' && r.result?.note ? h('small', { text: ` – ${r.result.note}` }) : null),
        h('span.links', null, r.findings.map((a) => h('a.link', { href: '#', text: `#${a.number}`, on: { click: (e) => (e.preventDefault(), (state.focusAnnotation = a.id), state.tab === 'annotations' ? refreshCards() : switchTab('annotations')) } }))),
        proof,
      ),
    );
    if (r.result?.image) proofs.set(r.item.id, { proof, r });
  }
  if (proofs.size) {
    loadPlanImages(state.bundle).then((imgs) => {
      for (const [id, { proof, r }] of proofs) {
        const src = imgs.get(id);
        if (src) proof.append(h('button.thumb-sm', { type: 'button', title: 'Beleg ansehen', on: { click: () => openImage(src, `Prüfpunkt ${r.n}: ${r.item.title}`) } }, h('img', { src, alt: `Beleg zu Prüfpunkt ${r.n}` })));
      }
    });
  }
  box.append(
    h('div.plan-card-head', null, h('h3', null, icon('checklist', 16), ` Testplan „${st.name}“`), h('span.small.muted', { text: `${st.rows.length - st.open} von ${st.rows.length} geprüft · ✓ ${st.ok} · ✗ ${st.problem} · – ${st.skip}` })),
    bar,
    list,
  );
  return box;
}

// ---------------------------------------------------------------------------
// Adding marks to stored screenshots
// ---------------------------------------------------------------------------

const Marks = globalThis.FL_MARKS;
document.head.append(h('style', { text: Marks.CSS }));

const loadBitmap = async (src) => (src ? createImageBitmap(await (await fetch(src)).blob()) : null);

/**
 * Opens the screenshot editor for a stored annotation. Only the finished
 * images are stored (blacked-out parts must not survive anywhere), so marks
 * can be added here but not removed. New marks go into crop and full view.
 */
/** The further screenshots of an annotation as small tiles, plus „+ Bild“. */
function extrasGrid(a) {
  const extras = extrasOf(a);
  const tiles = extras.map((x, i) => {
    const tile = h('button.x-tile', { type: 'button', title: x.caption || `Bild ${i + 2}`, 'aria-label': `Bild ${i + 2} zu #${a.number} öffnen` }, h('span.x-n', { text: `Bild ${i + 2}` }));
    thumbsFor(a).then((imgs) => {
      const src = imgs?.extra?.[x.id];
      if (src) tile.prepend(h('img', { src, alt: '', loading: 'lazy' }));
    });
    tile.addEventListener('click', () => openExtra(a, x.id));
    return tile;
  });
  const full = extras.length >= C.LIMITS.extraImages;
  const add = h('button.x-tile.x-plus', { type: 'button', disabled: full, title: full ? `Höchstens ${C.LIMITS.extraImages + 1} Screenshots pro Anmerkung` : 'Bild hinzufügen: einfügen (Strg+V) oder Datei wählen' }, icon('plus', 16), h('span', { text: 'Bild' }));
  add.addEventListener('click', () => addImageDialog(a));
  return h('div.x-grid', { role: 'group', 'aria-label': 'Weitere Screenshots' }, tiles, add);
}

/** Pictures from elsewhere (phone, other tools): paste, drop or choose; stored like a screenshot. */
function addImageDialog(a) {
  let picked = [];
  const preview = h('div.x-preview');
  const caption = h('input.input', { type: 'text', maxlength: '300', placeholder: 'Was zeigt das Bild? (optional)' });
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: true, hidden: true });
  const save = h('button.btn.primary', { type: 'button', disabled: true }, icon('check', 14), 'Hinzufügen');
  const room = C.LIMITS.extraImages - extrasOf(a).length;
  const take = async (files) => {
    const images = [...files].filter((f) => /^image\/(png|jpeg|webp|gif)$/.test(f.type)).slice(0, room);
    if (!images.length) return toast('Kein Bild gefunden – PNG, JPEG, WebP oder GIF.', 'error');
    picked = await Promise.all(images.map(downscale));
    preview.replaceChildren(...picked.map((src) => h('img', { src, alt: '' })));
    save.disabled = false;
    save.focus();
  };
  const drop = h('div.x-drop', { tabindex: '0' }, icon('image', 22), h('b', { text: 'Bild einfügen (Strg+V) oder hierher ziehen' }), h('button.btn.sm', { type: 'button', text: 'Datei wählen …', on: { click: () => file.click() } }), preview);
  file.addEventListener('change', () => take(file.files));
  drop.addEventListener('dragover', (e) => e.preventDefault());
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    take(e.dataTransfer.files);
  });
  const onPaste = (e) => {
    const files = [...(e.clipboardData?.items || [])].filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean);
    if (files.length) {
      e.preventDefault();
      take(files);
    }
  };
  document.addEventListener('paste', onPaste);
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const res = await send('fl:addImages', { sessionId: session().id, id: a.id, images: picked.map((dataUrl) => ({ dataUrl, meta: { caption: caption.value.trim() } })) });
      closeModal();
      toast(`${res.added === 1 ? 'Bild' : `${res.added} Bilder`} zu #${a.number} hinzugefügt`);
    } catch (err) {
      save.disabled = false;
      toast(err.message, 'error');
    }
  });
  openModal(
    h(
      'div',
      null,
      h('div.modal-head', null, h('h2', { text: `Bild zu #${a.number} hinzufügen` }), h('button.icon-btn', { type: 'button', 'aria-label': 'Schließen', on: { click: closeModal } }, icon('close', 18))),
      h('div.modal-body', null, h('p.muted.small', { text: 'Etwa ein Handy-Screenshot oder ein Bild aus einem anderen Werkzeug. Es wird wie ein Screenshot gespeichert und exportiert – vorher prüfen, dass nichts Vertrauliches darauf ist (oder danach „Nachzeichnen“ → Schwärzen).' }), drop, file, h('label', null, 'Beschriftung', caption)),
      h('div.modal-foot', null, h('button.btn', { type: 'button', text: 'Abbrechen', on: { click: closeModal } }), save),
    ),
  );
  $modal.addEventListener('close', () => document.removeEventListener('paste', onPaste), { once: true });
  drop.focus();
}

/** At most imageMaxEdge on the longer side; PNG for screenshot-sized pictures, JPEG for large ones. */
async function downscale(blob) {
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, C.LIMITS.imageMaxEdge / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * k);
  canvas.height = Math.round(bmp.height * k);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return canvas.width * canvas.height <= 1.4e6 ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.88);
}

/** One further screenshot: large, with caption, order, redraw and remove. */
async function openExtra(a, extraId) {
  const fresh = () => state.bundle.annotations.find((x) => x.id === a.id) || a;
  const img = h('img', { alt: '' });
  const title = h('h2');
  const caption = h('input.input', { type: 'text', maxlength: '300', placeholder: 'Was zeigt dieses Bild? (optional)' });
  const meta = h('span.muted.small');
  const edit = (patch) => send('fl:editExtra', { sessionId: session().id, id: a.id, extraId, ...patch });
  caption.addEventListener('change', () => edit({ caption: caption.value.trim() }).catch((e) => toast(e.message, 'error')));
  const move = (dir) => edit({ move: dir }).then(() => setTimeout(show, 300)).catch((e) => toast(e.message, 'error'));
  const back = h('button.btn.sm', { type: 'button', text: '‹ Nach vorn', on: { click: () => move(-1) } });
  const fwd = h('button.btn.sm', { type: 'button', text: 'Nach hinten ›', on: { click: () => move(1) } });
  const redraw = h('button.btn.sm', { type: 'button', title: 'Markieren, nummerieren, schwärzen', on: { click: () => editExtraShot(fresh(), extraId) } }, icon('edit', 14), 'Nachzeichnen');
  const drop = h('button.btn.sm.danger', { type: 'button', on: { click: async () => {
    if (!(await confirmDialog({ title: 'Bild entfernen?', text: 'Das Bild wird aus der Anmerkung gelöscht.', confirm: 'Entfernen' }))) return;
    await edit({ remove: true }).catch((e) => toast(e.message, 'error'));
    closeModal();
  } } }, icon('trash', 14), 'Entfernen');
  async function show() {
    const cur = fresh();
    const list = extrasOf(cur);
    const i = list.findIndex((x) => x.id === extraId);
    if (i < 0) return closeModal();
    const x = list[i];
    const imgs = await loadImages([cur]);
    img.src = imgs.get(cur.id)?.extra?.[extraId] || '';
    title.textContent = `#${cur.number} – Bild ${i + 2} von ${list.length + 1}`;
    if (document.activeElement !== caption) caption.value = x.caption || '';
    meta.textContent = [x.kind === 'file' ? 'eingefügtes Bild' : 'Screenshot', x.t ? formatDateTime(x.t) : '', x.url ? pathOf(x.url) : ''].filter(Boolean).join(' · ');
    back.disabled = i === 0;
    fwd.disabled = i === list.length - 1;
  }
  const box = h(
    'div.lightbox',
    null,
    h('div.modal-head', null, title, back, fwd, redraw, drop, h('button.icon-btn', { type: 'button', 'aria-label': 'Schließen', on: { click: closeModal } }, icon('close', 18))),
    h('div.x-captionbar', null, h('label', null, 'Beschriftung', caption), meta),
    h('div.stage', null, img),
  );
  openModal(box, { wide: true });
  await show();
}

/** Redrawing a further screenshot: one picture, numbers continue after the ones it has. */
async function editExtraShot(a, extraId) {
  const x = extrasOf(a).find((e) => e.id === extraId);
  const src = (await loadImages([a])).get(a.id)?.extra?.[extraId];
  const bmp = await loadBitmap(src);
  if (!x || !bmp) return;
  const view = { id: 'full', label: 'Bild', image: bmp, sx: 0, sy: 0, sw: bmp.width, sh: bmp.height, x: 0, y: 0, w: bmp.width, h: bmp.height };
  const drawnClicks = (x.clicks || []).filter((c) => c.n);
  const marks = { items: [], clicks: [], showClicks: false, tool: Marks.DEFAULT_TOOL, view: 'full', frame: null, base: Math.max(0, ...drawnClicks.map((c) => c.n), ...(x.numbers || []).map((n) => n.n)) };
  const dialog = h('dialog.flm-dialog');
  dialog.addEventListener('cancel', (e) => e.preventDefault());
  document.body.append(dialog);
  closeModal();
  dialog.showModal();
  Marks.openEditor({
    mount: dialog,
    views: [view],
    state: marks,
    title: `#${a.number} – Bild ${extrasOf(a).indexOf(x) + 2} nachzeichnen`,
    note: 'Bereits Gespeichertes bleibt – hier lässt sich nur ergänzen.',
    doneLabel: 'Speichern',
    onCancel: () => dialog.remove(),
    onDone: async () => {
      dialog.remove();
      const legend = Marks.legend(marks);
      if (!marks.items.length) return;
      try {
        await send('fl:updateImages', {
          sessionId: session().id,
          id: a.id,
          extraId,
          images: { image: Marks.toDataUrl(view, marks, Math.max(view.sw, view.sh), src.startsWith('data:image/png') ? 'image/png' : 'image/jpeg', 0.88) },
          marks: { drawn: legend.drawn, redacted: legend.redacted, clicks: x.clicks || [], numbers: [...(x.numbers || []), ...legend.numbers] },
        });
        toast(`Bild zu #${a.number} aktualisiert`);
      } catch (err) {
        toast(err.message, 'error');
      }
    },
  });
}

async function editShot(a) {
  const imgs = await thumbsFor(a);
  const [full, crop] = await Promise.all([loadBitmap(imgs?.full), loadBitmap(imgs?.crop)]);
  const cr = a.images?.cropRect;
  if (crop && !cr) return toast('Für diesen Screenshot fehlt die Lage des Ausschnitts – Nachzeichnen nicht möglich.', 'error');
  const views = [];
  if (crop) views.push({ id: 'crop', label: 'Ausschnitt', image: crop, sx: 0, sy: 0, sw: crop.width, sh: crop.height, x: cr.x, y: cr.y, w: cr.width, h: cr.height });
  if (full) {
    // the full view covers the whole viewport; its height follows from the image
    const w = a.page?.viewport?.width || full.width;
    views.push({ id: 'full', label: 'Ganze Ansicht', image: full, sx: 0, sy: 0, sw: full.width, sh: full.height, x: 0, y: 0, w, h: full.height * (w / full.width) });
  }
  if (!views.length) return;
  const drawnClicks = (a.images?.clicks || []).filter((c) => c.n);
  const marks = {
    items: [],
    clicks: (a.images?.clicks || []).filter((c) => !c.n).map((c) => ({ ...c, on: true })),
    showClicks: false,
    tool: Marks.DEFAULT_TOOL,
    view: views[0].id,
    frame: null,
    base: Math.max(0, ...drawnClicks.map((c) => c.n), ...(a.images?.numbers || []).map((x) => (typeof x === 'number' ? x : x.n))),
  };
  const dialog = h('dialog.flm-dialog');
  dialog.addEventListener('cancel', (e) => e.preventDefault()); // Esc is handled by the editor
  document.body.append(dialog);
  closeModal();
  dialog.showModal();
  Marks.openEditor({
    mount: dialog,
    views,
    state: marks,
    title: `#${a.number} nachzeichnen`,
    note: 'Bereits Gespeichertes bleibt – hier lässt sich nur ergänzen.',
    doneLabel: 'Speichern',
    onCancel: () => dialog.remove(),
    onDone: async () => {
      dialog.remove();
      const legend = Marks.legend(marks);
      if (!marks.items.length && !legend.clicks.some((c) => c.n)) return;
      const images = {};
      for (const view of views) {
        const png = view.id === 'crop' && imgs.crop?.startsWith('data:image/png');
        images[view.id] = Marks.toDataUrl(view, marks, Math.max(view.sw, view.sh), png ? 'image/png' : 'image/jpeg', view.id === 'crop' ? 0.9 : 0.86);
      }
      try {
        await send('fl:updateImages', {
          sessionId: session().id,
          id: a.id,
          images,
          marks: { drawn: legend.drawn, redacted: legend.redacted, clicks: [...drawnClicks, ...legend.clicks].sort((x, y) => String(x.t).localeCompare(String(y.t))), numbers: [...(a.images?.numbers || []), ...legend.numbers] },
        });
        toast(`Screenshot zu #${a.number} aktualisiert`);
      } catch (err) {
        toast(err.message, 'error');
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Lightbox
// ---------------------------------------------------------------------------

async function openLightbox(annotationId) {
  const list = filteredAnnotations().filter((a) => a.images?.crop || a.images?.full || extrasOf(a).length);
  let index = Math.max(0, list.findIndex((a) => a.id === annotationId));
  let view = 'crop';
  const img = h('img', { alt: '' });
  const title = h('h2');
  const seg = h('div.seg');
  const stage = h('div.stage', null, img);

  async function show() {
    const a = list[index];
    const imgs = await thumbsFor(a);
    const extra = extrasOf(a).filter((x) => imgs.extra?.[x.id]);
    const views = [['crop', 'Ausschnitt'], ['full', 'Gesamte Ansicht'], ...extra.map((x, i) => [x.id, `Bild ${i + 2}`])].filter(([v]) => imgs[v] || imgs.extra?.[v]);
    if (!views.some(([v]) => v === view)) view = views[0]?.[0];
    img.src = imgs[view] || imgs.extra?.[view] || '';
    img.alt = `Screenshot zu #${a.number}`;
    title.textContent = `#${a.number} – ${annotationTitle(a)}`;
    seg.replaceChildren(...views.map(([v, label]) => h(`button${view === v ? '.sel' : ''}`, { type: 'button', text: label, on: { click: () => ((view = v), show()) } })));
  }
  const nav = (d) => {
    index = (index + d + list.length) % list.length;
    show();
  };
  const head = h(
    'div.modal-head',
    null,
    title,
    seg,
    h('button.icon-btn', { type: 'button', title: 'Vorherige (←)', on: { click: () => nav(-1) } }, h('span', { text: '‹', style: { fontSize: '22px' } })),
    h('button.icon-btn', { type: 'button', title: 'Nächste (→)', on: { click: () => nav(1) } }, h('span', { text: '›', style: { fontSize: '22px' } })),
    h('button.btn.sm', { type: 'button', title: 'Markieren, nummerieren, schwärzen', on: { click: () => (/^x\d/.test(view) ? editExtraShot(list[index], view) : editShot(list[index])) } }, icon('edit', 14), 'Nachzeichnen'),
    h('button.icon-btn', { type: 'button', 'aria-label': 'Schließen', on: { click: closeModal } }, icon('close', 18)),
  );
  const box = h('div.lightbox', null, head, stage);
  box.tabIndex = -1;
  box.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') nav(-1);
    if (e.key === 'ArrowRight') nav(1);
  });
  openModal(box, { wide: true });
  box.focus();
  await show();
}

// ---------------------------------------------------------------------------
// Trail & technical events
// ---------------------------------------------------------------------------

const TRAIL_ICONS = { page: 'file', route: 'route', click: 'cursor', input: 'keyboard', submit: 'check', message: 'alert', annotation: 'note' };

function trailPanel() {
  const trail = state.bundle.trail;
  if (!trail.length) return h('div.card.empty', null, icon('route', 40), h('p', { text: 'Noch kein Klickpfad aufgezeichnet.' }));
  const groups = [];
  for (const e of trail) {
    const key = e.type === 'annotation' ? groups.at(-1)?.key : pathOf(e.url || '');
    if (!groups.length || (groups.at(-1).key !== key && e.type !== 'annotation') || e.type === 'page' || e.type === 'route') {
      groups.push({ key, title: e.title || '', url: e.url, items: [] });
    }
    groups.at(-1).items.push(e);
  }
  const byNumber = new Map(state.bundle.annotations.map((a) => [a.number, a]));
  return h(
    'div.trail',
    null,
    groups.map((g) =>
      h(
        'section.card.trail-group',
        null,
        h('h3', null, g.title || 'Seite', h('code', { text: pathOf(g.url || '') })),
        h(
          'ol',
          null,
          g.items.map((e) => {
            const target = e.type === 'annotation' ? byNumber.get(e.number) : null;
            const text = trailEntryText(e);
            return h(
              `li.t-${e.type}`,
              null,
              h('time', { text: formatTime(e.t) }),
              icon(TRAIL_ICONS[e.type] || 'cursor', 14),
              target ? h('button', { type: 'button', text, on: { click: () => ((state.focusAnnotation = target.id), switchTab('annotations')) } }) : h('span', { text }),
            );
          }),
        ),
      ),
    ),
  );
}

function techPanel() {
  const events = state.bundle.tech;
  if (!events.length) return h('div.card.empty', null, icon('alert', 40), h('p', { text: 'Keine Konsolen- oder Netzwerkfehler erfasst. 🎉' }));
  return h(
    'div.card',
    { style: { overflow: 'auto', maxHeight: '70vh' } },
    h(
      'table.tech-table',
      null,
      h('thead', null, h('tr', null, h('th', { text: 'Zeit' }), h('th', { text: 'Typ' }), h('th', { text: 'Meldung' }), h('th', { text: 'Seite' }))),
      h(
        'tbody',
        null,
        events
          .slice()
          .reverse()
          .map((e) => h('tr', null, h('td.when', { text: formatTime(e.t) }), h('td', null, h('span.badge', { style: { '--c': e.type === 'slow' ? '#ca8a04' : '#dc2626' }, text: techEventLabel(e) })), h('td.msg', { text: techEventText(e) + (e.stack ? `\n${e.stack}` : '') }), h('td', { text: pathOf(e.url || '') }))),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Pending edits must reach storage before anything is exported. */
const pendingSaves = new Set();
function trackSave(promise) {
  pendingSaves.add(promise);
  promise.finally(() => pendingSaves.delete(promise));
  return promise;
}

async function flushEdits() {
  if (document.activeElement?.blur) document.activeElement.blur(); // flushes debounced edits
  await Promise.all([...pendingSaves]);
}

async function withBusy(label, fn) {
  toast(`${label} …`, 'info', 60_000);
  try {
    await flushEdits();
    await fn();
  } catch (err) {
    console.error(err);
    toast(`${label} fehlgeschlagen: ${err.message}`, 'error', 6000);
  }
}

const NOTE_PLACEHOLDER = 'z. B. „Bitte zuerst #4 – blockiert die Demo am Freitag. #3 ist Geschmackssache, gern mit Design klären.“';

/**
 * Before the package is built: what goes in, and a message for the handover
 * (kept with the run, so a second export has it again).
 */
function openExportDialog({ only = null } = {}) {
  const s = session();
  if (!s) return;
  const total = state.bundle.annotations.length;
  const note = h('textarea.input', { rows: 5, placeholder: NOTE_PLACEHOLDER, 'aria-label': 'Nachricht an die Entwicklung' });
  let stored = s.handoffNote || '';
  note.value = stored;
  const save = async () => {
    if (note.value === stored) return;
    await send('fl:updateSession', { sessionId: s.id, patch: { handoffNote: note.value } });
    stored = note.value;
  };
  const go = h('button.btn.primary', { type: 'button' }, icon('download', 15), only ? 'Auswahl exportieren (.zip)' : 'Exportieren (.zip)');
  const preview = h('button.btn.ghost', { type: 'button', title: 'Den Bericht mit dieser Nachricht ansehen' }, icon('eye', 15), 'Vorschau');
  const run = async (after) => {
    go.disabled = preview.disabled = true;
    try {
      await save();
    } catch (err) {
      go.disabled = preview.disabled = false;
      return toast(err.message, 'error');
    }
    closeModal();
    after();
  };
  go.addEventListener('click', () => run(() => exportZip(only)));
  preview.addEventListener('click', () => run(() => openPreview()));
  note.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      go.click();
    }
  });
  const what = only ? `Nur die Auswahl: ${pl(only.length, 'Anmerkung', 'Anmerkungen')} von ${total}` : `${pl(total, 'Anmerkung', 'Anmerkungen')} mit Screenshots, Klickpfad, technischen Fehlern und Bericht`;
  openModal(
    h(
      'div.export-dialog',
      null,
      h('div.modal-head', null, h('h2', { text: 'Paket für die Entwicklung' }), h('button.icon-btn', { type: 'button', 'aria-label': 'Schließen', on: { click: closeModal } }, icon('close', 18))),
      h(
        'div.modal-body',
        null,
        h('p.export-what', null, icon('download', 16), h('span', { text: what })),
        h('label.export-note', null, h('b', { text: 'Nachricht an die Entwicklung' }), h('small', { text: 'optional' }), note),
        h('p.muted.small', { text: 'Steht ganz oben in der README und im Bericht – Claude Code liest sie zuerst. Gut für Reihenfolge, Schwerpunkte oder was bewusst warten kann. Die Nachricht bleibt beim Testlauf gespeichert.' }),
      ),
      h('div.modal-foot', null, preview, h('span.grow'), h('button.btn', { type: 'button', text: 'Abbrechen', on: { click: closeModal } }), go),
    ),
  );
  // closing without exporting (Esc, backdrop, „Abbrechen“) keeps what was typed
  $modal.addEventListener('close', () => save().catch((err) => toast(err.message, 'error')), { once: true });
  note.focus();
  note.setSelectionRange(note.value.length, note.value.length);
}

const exportZip = (only = null) =>
  withBusy('Export wird erstellt', async () => {
    const { blob, filename } = await buildZip(await loadBundle(session().id), { only: Array.isArray(only) && only.length ? only : null });
    downloadBlob(blob, filename);
    toast(`${filename} heruntergeladen (${bytesToSize(blob.size)})${Array.isArray(only) ? ` – ${only.length} ausgewählte Anmerkungen` : ''} – an die Entwicklung weitergeben.`, 'info', 6000);
  });

const copyMarkdown = () =>
  withBusy('Markdown wird erstellt', async () => {
    const md = buildMarkdown(await loadBundle(session().id));
    await copyText(md);
    toast(`Alle Anmerkungen kopiert (${md.length.toLocaleString('de-DE')} Zeichen, ohne Bilder).`, 'info', 5000);
  });

const exportHtml = () =>
  withBusy('HTML-Bericht wird erstellt', async () => {
    const bundle = await loadBundle(session().id);
    const html = buildHtml(bundle, await loadImages([...bundle.annotations, ...(bundle.plan || [])]), { planImages: await loadPlanImages(bundle) });
    downloadBlob(new Blob([html], { type: 'text/html' }), `${exportBaseName(bundle.session)}.html`);
    toast('HTML-Bericht heruntergeladen');
  });

/**
 * The report as the package's bericht.html, shown in a sandboxed frame
 * (src/preview): its own scripts run there, extension APIs are out of reach.
 */
async function openPreview() {
  const frame = h('iframe.preview-frame', { src: '../preview/preview.html', title: 'Vorschau des Berichts', allow: 'clipboard-write' });
  let html = '';
  const render = async () => {
    const bundle = await loadBundle(session().id);
    html = buildPreviewHtml(bundle, await loadImages([...bundle.annotations, ...(bundle.plan || [])]), await loadPlanImages(bundle));
  };
  // each load of the sandbox page shows the current HTML (again after „Aktualisieren“)
  frame.addEventListener('load', () => frame.contentWindow.postMessage({ html }, '*'));
  try {
    await withBusy('Vorschau wird erstellt', render);
  } catch {
    return;
  }
  if (!html) return;
  const dialog = h('dialog.preview-dialog', { 'aria-label': 'Vorschau des Berichts' });
  const close = () => dialog.close();
  const refresh = h('button.btn.sm', { type: 'button', title: 'Mit den aktuellen Anmerkungen neu aufbauen' }, icon('refresh', 14), 'Aktualisieren');
  refresh.addEventListener('click', async () => {
    refresh.disabled = true;
    await render().catch((e) => toast(e.message, 'error'));
    frame.src = frame.src; // reload the sandbox page, which then gets the new HTML
    refresh.disabled = false;
  });
  dialog.append(
    h(
      'div.preview-bar',
      null,
      h('div.preview-title', null, h('strong', { text: 'Vorschau: bericht.html' }), h('span', { text: 'So bekommt die Entwicklung den Bericht im Export-Paket – Häkchen, Suche und Großansicht funktionieren hier auch.' })),
      refresh,
      h('button.btn.sm', { type: 'button', title: 'Diesen Bericht als einzelne HTML-Datei speichern', on: { click: exportHtml } }, icon('file', 14), 'Als HTML speichern'),
      h('button.btn.sm.primary', { type: 'button', on: { click: () => (close(), openExportDialog()) } }, icon('download', 14), 'Exportieren (.zip)'),
      h('button.icon-btn', { type: 'button', 'aria-label': 'Vorschau schließen', title: 'Schließen (Esc)', on: { click: close } }, icon('close', 18)),
    ),
    frame,
  );
  // Esc inside the sandboxed report arrives as a message
  const onMessage = (e) => {
    if (e.source === frame.contentWindow && e.data?.type === 'fl:preview-close') close();
  };
  window.addEventListener('message', onMessage);
  dialog.addEventListener('close', () => {
    window.removeEventListener('message', onMessage);
    dialog.remove();
  });
  document.body.append(dialog);
  dialog.showModal();
}

const exportJson = () =>
  withBusy('JSON wird erstellt', async () => {
    const bundle = await loadBundle(session().id);
    const json = buildJson(bundle, { images: await loadImages([...bundle.annotations, ...(bundle.plan || [])]) });
    downloadBlob(new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' }), `${exportBaseName(bundle.session)}.json`);
    toast('JSON heruntergeladen');
  });

const exportBackup = () =>
  withBusy('Sicherung wird erstellt', async () => {
    const bundle = await loadBundle(session().id);
    const json = buildJson(bundle, { images: await loadImages([...bundle.annotations, ...(bundle.plan || [])]), embed: true, planImages: await loadPlanImages(bundle) });
    const blob = new Blob([JSON.stringify(json)], { type: 'application/json' });
    downloadBlob(blob, `${exportBaseName(bundle.session)}-sicherung.json`);
    toast(`Sicherung heruntergeladen (${bytesToSize(blob.size)})`);
  });

// ---------------------------------------------------------------------------
// Session actions
// ---------------------------------------------------------------------------

async function stopSession({ pause = false } = {}) {
  await send('fl:stopSession', { pause }).catch((e) => toast(e.message, 'error'));
  toast(pause ? 'Testlauf pausiert' : 'Testlauf beendet');
}

async function resumeSession() {
  const s = session();
  try {
    await send('fl:resumeSession', { sessionId: s.id });
    const open = await chrome.tabs.query({ url: s.origins.map((o) => (o === 'file://' ? 'file:///*' : `${o}/*`)) }).catch(() => []);
    if (open.length) {
      await chrome.tabs.update(open[0].id, { active: true });
      await chrome.windows.update(open[0].windowId, { focused: true }).catch(() => {});
    } else {
      const last = state.bundle.annotations.at(-1)?.page?.url;
      await chrome.tabs.create({ url: last && !last.includes('***') ? last : s.origins[0] });
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

function openImage(src, title) {
  openModal(h('div.lightbox', null, h('div.modal-head', null, h('h2', { text: title }), h('button.icon-btn', { type: 'button', 'aria-label': 'Schließen', on: { click: closeModal } }, icon('close', 18))), h('div.stage', null, h('img', { src, alt: title }))), { wide: true });
}

function openRetestDialog() {
  const s = session();
  const lastUrl = state.bundle.annotations.at(-1)?.page?.url || state.bundle.plan?.at(-1)?.url;
  const url = h('input.input', { type: 'url', value: s.origins[0] ? `${s.origins[0]}/` : '', placeholder: 'https://staging.example.com/' });
  const name = h('input.input', { type: 'text', value: `Nachtest: ${s.name}` });
  const version = h('input.input', { type: 'text', placeholder: 'z. B. 2.4.0 oder Commit a1b2c3d' });
  const error = h('p.small', { style: { color: 'var(--danger)', margin: 0 } });
  const start = h('button.btn.primary', { type: 'button' }, icon('play'), 'Nachtest starten');
  start.addEventListener('click', async () => {
    const target = url.value.trim();
    if (!/^(https?|file):\/\//i.test(target)) {
      error.textContent = 'Bitte die vollständige Adresse der neuen Version angeben (mit http:// oder https://).';
      return;
    }
    start.disabled = true;
    try {
      await flushEdits();
      await send('fl:startRetest', { baseSessionId: s.id, url: target, name: name.value.trim(), appVersion: version.value.trim(), openTab: true });
      closeModal();
    } catch (err) {
      error.textContent = err.message;
      start.disabled = false;
    }
  });
  const count = state.bundle.plan ? retestState(state.bundle).items.filter((x) => x.check?.retest.verdict !== 'fixed').length + retestState(state.bundle).fresh.length : state.bundle.annotations.filter((a) => a.status !== 'wontfix').length;
  openModal(
    h(
      'div',
      null,
      modalHead('Nachtest starten'),
      h(
        'div.modal-body',
        null,
        h('p.small.muted', { style: { margin: 0 }, text: `Prüft ${pl(count, 'Anmerkung', 'Anmerkungen')} aus „${s.name}“ in einer neueren Version: In der Leiste erscheint eine Liste, mit der du jede Anmerkung aufrufst und als behoben, besteht weiter, verändert oder nicht prüfbar bewertest. Am Ende gibt es ein Paket mit Vorher/nachher-Vergleich und nur den offenen Punkten.` }),
        h('label.field', null, 'Adresse der neuen Version', url),
        lastUrl ? h('p.small.muted', { style: { margin: '-6px 0 0' }, text: `Zuletzt getestet: ${lastUrl}` }) : null,
        h('label.field', null, 'Name', name),
        h('label.field', null, 'Version / Build / Commit (empfohlen)', version),
        error,
      ),
      h('div.modal-foot', null, h('button.btn', { type: 'button', text: 'Abbrechen', on: { click: closeModal } }), start),
    ),
  );
  url.focus();
}

function importDevResults() {
  const s = session();
  const input = h('input', { type: 'file', accept: '.md,.markdown,text/markdown,text/plain' });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const results = parseDevResults(await file.text());
      if (!results.length) throw new Error('Keine bearbeiteten Anmerkungen gefunden (erwartet wird die README.md aus dem Paket mit „- [x] **#4 …**“ bzw. „Ergebnis: …“).');
      const { matched } = await send('fl:applyDevResults', { sessionId: s.id, results });
      toast(`Ergebnisse der Entwicklung übernommen: ${pl(matched, 'Anmerkung', 'Anmerkungen')}${matched < results.length ? ` (${results.length - matched} ohne passende Nummer)` : ''}`, 'info', 6000);
    } catch (err) {
      toast(`Einlesen fehlgeschlagen: ${err.message}`, 'error', 7000);
    }
  });
  input.click();
}

async function deleteSession() {
  const s = session();
  const ok = await confirmDialog({ title: `„${s.name}“ löschen?`, text: `${pl(s.count, 'Anmerkung', 'Anmerkungen')} mit Screenshots und Klickpfad werden endgültig gelöscht. Tipp: Vorher eine Sicherung exportieren.` });
  if (!ok) return;
  await send('fl:deleteSession', { sessionId: s.id }).catch((e) => toast(e.message, 'error'));
  state.thumbs.clear();
  toast('Testlauf gelöscht');
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dictation setup (the dictation itself runs in src/offscreen/dictation.js)
// ---------------------------------------------------------------------------

const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
const localSpeech = () => (SR && 'processLocally' in SR.prototype && typeof SR.available === 'function' ? 'processLocally' : SR && 'mode' in SR.prototype && typeof SR.availableOnDevice === 'function' ? 'mode' : null);

async function speechStatus(lang) {
  const mode = localSpeech();
  if (!mode) return 'unsupported';
  try {
    const res = mode === 'processLocally' ? await SR.available({ langs: [lang], processLocally: true }) : await SR.availableOnDevice(lang);
    return typeof res === 'string' ? res : res ? 'available' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

async function micPermission() {
  try {
    return (await navigator.permissions.query({ name: 'microphone' })).state; // granted | prompt | denied
  } catch {
    return 'prompt';
  }
}

/** Settings section: status, microphone permission for the extension, language pack. */
function dictationSection(settings) {
  const lang = h('select.input', { 'aria-label': 'Sprache für das Diktat' }, C.DICTATION_LANGS.map((l) => h('option', { value: l.id, text: l.label })));
  lang.value = settings.dictationLang;
  lang.dataset.key = 'dictationLang';
  const status = h('ul.dict-status');
  const actions = h('div.row');
  const output = h('p.small.dict-try', { hidden: true });
  const row = (ok, text) => h('li', { class: ok === true ? 'ok' : ok === false ? 'bad' : '' }, h('span', { text: ok === true ? '✓' : ok === false ? '✗' : '…' }), text);

  async function refresh() {
    const [speech, mic] = await Promise.all([speechStatus(lang.value), micPermission()]);
    const label = C.DICTATION_LANGS.find((l) => l.id === lang.value)?.label;
    const speechText = {
      available: `Sprachpaket ${label} installiert – Erkennung läuft auf diesem Gerät`,
      downloadable: `Sprachpaket ${label} noch nicht installiert`,
      downloading: `Sprachpaket ${label} wird installiert …`,
      unavailable: `Für ${label} gibt es in diesem Browser keine Erkennung auf dem Gerät`,
      unsupported: 'Dieser Browser bietet keine Spracherkennung auf dem Gerät (Diktat bleibt aus)',
    }[speech];
    status.replaceChildren(
      row(speech === 'available' ? true : speech === 'downloading' ? null : false, speechText),
      row(mic === 'granted' ? true : mic === 'denied' ? false : null, mic === 'granted' ? 'Mikrofon für Feedback Lens freigegeben' : mic === 'denied' ? 'Mikrofon für Feedback Lens blockiert – in den Website-Einstellungen der Erweiterung erlauben' : 'Mikrofon für Feedback Lens noch nicht freigegeben'),
    );
    const buttons = [];
    if (mic !== 'granted') {
      const allow = h('button.btn.sm', { type: 'button', text: 'Mikrofon erlauben' });
      allow.addEventListener('click', async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach((t) => t.stop());
        } catch (err) {
          toast(`Mikrofon nicht freigegeben: ${err.message}`, 'error');
        }
        refresh();
      });
      buttons.push(allow);
    }
    if (speech === 'available' && mic === 'granted') {
      const tryIt = h('button.btn.sm', { type: 'button', text: 'Ausprobieren' });
      tryIt.addEventListener('click', () => {
        // Same settings as in the dialog: on this device only.
        const r = new SR();
        if (localSpeech() === 'processLocally') r.processLocally = true;
        else r.mode = 'ondevice-only';
        r.lang = lang.value;
        r.interimResults = true;
        output.hidden = false;
        output.textContent = 'Sprich jetzt einen Satz …';
        r.onresult = (e) => (output.textContent = Array.from(e.results, (x) => x[0].transcript).join(' '));
        r.onerror = (e) => (output.textContent = `Fehler: ${e.error}`);
        r.onend = () => (tryIt.disabled = false);
        tryIt.disabled = true;
        r.start();
      });
      buttons.push(tryIt);
    }
    if (speech === 'downloadable') {
      const install = h('button.btn.sm', { type: 'button', text: 'Sprachpaket installieren' });
      install.addEventListener('click', async () => {
        install.disabled = true;
        try {
          const ok = localSpeech() === 'processLocally' ? await SR.install({ langs: [lang.value], processLocally: true }) : await SR.installOnDevice(lang.value);
          toast(ok === false ? 'Das Sprachpaket konnte nicht installiert werden.' : 'Sprachpaket wird installiert – das kann einen Moment dauern.', ok === false ? 'error' : 'info');
        } catch (err) {
          toast(`Installation fehlgeschlagen: ${err.message}`, 'error');
        }
        refresh();
      });
      buttons.push(install);
    }
    actions.replaceChildren(...buttons);
  }
  lang.addEventListener('change', refresh);
  refresh();
  return h(
    'fieldset',
    { id: 'settings-dictation' },
    h('legend', { text: 'Diktat' }),
    h('p.small.muted', { style: { margin: 0 }, text: 'Im Anmerkungsdialog sprechen statt tippen (Mikrofon-Symbol im Textfeld). Die Spracherkennung läuft ausschließlich auf diesem Gerät – ist das nicht möglich, bleibt das Diktat aus; Sprache wird nie an einen Server geschickt. Die Freigabe des Mikrofons gilt nur für Feedback Lens, nicht für die getesteten Seiten.' }),
    h('label.field', null, 'Sprache', lang),
    status,
    actions,
    output,
    h('p.small.muted', { style: { margin: 0 }, text: 'Ohne lokale Erkennung: Diktierfunktion des Betriebssystems nutzen (Windows Win+H, macOS zweimal die Fn-Taste).' }),
  );
}

async function openSettings({ focus = null } = {}) {
  const store = await chrome.storage.local.get(K.settings);
  const settings = { ...C.DEFAULT_SETTINGS, ...(store[K.settings] || {}) };
  const check = (name, label, hint) => {
    const input = h('input', { type: 'checkbox', checked: settings[name] });
    input.dataset.key = name;
    return h('label.check-row', null, input, h('span', null, label, hint ? h('small', { text: hint }) : null));
  };
  const captureChecks = [
    check('captureConsole', 'Konsolenfehler erfassen', 'console.error/warn, JavaScript-Fehler, nicht geladene Ressourcen'),
    check('captureNetwork', 'Netzwerkfehler erfassen', 'Fehlgeschlagene (≥ 400) und langsame (> 3 s) Requests'),
    check('captureInteractions', 'Klickpfad aufzeichnen', 'Klicks, Eingaben (nur Länge, nie der Inhalt), Formulare – ergibt die „Schritte zum Nachstellen“'),
    check('maskSensitiveParams', 'Sensible Daten schwärzen', 'In erfassten Texten (HTML, Meldungen, Konsole, Fehlerantworten, Klickpfad) werden Passwörter, Tokens, API-Schlüssel, Kartennummern, IBAN und E-Mail-Adressen entfernt; URL-Parameter wie token, key, password, session, code, email werden durch *** ersetzt'),
    check('stripUrlQuery', 'Alle URL-Parameter entfernen', 'Adressen werden ohne ?… gespeichert – für Anwendungen, die Daten in der Adresse tragen. Der Nachtest öffnet Seiten dann ohne diese Parameter'),
  ];

  // Schnell-Anmerkung and „Speichern & kopieren“: where the copied annotation is pasted by default
  const quickFormat = h('select.input', { 'aria-label': 'Standard zum Kopieren' }, C.QUICK_FORMATS.map((f) => h('option', { value: f.id, text: `${f.label} – ${f.hint}` })));
  quickFormat.value = C.QUICK_FORMATS.some((f) => f.id === settings.quickFormat) ? settings.quickFormat : C.DEFAULT_SETTINGS.quickFormat;
  quickFormat.dataset.key = 'quickFormat';

  const shortcuts = h('div.shortcut-list');
  chrome.commands.getAll().then((cmds) => {
    for (const c of cmds) {
      const keys = shortcutKeys(c.shortcut);
      shortcuts.append(
        keys.length ? h('span.keys', { title: c.shortcut }, ...keys.map((k) => h(/^[⇧⌥⌘⌃]$/.test(k) ? 'kbd.sym' : 'kbd', { text: k }))) : h('span.muted', { text: '—' }),
        h('span', { text: c.description || (c.name === '_execute_action' ? 'Menü öffnen' : c.name) }),
      );
    }
  });
  const changeShortcuts = h('button.btn.sm', { type: 'button', text: 'Tastenkürzel ändern', on: { click: () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }) } });

  const wipe = h('button.btn.danger.sm', { type: 'button', text: 'Alle Daten löschen' });
  wipe.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Alle Daten löschen?', text: 'Alle Testläufe, Anmerkungen, Screenshots und Einstellungen werden aus diesem Browser entfernt.' });
    if (!ok) return;
    try {
      await send('fl:wipe');
      state.thumbs.clear();
      toast('Alle Daten gelöscht');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  const save = h('button.btn.primary', { type: 'button', text: 'Speichern' });
  save.addEventListener('click', async () => {
    const patch = {};
    for (const input of $modal.querySelectorAll('input[type=checkbox][data-key]')) patch[input.dataset.key] = input.checked;
    for (const select of $modal.querySelectorAll('select[data-key]')) patch[select.dataset.key] = select.value;
    await send('fl:saveSettings', { patch });
    closeModal();
    toast('Einstellungen gespeichert');
  });

  openModal(
    h(
      'div',
      null,
      modalHead('Einstellungen'),
      h(
        'div.modal-body',
        null,
        h('fieldset', null, h('legend', { text: 'Erfassung während des Tests' }), captureChecks),
        dictationSection(settings),
        h(
          'fieldset',
          { id: 'settings-quick' },
          h('legend', { text: 'Schnell-Anmerkung & Kopieren' }),
          h('p.small.muted', { style: { margin: 0 }, text: 'Außerhalb eines Testlaufs starten die Tastenkürzel (oder das Menü) eine Schnell-Anmerkung: markieren, kurz beschreiben, „Kopieren“ – gespeichert wird nichts. Im Testlauf kopiert „Speichern & kopieren“ eine Anmerkung zusätzlich. Für Claude und ChatGPT wird daraus ein einziges Bild mit Screenshot und allen Angaben, weil Chats beim Einfügen nur Text oder nur ein Bild übernehmen.' }),
          h('label.field', null, 'Standard beim Kopieren', quickFormat),
          h('p.small.muted', { style: { margin: 0 }, text: 'Im Dialog lässt sich das Ziel für jede Anmerkung auch einzeln wählen.' }),
        ),
        h('fieldset', null, h('legend', { text: 'Tastenkürzel' }), shortcuts, h('div', null, changeShortcuts)),
        h(
          'fieldset',
          null,
          h('legend', { text: 'Daten' }),
          h('p.small.muted', { style: { margin: 0 }, text: 'Alle Testläufe liegen ausschließlich lokal in diesem Browser; die Erweiterung sendet nichts ins Netz. Mit „Weitere Formate → Sicherung“ lässt sich ein Testlauf sichern oder auf einen anderen Rechner übertragen.' }),
          h('div', null, wipe),
        ),
      ),
      h('div.modal-foot', null, h('button.btn', { type: 'button', text: 'Abbrechen', on: { click: closeModal } }), save),
    ),
  );
  if (focus === 'dictation') document.getElementById('settings-dictation')?.scrollIntoView({ block: 'start' });
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

const $file = document.getElementById('import-file');
$file.addEventListener('change', async () => {
  const file = $file.files?.[0];
  $file.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    // Screenshots travel separately and in batches: one message for a large
    // backup would exceed Chrome's message size limit.
    const images = [];
    if (Array.isArray(data?.annotations)) {
      for (const a of [...data.annotations, ...(Array.isArray(data.plan) ? data.plan : [])]) {
        if (a && typeof a === 'object') {
          for (const variant of ['crop', 'full']) if (typeof a.imageData?.[variant] === 'string') images.push({ oldId: a.id, variant, dataUrl: a.imageData[variant] });
          for (const [variant, dataUrl] of Object.entries(a.imageData?.extra || {})) if (/^x\d{1,2}$/.test(variant) && typeof dataUrl === 'string') images.push({ oldId: a.id, variant, dataUrl });
          delete a.imageData;
        }
      }
    }
    for (const [itemId, r] of Object.entries(data?.testPlan?.results || {})) {
      if (typeof r?.imageData?.full === 'string') images.push({ oldId: `tp:${itemId}`, variant: 'full', dataUrl: r.imageData.full });
      if (r && typeof r === 'object') delete r.imageData;
    }
    const { meta, idMap } = await send('fl:importSession', { data });
    let batch = [];
    let size = 0;
    let stored = 0;
    const flushBatch = async () => {
      if (batch.length) stored += await send('fl:importImages', { sessionId: meta.id, images: batch });
      batch = [];
      size = 0;
    };
    for (const img of images) {
      if (!idMap[img.oldId]) continue;
      if (size + img.dataUrl.length > 16 * 1024 * 1024) await flushBatch();
      batch.push({ id: idMap[img.oldId], variant: img.variant, dataUrl: img.dataUrl });
      size += img.dataUrl.length;
    }
    await flushBatch();
    toast(`„${meta.name}“ importiert (${pl(meta.count, 'Anmerkung', 'Anmerkungen')}, ${pl(stored, 'Screenshot', 'Screenshots')})`);
    await loadSessions();
    await selectSession(meta.id);
  } catch (err) {
    toast(`Import fehlgeschlagen: ${err.message}`, 'error', 6000);
  }
});

// ---------------------------------------------------------------------------
// Live updates
// ---------------------------------------------------------------------------

let pendingKeys = new Set();
const refreshFromStorage = debounce(async () => {
  const keys = pendingKeys;
  pendingKeys = new Set();
  if (state.view === 'plans') {
    if (keys.has(K.sessions) || keys.has(K.active)) {
      await loadSessions();
      renderSidebar();
    }
    if (keys.has(K.templates) && !$modal.open) await openPlans();
    return;
  }
  const sessionKeysChanged = keys.has(K.sessions) || keys.has(K.active);
  if (sessionKeysChanged) {
    const before = state.selectedId;
    await loadSessions();
    renderSidebar();
    if (before !== state.selectedId) {
      await loadSelected();
      renderMain();
      return;
    }
  }
  const sid = state.selectedId;
  if (!sid) {
    state.bundle = null;
    renderMain();
    return;
  }
  const dataChanged = [K.ann(sid), K.trail(sid), K.tech(sid), K.testPlan(sid)].some((k) => keys.has(k));
  if (!dataChanged && !sessionKeysChanged) return;
  await loadSelected();
  if (!state.bundle) return renderMain();
  const page = $main.querySelector('.page');
  if (!page) return renderMain();
  // Update header/stats/tabs without touching inputs that currently have focus.
  const head = page.querySelector('.s-head');
  const focused = head.contains(document.activeElement) ? document.activeElement : null;
  if (sessionKeysChanged && !focused?.matches('input, textarea')) {
    const fresh = sessionHead();
    head.replaceWith(fresh);
    // Keep keyboard focus in the header (e.g. "Beenden" turns into "Fortsetzen").
    if (focused) fresh.querySelector('.s-actions .btn')?.focus();
  }
  page.querySelector('.stats').replaceWith(statsRow());
  const oldPlan = page.querySelector('.plan-card');
  if (oldPlan && state.bundle.testPlan) oldPlan.replaceWith(planCard());
  page.querySelector('.tabs').replaceWith(tabsBar());
  if (state.tab === 'annotations') refreshCards();
  else renderPanel();
}, 120);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const k of Object.keys(changes)) if (!k.startsWith('fl:img:') && k !== K.ui) pendingKeys.add(k);
  if (pendingKeys.size) refreshFromStorage();
});

// Must not be async: a returned promise counts as a response in Chrome and
// would answer other contexts' messages (e.g. the overlay's state requests).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'fl:show') showRequested(msg);
});

async function showRequested(msg) {
  if (msg.settings === 'dictation') return openSettings({ focus: 'dictation' });
  await loadSessions();
  if (!msg.sessionId || !state.sessions.some((s) => s.id === msg.sessionId)) return;
  if (msg.sessionId !== state.selectedId) await selectSession(msg.sessionId, { annotationId: msg.annotationId });
  else if (msg.annotationId) {
    state.focusAnnotation = msg.annotationId;
    if (state.tab !== 'annotations') switchTab('annotations');
    else refreshCards();
  }
  if (msg.exportZip) openExportDialog();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.getElementById('btn-import').append(icon('upload', 16));
document.getElementById('btn-import').addEventListener('click', () => $file.click());
const plansBtn = document.getElementById('btn-plans');
plansBtn.append(icon('checklist', 16), 'Testpläne');
plansBtn.addEventListener('click', openPlans);
const settingsBtn = document.getElementById('btn-settings');
settingsBtn.append(icon('settings', 16), 'Einstellungen');
settingsBtn.addEventListener('click', openSettings);

(async () => {
  await loadSessions();
  await loadSelected();
  renderSidebar();
  renderMain();
  if (params.get('settings') === 'dictation') {
    history.replaceState(null, '', state.selectedId ? `?session=${encodeURIComponent(state.selectedId)}` : location.pathname);
    openSettings({ focus: 'dictation' });
  }
  if (state.exportOnLoad && state.bundle) {
    // "Beenden & exportieren" from the popup; don't repeat it on reload.
    history.replaceState(null, '', `?session=${encodeURIComponent(state.selectedId)}`);
    openExportDialog();
  }
})().catch((err) => {
  console.error(err);
  $main.replaceChildren(h('div.page', null, h('div.notice.error', { text: `Fehler beim Laden: ${err.message}` })));
});
