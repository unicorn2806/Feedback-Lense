// In-page overlay (isolated world): toolbar, element/region picking, the
// annotation drawer with screenshot + pen, pins for existing annotations and
// the interaction trail. All UI lives in a closed shadow root.
(() => {
  const C = globalThis.FL_CONST;
  const X = globalThis.FL_CTX;
  const S = globalThis.FL_SAN;
  const M = globalThis.FL_MARKS;
  const HOST_ATTR = 'data-feedback-lens';
  const TO_PAGE = '__fl_to_page';
  const FROM_PAGE = '__fl_from_page';
  const PROBE = '__fl_probe';
  const ACCENT = '#f43f5e';

  // Replace an older instance (e.g. after the extension was reloaded).
  try {
    globalThis.__feedbackLensOverlay?.destroy();
  } catch {
    /* orphaned instance */
  }
  document.querySelectorAll(`[${HOST_ATTR}]`).forEach((n) => n.remove());

  const ac = new AbortController();
  const listen = (target, type, fn, opts = {}) => target.addEventListener(type, fn, { ...opts, signal: ac.signal });
  const timers = new Set();
  let destroyed = false;

  const state = {
    session: null,
    settings: { ...C.DEFAULT_SETTINGS },
    annotations: [],
    plan: [], // re-test: the earlier annotations to check
    testPlan: null, // test plan: { name, items, results }
    planTarget: null, // checkpoint a finding is being recorded for
    drafts: [], // parked annotations of this run (summaries; the content stays in storage)
    mode: 'idle', // idle | pick | region | busy | dialog
    ui: { x: null, y: null, minimized: false, lastCategory: 'usability', pins: true, retestOpen: false, retestFocus: null, retestDock: 'right', retestCollapsed: false },
    pageEvents: [],
    lastUrl: location.href,
  };

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  const extensionAlive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  };

  async function call(type, payload = {}) {
    if (!extensionAlive()) {
      destroy();
      throw new Error('Die Erweiterung wurde neu geladen. Bitte die Seite neu laden.');
    }
    const res = await chrome.runtime.sendMessage({ type, ...payload });
    if (!res) throw new Error('Keine Antwort von Feedback Lens.');
    if (!res.ok) throw new Error(res.error);
    return res.data;
  }

  const toPage = (msg) => document.dispatchEvent(new CustomEvent(TO_PAGE, { detail: JSON.stringify(msg) }));

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------

  function h(tag, props, ...children) {
    const [name, ...classes] = tag.split('.');
    const el = document.createElement(name);
    if (classes.length) el.className = classes.join(' ');
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'on') for (const [ev, fn] of Object.entries(value)) el.addEventListener(ev, fn);
      else if (key === 'style') Object.assign(el.style, value);
      else if (key === 'text') el.textContent = value;
      else if (key === 'value') el.value = value;
      else el.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : String(child));
    }
    return el;
  }

  const ICONS = {
    logo: 'M10.5 3.5a7 7 0 100 14 7 7 0 000-14zM15.5 15.5l5 5',
    pick: 'M12 2v4M12 18v4M2 12h4M18 12h4M12 9a3 3 0 100 6 3 3 0 000-6z',
    region: 'M4 9V5a1 1 0 011-1h4M15 4h4a1 1 0 011 1v4M20 15v4a1 1 0 01-1 1h-4M9 20H5a1 1 0 01-1-1v-4',
    note: 'M5 4h14a1 1 0 011 1v10l-5 5H5a1 1 0 01-1-1V5a1 1 0 011-1zM15 20v-5h5M8 9h8M8 13h5',
    pin: 'M12 21s-6.5-5.6-6.5-11.2a6.5 6.5 0 0113 0C18.5 15.4 12 21 12 21zM12 12.3a2.5 2.5 0 100-5 2.5 2.5 0 000 5z',
    list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
    minimize: 'M5 12h14',
    close: 'M6 6l12 12M18 6L6 18',
    undo: 'M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 010 11H11',
    trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
    external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
    checklist: 'M10 6h10M10 12h10M10 18h10M3.5 6l1.5 1.5L7.5 5M3.5 12l1.5 1.5L7.5 11M3.5 18l1.5 1.5L7.5 17',
    eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z',
    chevronUp: 'M6 15l6-6 6 6',
    chevronDown: 'M6 9l6 6 6-6',
    swap: 'M7 7h13M16 3l4 4-4 4M17 17H4M8 13l-4 4 4 4',
    mic: 'M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3zM5 11a7 7 0 0014 0M12 18v3',
    aside: 'M5 20h14M12 4v11M7.5 10.5L12 15l4.5-4.5',
    camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 16.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7z',
    draft: 'M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4',
  };

  function icon(name, size = 18) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', ICONS[name]);
    svg.append(path);
    return svg;
  }

  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clip = (s, n) => (String(s || '').length > n ? String(s).slice(0, n - 1) + '…' : String(s || ''));
  /** Secrets and personal data out of everything taken from the page (setting „Sensible Daten schwärzen“). */
  const scrub = (data) => (state.settings.maskSensitiveParams ? S.redactDeep(data) : data);
  const categoryOf = (id) => C.CATEGORIES.find((c) => c.id === id) || C.CATEGORIES[0];
  const priorityOf = (id) => C.PRIORITIES.find((p) => p.id === id) || C.PRIORITIES[1];

  // ---------------------------------------------------------------------------
  // Shadow root & styles
  // ---------------------------------------------------------------------------

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.root { font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: #0f172a; -webkit-font-smoothing: antialiased; }
button { font: inherit; color: inherit; cursor: pointer; border: 0; background: none; padding: 0; }
button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid #818cf8; outline-offset: 2px; }
kbd { font: 600 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: rgba(255,255,255,.14); border: 1px solid rgba(255,255,255,.22); border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; }

.toolbar { position: fixed; z-index: 10; display: flex; align-items: center; gap: 2px; padding: 5px; background: #0f172a; color: #e2e8f0; border-radius: 14px; box-shadow: 0 10px 30px rgba(2,6,23,.35), 0 0 0 1px rgba(255,255,255,.06) inset; user-select: none; pointer-events: auto; }
.toolbar .grip { display: flex; align-items: center; gap: 8px; padding: 4px 8px 4px 6px; cursor: grab; border-radius: 10px; max-width: 220px; }
.toolbar .grip:active { cursor: grabbing; }
.toolbar .logo { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 8px; background: #4f46e5; color: #fff; flex: none; }
.toolbar .meta { display: flex; flex-direction: column; min-width: 0; line-height: 1.15; }
.toolbar .meta b { font-size: 12px; font-weight: 600; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.toolbar .meta span { font-size: 11px; color: #94a3b8; white-space: nowrap; }
.toolbar .sep { width: 1px; height: 24px; background: rgba(255,255,255,.12); margin: 0 4px; }
.tb { position: relative; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px; color: #cbd5e1; transition: background .12s, color .12s; }
.tb:hover { background: rgba(255,255,255,.1); color: #fff; }
.tb.on { background: #4f46e5; color: #fff; }
.tb.off { color: #64748b; }
.tb .tip { position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%); background: #020617; color: #f8fafc; font-size: 12px; white-space: nowrap; padding: 5px 8px; border-radius: 6px; pointer-events: none; opacity: 0; transition: opacity .12s; box-shadow: 0 4px 14px rgba(0,0,0,.3); }
.toolbar.top .tb .tip { bottom: auto; top: calc(100% + 8px); }
.tb:hover .tip { opacity: 1; transition-delay: .35s; }
.tb:nth-last-child(-n+3) .tip { left: auto; right: 0; transform: none; }
.fab { position: fixed; z-index: 10; width: 44px; height: 44px; border-radius: 50%; background: #4f46e5; color: #fff; display: grid; place-items: center; box-shadow: 0 8px 24px rgba(79,70,229,.45); pointer-events: auto; }
.tb-draft { display: inline-flex; align-items: center; gap: 6px; height: 30px; margin-left: 4px; padding: 0 10px 0 8px; border-radius: 9px; background: #fbbf24; color: #1f2937; font: 600 12px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; white-space: nowrap; box-shadow: 0 0 0 3px rgba(251,191,36,.25); }
.tb-draft:hover { background: #f59e0b; }
.fab.has-draft { box-shadow: 0 8px 24px rgba(79,70,229,.45), 0 0 0 3px #fbbf24; }
.draft-menu { position: fixed; z-index: 16; min-width: 240px; max-width: 340px; background: #fff; border-radius: 12px; box-shadow: 0 16px 40px rgba(2,6,23,.3), 0 0 0 1px rgba(15,23,42,.08); padding: 6px; pointer-events: auto; display: grid; gap: 2px; }
.draft-menu .dm-head { padding: 6px 8px 4px; font-size: 11.5px; color: #64748b; }
.draft-menu button { display: grid; gap: 1px; text-align: left; padding: 7px 9px; border-radius: 8px; }
.draft-menu button:hover, .draft-menu button:focus-visible { background: #f1f5f9; outline: none; }
.draft-menu b { font-size: 13px; font-weight: 600; color: #0f172a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.draft-menu small { font-size: 11.5px; color: #64748b; }
.d-aside { white-space: nowrap; }
.await-bar { position: fixed; z-index: 12; top: 12px; left: 50%; transform: translateX(-50%); display: none; align-items: center; gap: 10px; max-width: min(860px, calc(100vw - 24px)); padding: 8px 10px 8px 14px; border-radius: 14px; background: #0f172a; color: #e2e8f0; font-size: 12.5px; line-height: 1.35; box-shadow: 0 10px 30px rgba(2,6,23,.35), 0 0 0 2px #fbbf24; pointer-events: auto; }
.await-bar svg { flex: none; color: #fbbf24; }
.await-bar .btn { flex: none; white-space: nowrap; }
.await-bar .btn.ghost { color: #cbd5e1; }
.await-bar .btn.ghost:hover { background: rgba(255,255,255,.1); color: #fff; }
.x-field .label small { font-weight: 400; color: #64748b; }
.x-list { display: grid; gap: 8px; }
.x-list:empty { display: none; }
.x-row { display: flex; gap: 10px; align-items: flex-start; padding: 8px; border: 1px solid #e2e8f0; border-radius: 12px; background: #f8fafc; }
.x-thumb { flex: none; border-radius: 6px; cursor: zoom-in; background: #fff; box-shadow: 0 1px 3px rgba(15,23,42,.15); }
.x-body { flex: 1; min-width: 0; display: grid; gap: 6px; }
.x-head { display: flex; align-items: center; gap: 2px; font-size: 12px; }
.x-head .x-num { font-weight: 650; color: #0f172a; margin-right: 6px; }
.x-head .x-meta { color: #64748b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.x-head .grow { flex: 1; }
.x-head .icon-btn { width: 26px; height: 26px; }
.x-head .icon-btn[disabled] { opacity: .35; cursor: default; }
.x-row input { width: 100%; font: inherit; font-size: 13px; padding: 6px 8px; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff; color: #0f172a; }
.x-add { margin-top: 8px; }
.x-add[disabled] { opacity: .5; cursor: not-allowed; }
.fab .count { position: absolute; top: -4px; right: -4px; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px; background: #f43f5e; font: 700 11px/20px system-ui, sans-serif; text-align: center; border: 2px solid #fff; }

.hl { position: fixed; z-index: 5; pointer-events: none; border: 2px solid ${ACCENT}; background: rgba(244,63,94,.10); border-radius: 3px; box-shadow: 0 0 0 1px rgba(255,255,255,.7); transition: top .06s linear, left .06s linear, width .06s linear, height .06s linear; display: none; }
.hl-label { position: fixed; z-index: 6; pointer-events: none; display: none; max-width: min(520px, 90vw); background: #0f172a; color: #f8fafc; font: 12px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; padding: 4px 7px; border-radius: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-shadow: 0 4px 14px rgba(0,0,0,.25); }
.hl-label em { font-style: normal; color: #94a3b8; }
.hint { position: fixed; z-index: 7; top: 14px; left: 50%; transform: translateX(-50%); display: none; align-items: center; gap: 10px; background: #0f172a; color: #e2e8f0; padding: 8px 14px; border-radius: 999px; font-size: 12.5px; box-shadow: 0 10px 30px rgba(2,6,23,.35); pointer-events: none; white-space: nowrap; }
.hint b { color: #fff; }

.region-layer { position: fixed; inset: 0; z-index: 4; cursor: crosshair; background: rgba(15,23,42,.16); pointer-events: auto; }
.region-rect { position: fixed; border: 2px dashed ${ACCENT}; background: rgba(244,63,94,.08); box-shadow: 0 0 0 9999px rgba(15,23,42,.18); pointer-events: none; }
.region-size { position: absolute; right: 0; bottom: -24px; background: #0f172a; color: #fff; font: 11px ui-monospace, monospace; padding: 2px 6px; border-radius: 4px; }

.busy { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center; pointer-events: auto; cursor: progress; }
.busy span { background: #0f172a; color: #fff; padding: 10px 16px; border-radius: 999px; box-shadow: 0 10px 30px rgba(2,6,23,.35); }

.pins { position: fixed; inset: 0; pointer-events: none; z-index: 2; }
.pin { position: fixed; width: 24px; height: 24px; margin: -12px 0 0 -12px; border-radius: 50% 50% 50% 4px; color: #fff; font: 700 11px/20px system-ui, sans-serif; text-align: center; border: 2px solid #fff; box-shadow: 0 3px 10px rgba(2,6,23,.35); pointer-events: auto; transition: transform .1s; }
.pin:hover { transform: scale(1.12); }
.pin.done { opacity: .55; }
.popover { position: fixed; z-index: 15; width: 300px; background: #fff; border-radius: 12px; box-shadow: 0 16px 40px rgba(2,6,23,.3), 0 0 0 1px rgba(15,23,42,.08); padding: 12px 14px; pointer-events: auto; }
.popover h4 { margin: 6px 0 4px; font-size: 14px; }
.popover p { margin: 0 0 10px; color: #334155; white-space: pre-wrap; max-height: 140px; overflow: auto; }
.popover .row { display: flex; gap: 6px; flex-wrap: wrap; }

.backdrop { position: fixed; inset: 0; z-index: 30; background: rgba(15,23,42,.28); pointer-events: auto; }
.drawer { position: fixed; z-index: 31; top: 12px; right: 12px; bottom: 12px; width: min(460px, calc(100vw - 24px)); background: #fff; border-radius: 16px; box-shadow: 0 24px 60px rgba(2,6,23,.35); display: flex; flex-direction: column; overflow: hidden; pointer-events: auto; animation: slide .16s ease-out; }
@keyframes slide { from { transform: translateX(24px); opacity: 0; } }
.d-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px 12px; border-bottom: 1px solid #e2e8f0; }
.d-head h3 { margin: 0; font-size: 15px; font-weight: 650; flex: 1; }
.d-target { display: inline-flex; align-items: center; gap: 6px; max-width: 220px; font: 11.5px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #475569; background: #f1f5f9; padding: 3px 8px; border-radius: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.icon-btn { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 8px; color: #475569; flex: none; }
.icon-btn:hover { background: #f1f5f9; color: #0f172a; }
.d-body { flex: 1; overflow: auto; padding: 14px 16px 18px; display: flex; flex-direction: column; gap: 14px; }
.field label, .label { display: block; font-size: 12px; font-weight: 600; color: #334155; margin-bottom: 6px; }
.label small { font-weight: 400; color: #64748b; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 999px; border: 1px solid #e2e8f0; background: #fff; color: #334155; font-size: 12.5px; }
.chip:hover { border-color: #cbd5e1; background: #f8fafc; }
.chip i { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.chip.sel { border-color: var(--c); background: color-mix(in srgb, var(--c) 10%, #fff); color: #0f172a; font-weight: 600; }
.seg { display: grid; grid-template-columns: repeat(4, 1fr); background: #f1f5f9; border-radius: 10px; padding: 3px; gap: 3px; }
.seg button { padding: 6px 0; border-radius: 8px; font-size: 12.5px; color: #475569; }
.seg button.sel { background: #fff; color: #0f172a; font-weight: 600; box-shadow: 0 1px 3px rgba(15,23,42,.12); }
input[type=text], textarea { width: 100%; font: inherit; font-size: 13.5px; color: #0f172a; background: #fff; border: 1px solid #cbd5e1; border-radius: 10px; padding: 8px 10px; resize: vertical; }
input[type=text]:focus, textarea:focus { border-color: #6366f1; outline: none; box-shadow: 0 0 0 3px rgba(99,102,241,.18); }
textarea { min-height: 76px; }
.err { color: #dc2626; font-size: 12px; margin-top: 4px; }
.plan-sel { width: 100%; font: inherit; font-size: 13px; padding: 7px 9px; border: 1px solid #cbd5e1; border-radius: 10px; background: #fff; color: #0f172a; }
.rt-group { padding: 8px 12px 2px; font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: #64748b; }
.rt-notes { margin: 0 0 6px; padding-left: 18px; font-size: 12px; color: #475569; }
.rt-skip { display: flex; gap: 6px; margin-top: 6px; }
.rt-skip input { flex: 1; font: inherit; font-size: 12.5px; padding: 6px 8px; border: 1px solid #cbd5e1; border-radius: 8px; }
.rt-detail .row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.linkish { margin-top: 8px; font-size: 12px; color: #64748b; text-decoration: underline; background: none; border: 0; padding: 0; cursor: pointer; }
.dup { border: 1px solid #fcd34d; background: #fffbeb; border-radius: 12px; padding: 10px 12px; margin-bottom: 14px; font-size: 13px; color: #78350f; }
.dup p { margin: 0 0 6px; } .dup ul { margin: 0 0 8px; padding-left: 18px; } .dup li { margin: 2px 0; } .dup li small { color: #92400e; }
.dup .seg { display: inline-flex; flex-wrap: wrap; background: #fef3c7; }
.dup .seg button { flex: 0 0 auto; white-space: nowrap; padding: 5px 12px; } .dup .row { display: flex; gap: 8px; margin-top: 4px; }
.dup-note { font-size: 11.5px; color: #92400e; margin-top: 6px !important; }
.drawer:not(.as-addition) .dup-note { display: none; }
.as-addition .f-new { display: none !important; }
.shot { border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background: #f8fafc; }
.shot-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 6px; border-bottom: 1px solid #e2e8f0; background: #fff; }
.shot-bar .tabs { display: flex; background: #f1f5f9; border-radius: 8px; padding: 2px; }
.shot-bar .tabs button { font-size: 12px; padding: 3px 7px; border-radius: 6px; color: #475569; white-space: nowrap; }
.shot-bar .actions { display: flex; gap: 2px; margin-left: auto; }
.shot-bar .tabs button.sel { background: #fff; color: #0f172a; font-weight: 600; box-shadow: 0 1px 2px rgba(15,23,42,.1); }
.shot-bar .icon-btn { width: 26px; height: 26px; }
.shot + .flm-notes { margin-top: 10px; }
.shot-note { padding: 6px 10px 0; font-size: 11.5px; color: #92400e; }
.shot-note[hidden] { display: none; }
.canvas-wrap { position: relative; display: grid; place-items: center; padding: 8px; min-height: 80px; }
.shot-expand { position: absolute; top: 14px; right: 14px; display: inline-flex; align-items: center; gap: 5px; padding: 4px 9px; border-radius: 999px; background: rgba(15,23,42,.78); color: #fff; font-size: 11.5px; font-weight: 600; box-shadow: 0 2px 8px rgba(15,23,42,.25); }
.shot-expand:hover { background: #0f172a; }
.shot-bar .tabs.tools button { display: inline-grid; place-items: center; padding: 3px 7px; }
.shot-bar:has(+ .shot-tools) { border-bottom: 0; }
.shot-bar.shot-tools { justify-content: space-between; padding-top: 0; }
.shot-bar .flm-colors { padding-right: 2px; }
canvas.preview { max-width: 100%; border-radius: 6px; cursor: crosshair; touch-action: none; box-shadow: 0 1px 4px rgba(15,23,42,.18); background: #fff; }
.shot-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 10px 8px; font-size: 12px; color: #64748b; }
.check { display: inline-flex; align-items: center; gap: 6px; color: #334155; cursor: pointer; }
.noshot { padding: 18px; text-align: center; color: #64748b; font-size: 12.5px; }
details.tech { border: 1px solid #e2e8f0; border-radius: 12px; padding: 0 12px; }
details.tech summary { cursor: pointer; padding: 9px 0; font-size: 12.5px; font-weight: 600; color: #334155; list-style: none; display: flex; justify-content: space-between; }
details.tech summary::-webkit-details-marker { display: none; }
details.tech summary span { font-weight: 400; color: #64748b; }
.kv { display: grid; grid-template-columns: 110px 1fr; gap: 4px 10px; padding: 0 0 12px; font-size: 12px; }
.kv dt { color: #64748b; }
.kv dd { margin: 0; color: #0f172a; word-break: break-word; }
.kv code { font: 11.5px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #f1f5f9; padding: 1px 4px; border-radius: 4px; }
.kv .warn { color: #b45309; }
.d-foot { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-top: 1px solid #e2e8f0; background: #f8fafc; }
.d-foot .grow { flex: 1; font-size: 11.5px; color: #64748b; }
.btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 10px; font-size: 13px; font-weight: 600; border: 1px solid #cbd5e1; background: #fff; color: #0f172a; }
.btn:hover { background: #f1f5f9; }
.btn.primary { background: #4f46e5; border-color: #4f46e5; color: #fff; }
.btn.primary:hover { background: #4338ca; }
.btn.small { padding: 5px 9px; font-size: 12px; border-radius: 8px; }
.btn.ghost { border-color: transparent; background: transparent; color: #475569; padding-left: 8px; padding-right: 10px; }
.btn.ghost:hover { background: #eef2ff; color: #3730a3; }
.btn[disabled] { opacity: .6; cursor: progress; }
.badge { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: color-mix(in srgb, var(--c) 12%, #fff); color: var(--c); }
.toast { position: fixed; z-index: 40; left: 50%; bottom: 24px; transform: translateX(-50%) translateY(20px); opacity: 0; background: #0f172a; color: #fff; padding: 10px 16px; border-radius: 12px; font-size: 13px; box-shadow: 0 10px 30px rgba(2,6,23,.35); transition: opacity .18s, transform .18s; pointer-events: none; max-width: 90vw; }
.toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
.toast.error { background: #b91c1c; }
.pin.plan { background: #fff; color: #475569; border: 2px dashed #64748b; }

.rt { position: fixed; z-index: 12; top: 12px; right: 12px; width: min(370px, calc(100vw - 24px)); max-height: min(72vh, calc(100vh - 96px)); display: flex; flex-direction: column; background: #fff; border-radius: 14px; box-shadow: 0 16px 44px rgba(2,6,23,.3), 0 0 0 1px rgba(15,23,42,.08); pointer-events: auto; overflow: hidden; }
.rt.left { right: auto; left: 12px; }
.rt.collapsed .rt-list { display: none; }
.rt.collapsed .rt-head { border-bottom: 0; }
.rt-head { display: flex; align-items: flex-start; gap: 2px; padding: 12px 8px 10px 14px; border-bottom: 1px solid #e2e8f0; }
.rt-head > div { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.rt-head b { font-size: 14px; }
.rt-head span { font-size: 12px; color: #64748b; }
.rt-bar { height: 4px; background: #e2e8f0; border-radius: 2px; margin-top: 6px; overflow: hidden; display: flex; }
.rt-bar i { display: block; height: 100%; }
.rt-list { overflow: auto; padding: 6px; }
.rt-item { border-radius: 10px; }
.rt-item.sel { background: #f8fafc; box-shadow: 0 0 0 1px #e2e8f0 inset; margin: 4px 0; }
.rt-row { display: flex; align-items: center; gap: 9px; width: 100%; text-align: left; padding: 8px; border-radius: 10px; }
.rt-row:hover { background: #f1f5f9; }
.rt-num { flex: none; min-width: 30px; padding: 2px 6px; border-radius: 6px; color: #fff; font: 700 11.5px/18px system-ui, sans-serif; text-align: center; }
.rt-title { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.rt-title b { font-weight: 600; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rt-title small { color: #64748b; font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rt-verdict { flex: none; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; color: var(--c); background: color-mix(in srgb, var(--c) 12%, #fff); }
.rt-detail { padding: 0 10px 12px 10px; display: flex; flex-direction: column; gap: 8px; font-size: 12.5px; }
.rt-detail p { margin: 0; color: #334155; white-space: pre-wrap; }
.rt-detail b { color: #0f172a; }
.rt-desc { border-left: 3px solid #c7d2fe; padding-left: 8px; }
.rt-detail details summary { cursor: pointer; color: #475569; font-weight: 600; }
.rt-detail ol { margin: 6px 0 0; padding-left: 20px; color: #334155; }
.rt-where { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 9px; border-radius: 8px; background: #fff; border: 1px solid #e2e8f0; color: #334155; }
.rt-where.ok { border-color: #bbf7d0; background: #f0fdf4; }
.rt-where.warn { border-color: #fde68a; background: #fffbeb; }
.rt-label { font-weight: 600; color: #334155; }
.rt-verdicts { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.rt-v { padding: 7px 8px; border-radius: 8px; border: 1px solid color-mix(in srgb, var(--c) 40%, #fff); color: var(--c); background: #fff; font-weight: 600; font-size: 12.5px; }
.rt-v:hover, .rt-v.sel { background: color-mix(in srgb, var(--c) 12%, #fff); }
.rt-v.sel { box-shadow: 0 0 0 2px var(--c) inset; }
.rt-intro { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 10px 12px; font-size: 12.5px; color: #334155; display: flex; flex-direction: column; gap: 4px; }
.rt-intro b { color: #0f172a; }
.rt-intro .warn { color: #b45309; }
.dict { position: relative; }
.dict textarea { padding-right: 42px; }
.dict-field { grid-column: 2; min-width: 0; }
.dict.inline input { width: 100%; padding-right: 36px !important; }
.dict.inline .mic { top: 50%; right: 4px; width: 26px; height: 26px; transform: translateY(-50%); }
.flm-editor .dict.inline .mic { background: rgba(255,255,255,.1); border-color: rgba(255,255,255,.18); color: #cbd5e1; }
.mic { position: absolute; right: 7px; top: 7px; width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center; color: #64748b; background: #f8fafc; border: 1px solid #e2e8f0; }
.mic:hover { color: #0f172a; background: #f1f5f9; }
.mic.on { color: #fff; background: #dc2626; border-color: #dc2626; animation: pulse 1.2s infinite; }
.mic[disabled] { opacity: .5; cursor: progress; }
@keyframes pulse { 50% { box-shadow: 0 0 0 5px rgba(220,38,38,.2); } }
.dict-hint { margin-top: 6px; font-size: 12px; color: #334155; background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 8px 10px; flex-direction: column; gap: 6px; }
.dict-hint p { margin: 0; }
.dict-hint .muted { color: #64748b; }
.shake { animation: shake .3s; }
@keyframes shake { 25% { transform: translateX(-4px); } 75% { transform: translateX(4px); } }
`;

  // A custom tag (not a div) so generic page rules like `div { display: none }` cannot hit it.
  const host = document.createElement('feedback-lens-ui');
  host.setAttribute(HOST_ATTR, '');
  // Full-viewport but click-through: only our controls take pointer events. The
  // transform makes the host the containing block of our fixed elements, so they
  // stay put even when the host has to live inside a page's modal dialog.
  Object.assign(host.style, { all: 'initial', position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh', zIndex: '2147483647', display: 'block', pointerEvents: 'none', transform: 'translate(0px, 0px)' });
  const shadow = host.attachShadow({ mode: 'closed' });
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS + M.CSS);
    shadow.adoptedStyleSheets = [sheet]; // not subject to the page's style-src CSP
  } catch {
    shadow.append(h('style', { text: CSS + M.CSS }));
  }
  const root = h('div.root');
  shadow.append(root);

  // Keep our clicks and keystrokes away from the page's own handlers
  // ("click outside" closing menus, global hotkeys, …).
  for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'contextmenu', 'keydown', 'keyup', 'keypress', 'input', 'beforeinput', 'focusin', 'focusout', 'paste', 'copy', 'cut', 'wheel']) {
    host.addEventListener(type, (e) => e.stopPropagation());
  }

  const isOurs = (e) => e.composedPath().includes(host);

  // ---------------------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------------------

  const toastEl = h('div.toast', { role: 'status' });
  root.append(toastEl);
  let toastTimer;
  function toast(text, kind = 'info', ms = 2600) {
    toastEl.textContent = text;
    toastEl.className = `toast show ${kind === 'error' ? 'error' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.className = 'toast'), ms);
  }

  // ---------------------------------------------------------------------------
  // Toolbar
  // ---------------------------------------------------------------------------

  const tbButtons = {};
  const sessionName = h('b');
  const sessionCount = h('span');

  function tbButton(key, iconName, tip, onClick) {
    const btn = h('button.tb', { type: 'button', 'aria-label': tip }, icon(iconName), h('span.tip', { text: tip }));
    btn.dataset.tip = tip;
    // Don't steal focus from the page: open menus would close on blur.
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', onClick);
    tbButtons[key] = btn;
    return btn;
  }

  // parked drafts: one click continues the draft (with several: a short list)
  const draftBtn = h('button.tb-draft', { type: 'button' }, icon('draft', 15), h('span'));
  let draftMenu = null;

  // A draft waits for a further screenshot: say so, until the next capture
  const awaitText = h('span');
  const awaitPage = h('button.btn.small', { type: 'button', text: 'Sichtbaren Bereich aufnehmen' });
  const awaitBack = h('button.btn.small.ghost', { type: 'button', text: 'Zurück zum Entwurf' });
  const awaitBar = h('div.await-bar', { role: 'status' }, icon('camera', 18), awaitText, awaitPage, awaitBack);
  for (const b of [awaitPage, awaitBack]) b.addEventListener('mousedown', (e) => e.preventDefault()); // keep open menus open
  awaitPage.addEventListener('click', () => startPageNote());
  awaitBack.addEventListener('click', () => {
    const d = state.drafts.find((x) => x.awaitShot);
    if (d) resumeDraft(d.id);
  });
  draftBtn.addEventListener('mousedown', (e) => e.preventDefault());
  draftBtn.addEventListener('click', () => (state.drafts.length === 1 ? resumeDraft(state.drafts[0].id) : toggleDraftMenu()));

  const grip = h('div.grip', { title: 'Ziehen zum Verschieben' }, h('div.logo', null, icon('logo', 16)), h('div.meta', null, sessionName, sessionCount));
  const toolbar = h(
    'div.toolbar',
    { role: 'toolbar', 'aria-label': 'Feedback Lens' },
    grip,
    h('div.sep'),
    tbButton('pick', 'pick', 'Element markieren', () => (state.mode === 'pick' ? stopPick() : startPick())),
    tbButton('region', 'region', 'Bereich markieren', () => (state.mode === 'region' ? stopRegion() : startRegion())),
    tbButton('note', 'note', 'Notiz zur ganzen Seite', () => startPageNote()),
    draftBtn,
    h('div.sep'),
    tbButton('retest', 'checklist', 'Nachtest: frühere Anmerkungen prüfen', () => setRetestOpen(!state.ui.retestOpen)),
    tbButton('pins', 'pin', 'Markierungen ein-/ausblenden', () => togglePins()),
    tbButton('list', 'list', 'Alle Anmerkungen (Dashboard)', () => call('fl:openDashboard', { sessionId: state.session?.id }).catch((e) => toast(e.message, 'error'))),
    tbButton('min', 'minimize', 'Leiste minimieren', () => setMinimized(true)),
  );
  const fabCount = h('span.count');
  const fab = h('button.fab', { type: 'button', title: 'Feedback Lens öffnen', 'aria-label': 'Feedback Lens öffnen' }, icon('logo', 20), fabCount);
  fab.addEventListener('mousedown', (e) => e.preventDefault());
  fab.addEventListener('click', () => setMinimized(false));

  const COMMAND_OF = { pick: 'pick-element', region: 'select-region', note: 'page-note' };

  function applyShortcuts(shortcuts = {}) {
    for (const [key, command] of Object.entries(COMMAND_OF)) {
      const btn = tbButtons[key];
      const keys = shortcuts[command];
      btn.querySelector('.tip').textContent = keys ? `${btn.dataset.tip} (${keys})` : btn.dataset.tip;
    }
  }

  function updateToolbar() {
    const count = state.annotations.length;
    sessionName.textContent = state.session?.name || 'Testlauf';
    if (state.plan.length) {
      const checked = state.plan.filter((p) => checkOf(p)).length;
      const fresh = state.annotations.filter((a) => !a.retest).length;
      sessionCount.textContent = `${checked}/${state.plan.length} geprüft${fresh ? ` · ${fresh} neu` : ''}`;
    } else if (state.testPlan) {
      const checked = state.testPlan.items.filter((it) => planStatus(it)).length;
      sessionCount.textContent = `${checked}/${state.testPlan.items.length} Prüfpunkte · ${count} Anm.`;
    } else {
      sessionCount.textContent = count === 1 ? '1 Anmerkung' : `${count} Anmerkungen`;
    }
    const hasList = Boolean(state.plan.length || state.testPlan);
    tbButtons.retest.style.display = hasList ? '' : 'none';
    tbButtons.retest.classList.toggle('on', Boolean(state.ui.retestOpen && hasList));
    tbButtons.retest.title = state.testPlan && !state.plan.length ? 'Testplan: Prüfpunkte durchgehen' : 'Nachtest: frühere Anmerkungen prüfen';
    fabCount.textContent = String(count);
    fabCount.style.display = count ? '' : 'none';
    const drafts = state.drafts.length;
    const draftShown = draftBtn.style.display !== 'none';
    draftBtn.style.display = drafts ? '' : 'none';
    if (draftShown !== Boolean(drafts)) requestAnimationFrame(placeToolbar); // the bar got wider or narrower
    draftBtn.lastChild.textContent = drafts > 1 ? `${drafts} Entwürfe` : 'Entwurf';
    draftBtn.title = drafts === 1 ? `Weiter mit „${state.drafts[0].label}“` : 'Zur Seite gelegte Entwürfe';
    fab.classList.toggle('has-draft', drafts > 0);
    fab.title = drafts ? 'Feedback Lens öffnen – ein Entwurf wartet' : 'Feedback Lens öffnen';
    if (draftMenu && !drafts) closeDraftMenu();
    const waiting = state.drafts.find((d) => d.awaitShot);
    awaitBar.style.display = waiting && state.mode === 'idle' ? 'flex' : 'none';
    if (waiting) awaitText.textContent = `Weiterer Screenshot für „${clip(waiting.label, 32)}“ – Seite vorbereiten, dann in der Leiste Element, Bereich oder Seite wählen.`;
    tbButtons.pick.classList.toggle('on', state.mode === 'pick');
    tbButtons.region.classList.toggle('on', state.mode === 'region');
    tbButtons.pins.classList.toggle('off', !state.ui.pins);
    toolbar.style.display = state.ui.minimized ? 'none' : 'flex';
    fab.style.display = state.ui.minimized ? 'grid' : 'none';
  }

  function placeToolbar() {
    const w = toolbar.offsetWidth || 420;
    const hgt = toolbar.offsetHeight || 46;
    const x = state.ui.x ?? window.innerWidth - w - 20;
    const y = state.ui.y ?? window.innerHeight - hgt - 20;
    const cx = Math.min(Math.max(8, x), Math.max(8, window.innerWidth - w - 8));
    const cy = Math.min(Math.max(8, y), Math.max(8, window.innerHeight - hgt - 8));
    toolbar.style.left = `${cx}px`;
    toolbar.style.top = `${cy}px`;
    toolbar.classList.toggle('top', cy < 60);
    fab.style.left = `${Math.min(cx + w - 52, window.innerWidth - 56)}px`;
    fab.style.top = `${Math.min(cy, window.innerHeight - 56)}px`;
  }

  function saveUi() {
    if (!extensionAlive()) return;
    call('fl:saveUi', { patch: state.ui }).catch(() => {});
  }

  function setMinimized(min) {
    state.ui.minimized = min;
    updateToolbar();
    placeToolbar();
    saveUi();
  }

  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, left: toolbar.offsetLeft, top: toolbar.offsetTop };
    grip.setPointerCapture(e.pointerId);
    const move = (ev) => {
      state.ui.x = start.left + ev.clientX - start.x;
      state.ui.y = start.top + ev.clientY - start.y;
      placeToolbar();
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      state.ui.x = toolbar.offsetLeft;
      state.ui.y = toolbar.offsetTop;
      saveUi();
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });

  // ---------------------------------------------------------------------------
  // Pick mode
  // ---------------------------------------------------------------------------

  const hl = h('div.hl');
  const hlLabel = h('div.hl-label');
  const hint = h('div.hint');
  const pick = { candidate: null, childStack: [], raf: 0, lastPoint: null };

  function setHint(parts) {
    hint.replaceChildren(...parts);
    hint.style.display = parts.length ? 'flex' : 'none';
  }

  const hintParts = (items) => items.map(([k, label]) => h('span', null, h('kbd', { text: k }), ` ${label}`));

  function showHighlight(el) {
    if (!el) {
      hl.style.display = 'none';
      hlLabel.style.display = 'none';
      return;
    }
    const r = X.rectOf(el);
    Object.assign(hl.style, { display: 'block', left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
    const name = X.accessibleName(el).name;
    hlLabel.replaceChildren(X.shortLabel(el), h('em', { text: `  ${Math.round(r.width)}×${Math.round(r.height)}${name ? `  „${clip(name, 40)}“` : ''}` }));
    hlLabel.style.display = 'block';
    const labelY = r.y > 30 ? r.y - 28 : Math.min(r.y + r.height + 6, window.innerHeight - 28);
    hlLabel.style.left = `${Math.max(4, Math.min(r.x, window.innerWidth - 300))}px`;
    hlLabel.style.top = `${Math.max(4, labelY)}px`;
  }

  function startPick() {
    if (state.mode === 'dialog' || state.mode === 'busy') return;
    if (state.mode === 'region') stopRegion();
    closePopover();
    state.mode = 'pick';
    pick.candidate = null;
    pick.childStack = [];
    setHint([h('b', { text: 'Element anklicken' }), ...hintParts([['↑', 'Elternelement'], ['↓', 'zurück'], ['Enter', 'übernehmen'], ['Esc', 'abbrechen']])]);
    document.documentElement.style.cursor = 'crosshair';
    bindFrames();
    if (pick.lastPoint) updateCandidate(pick.lastPoint.x, pick.lastPoint.y);
    updateToolbar();
  }

  function stopPick() {
    if (state.mode !== 'pick') return;
    cancelAnimationFrame(pick.raf);
    frameAc?.abort();
    frameAc = null;
    state.mode = 'idle';
    showHighlight(null);
    setHint([]);
    document.documentElement.style.cursor = '';
    updateToolbar();
  }

  function updateCandidate(x, y) {
    if (state.mode !== 'pick') return;
    const el = X.deepElementFromPoint(x, y);
    if (!el || el === host || el === document.documentElement) return;
    if (el !== pick.candidate) {
      pick.candidate = el;
      pick.childStack = [];
    }
    showHighlight(pick.candidate);
  }

  const PICK_BLOCKED = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'touchstart', 'touchend'];

  function onPickMove(x, y) {
    cancelAnimationFrame(pick.raf);
    pick.raf = requestAnimationFrame(() => updateCandidate(x, y));
  }

  // While picking, swallow the page's pointer events so nothing gets clicked.
  function onPickBlocked(e, x, y) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'click' && e.button === 0) {
      if (!pick.candidate) updateCandidate(x, y);
      if (pick.candidate) confirmPick(pick.candidate);
    }
    if (e.type === 'contextmenu') stopPick();
  }

  listen(window, 'mousemove', (e) => {
    pick.lastPoint = { x: e.clientX, y: e.clientY };
    if (state.mode !== 'pick') return;
    if (isOurs(e)) {
      showHighlight(null);
      return;
    }
    onPickMove(e.clientX, e.clientY);
  }, { capture: true, passive: true });

  for (const type of PICK_BLOCKED) {
    listen(window, type, (e) => {
      if (state.mode !== 'pick' || isOurs(e)) return;
      onPickBlocked(e, e.clientX, e.clientY);
    }, { capture: true });
  }

  // Pointer events over an iframe never reach this window. Same-origin frames
  // get their own listeners while picking; cross-origin frames can only be
  // selected as a whole (hover, then Enter).
  let frameAc = null;
  function bindFrames() {
    frameAc?.abort();
    frameAc = new AbortController();
    const visit = (doc, depth) => {
      if (depth > 4) return;
      for (const frame of Array.from(doc.querySelectorAll('iframe, frame'))) {
        let win = null;
        try {
          win = frame.contentWindow && frame.contentDocument ? frame.contentWindow : null;
        } catch {
          win = null;
        }
        if (!win) continue;
        const toTop = (e) => {
          const r = X.rectOf(frame);
          return [r.x + frame.clientLeft + e.clientX, r.y + frame.clientTop + e.clientY];
        };
        const opts = { capture: true, signal: frameAc.signal };
        win.addEventListener('mousemove', (e) => state.mode === 'pick' && onPickMove(...toTop(e)), { ...opts, passive: true });
        for (const type of PICK_BLOCKED) win.addEventListener(type, (e) => state.mode === 'pick' && onPickBlocked(e, ...toTop(e)), opts);
        win.addEventListener('keydown', (e) => state.mode === 'pick' && onPickKey(e), opts);
        visit(win.document, depth + 1);
      }
    };
    visit(document, 0);
  }

  listen(window, 'mouseover', (e) => {
    if (state.mode !== 'pick') return;
    const target = e.composedPath()[0];
    if (!target || (target.tagName !== 'IFRAME' && target.tagName !== 'FRAME')) return;
    let sameOrigin = false;
    try {
      sameOrigin = Boolean(target.contentDocument);
    } catch {
      sameOrigin = false;
    }
    if (sameOrigin) return;
    pick.candidate = target;
    pick.childStack = [];
    showHighlight(target);
  }, { capture: true, passive: true });

  function confirmPick(el) {
    stopPick();
    captureAndOpen({ kind: 'element', el }).catch((err) => failCapture(err));
  }

  // ---------------------------------------------------------------------------
  // Region mode
  // ---------------------------------------------------------------------------

  let regionLayer = null;

  function startRegion() {
    if (state.mode === 'dialog' || state.mode === 'busy') return;
    if (state.mode === 'pick') stopPick();
    closePopover();
    state.mode = 'region';
    setHint([h('b', { text: 'Bereich aufziehen' }), ...hintParts([['Esc', 'abbrechen']])]);
    const rectEl = h('div.region-rect', { style: { display: 'none' } });
    const sizeEl = h('span.region-size');
    rectEl.append(sizeEl);
    regionLayer = h('div.region-layer', null, rectEl);
    let start = null;
    let current = null;
    regionLayer.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      regionLayer.setPointerCapture(e.pointerId);
      start = { x: e.clientX, y: e.clientY };
      regionLayer.style.background = 'transparent';
    });
    regionLayer.addEventListener('pointermove', (e) => {
      if (!start) return;
      const x = Math.min(start.x, e.clientX);
      const y = Math.min(start.y, e.clientY);
      current = { x, y, width: Math.abs(e.clientX - start.x), height: Math.abs(e.clientY - start.y) };
      Object.assign(rectEl.style, { display: 'block', left: `${x}px`, top: `${y}px`, width: `${current.width}px`, height: `${current.height}px` });
      sizeEl.textContent = `${Math.round(current.width)} × ${Math.round(current.height)}`;
    });
    regionLayer.addEventListener('pointerup', () => {
      const rect = current;
      start = null;
      current = null;
      if (!rect || rect.width < 8 || rect.height < 8) {
        rectEl.style.display = 'none';
        regionLayer.style.background = '';
        return;
      }
      stopRegion();
      captureAndOpen({ kind: 'region', rect }).catch((err) => failCapture(err));
    });
    root.append(regionLayer);
    updateToolbar();
  }

  function stopRegion() {
    if (state.mode !== 'region') return;
    state.mode = 'idle';
    regionLayer?.remove();
    regionLayer = null;
    setHint([]);
    updateToolbar();
  }

  function startPageNote() {
    if (state.mode === 'dialog' || state.mode === 'busy') return;
    stopPick();
    stopRegion();
    closePopover();
    captureAndOpen({ kind: 'page' }).catch((err) => failCapture(err));
  }

  function onPickKey(e) {
    if (!['Escape', 'ArrowUp', 'ArrowDown', 'Enter'].includes(e.key)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === 'Escape') {
      stopPick();
      state.planTarget = null;
    } else if (e.key === 'Enter' && pick.candidate) confirmPick(pick.candidate);
    else if (e.key === 'ArrowUp' && pick.candidate) {
      const parent = X.parentOf(pick.candidate);
      if (parent && parent !== document.documentElement) {
        pick.childStack.push(pick.candidate);
        pick.candidate = parent;
        showHighlight(parent);
      }
    } else if (e.key === 'ArrowDown' && pick.childStack.length) {
      pick.candidate = pick.childStack.pop();
      showHighlight(pick.candidate);
    }
  }

  listen(window, 'keydown', (e) => {
    if (state.mode === 'pick') {
      onPickKey(e);
    } else if (state.mode === 'region' && e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      stopRegion();
    }
  }, { capture: true });

  listen(window, 'scroll', () => {
    if (state.mode === 'pick' && pick.candidate) showHighlight(pick.candidate);
    schedulePins();
  }, { capture: true, passive: true });

  listen(window, 'resize', () => {
    placeToolbar();
    schedulePins();
  }, { passive: true });

  // ---------------------------------------------------------------------------
  // Capture: context + screenshot
  // ---------------------------------------------------------------------------

  const busy = h('div.busy', { style: { display: 'none' } }, h('span', { text: 'Screenshot wird erstellt …' }));

  const pendingProbes = new Map();
  function probePage(el) {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      const timer = setTimeout(() => {
        pendingProbes.delete(id);
        resolve(null);
      }, 500);
      pendingProbes.set(id, (res) => {
        clearTimeout(timer);
        pendingProbes.delete(id);
        resolve(res);
      });
      const target = el && el.ownerDocument === document ? el : document;
      target.dispatchEvent(new CustomEvent(PROBE, { bubbles: true, composed: true, detail: JSON.stringify({ id, element: target !== document }) }));
    });
  }

  function dataUrlToBlob(dataUrl) {
    const [head, b64] = dataUrl.split(',');
    const mime = /data:([^;]+)/.exec(head)?.[1] || 'image/png';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  // No transition may animate the inherited visibility (it would keep elements
  // visible for the duration); the toast is dismissed so it can't reappear.
  function hideUi(hidden) {
    if (hidden) {
      clearTimeout(toastTimer);
      toastEl.className = 'toast';
    }
    host.style.visibility = hidden ? 'hidden' : 'visible';
  }

  function inViewport(r) {
    return r.y >= 0 && r.x >= 0 && r.y + r.height <= window.innerHeight && r.x + r.width <= window.innerWidth;
  }

  async function captureAndOpen({ kind, el, rect, retest = null }) {
    if (state.mode === 'busy' || state.mode === 'dialog') return;
    state.mode = 'busy';
    busy.style.display = 'grid';
    const draft = { kind, el, rect: rect || null, includeShot: true, retest, extras: [] };
    // „Weiteren Screenshot aufnehmen“: this capture belongs to a parked draft
    const waiting = retest ? null : state.drafts.find((d) => d.awaitShot);
    try {
      if (kind === 'element') {
        let r = X.rectOf(el);
        const fits = r.height <= window.innerHeight && r.width <= window.innerWidth;
        if (!inViewport(r) && (fits || r.y > window.innerHeight || r.y + r.height < 0)) {
          el.scrollIntoView({ block: fits ? 'center' : 'start', inline: 'nearest' });
          await nextFrame();
          await sleep(160);
          r = X.rectOf(el);
        }
        draft.rect = r;
        draft.element = scrub(X.describeElement(el));
      }
      draft.scroll = [window.scrollX, window.scrollY]; // the rect is in viewport px of this moment
      const probe = await probePage(kind === 'element' ? el : null);
      draft.probe = probe;
      busy.style.display = 'none';
      hideUi(true);
      await nextFrame();
      await nextFrame();
      await sleep(40);
      if (kind === 'region') draft.region = scrub(X.describeRegion(rect));
      draft.page = scrub(X.pageInfo(state.settings.maskSensitiveParams));
      draft.techEvents = recentTechEvents();
      const clicks = clickCandidates();
      let shot = null;
      try {
        shot = await call('fl:capture');
      } catch (err) {
        draft.shotError = err.message;
      }
      hideUi(false);
      if (shot) {
        draft.shot = shot; // kept for parking the draft
        draft.bitmap = await createImageBitmap(dataUrlToBlob(shot));
        draft.scale = draft.bitmap.width / window.innerWidth;
        draft.cropRect = kind === 'page' ? null : cropRectFor(draft.rect);
      } else {
        draft.includeShot = false;
      }
      const r = draft.rect;
      draft.marks = {
        items: [],
        clicks,
        showClicks: state.ui.showClicks === true && clicks.length > 0,
        tool: M.DEFAULT_TOOL,
        view: kind === 'page' ? 'full' : 'crop',
        frame: kind !== 'page' && r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null,
      };
      if (waiting) await attachShot(waiting.id, draft);
      else openDrawer(draft);
    } catch (err) {
      hideUi(false);
      busy.style.display = 'none';
      state.mode = 'idle';
      throw err;
    }
  }

  function failCapture(err) {
    console.warn('[Feedback Lens]', err);
    toast(err.message || String(err), 'error', 4500);
  }

  // ---------------------------------------------------------------------------
  // Parked drafts („Kurz zur Seite“): continue where the dialog was left
  // ---------------------------------------------------------------------------

  async function restoreDraft(d) {
    const draft = { ...d, el: null, bitmap: null };
    delete draft.values;
    delete draft.label;
    delete draft.awaitShot;
    if (d.shot) draft.bitmap = await createImageBitmap(dataUrlToBlob(d.shot));
    else draft.includeShot = false;
    draft.marks = { items: [], clicks: [], ...d.marks, history: [], selected: null };
    draft.extras = [];
    for (const x of Array.isArray(d.extras) ? d.extras : []) {
      if (!x?.shot) continue;
      draft.extras.push({ ...x, bitmap: await createImageBitmap(dataUrlToBlob(x.shot)), marks: { items: [], clicks: [], ...x.marks, history: [], selected: null } });
    }
    if (d.retest) {
      const item = state.plan.find((p) => p.number === d.retest.number);
      draft.retest = item ? { ...d.retest, item, verdict: d.values?.verdict } : null;
    }
    return draft;
  }

  /** A further screenshot from a capture (its crop, or the visible area for a page note). */
  function extraFrom(cap) {
    return {
      shot: cap.shot,
      bitmap: cap.bitmap,
      scale: cap.scale,
      cropRect: cap.cropRect,
      kind: cap.kind,
      url: cap.page?.url || '',
      t: new Date().toISOString(),
      caption: '',
      marks: { items: [], clicks: cap.marks.clicks, showClicks: cap.marks.showClicks, tool: M.DEFAULT_TOOL, view: cap.cropRect ? 'crop' : 'full', frame: cap.marks.frame, history: [] },
    };
  }

  /** The capture goes to the parked draft that asked for it; the dialog opens again with it. */
  async function attachShot(id, cap) {
    let data;
    try {
      data = await call('fl:takeDraft', { sessionId: state.session.id, id });
    } catch {
      return openDrawer(cap); // the draft is gone (continued elsewhere): a new annotation then
    }
    state.drafts = state.drafts.filter((d) => d.id !== id);
    const draft = await restoreDraft(data);
    if (cap.bitmap && draft.extras.length < C.LIMITS.extraImages) draft.extras.push(extraFrom(cap));
    else if (!cap.bitmap) toast(`Kein Screenshot möglich${cap.shotError ? `: ${cap.shotError}` : ''}`, 'error', 4500);
    state.mode = 'idle';
    openDrawer(draft, data.values, { showExtra: draft.extras.length - 1 });
  }

  async function resumeDraft(id) {
    closeDraftMenu();
    if (state.mode === 'dialog' || state.mode === 'busy') return toast('Erst den offenen Dialog speichern oder zur Seite legen.');
    if (state.mode === 'pick') stopPick();
    if (state.mode === 'region') stopRegion();
    state.mode = 'busy';
    let data = null;
    try {
      data = await call('fl:takeDraft', { sessionId: state.session.id, id });
      state.drafts = state.drafts.filter((d) => d.id !== id);
      updateToolbar();
      const draft = await restoreDraft(data);
      state.mode = 'idle';
      openDrawer(draft, data.values);
    } catch (err) {
      state.mode = 'idle';
      if (data) call('fl:parkDraft', { sessionId: state.session.id, draft: data }).catch(() => {}); // taken but not shown: put it back
      toast(err.message || String(err), 'error', 4500);
    }
  }

  function closeDraftMenu() {
    draftMenu?.remove();
    draftMenu = null;
  }
  function toggleDraftMenu() {
    if (draftMenu) return closeDraftMenu();
    const at = (iso) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    const where = (url) => {
      try {
        const u = new URL(url);
        return u.pathname + u.hash === location.pathname + location.hash ? 'diese Seite' : clip(u.pathname + u.hash, 40);
      } catch {
        return '';
      }
    };
    draftMenu = h(
      'div.draft-menu',
      { role: 'menu', 'aria-label': 'Zur Seite gelegte Entwürfe' },
      h('div.dm-head', { text: 'Zur Seite gelegt – weiter mit:' }),
      state.drafts.map((d) => {
        const b = h('button', { type: 'button', role: 'menuitem' }, h('b', { text: d.label }), h('small', { text: [d.retest ? `Nachtest #${d.retest}` : '', `${at(d.parkedAt)} Uhr`, where(d.url)].filter(Boolean).join(' · ') }));
        b.addEventListener('click', () => resumeDraft(d.id));
        return b;
      }),
    );
    draftMenu.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeDraftMenu();
    });
    root.append(draftMenu);
    const r = toolbar.getBoundingClientRect();
    const w = draftMenu.offsetWidth;
    draftMenu.style.left = `${Math.max(8, Math.min(draftBtn.getBoundingClientRect().left, window.innerWidth - w - 8))}px`;
    if (r.top > draftMenu.offsetHeight + 16) draftMenu.style.bottom = `${window.innerHeight - r.top + 8}px`;
    else draftMenu.style.top = `${r.bottom + 8}px`;
    draftMenu.querySelector('button')?.focus();
  }

  /** Crop area around the target in CSS px (viewport), with context padding. */
  function cropRectFor(r) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 56;
    let x0 = Math.max(0, r.x - pad);
    let y0 = Math.max(0, r.y - pad);
    let x1 = Math.min(vw, r.x + r.width + pad);
    let y1 = Math.min(vh, r.y + r.height + pad);
    const grow = (a0, a1, min, max) => {
      const need = min - (a1 - a0);
      if (need <= 0) return [a0, a1];
      a0 = Math.max(0, a0 - need / 2);
      a1 = Math.min(max, a0 + min);
      a0 = Math.max(0, a1 - min);
      return [a0, a1];
    };
    [x0, x1] = grow(x0, x1, Math.min(360, vw), vw);
    [y0, y1] = grow(y0, y1, Math.min(200, vh), vh);
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  function recentTechEvents() {
    const s = state.settings;
    return state.pageEvents
      .filter((ev) => (['console', 'error', 'rejection', 'resource'].includes(ev.type) ? s.captureConsole : s.captureNetwork))
      .slice(-C.LIMITS.techPerAnnotation);
  }

  // ---------------------------------------------------------------------------
  // Screenshot views and recent clicks (the drawing itself: shared/marks.js)
  // ---------------------------------------------------------------------------

  /** Crop and full view of the captured bitmap; marks are in CSS px of the viewport. */
  function shotViews(draft) {
    const s = draft.scale;
    const b = draft.bitmap;
    const views = [];
    if (draft.cropRect) {
      const c = draft.cropRect;
      views.push({ id: 'crop', label: 'Ausschnitt', image: b, sx: c.x * s, sy: c.y * s, sw: c.width * s, sh: c.height * s, x: c.x, y: c.y, w: c.width, h: c.height });
    }
    views.push({ id: 'full', label: 'Ganze Ansicht', image: b, sx: 0, sy: 0, sw: b.width, sh: b.height, x: 0, y: 0, w: b.width / s, h: b.height / s });
    return views;
  }

  function renderFinalImages(draft) {
    const images = {};
    const max = C.LIMITS.imageMaxEdge;
    if (draft.bitmap && draft.includeShot) {
      const [crop, full] = draft.cropRect ? shotViews(draft) : [null, ...shotViews(draft)];
      images.full = M.toDataUrl(full, draft.marks, max, 'image/jpeg', 0.86);
      if (crop) images.crop = M.toDataUrl(crop, draft.marks, max, crop.sw * crop.sh <= 1.4e6 ? 'image/png' : 'image/jpeg', 0.9);
    }
    if (draft.extras?.length) images.extras = draft.extras.map((x) => renderView(extraView(x), x.marks));
    return images;
  }

  /** One image with its marks: PNG keeps small screenshots crisp, JPEG keeps large ones small. */
  const renderView = (view, marks) => M.toDataUrl(view, marks, C.LIMITS.imageMaxEdge, view.sw * view.sh <= 1.4e6 ? 'image/png' : 'image/jpeg', 0.88);

  /** A further screenshot is one picture: the crop around what was marked, or the visible area. */
  function extraView(x) {
    const s = x.scale;
    const b = x.bitmap;
    const c = x.cropRect;
    return c
      ? { id: 'crop', label: 'Ausschnitt', image: b, sx: c.x * s, sy: c.y * s, sw: c.width * s, sh: c.height * s, x: c.x, y: c.y, w: c.width, h: c.height }
      : { id: 'full', label: 'Ganze Ansicht', image: b, sx: 0, sy: 0, sw: b.width, sh: b.height, x: 0, y: 0, w: b.width / s, h: b.height / s };
  }

  /** What of a marks state is kept when a draft is parked (no history, no selection). */
  const marksData = ({ items, clicks, showClicks, tool, view, frame, color, base }) => ({ items, clicks, showClicks, tool, view, frame, color, base });
  const extraMeta = (x) => ({ caption: x.caption.trim(), url: x.url, kind: x.kind, t: x.t, ...M.legend(x.marks) });

  // The tester's last clicks, to number them on a screenshot. The click handler
  // stays cheap: the position is resolved only when a screenshot is taken.
  const recentClicks = [];
  function rememberClick(entry, el, e) {
    recentClicks.push({ entry, el: new WeakRef(el), client: [e.clientX, e.clientY], scroll: [window.scrollX, window.scrollY] });
    if (recentClicks.length > 20) recentClicks.shift();
  }

  /** Up to 9 last clicks visible in the viewport now, oldest first (CSS px). */
  function clickCandidates() {
    const out = [];
    for (const c of recentClicks.slice().reverse()) {
      if (out.length >= 9) break;
      let x = c.client[0] + c.scroll[0] - window.scrollX;
      let y = c.client[1] + c.scroll[1] - window.scrollY;
      const el = c.el.deref();
      if (el?.isConnected) {
        // moved since (layout change, fixed header while scrolling): mark where the element is now
        const r = el.getBoundingClientRect();
        if (r.width && r.height && !(x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) {
          x = r.left + r.width / 2;
          y = r.top + r.height / 2;
        }
      }
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue;
      out.unshift({ x: Math.round(x), y: Math.round(y), label: c.entry.label || '', role: c.entry.role || '', selector: c.entry.selector || '', t: c.entry.t, on: true });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Dictation: speech recognition on this device (see offscreen/dictation.js)
  // ---------------------------------------------------------------------------

  let dictation = null; // { field, button, hintBox, interim, runId }
  let dictationToken = 0; // a start that is overtaken (dialog closed, other field) must not switch the mic on

  const DICTATION_HINTS = {
    unsupported: 'Dieser Browser bietet keine Spracherkennung auf dem Gerät – und an einen Server schickt Feedback Lens keine Sprache.',
    unavailable: 'Für die eingestellte Sprache gibt es hier keine Spracherkennung auf dem Gerät.',
    downloadable: 'Das Sprachpaket für das lokale Diktat ist noch nicht installiert. Das geht einmalig im Dashboard unter Einstellungen → Diktat.',
    downloading: 'Das Sprachpaket wird gerade installiert – gleich noch einmal versuchen.',
    'not-allowed': 'Das Mikrofon ist für Feedback Lens noch nicht freigegeben. Das geht einmalig im Dashboard unter Einstellungen → Diktat.',
    'service-not-allowed': 'Die lokale Spracherkennung ist nicht eingerichtet (Dashboard → Einstellungen → Diktat).',
    'language-not-supported': 'Für die eingestellte Sprache gibt es hier keine Spracherkennung auf dem Gerät.',
    'audio-capture': 'Kein Mikrofon gefunden.',
    error: 'Das Diktat ließ sich nicht starten.',
  };
  const SETUP_STATUSES = ['downloadable', 'not-allowed', 'service-not-allowed'];

  function withDictation(field, { inline = false } = {}) {
    const button = h('button.mic', { type: 'button', title: 'Diktieren – Spracherkennung auf diesem Gerät', 'aria-label': 'Diktieren', 'aria-pressed': 'false' }, icon('mic', 16));
    const hintBox = h('div.dict-hint', { role: 'status', style: { display: 'none' } });
    button.addEventListener('mousedown', (e) => e.preventDefault()); // keep the caret in the field
    button.addEventListener('click', () => (dictation?.field === field ? stopDictation() : startDictation(field, button, hintBox)));
    return h(inline ? 'div.dict-field' : 'div', null, h(`div.dict${inline ? '.inline' : ''}`, null, field, button), hintBox);
  }

  function showDictationHint(box, status) {
    const setup = h('button.btn.small', { type: 'button', text: 'Diktat einrichten' });
    setup.addEventListener('click', () => call('fl:openDashboard', { settings: 'dictation' }).catch((e) => toast(e.message, 'error')));
    box.replaceChildren(
      h('p', { text: DICTATION_HINTS[status] || DICTATION_HINTS.error }),
      h('p.muted', { text: 'Alternativ die Diktierfunktion des Betriebssystems: Windows Win+H, macOS zweimal die Fn-Taste.' }),
      SETUP_STATUSES.includes(status) ? h('div', null, setup) : null,
    );
    box.style.display = 'flex';
  }

  async function startDictation(field, button, hintBox) {
    await stopDictation();
    const token = ++dictationToken;
    hintBox.style.display = 'none';
    button.disabled = true;
    let res;
    try {
      res = await call('fl:dictation', { action: 'start' });
    } catch (err) {
      res = { ok: false, status: 'error' };
    }
    button.disabled = false;
    if (token !== dictationToken || !field.isConnected) {
      if (res.ok) call('fl:dictation', { action: 'stop' }).catch(() => {});
      return;
    }
    if (!res.ok) return showDictationHint(hintBox, res.status);
    dictation = { field, button, hintBox, interim: '', runId: res.runId };
    button.classList.add('on');
    button.setAttribute('aria-pressed', 'true');
    button.title = 'Diktat beenden';
    field.focus();
  }

  async function stopDictation() {
    dictationToken++;
    const d = dictation;
    if (!d) return;
    dictation = null;
    d.button.classList.remove('on');
    d.button.setAttribute('aria-pressed', 'false');
    d.button.title = 'Diktieren – Spracherkennung auf diesem Gerät';
    await call('fl:dictation', { action: 'stop' }).catch(() => {});
  }

  /** Appends recognised text; interim text is shown and replaced by the final result. */
  function onDictationEvent(ev) {
    const d = dictation;
    if (!d || ev.runId !== d.runId) return;
    const field = d.field;
    if (!field.isConnected && ev.kind !== 'end') return stopDictation(); // its editor was closed
    if (ev.kind === 'result') {
      if (d.interim && field.value.endsWith(d.interim)) field.value = field.value.slice(0, -d.interim.length);
      d.interim = '';
      const join = (text) => {
        const before = field.value;
        const start = !before.trim() || /[.!?]\s*$/.test(before);
        const body = start ? text.charAt(0).toUpperCase() + text.slice(1) : text;
        return (before && !/\s$/.test(before) ? ' ' : '') + body;
      };
      if (ev.final) field.value += join(String(ev.final));
      if (ev.interim) {
        d.interim = join(String(ev.interim));
        field.value += d.interim;
      }
      field.scrollTop = field.scrollHeight;
      field.dispatchEvent(new Event('input', { bubbles: true })); // e.g. notes keep their text this way
    } else if (ev.kind === 'error') {
      if (!['no-speech', 'aborted'].includes(ev.error)) showDictationHint(d.hintBox, ev.error);
      stopDictation();
    } else if (ev.kind === 'end') {
      dictation = null; // already ended on the other side
      d.button.classList.remove('on');
      d.button.setAttribute('aria-pressed', 'false');
      d.button.title = 'Diktieren – Spracherkennung auf diesem Gerät';
    }
  }

  // ---------------------------------------------------------------------------
  // Annotation drawer
  // ---------------------------------------------------------------------------

  let drawer = null;

  function targetLabel(draft) {
    if (draft.kind === 'element') return `${C.KINDS.element}: ${draft.element.label}`;
    if (draft.kind === 'region') return `${C.KINDS.region} ${Math.round(draft.rect.width)}×${Math.round(draft.rect.height)}`;
    return C.KINDS.page;
  }

  const COMMENT_HINT = {
    fixed: 'Optional: Was ist jetzt anders?',
    open: 'Optional: Was ist noch genauso? Hat sich etwas verschlechtert?',
    changed: 'Was hat sich verändert, und was stört noch?',
    untestable: 'Warum ließ es sich nicht prüfen (z. B. Seite entfernt, Funktion fehlt)?',
  };

  function retestIntro(rt) {
    const item = rt.item;
    const lines = [h('div', null, h('b', { text: `Ursprünglich #${item.number}: ` }), item.title || '')];
    if (item.description && item.description !== item.title) lines.push(h('div', { text: clip(item.description, 280) }));
    if (!rt.onPage) lines.push(h('div.warn', { text: `Du bist nicht auf der ursprünglichen Seite (${routeKey(item.url)}).` }));
    else if (item.kind !== 'page' && !rt.how) lines.push(h('div.warn', { text: 'Das ursprüngliche Element wurde nicht gefunden – der Screenshot zeigt die ganze Seite.' }));
    return h('div.rt-intro', null, lines);
  }

  /** saved: the form of a parked draft that is continued; showExtra: scroll to that further screenshot. */
  function openDrawer(draft, saved = null, { showExtra = -1 } = {}) {
    state.mode = 'dialog';
    updateToolbar(); // e.g. the hint for a further screenshot goes away
    const rt = draft.retest;
    const values = { category: saved?.category || state.ui.lastCategory || 'usability', priority: saved?.priority || 'medium', verdict: saved?.verdict || rt?.verdict };

    // --- category & priority
    const catChips = C.CATEGORIES.map((cat) => {
      const chip = h('button.chip', { type: 'button', title: cat.hint, style: { '--c': cat.color } }, h('i', { style: { background: cat.color } }), cat.label);
      chip.style.setProperty('--c', cat.color);
      chip.addEventListener('click', () => {
        values.category = cat.id;
        catChips.forEach((c) => c.classList.toggle('sel', c === chip));
      });
      if (cat.id === values.category) chip.classList.add('sel');
      return chip;
    });
    const prioButtons = C.PRIORITIES.map((p) => {
      const b = h('button', { type: 'button', text: p.label });
      b.addEventListener('click', () => {
        values.priority = p.id;
        prioButtons.forEach((x) => x.classList.toggle('sel', x === b));
      });
      if (p.id === values.priority) b.classList.add('sel');
      return b;
    });

    // --- re-test verdict
    const verdictButtons = rt
      ? C.VERDICTS.map((v) => {
          const b = h('button', { type: 'button', text: v.label, title: v.hint });
          b.addEventListener('click', () => {
            values.verdict = v.id;
            verdictButtons.forEach((x) => x.classList.toggle('sel', x === b));
            description.placeholder = COMMENT_HINT[v.id];
          });
          if (v.id === values.verdict) b.classList.add('sel');
          return b;
        })
      : [];

    // --- test plan: which checkpoint this finding belongs to
    let planSelect = null;
    if (state.testPlan && !rt) {
      planSelect = h('select.plan-sel', { 'aria-label': 'Prüfpunkt im Testplan' }, h('option', { value: '', text: '– keinem Prüfpunkt zugeordnet –' }), state.testPlan.items.map((it) => h('option', { value: it.id, text: `${itemNo(it)} · ${clip(it.title, 70)}` })));
      planSelect.value = saved ? saved.planItem || '' : state.planTarget || '';
    }

    // --- text fields
    const title = h('input', { type: 'text', placeholder: 'Kurzer Titel (optional)', maxlength: '140', value: saved?.title || '' });
    const description = h('textarea', { placeholder: rt ? COMMENT_HINT[values.verdict] : 'Was ist das Problem? Was ist passiert, was stört dich?', rows: '4', value: saved?.description || '' });
    const expected = h('textarea', { placeholder: 'Was hättest du erwartet? Wie könnte es besser sein? (optional)', rows: '3', value: saved?.expected || '' });
    const errorLine = h('div.err');
    const previousFocus = document.activeElement;

    // --- screenshot
    const shotSection = buildShotSection(draft);
    const extrasSection = rt ? null : buildExtras(draft, { onAdd: () => park({ awaitShot: true }) });

    // --- the same spot already has an annotation: add to it instead of a duplicate
    const descLabel = h('label', null, 'Beschreibung ', h('small', { text: '– so konkret wie möglich, eine Beobachtung pro Anmerkung' }));
    const same = rt ? { box: null } : sameSpotChoice(draft, (target) => {
      panel.classList.toggle('as-addition', Boolean(target));
      shotSection.setAddition(target);
      if (target) descLabel.replaceChildren(`Nachtrag zu #${target.number}`);
      else descLabel.replaceChildren('Beschreibung ', h('small', { text: '– so konkret wie möglich, eine Beobachtung pro Anmerkung' }));
      panel.querySelector('.d-head h3').textContent = target ? `Nachtrag zu #${target.number}` : 'Neue Anmerkung';
      description.placeholder = target ? `Was möchtest du zu #${target.number} ergänzen?` : 'Was ist das Problem? Was ist passiert, was stört dich?';
      save.lastChild.textContent = target ? `Zu #${target.number} hinzufügen` : 'Speichern';
    });

    // --- technical summary
    const tech = buildTechSummary(draft);

    const save = h('button.btn.primary', { type: 'button', title: 'Speichern (Strg/⌘ + Enter)' }, icon('check', 16), 'Speichern');
    const cancel = h('button.btn', { type: 'button', text: 'Abbrechen' });
    const aside = h('button.btn.ghost.d-aside', { type: 'button', title: 'Den Dialog schließen, ohne etwas zu verlieren: Die Anwendung ist wieder bedienbar, der Entwurf bleibt gespeichert (auch beim Neuladen oder auf anderen Seiten). Weiter geht es über „Entwurf“ in der Leiste.' }, icon('aside', 16), 'Kurz zur Seite');
    const close = h('button.icon-btn', { type: 'button', title: 'Schließen (Esc)', 'aria-label': 'Schließen' }, icon('close'));

    const body = rt
      ? h(
          'div.d-body',
          null,
          retestIntro(rt),
          h('div.field', null, h('div.label', { text: 'Ergebnis im Nachtest' }), h('div.seg', null, verdictButtons)),
          h('div.field', null, h('label', { text: 'Kommentar' }), withDictation(description), errorLine),
          shotSection.el,
          tech,
        )
      : h(
      'div.d-body',
      null,
      same.box,
      planSelect ? h('div.field.f-new', null, h('label', { text: 'Prüfpunkt im Testplan' }), planSelect) : null,
      h('div.field.f-new', null, h('div.label', { text: 'Kategorie' }), h('div.chips', null, catChips)),
      h('div.field.f-new', null, h('div.label', { text: 'Priorität' }), h('div.seg', null, prioButtons)),
      h('div.field.f-new', null, h('label', { text: 'Titel' }), title),
      h('div.field', null, descLabel, withDictation(description), errorLine),
      h('div.field', null, h('label', { text: 'Erwartung / Verbesserungsidee' }), withDictation(expected)),
      shotSection.el,
      extrasSection.el,
      tech,
    );
    tech.classList.add('f-new');

    const panel = h(
      'div.drawer',
      { role: 'dialog', 'aria-modal': 'true', 'aria-label': rt ? `Nachtest #${rt.item.number}` : 'Neue Anmerkung' },
      h('div.d-head', null, h('h3', { text: rt ? `Nachtest #${rt.item.number}` : 'Neue Anmerkung' }), h('span.d-target', { title: draft.element?.selector || '', text: targetLabel(draft) }), close),
      body,
      h('div.d-foot', null, aside, h('div.grow'), cancel, save),
    );
    const backdrop = h('div.backdrop');
    drawer = { panel, backdrop, draft };
    root.append(backdrop, panel);
    shotSection.draw();
    if (saved?.addTo) same.choose?.(saved.addTo);
    if (showExtra >= 0) setTimeout(() => extrasSection?.reveal(showExtra), 60);
    else setTimeout(() => description.focus(), 30);

    const dirty = () => Boolean(title.value.trim() || description.value.trim() || expected.value.trim() || draft.marks.items.length || draft.marks.clicks.some((c) => c.note?.trim()) || draft.extras?.length);

    /** Everything needed to continue later – on this page or another one. */
    const snapshot = () => ({
      label: clip(title.value.trim() || description.value.trim().split('\n')[0] || targetLabel(draft) || 'Anmerkung', 120),
      kind: draft.kind,
      rect: draft.rect,
      scroll: draft.scroll,
      element: draft.element,
      region: draft.region,
      probe: draft.probe,
      page: draft.page,
      techEvents: draft.techEvents,
      shot: draft.shot || null,
      shotError: draft.shotError,
      scale: draft.scale,
      cropRect: draft.cropRect,
      includeShot: draft.includeShot,
      marks: marksData(draft.marks),
      extras: (draft.extras || []).map((x) => ({ shot: x.shot, scale: x.scale, cropRect: x.cropRect, kind: x.kind, url: x.url, t: x.t, caption: x.caption, marks: marksData(x.marks) })),
      retest: rt ? { number: rt.item.number, how: rt.how, onPage: rt.onPage } : null,
      values: { category: values.category, priority: values.priority, verdict: values.verdict, title: title.value, description: description.value, expected: expected.value, planItem: planSelect?.value || '', addTo: same.target?.id || null },
    });
    async function park({ quiet = false, awaitShot = false } = {}) {
      stopDictation();
      aside.disabled = true;
      try {
        const summary = await call('fl:parkDraft', { sessionId: state.session.id, draft: JSON.parse(JSON.stringify({ ...snapshot(), awaitShot })) });
        if (awaitShot) state.drafts = state.drafts.map((d) => ({ ...d, awaitShot: false }));
        if (!state.drafts.some((d) => d.id === summary.id)) state.drafts = [...state.drafts, summary];
      } catch (err) {
        aside.disabled = false;
        if (!quiet) errorLine.textContent = `Zur Seite legen fehlgeschlagen: ${err.message}`;
        return;
      }
      if (drawer?.panel !== panel) return;
      closeDrawer();
      if (quiet) return;
      if (state.ui.minimized) setMinimized(false);
      if (!awaitShot) toast('Zur Seite gelegt – weiter geht es über „Entwurf“ in der Leiste.', 'info', 4000);
    }
    Object.assign(drawer, { dirty, park });
    const closeDrawer = () => {
      state.planTarget = null;
      stopDictation();
      panel.remove();
      backdrop.remove();
      drawer = null;
      draft.bitmap?.close?.();
      state.mode = 'idle';
      updateToolbar();
      if (previousFocus?.isConnected) previousFocus.focus?.({ preventScroll: true });
    };
    const tryClose = () => {
      if (dirty() && !panel.dataset.confirm) {
        panel.dataset.confirm = '1';
        toast('Ungespeicherte Eingaben – nochmal „Abbrechen“ verwirft sie, „Kurz zur Seite“ behält sie.', 'info', 3500);
        setTimeout(() => delete panel.dataset.confirm, 3000);
        return;
      }
      closeDrawer();
    };

    async function doSave() {
      if (same.target) return saveAddition(same.target);
      const needsText = rt ? values.verdict === 'changed' : !title.value.trim();
      if (needsText && !description.value.trim()) {
        errorLine.textContent = rt ? 'Bitte kurz beschreiben, was sich verändert hat.' : 'Bitte kurz beschreiben, was dir aufgefallen ist.';
        description.classList.add('shake');
        setTimeout(() => description.classList.remove('shake'), 400);
        description.focus();
        return;
      }
      save.disabled = true;
      save.lastChild.textContent = 'Speichert …';
      try {
        const images = renderFinalImages(draft);
        const annotation = buildAnnotation(
          draft,
          rt
            ? { category: rt.item.category, priority: rt.item.priority, title: rt.item.title, description: description.value.trim(), expected: '', retest: { number: rt.item.number, verdict: values.verdict } }
            : { category: values.category, priority: values.priority, title: title.value.trim(), description: description.value.trim(), expected: expected.value.trim(), planItem: planSelect?.value || undefined },
        );
        flush(); // steps recorded so far must be stored before the annotation
        const res = await call('fl:saveAnnotation', { sessionId: state.session.id, annotation, images });
        if (rt) {
          // Continue with the next earlier annotation that has not been checked yet.
          // by number: the plan may have been reloaded while the dialog was open
          const idx = state.plan.findIndex((p) => p.number === rt.item.number);
          const next = [...state.plan.slice(idx + 1), ...state.plan.slice(0, Math.max(0, idx))].find((p) => p.number !== rt.item.number && !checkOf(p));
          state.ui.retestFocus = next ? next.number : null;
        } else {
          state.ui.lastCategory = values.category;
        }
        saveUi();
        closeDrawer();
        toast(rt ? `Nachtest #${res.number}: ${verdictOf(values.verdict).label}` : `Anmerkung #${res.number} gespeichert`);
      } catch (err) {
        save.disabled = false;
        save.lastChild.textContent = 'Speichern';
        errorLine.textContent = `Speichern fehlgeschlagen: ${err.message}`;
      }
    }

    async function saveAddition(target) {
      // the screenshot (crop, or the visible area) and the further ones become further screenshots of the target
      const shots = [];
      if (draft.bitmap && draft.includeShot) {
        const [view] = shotViews(draft);
        shots.push({ dataUrl: renderView(view, draft.marks), meta: { caption: 'Nachtrag', url: draft.page?.url, kind: draft.kind, t: new Date().toISOString(), ...M.legend(draft.marks) } });
      }
      for (const x of draft.extras || []) shots.push({ dataUrl: renderView(extraView(x), x.marks), meta: extraMeta(x) });
      if (!description.value.trim() && !expected.value.trim() && !shots.length) {
        errorLine.textContent = `Bitte beschreiben, was du zu #${target.number} ergänzen möchtest.`;
        description.focus();
        return;
      }
      save.disabled = true;
      try {
        flush();
        const res = await call('fl:appendToAnnotation', { sessionId: state.session.id, id: target.id, description: description.value.trim(), expected: expected.value.trim(), images: shots });
        closeDrawer();
        toast(`Nachtrag zu #${target.number} gespeichert${res?.skipped ? ` – ${res.skipped} Screenshot(s) passten nicht mehr dazu (höchstens ${C.LIMITS.extraImages + 1})` : ''}`, res?.skipped ? 'error' : 'info', res?.skipped ? 5000 : 2600);
      } catch (err) {
        save.disabled = false;
        errorLine.textContent = `Speichern fehlgeschlagen: ${err.message}`;
      }
    }

    save.addEventListener('click', doSave);
    aside.addEventListener('click', () => park());
    cancel.addEventListener('click', tryClose);
    close.addEventListener('click', tryClose);
    // a click beside the dialog means „I want to get to the page“ – never discard on it
    backdrop.addEventListener('click', () => park());
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        doSave();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        tryClose();
      }
    });
  }

  /** Earlier annotations of this run on the same spot: the same element, or (areas) mostly the same area. */
  function sameSpot(draft) {
    if (draft.kind === 'page') return [];
    // a continued draft may be opened on another page: compare with where it was captured
    const here = routeKey(draft.page?.url || X.maskUrl(location.href, state.settings.maskSensitiveParams));
    const [sx, sy] = draft.scroll || [window.scrollX, window.scrollY];
    const doc = draft.rect && { x: draft.rect.x + sx, y: draft.rect.y + sy, width: draft.rect.width, height: draft.rect.height };
    const overlap = (a, b) => {
      const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const h2 = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      const inter = Math.max(0, w) * Math.max(0, h2);
      return inter / (a.width * a.height + b.width * b.height - inter || 1);
    };
    return state.annotations.filter((a) => {
      if (a.retest || a.kind !== draft.kind || routeKey(a.page?.url || '') !== here) return false;
      if (draft.kind === 'element') {
        if (a.element?.selector && a.element.selector === draft.element?.selector) return true;
        try {
          return Boolean(draft.el && a.anchor?.selector) && X.querySelectorDeep(a.anchor.selector) === draft.el;
        } catch {
          return false;
        }
      }
      return Boolean(doc && a.anchor?.docRect) && overlap(a.anchor.docRect, doc) > 0.6;
    });
  }

  /**
   * The hint at the top of the dialog: this spot already has annotation(s) – or,
   * in a re-test, belongs to an earlier one that is checked via the list.
   * onChoose(target|null) switches the dialog between "new" and "add to #n".
   */
  function sameSpotChoice(draft, onChoose) {
    const result = { box: null, target: null };
    const planHit = draft.kind === 'element' ? state.plan.find((p) => p.kind === 'element' && onItemPage(p) && !checkOf(p) && ((p.selector && p.selector === draft.element?.selector) || (draft.el && findTarget(p)?.el === draft.el))) : null;
    const hits = sameSpot(draft).slice(-3);
    if (!hits.length && !planHit) return result;
    const parts = [];
    if (planHit) {
      const go = h('button.btn.small', { type: 'button', text: 'Zur Nachtest-Liste' });
      go.addEventListener('click', () => {
        drawer?.panel.querySelector('.d-foot .btn:not(.primary)')?.click(); // like „Abbrechen“
        if (drawer) return;
        setRetestOpen(true);
        focusItem(planHit.number);
      });
      parts.push(h('p', null, h('b', { text: `#${planHit.number} „${clip(planHit.title || planHit.description, 60)}“` }), ' aus dem früheren Test betrifft diese Stelle – bewerte sie in der Nachtest-Liste, statt eine neue Anmerkung anzulegen.'), h('div.row', null, go));
    }
    if (hits.length) {
      const options = [null, ...hits];
      const buttons = options.map((a) => {
        const b = h('button', { type: 'button', text: a ? `Zu #${a.number} hinzufügen` : 'Neue Anmerkung' });
        b.addEventListener('click', () => {
          result.target = a;
          buttons.forEach((x) => x.classList.toggle('sel', x === b));
          onChoose(a);
        });
        if (!a) b.classList.add('sel');
        return b;
      });
      result.choose = (id) => buttons[options.findIndex((a) => a?.id === id)]?.click();
      parts.push(
        h('p', null, hits.length === 1 ? 'Zu dieser Stelle gibt es schon eine Anmerkung:' : 'Zu dieser Stelle gibt es schon Anmerkungen:'),
        h('ul', null, hits.map((a) => h('li', null, h('b', { text: `#${a.number}` }), ` ${clip(a.title || a.description, 70)}`, h('small', { text: ` · ${categoryOf(a.category).label}${a.status === 'done' ? ' · erledigt' : ''}` })))),
        h('div.seg', null, buttons),
        h('p.dup-note', { text: 'Beim Hinzufügen bleiben Kategorie, Priorität und Screenshot der früheren Anmerkung; dein Text wird dort als Nachtrag angehängt, deine Screenshots als weitere Bilder.' }),
      );
    }
    result.box = h('div.dup', { role: 'note' }, parts);
    return result;
  }

  function buildShotSection(draft) {
    if (!draft.bitmap) {
      const el = h('div.field', null, h('div.label', { text: 'Screenshot' }), h('div.shot', null, h('div.noshot', { text: draft.shotError ? `Kein Screenshot möglich: ${draft.shotError}` : 'Kein Screenshot verfügbar.' })));
      return { el, draw() {}, setAddition() {} };
    }
    const ms = draft.marks;
    const views = shotViews(draft);
    const viewOf = () => views.find((v) => v.id === ms.view) || views[0];
    const canvas = h('canvas.preview');
    const expand = h('button.shot-expand', { type: 'button', title: 'Screenshot fensterfüllend bearbeiten' }, M.icon('expand', 13), 'Groß bearbeiten');
    const wrap = h('div.canvas-wrap', null, canvas, expand);
    // the full view is saved as well – and shows more than the crop
    const note = h('div.shot-note', { text: 'Gespeichert werden Ausschnitt und ganze Ansicht – unter „Ganze Ansicht“ prüfen, ob dort noch Vertrauliches zu sehen ist.' });
    const tools = M.toolButtons(ms, { labels: false, onChange: () => sync() });
    const colors = M.colorButtons(ms, { onChange: () => sync() });
    const tabs = views.map((v) => {
      const b = h('button', { type: 'button', text: v.label });
      b.addEventListener('click', () => {
        ms.view = v.id;
        sync();
      });
      return b;
    });
    const undo = h('button.icon-btn', { type: 'button', title: 'Letzte Markierung entfernen', 'aria-label': 'Rückgängig' }, icon('undo', 16));
    const clear = h('button.icon-btn', { type: 'button', title: 'Alle Markierungen entfernen', 'aria-label': 'Markierungen löschen' }, icon('trash', 16));
    undo.addEventListener('click', () => {
      M.undo(ms);
      sync();
    });
    clear.addEventListener('click', () => {
      M.clearItems(ms);
      sync();
    });
    // one field per number – the note travels with its circle
    const notes = M.noteList(ms, { onChange: (structural) => structural && sync(), decorate: (input) => withDictation(input, { inline: true }) });
    const include = h('input', { type: 'checkbox' });
    const includeText = h('span', { text: 'Screenshot speichern' });
    include.checked = draft.includeShot !== false;
    if (!include.checked) wrap.style.opacity = '.35';
    include.addEventListener('change', () => {
      draft.includeShot = include.checked;
      wrap.style.opacity = include.checked ? '1' : '.35';
    });
    // the last clicks on this page, numbered in their order (remembered as a preference)
    let showClicks = null;
    if (ms.clicks.length) {
      showClicks = h('input', { type: 'checkbox' });
      showClicks.addEventListener('change', () => {
        ms.showClicks = showClicks.checked;
        rememberShowClicks();
        sync();
      });
    }
    const rememberShowClicks = () => {
      if (!ms.clicks.length || state.ui.showClicks === ms.showClicks) return;
      state.ui.showClicks = ms.showClicks;
      saveUi();
    };

    function draw() {
      const maxW = Math.max(200, (drawer?.panel?.clientWidth || 440) - 52);
      M.render(canvas, viewOf(), ms, maxW, 300);
    }
    function sync() {
      notes.update();
      tabs.forEach((b, i) => b.classList.toggle('sel', views[i] === viewOf()));
      tools.update();
      colors.update();
      if (showClicks) showClicks.checked = ms.showClicks;
      canvas.title = M.hint(ms.tool);
      note.hidden = !(ms.tool === 'box' && views.length > 1);
      draw();
    }
    M.attach(canvas, viewOf, ms, draw, () => {
      notes.update();
      colors.update();
    });
    expand.addEventListener('click', () =>
      M.openEditor({
        mount: root,
        views,
        state: ms,
        title: draft.retest ? `Screenshot – Nachtest #${draft.retest.item.number}` : 'Screenshot bearbeiten',
        decorateNote: (input) => withDictation(input, { inline: true }),
        onDone: () => {
          rememberShowClicks();
          sync();
        },
      }),
    );

    const el = h(
      'div.field',
      null,
      h('div.label', null, 'Screenshot ', h('small', { text: '– Rahmen, Pfeile, Nummern, Vertrauliches schwärzen' })),
      h(
        'div.shot',
        null,
        h('div.shot-bar', null, h('div.tabs', null, tabs), h('div.actions', null, undo, clear)),
        h('div.shot-bar.shot-tools', null, h('div.tabs.tools', null, tools.buttons), colors.el),
        note,
        wrap,
        h(
          'div.shot-foot',
          null,
          h('label.check', null, include, includeText),
          showClicks ? h('label.check', { title: 'Wo du auf dieser Seite zuletzt geklickt hast, nummeriert in der Reihenfolge' }, showClicks, `Letzte Klicks einzeichnen (${ms.clicks.length})`) : h('span', { text: `${draft.bitmap.width}×${draft.bitmap.height} px` }),
        ),
      ),
      notes.el,
    );
    // addition to an earlier annotation: the screenshot goes there as a further one
    const setAddition = (target) => {
      includeText.textContent = target ? `Als weiteres Bild an #${target.number} anhängen` : 'Screenshot speichern';
    };
    return { el, draw: sync, setAddition };
  }

  /**
   * The further screenshots of a draft: a row each (preview, caption, order,
   * remove; click the preview for the large editor) and the button to take one.
   */
  function buildExtras(draft, { onAdd }) {
    const list = h('div.x-list');
    const addTitle = 'Der Dialog geht kurz zur Seite: Seite vorbereiten (scrollen, Menü öffnen – auch auf einer anderen Seite), dann Element, Bereich oder Seite über die Leiste oder die Tastenkürzel aufnehmen. Danach geht es hier weiter.';
    const add = h('button.btn.small.x-add', { type: 'button', title: addTitle }, icon('camera', 15), 'Weiteren Screenshot aufnehmen');
    add.addEventListener('click', () => onAdd());
    const count = h('small');
    const el = h('div.field.x-field', null, h('div.label', null, 'Weitere Screenshots ', count), list, add);
    const rows = new Map(); // extra → row
    function rowFor(x) {
      if (rows.has(x)) return rows.get(x);
      const canvas = h('canvas.x-thumb', { title: 'Groß bearbeiten: Rahmen, Pfeile, Nummern, Schwärzen' });
      const caption = h('input', { type: 'text', maxlength: '300', placeholder: 'Was zeigt dieses Bild? (optional)', value: x.caption || '' });
      caption.addEventListener('input', () => (x.caption = caption.value));
      const btn = (iconName, label, fn) => {
        const b = h('button.icon-btn', { type: 'button', title: label, 'aria-label': label }, icon(iconName, 15));
        b.addEventListener('click', fn);
        return b;
      };
      const move = (dir) => {
        const i = draft.extras.indexOf(x);
        const j = i + dir;
        if (j < 0 || j >= draft.extras.length) return;
        [draft.extras[i], draft.extras[j]] = [draft.extras[j], draft.extras[i]];
        update();
      };
      const up = btn('chevronUp', 'Nach vorn', () => move(-1));
      const down = btn('chevronDown', 'Nach hinten', () => move(1));
      const removeBtn = btn('trash', 'Dieses Bild entfernen', () => {
        draft.extras.splice(draft.extras.indexOf(x), 1);
        x.bitmap?.close?.();
        update();
      });
      const num = h('b.x-num');
      const meta = h('small.x-meta');
      const row = h('div.x-row', null, canvas, h('div.x-body', null, h('div.x-head', null, num, meta, h('span.grow'), up, down, removeBtn), caption));
      const paint = () => M.render(canvas, extraView(x), x.marks, 120, 76);
      canvas.addEventListener('click', () =>
        M.openEditor({
          mount: root,
          views: [extraView(x)],
          state: x.marks,
          title: `Bild ${draft.extras.indexOf(x) + 2} bearbeiten`,
          decorateNote: (input) => withDictation(input, { inline: true }),
          onDone: () => paint(),
        }),
      );
      const r = { row, num, meta, up, down, caption, paint };
      rows.set(x, r);
      return r;
    }
    function update() {
      const extras = draft.extras || [];
      for (const x of rows.keys()) if (!extras.includes(x)) rows.delete(x);
      list.replaceChildren(
        ...extras.map((x, i) => {
          const r = rowFor(x);
          r.num.textContent = `Bild ${i + 2}`;
          // taken on another page than the first screenshot: say where
          const other = x.url && pageKey(x.url) !== pageKey(draft.page?.url || location.href);
          r.meta.textContent = `${{ element: 'Element', region: 'Bereich', page: 'Seite' }[x.kind] || 'Bild'}${other ? ` · ${clip(x.url.replace(/^https?:\/\/[^/]+/, ''), 40)}` : ''}`;
          r.up.disabled = i === 0;
          r.down.disabled = i === extras.length - 1;
          r.paint();
          return r.row;
        }),
      );
      count.textContent = extras.length ? `(${extras.length})` : '– z. B. für einen Ablauf oder dieselbe Stelle auf einer anderen Seite';
      const full = extras.length >= C.LIMITS.extraImages;
      add.disabled = full;
      add.title = full ? `Höchstens ${C.LIMITS.extraImages + 1} Screenshots pro Anmerkung.` : addTitle;
    }
    update();
    return {
      el,
      update,
      reveal(i) {
        const r = rowFor(draft.extras[i]);
        r?.row.scrollIntoView({ block: 'center' });
        r?.caption.focus({ preventScroll: true });
      },
    };
  }

  function buildTechSummary(draft) {
    const rows = [];
    const add = (k, v, cls) => {
      if (v === null || v === undefined || v === '') return;
      rows.push(h('dt', { text: k }), h('dd', cls ? { class: cls } : null, v));
    };
    const e = draft.element;
    if (e) {
      add('Selektor', h('code', { text: clip(e.selector, 160) }));
      if (e.a11y?.role || e.a11y?.name) add('Rolle / Name', `${e.a11y.role || '–'}${e.a11y.name ? ` „${clip(e.a11y.name, 60)}“` : ''}`);
      if (e.contrast) add('Kontrast', `${e.contrast.ratio}:1 ${e.contrast.passesAA ? '✓ AA' : '✗ unter AA'}`, e.contrast.passesAA ? null : 'warn');
      const before = draft.retest?.item.baseline?.contrast;
      if (before) add('Kontrast vorher', `${before.ratio}:1 ${before.passesAA ? '✓ AA' : '✗ unter AA'}`);
      if (e.location?.landmarks?.length) add('Ort', e.location.landmarks.join(' › '));
      for (const hint of e.hints || []) add('Hinweis', hint, 'warn');
    }
    if (draft.region?.container) add('Bereich', h('code', { text: clip(draft.region.container.selector, 160) }));
    const comp = draft.probe?.component;
    if (comp?.framework) add('Komponente', `${comp.framework}: ${comp.components.slice(0, 3).join(' › ') || '–'}${comp.source ? ` (${comp.source})` : ''}`);
    const errors = draft.techEvents.filter((ev) => ['console', 'error', 'rejection', 'resource'].includes(ev.type)).length;
    const requests = draft.techEvents.filter((ev) => ev.type === 'network' || ev.type === 'slow').length;
    add('Konsole', errors ? `${errors} Fehler/Warnungen auf dieser Seite` : 'keine Fehler erfasst', errors ? 'warn' : null);
    add('Netzwerk', requests ? `${requests} fehlgeschlagene/langsame Requests` : 'keine Auffälligkeiten', requests ? 'warn' : null);
    const p = draft.page;
    add('Ansicht', `${p.viewport.width}×${p.viewport.height} @${p.dpr}x`);
    const summary = h('summary', null, 'Automatisch erfasster Kontext', h('span', { text: 'für die Entwicklung' }));
    return h('details.tech', null, summary, h('dl.kv', null, rows));
  }

  function buildAnnotation(draft, values) {
    const r = draft.rect;
    const [sx, sy] = draft.scroll || [window.scrollX, window.scrollY];
    const annotation = {
      kind: draft.kind,
      ...values,
      page: draft.page,
      element: draft.element || undefined,
      region: draft.kind === 'region' ? { rect: roundRect(r), ...draft.region } : undefined,
      component: draft.probe?.component?.framework ? draft.probe.component : undefined,
      performance: draft.probe?.perf || undefined,
      techStack: draft.probe?.stack?.length ? draft.probe.stack : undefined,
      techEvents: draft.techEvents,
      anchor: r ? { selector: draft.element?.selector, docRect: { x: Math.round(r.x + sx), y: Math.round(r.y + sy), width: Math.round(r.width), height: Math.round(r.height) } } : undefined,
      images:
        (draft.bitmap && draft.includeShot) || draft.extras?.length
          ? {
              ...(draft.bitmap && draft.includeShot ? { cropRect: draft.cropRect ? roundRect(draft.cropRect) : null, markRect: r ? roundRect(r) : null, ...M.legend(draft.marks) } : {}),
              extra: (draft.extras || []).map(extraMeta),
            }
          : undefined,
      createdAt: new Date().toISOString(),
    };
    return JSON.parse(JSON.stringify(annotation));
  }

  const roundRect = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });

  // ---------------------------------------------------------------------------
  // Pins for existing annotations on this page
  // ---------------------------------------------------------------------------

  const pinsLayer = h('div.pins');
  let pins = [];
  let pinsRaf = 0;
  let popover = null;

  const pageKey = (url) => {
    try {
      const u = new URL(url);
      return u.origin + u.pathname + u.hash;
    } catch {
      return url;
    }
  };

  function renderPins() {
    pinsLayer.replaceChildren();
    pins = [];
    if (!state.ui.pins) return;
    const here = pageKey(X.maskUrl(location.href, state.settings.maskSensitiveParams));
    for (const a of state.annotations) {
      if (a.kind === 'page' || pageKey(a.page?.url) !== here) continue;
      const cat = categoryOf(a.category);
      const pin = h('button.pin', { type: 'button', title: `#${a.number} ${a.title || clip(a.description, 60)}`, style: { background: cat.color } }, String(a.number));
      if (a.status && a.status !== 'open') pin.classList.add('done');
      pin.addEventListener('mousedown', (e) => e.preventDefault());
      pin.addEventListener('click', () => showPopover(a, pin));
      pinsLayer.append(pin);
      pins.push({ a, pin, el: null });
    }
    // Re-test: where the earlier, not yet checked annotations were.
    for (const item of state.plan) {
      if (item.kind === 'page' || checkOf(item) || !onItemPage(item)) continue;
      const pin = h('button.pin.plan', { type: 'button', title: `Nachtest #${item.number}: ${item.title}` }, String(item.number));
      pin.addEventListener('mousedown', (e) => e.preventDefault());
      pin.addEventListener('click', () => {
        if (!state.ui.retestOpen) setRetestOpen(true);
        focusItem(item.number);
      });
      pinsLayer.append(pin);
      pins.push({ item, pin, el: null });
    }
    positionPins();
  }

  function positionPins() {
    for (const p of pins) {
      let rect = null;
      if (p.item) {
        // Searching a page for a missing element is expensive: retry at most every 3 s.
        if ((!p.el || !p.el.isConnected) && !(p.missedAt > Date.now() - 3000)) {
          p.el = findTarget(p.item)?.el || null;
          p.missedAt = p.el ? 0 : Date.now();
        }
        const r = p.el && X.rectOf(p.el);
        if (r && (r.width || r.height)) rect = r;
      } else if (p.a.kind === 'element' && p.a.element?.selector) {
        if (!p.el || !p.el.isConnected) p.el = X.querySelectorDeep(p.a.element.selector);
        if (p.el) {
          const r = X.rectOf(p.el);
          if (r.width || r.height) rect = r;
        }
      }
      if (!rect && p.a?.anchor?.docRect) {
        const d = p.a.anchor.docRect;
        rect = { x: d.x - window.scrollX, y: d.y - window.scrollY, width: d.width, height: d.height };
      }
      const visible = rect && rect.y + rect.height > 0 && rect.y < window.innerHeight && rect.x + rect.width > 0 && rect.x < window.innerWidth;
      p.pin.style.display = visible ? 'block' : 'none';
      if (visible) {
        p.pin.style.left = `${Math.min(Math.max(14, rect.x + rect.width), window.innerWidth - 14)}px`;
        p.pin.style.top = `${Math.min(Math.max(14, rect.y), window.innerHeight - 14)}px`;
      }
    }
  }

  function schedulePins() {
    if (!pins.length) return;
    cancelAnimationFrame(pinsRaf);
    pinsRaf = requestAnimationFrame(positionPins);
  }

  function togglePins() {
    state.ui.pins = !state.ui.pins;
    saveUi();
    renderPins();
    updateToolbar();
    toast(state.ui.pins ? 'Markierungen eingeblendet' : 'Markierungen ausgeblendet', 'info', 1500);
  }

  listen(window, 'pointerdown', (e) => {
    if (popover && !isOurs(e)) closePopover();
  }, { capture: true, passive: true });

  function closePopover() {
    popover?.remove();
    popover = null;
  }

  function showPopover(a, pin) {
    closePopover();
    const cat = categoryOf(a.category);
    const prio = priorityOf(a.priority);
    const done = a.status && a.status !== 'open';
    const toggle = h('button.btn.small', { type: 'button', text: done ? 'Wieder öffnen' : 'Als erledigt markieren' });
    toggle.addEventListener('click', async () => {
      try {
        await call('fl:updateAnnotation', { sessionId: a.sessionId, id: a.id, patch: { status: done ? 'open' : 'done' } });
        closePopover();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    const open = h('button.btn.small.primary', { type: 'button' }, icon('external', 14), 'Im Dashboard');
    open.addEventListener('click', () => call('fl:openDashboard', { sessionId: a.sessionId, annotationId: a.id }).catch((e) => toast(e.message, 'error')));
    const closeBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Schließen', style: { float: 'right', marginTop: '-4px' } }, icon('close', 16));
    closeBtn.addEventListener('click', closePopover);
    popover = h(
      'div.popover',
      { role: 'dialog' },
      closeBtn,
      h('div.row', null, h('span.badge', { style: { '--c': cat.color }, text: cat.label }), h('span.badge', { style: { '--c': prio.color }, text: prio.label })),
      h('h4', { text: `#${a.number} ${a.title || clip(a.description, 70)}` }),
      h('p', { text: clip(a.description, 600) }),
      h('div.row', null, open, toggle),
    );
    popover.querySelectorAll('.badge').forEach((b, i) => b.style.setProperty('--c', i ? prio.color : cat.color));
    root.append(popover);
    const r = pin.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.left - 150), window.innerWidth - 308);
    const top = r.bottom + 8 + 200 > window.innerHeight ? Math.max(8, r.top - popover.offsetHeight - 8) : r.bottom + 8;
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }

  // ---------------------------------------------------------------------------
  // Re-test: go through the annotations of an earlier test run
  // ---------------------------------------------------------------------------

  const verdictOf = (id) => C.VERDICTS.find((v) => v.id === id) || C.VERDICTS[1];
  const devLabel = (id) => C.DEV_RESULTS.find((r) => r.id === id)?.label || id;
  const checkOf = (item) => state.annotations.find((a) => a.retest?.number === item.number) || null;
  const rtPanel = h('div.rt', { role: 'dialog', 'aria-label': 'Nachtest' });
  let flashTimer = null;

  /** The earlier page in the version under test (which may run on another origin). */
  function retestUrl(item) {
    try {
      const u = new URL(item.url);
      if (!state.session.origins.includes(u.origin)) {
        const here = new URL(location.href);
        u.protocol = here.protocol;
        u.host = here.host;
      }
      if (u.search.includes('***')) u.search = ''; // masked parameters would break the link
      // A redacted path segment (e-mail, token) cannot be opened: go as far as the address is known.
      const cut = u.pathname.indexOf('***');
      if (cut >= 0) {
        u.pathname = u.pathname.slice(0, u.pathname.lastIndexOf('/', cut) + 1);
        u.hash = '';
      } else if (u.hash.includes('***')) u.hash = u.hash.slice(0, u.hash.indexOf('***')).replace(/[^/]*$/, '');
      return u.href;
    } catch {
      return null;
    }
  }

  const routeKey = (url) => {
    try {
      const u = new URL(url);
      return u.pathname + (u.hash.startsWith('#/') ? u.hash.split('?')[0] : '');
    } catch {
      return url || '';
    }
  };
  // The stored address is masked (*** for tokens/e-mails in the path): compare like with like.
  const onItemPage = (item) => {
    if (!item.url) return false;
    const key = routeKey(item.url);
    return key === routeKey(location.href) || key === routeKey(X.maskUrl(location.href, state.settings.maskSensitiveParams));
  };

  /** The earlier element in this version: by selector, else by tag/role and text. */
  function findTarget(item) {
    if (item.kind === 'page' || !onItemPage(item)) return null;
    const visible = (el) => {
      const r = X.rectOf(el);
      return r.width > 0 && r.height > 0;
    };
    if (item.selector) {
      const el = X.querySelectorDeep(item.selector);
      if (el && visible(el)) return { el, how: 'selector' };
    }
    const text = (item.text || '').trim();
    if (text.length < 2) return null;
    // The plan keeps the first 120 characters: longer texts match by their start.
    const sameText = (t) => (text.length >= 120 ? t.startsWith(text) : t === text);
    const tag = /^[a-z][a-z0-9-]*$/.test(item.tag || '') ? item.tag : null;
    // The plan holds texts as captured, i.e. maybe redacted: only then compare redacted live texts.
    const redacted = state.settings.maskSensitiveParams && /\[[^\]]* entfernt\]|\*\*\*/.test(text);
    const matches = (t) => sameText(t) || (redacted && sameText(S.redact(t)));
    for (const el of Array.from(document.querySelectorAll(tag || X.INTERACTIVE)).slice(0, 3000)) {
      if (visible(el) && (matches(X.accessibleName(el).name || '') || matches(X.visibleText(el, 400)))) return { el, how: 'text' };
    }
    return null;
  }

  function flashTarget(el) {
    if (state.mode !== 'idle') return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    clearTimeout(flashTimer);
    const show = setTimeout(() => {
      if (state.mode !== 'idle') return;
      showHighlight(el);
      // Don't hide the element behind the list: move the list to the other side.
      if (rtPanel.isConnected && !state.ui.retestCollapsed) {
        const a = X.rectOf(el);
        const b = rtPanel.getBoundingClientRect();
        if (a.x < b.right && a.x + a.width > b.left && a.y < b.bottom && a.y + a.height > b.top) setRetestDock(state.ui.retestDock === 'left' ? 'right' : 'left');
      }
    }, 350);
    flashTimer = setTimeout(() => state.mode === 'idle' && showHighlight(null), 2600);
    timers.add(show);
    timers.add(flashTimer);
  }

  function setRetestDock(dock) {
    state.ui.retestDock = dock;
    saveUi();
    renderRetest();
  }

  function setRetestCollapsed(collapsed) {
    state.ui.retestCollapsed = collapsed;
    saveUi();
    renderRetest();
  }

  function setRetestOpen(open) {
    state.ui.retestOpen = open;
    saveUi();
    renderRetest();
    updateToolbar();
  }

  function focusItem(number) {
    state.ui.retestFocus = number;
    saveUi();
    renderRetest();
    const item = state.plan.find((p) => p.number === number);
    const found = item && findTarget(item);
    if (found) flashTarget(found.el);
  }

  async function gotoItem(item) {
    const url = retestUrl(item);
    if (!url) return toast('Für diese Anmerkung ist keine Seite gespeichert.', 'error');
    state.ui.retestOpen = true;
    state.ui.retestFocus = item.number;
    flush();
    await call('fl:saveUi', { patch: state.ui }).catch(() => {});
    location.assign(url);
  }

  function renderRetest() {
    if (state.testPlan && !state.plan.length) return renderTestPlan();
    if (!state.plan.length || !state.ui.retestOpen) {
      rtPanel.remove();
      return;
    }
    const r = state.session?.retestOf || {};
    const checks = state.plan.map(checkOf);
    const done = checks.filter(Boolean).length;
    const bar = h('div.rt-bar', null, C.VERDICTS.map((v) => h('i', { style: { width: `${(checks.filter((c) => c?.retest.verdict === v.id).length / state.plan.length) * 100}%`, background: v.color } })));
    const collapsed = Boolean(state.ui.retestCollapsed);
    const button = (iconName, label, onClick) => {
      const b = h('button.icon-btn', { type: 'button', title: label, 'aria-label': label }, icon(iconName, 16));
      b.addEventListener('click', onClick);
      return b;
    };
    const head = h(
      'div.rt-head',
      null,
      h('div', null, h('b', { text: `Nachtest: ${done} von ${state.plan.length} geprüft` }), h('span', { text: `Vergleich mit „${clip(r.name || 'früherer Test', 40)}“${r.appVersion ? ` (${clip(r.appVersion, 30)})` : ''}` }), bar),
      button(collapsed ? 'chevronDown' : 'chevronUp', collapsed ? 'Liste ausklappen' : 'Liste einklappen', () => setRetestCollapsed(!collapsed)),
      button('swap', 'Liste auf die andere Seite', () => setRetestDock(state.ui.retestDock === 'left' ? 'right' : 'left')),
      button('close', 'Nachtest-Liste schließen', () => setRetestOpen(false)),
    );
    const list = h('div.rt-list', null, state.plan.map((item, i) => rtItem(item, checks[i])));
    rtPanel.className = `rt${state.ui.retestDock === 'left' ? ' left' : ''}${collapsed ? ' collapsed' : ''}`;
    rtPanel.replaceChildren(head, list);
    if (!rtPanel.isConnected) root.append(rtPanel);
    list.querySelector('.rt-item.sel')?.scrollIntoView({ block: 'nearest' });
  }

  function rtItem(item, check) {
    const v = check ? verdictOf(check.retest.verdict) : null;
    const open = state.ui.retestFocus === item.number;
    const badge = h('span.rt-verdict', { text: v ? v.label : 'ungeprüft' });
    badge.style.setProperty('--c', v ? v.color : '#94a3b8');
    const row = h('button.rt-row', { type: 'button', 'aria-expanded': String(open) }, h('span.rt-num', { text: `#${item.number}`, style: { background: categoryOf(item.category).color } }), h('span.rt-title', null, h('b', { text: item.title || clip(item.description, 80) }), h('small', { text: routeKey(item.url) || '–' })), badge);
    row.addEventListener('click', () => focusItem(open ? null : item.number));
    return h(`div.rt-item${open ? '.sel' : ''}`, null, row, open ? rtDetail(item, check) : null);
  }

  function rtDetail(item, check) {
    const parts = [];
    if (item.description) parts.push(h('p.rt-desc', { text: clip(item.description, 500) }));
    if (item.expected) parts.push(h('p', null, h('b', { text: 'Erwartet: ' }), clip(item.expected, 300)));
    if (item.devResult) parts.push(h('p', null, h('b', { text: 'Entwicklung: ' }), `${devLabel(item.devResult.result)}${item.devResult.notes?.length ? ` – ${clip(item.devResult.notes.join(' · '), 300)}` : ''}`));
    const b = item.baseline || {};
    const before = [];
    if (b.contrast) before.push(`Kontrast ${Number(b.contrast.ratio).toLocaleString('de-DE')}:1`);
    if (b.interaction) before.push(`${b.interaction} → ${b.after?.length ? b.after.slice(0, 2).map((x) => clip(x.text, 90)).join('; ') : 'nichts erfasst'}`);
    if (before.length) parts.push(h('p', null, h('b', { text: 'Vorher: ' }), before.join(' · ')));
    if (item.steps?.length) parts.push(h('details', null, h('summary', { text: `Schritte zum Nachstellen (${item.steps.length})` }), h('ol', null, item.steps.map((st) => h('li', { text: st })))));

    if (!item.url) parts.push(h('p.rt-where', { text: 'Keine Seite gespeichert.' }));
    else if (!onItemPage(item)) {
      const go = h('button.btn.small', { type: 'button' }, icon('external', 14), 'Seite öffnen');
      go.addEventListener('click', () => gotoItem(item));
      parts.push(h('div.rt-where', null, h('span', { text: `Auf ${routeKey(item.url)}` }), go));
      if (routeKey(item.url).includes('***')) parts.push(h('p.rt-where.warn', { text: 'Die Adresse enthält geschwärzte Teile (***) – „Seite öffnen“ führt bis dorthin, den Rest bitte selbst aufrufen.' }));
    } else if (item.kind === 'page') parts.push(h('p.rt-where.ok', { text: 'Betrifft die ganze Seite – du bist auf der richtigen Seite.' }));
    else {
      const found = findTarget(item);
      if (found) {
        const show = h('button.btn.small', { type: 'button' }, icon('eye', 14), 'Zeigen');
        show.addEventListener('click', () => flashTarget(found.el));
        parts.push(h('div.rt-where.ok', null, h('span', { text: found.how === 'selector' ? 'Element gefunden.' : 'Element über seinen Text gefunden (Aufbau geändert).' }), show));
      } else {
        parts.push(h('p.rt-where.warn', { text: 'Element hier nicht gefunden – verändert, entfernt oder erst nach einer Aktion sichtbar? Die Bewertung gilt dann der ganzen Seite.' }));
      }
    }

    const buttons = C.VERDICTS.map((v) => {
      const btn = h('button.rt-v', { type: 'button', title: v.hint, text: v.label });
      btn.style.setProperty('--c', v.color);
      if (check?.retest.verdict === v.id) btn.classList.add('sel');
      btn.addEventListener('click', () => checkItem(item, v.id));
      return btn;
    });
    parts.push(h('div.rt-label', { text: check ? 'Neu bewerten (ersetzt die bisherige Bewertung):' : 'Wie ist es jetzt?' }), h('div.rt-verdicts', null, buttons));
    if (check?.description) parts.push(h('p', null, h('b', { text: 'Dein Kommentar: ' }), clip(check.description, 200)));
    return h('div.rt-detail', null, parts);
  }

  function checkItem(item, verdict) {
    if (state.mode !== 'idle') return;
    const found = findTarget(item);
    showHighlight(null);
    captureAndOpen({ kind: found ? 'element' : 'page', el: found?.el, retest: { item, verdict, how: found?.how || null, onPage: onItemPage(item) } }).catch((err) => failCapture(err));
  }

  // ---------------------------------------------------------------------------
  // Test plan: go through prepared checkpoints (same list as the re-test)
  // ---------------------------------------------------------------------------

  const PLAN = Object.fromEntries(C.PLAN_STATUSES.map((x) => [x.id, x]));
  const findingsOf = (item) => state.annotations.filter((a) => a.planItem === item.id);
  const planStatus = (item) => state.testPlan?.results[item.id]?.status || (findingsOf(item).length ? 'problem' : null);
  const itemNo = (item) => Number(item.id.slice(1));
  /** Paths apply to the domain of this run, full addresses as they are. */
  const planStart = (item) => {
    try {
      return item.start ? new URL(item.start, `${location.origin}/`).href : null;
    } catch {
      return null;
    }
  };
  let planAction = null; // inline choice open in the list: { id, kind: 'problem' | 'skip' }

  function renderTestPlan() {
    const tp = state.testPlan;
    if (!state.ui.retestOpen) {
      rtPanel.remove();
      return;
    }
    const statuses = tp.items.map(planStatus);
    const done = statuses.filter(Boolean).length;
    const bar = h('div.rt-bar', null, C.PLAN_STATUSES.map((x) => h('i', { style: { width: `${(statuses.filter((st) => st === x.id).length / tp.items.length) * 100}%`, background: x.color } })));
    const collapsed = Boolean(state.ui.retestCollapsed);
    const button = (iconName, label, onClick) => {
      const b = h('button.icon-btn', { type: 'button', title: label, 'aria-label': label }, icon(iconName, 16));
      b.addEventListener('click', onClick);
      return b;
    };
    const head = h(
      'div.rt-head',
      null,
      h('div', null, h('b', { text: `Testplan: ${done} von ${tp.items.length} geprüft` }), h('span', { text: `„${clip(tp.name, 50)}“` }), bar),
      button(collapsed ? 'chevronDown' : 'chevronUp', collapsed ? 'Liste ausklappen' : 'Liste einklappen', () => setRetestCollapsed(!collapsed)),
      button('swap', 'Liste auf die andere Seite', () => setRetestDock(state.ui.retestDock === 'left' ? 'right' : 'left')),
      button('close', 'Testplan-Liste schließen', () => setRetestOpen(false)),
    );
    const rows = [];
    let group = null;
    tp.items.forEach((item, i) => {
      if ((item.group || '') !== group) {
        group = item.group || '';
        if (group) rows.push(h('div.rt-group', { text: group }));
      }
      rows.push(tpItem(item, statuses[i]));
    });
    const list = h('div.rt-list', null, rows);
    rtPanel.className = `rt${state.ui.retestDock === 'left' ? ' left' : ''}${collapsed ? ' collapsed' : ''}`;
    rtPanel.setAttribute('aria-label', 'Testplan');
    rtPanel.replaceChildren(head, list);
    if (!rtPanel.isConnected) root.append(rtPanel);
    list.querySelector('.rt-item.sel')?.scrollIntoView({ block: 'nearest' });
  }

  function tpItem(item, status) {
    const n = itemNo(item);
    const open = state.ui.retestFocus === n;
    const st = PLAN[status];
    const findings = findingsOf(item).length;
    const badge = h('span.rt-verdict', { text: st ? `${st.label}${findings > 1 ? ` (${findings})` : ''}` : 'offen' });
    badge.style.setProperty('--c', st ? st.color : '#94a3b8');
    const row = h('button.rt-row', { type: 'button', 'aria-expanded': String(open) }, h('span.rt-num', { text: String(n), style: { background: '#4f46e5' } }), h('span.rt-title', null, h('b', { text: item.title }), h('small', { text: item.start || item.expected || '' })), badge);
    row.addEventListener('click', () => {
      planAction = null;
      state.ui.retestFocus = open ? null : n;
      saveUi();
      renderTestPlan();
    });
    return h(`div.rt-item${open ? '.sel' : ''}`, null, row, open ? tpDetail(item, status) : null);
  }

  function tpDetail(item, status) {
    const parts = [];
    const result = state.testPlan.results[item.id];
    if (item.expected) parts.push(h('p', null, h('b', { text: 'Erwartung: ' }), clip(item.expected, 400)));
    if (item.notes?.length) parts.push(h('ul.rt-notes', null, item.notes.map((note) => h('li', { text: note }))));
    const start = planStart(item);
    if (start && routeKey(start) !== routeKey(location.href)) {
      const go = h('button.btn.small', { type: 'button' }, icon('external', 14), 'Seite öffnen');
      go.addEventListener('click', () => gotoStart(item));
      parts.push(h('div.rt-where', null, h('span', { text: `Start: ${item.start}` }), go));
    } else if (start) parts.push(h('p.rt-where.ok', { text: 'Du bist auf der Startseite dieses Prüfpunkts.' }));
    const findings = findingsOf(item);
    if (findings.length) parts.push(h('p', null, h('b', { text: 'Anmerkungen: ' }), findings.map((a) => `#${a.number} ${clip(a.title || a.description, 40)}`).join(' · ')));
    if (result?.status === 'ok') parts.push(h('p.rt-where.ok', { text: `In Ordnung (${new Date(result.t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })})${result.image ? ' – Beleg gespeichert' : ''}` }));
    if (result?.status === 'skip') parts.push(h('p.rt-where.warn', { text: `Nicht testbar${result.note ? `: ${result.note}` : ''}` }));

    const choice = (id, label, onClick) => {
      const b = h('button.rt-v', { type: 'button', text: label });
      b.style.setProperty('--c', PLAN[id].color);
      if (status === id) b.classList.add('sel');
      b.addEventListener('click', onClick);
      return b;
    };
    parts.push(
      h('div.rt-label', { text: status ? 'Ergebnis ändern:' : 'Durchgespielt? Ergebnis:' }),
      h(
        'div.rt-verdicts',
        null,
        choice('ok', 'In Ordnung', () => planOk(item)),
        choice('problem', 'Problem', () => {
          planAction = planAction?.id === item.id && planAction.kind === 'problem' ? null : { id: item.id, kind: 'problem' };
          renderTestPlan();
        }),
        choice('skip', 'Nicht testbar', () => {
          planAction = planAction?.id === item.id && planAction.kind === 'skip' ? null : { id: item.id, kind: 'skip' };
          renderTestPlan();
        }),
      ),
    );
    if (planAction?.id === item.id && planAction.kind === 'problem') {
      const tool = (label, run) => {
        const b = h('button.btn.small', { type: 'button', text: label });
        b.addEventListener('click', () => {
          planAction = null;
          state.planTarget = item.id;
          renderTestPlan();
          run();
        });
        return b;
      };
      parts.push(h('div.rt-label', { text: 'Wo ist das Problem? Die Anmerkung gehört dann zu diesem Prüfpunkt.' }), h('div.row', null, tool('Element', startPick), tool('Bereich', startRegion), tool('Ganze Seite', startPageNote)));
    }
    if (planAction?.id === item.id && planAction.kind === 'skip') {
      const reason = h('input', { type: 'text', placeholder: 'Warum? (optional, z. B. „Testzugang fehlt“)', maxlength: '300' });
      const ok = h('button.btn.small.primary', { type: 'button', text: 'Speichern' });
      const go = () => {
        planAction = null;
        savePlanResult(item, 'skip', { note: reason.value.trim() });
      };
      ok.addEventListener('click', go);
      reason.addEventListener('keydown', (e) => e.key === 'Enter' && go());
      parts.push(h('div.rt-skip', null, reason, ok));
      setTimeout(() => reason.focus(), 0);
    }
    if (result) {
      const reset = h('button.linkish', { type: 'button', text: 'Ergebnis zurücksetzen' });
      reset.addEventListener('click', () => savePlanResult(item, null));
      parts.push(reset);
    }
    return h('div.rt-detail', null, parts);
  }

  async function gotoStart(item) {
    const url = planStart(item);
    if (!url) return;
    state.ui.retestOpen = true;
    state.ui.retestFocus = itemNo(item);
    flush();
    await call('fl:saveUi', { patch: state.ui }).catch(() => {});
    location.assign(url);
  }

  async function savePlanResult(item, status, { note = '', image } = {}) {
    try {
      await call('fl:planResult', { sessionId: state.session.id, itemId: item.id, status, note, image, url: X.maskUrl(location.href, state.settings.maskSensitiveParams) });
      if (status) {
        // On to the next checkpoint without a result – by id: the list may have been reloaded meanwhile.
        const items = state.testPlan.items;
        const i = items.findIndex((it) => it.id === item.id);
        const next = [...items.slice(i + 1), ...items.slice(0, Math.max(0, i))].find((it) => it.id !== item.id && !planStatus(it));
        state.ui.retestFocus = next ? itemNo(next) : null;
        saveUi();
        toast(`Prüfpunkt ${itemNo(item)}: ${PLAN[status].label}`);
      }
      await refreshState();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /** "In Ordnung": a screenshot as proof – shown first, so confidential parts can be blacked out. */
  async function planOk(item) {
    if (state.mode !== 'idle') return;
    state.mode = 'busy';
    hideUi(true);
    await nextFrame();
    await nextFrame();
    await sleep(40);
    const clicks = clickCandidates();
    let shot = null;
    let failed = '';
    try {
      shot = await call('fl:capture');
    } catch (err) {
      failed = err.message;
    }
    hideUi(false);
    state.mode = 'idle';
    if (!shot) {
      toast(`Kein Screenshot möglich (${failed}) – als in Ordnung ohne Beleg gespeichert.`, 'error', 5000);
      return savePlanResult(item, 'ok');
    }
    const bitmap = await createImageBitmap(dataUrlToBlob(shot));
    const scale = bitmap.width / window.innerWidth;
    const view = { id: 'full', label: 'Ganze Ansicht', image: bitmap, sx: 0, sy: 0, sw: bitmap.width, sh: bitmap.height, x: 0, y: 0, w: bitmap.width / scale, h: bitmap.height / scale };
    const marks = { items: [], clicks, showClicks: state.ui.showClicks === true && clicks.length > 0, tool: M.DEFAULT_TOOL, view: 'full', frame: null };
    state.mode = 'dialog';
    M.openEditor({
      mount: root,
      views: [view],
      state: marks,
      title: `Beleg für Prüfpunkt ${itemNo(item)}: ${clip(item.title, 50)}`,
      note: 'Wird als Beleg gespeichert – Vertrauliches vorher schwärzen. Enter speichert, Esc bricht ab.',
      doneLabel: 'Als „In Ordnung“ speichern',
      notes: false,
      onDone: () => {
        state.mode = 'idle';
        const image = M.toDataUrl(view, marks, C.LIMITS.imageMaxEdge, 'image/jpeg', 0.86);
        bitmap.close?.();
        savePlanResult(item, 'ok', { image });
      },
      onCancel: () => {
        state.mode = 'idle';
        bitmap.close?.();
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Trail & technical events
  // ---------------------------------------------------------------------------

  const trailBuffer = [];
  const techBuffer = [];
  let flushTimer = null;

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 1500);
    timers.add(flushTimer);
  }

  function flush() {
    clearTimeout(flushTimer);
    timers.delete(flushTimer);
    flushTimer = null;
    if (!state.session || !extensionAlive()) return;
    const sessionId = state.session.id;
    if (trailBuffer.length) call('fl:trail', { sessionId, entries: trailBuffer.splice(0) }).catch(() => {});
    if (techBuffer.length) call('fl:tech', { sessionId, events: techBuffer.splice(0) }).catch(() => {});
  }

  /** Queues a trail entry; returns it so slow details can be filled in later. */
  function trail(entry, always = false) {
    if (!state.session) return null;
    if (!always && !state.settings.captureInteractions) return null;
    const item = { t: new Date().toISOString(), url: X.maskUrl(location.href, state.settings.maskSensitiveParams), ...entry };
    if (state.settings.maskSensitiveParams && entry.type !== 'annotation') {
      for (const key of ['title', 'label', 'detail']) if (item[key]) item[key] = S.redact(item[key]);
    }
    trailBuffer.push(item);
    if (trailBuffer.length > 300) trailBuffer.shift();
    scheduleFlush();
    return item;
  }

  const maskText = (text) => {
    const mask = state.settings.maskSensitiveParams;
    const s = String(text).replace(/https?:\/\/[^\s"'<>()]+/g, (u) => X.maskUrl(u, mask));
    return mask ? S.redact(s) : s;
  };
  let eventWindow = { start: 0, count: 0 };

  // Events come from the page world, so a page could forge or flood them:
  // rate-limit, validate and clip before keeping anything.
  function onTech(raw, forward) {
    const now = Date.now();
    if (now - eventWindow.start > 10_000) eventWindow = { start: now, count: 0 };
    if (++eventWindow.count > 60) return;
    const ev = S.techEvent(raw);
    if (!ev) return;
    delete ev.delivered;
    const mask = state.settings.maskSensitiveParams;
    if (ev.url) ev.url = X.maskUrl(ev.url, mask);
    if (ev.requestUrl) ev.requestUrl = X.maskUrl(ev.requestUrl, mask);
    for (const key of ['message', 'head', 'source', 'stack', 'body', 'statusText', 'requestId']) if (ev[key]) ev[key] = maskText(ev[key]);
    state.pageEvents.push(ev);
    if (state.pageEvents.length > 60) state.pageEvents.shift();
    const isConsole = ['console', 'error', 'rejection', 'resource'].includes(ev.type);
    if (!forward || (isConsole && !state.settings.captureConsole) || (!isConsole && !state.settings.captureNetwork)) return;
    if (techBuffer.length >= 200) return;
    techBuffer.push(ev);
    scheduleFlush();
  }

  let routeTimer = null;
  let lastRouteLogged = null;
  function onRoute() {
    if (location.href === state.lastUrl) return;
    state.lastUrl = location.href;
    const changedAt = new Date().toISOString(); // logged below once settled, but timed now
    clearTimeout(routeTimer);
    timers.delete(routeTimer);
    // Wait until the URL settles (search-as-you-type, map panning …) and the
    // app has updated document.title, then log one entry.
    routeTimer = setTimeout(() => {
      timers.delete(routeTimer);
      const masked = X.maskUrl(location.href, state.settings.maskSensitiveParams);
      if (masked !== lastRouteLogged) {
        lastRouteLogged = masked;
        trail({ type: 'route', title: document.title, t: changedAt }, true);
      }
      renderPins();
      renderRetest(); // e.g. "Seite öffnen" in an app with hash routing: no reload
    }, 600);
    timers.add(routeTimer);
  }

  listen(document, FROM_PAGE, (e) => {
    if (typeof e.detail !== 'string' || e.detail.length > 200_000) return;
    let msg;
    try {
      msg = JSON.parse(e.detail);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.kind === 'tech') onTech(msg.event, true);
    else if (msg.kind === 'replay' && Array.isArray(msg.events)) for (const ev of msg.events.slice(-60)) onTech(ev, !ev?.delivered);
    else if (msg.kind === 'route') onRoute();
    else if (msg.kind === 'probe-result') pendingProbes.get(msg.id)?.(S.probe(msg));
  });

  const interactiveTarget = (el) => {
    for (let cur = el, i = 0; cur && i < 8; cur = X.parentOf(cur), i++) {
      if (cur.nodeType === 1 && cur.matches?.(X.INTERACTIVE)) return cur;
    }
    return el;
  };

  const quickText = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();

  function isClickableLeaf(el) {
    if (el === document.body || el === document.documentElement) return false;
    const text = quickText(el);
    if (el.childElementCount <= 2 && text && text.length <= 120) return true;
    return text.length <= 300 && getComputedStyle(el).cursor === 'pointer';
  }

  // The click/change handlers run before the app's own handlers, so they stay
  // cheap (no layout); the selector is filled in right after.
  const fillSelector = (entry, el) => {
    if (!entry) return;
    const t = setTimeout(() => {
      timers.delete(t);
      if (!destroyed && el.isConnected) entry.selector = X.deepSelector(el);
    }, 0);
    timers.add(t);
  };

  // Messages that appear after an interaction (validation errors, toasts) go
  // into the trail, so the export can show which click produced which message.
  let shownMessages = new Set(X.visibleMessages(8));
  function checkMessages() {
    if (destroyed || !state.session || !state.settings.captureInteractions) return;
    const now = X.visibleMessages(8);
    for (const text of now) if (!shownMessages.has(text)) trail({ type: 'message', label: clip(text, 200) });
    shownMessages = new Set(now);
  }
  function afterInteraction() {
    for (const ms of [700, 2500]) {
      const t = setTimeout(() => {
        timers.delete(t);
        checkMessages();
      }, ms);
      timers.add(t);
    }
  }

  listen(window, 'click', (e) => {
    if (state.mode !== 'idle' || isOurs(e) || !state.settings.captureInteractions) return;
    const origin = e.composedPath()[0];
    if (!origin || origin.nodeType !== 1) return;
    const el = interactiveTarget(origin);
    if (!el.matches?.(X.INTERACTIVE) && !isClickableLeaf(el)) return; // clicks on empty areas are noise
    // In fields and editors the text is what was typed (React mirrors a textarea's value into its
    // content, rich-text editors are contenteditable): label those only by their attributes.
    const typed = el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable || origin.isContentEditable || el.getAttribute('role') === 'textbox';
    const buttonValue = el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes((el.type || '').toLowerCase()) ? el.value : '';
    const label = el.getAttribute('aria-label') || (typed ? '' : quickText(el)) || buttonValue || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('alt') || '';
    const entry = trail({ type: 'click', label: clip(label, 80), role: X.roleOf(el) || el.tagName.toLowerCase() });
    fillSelector(entry, el);
    if (entry) rememberClick(entry, el, e);
    afterInteraction();
  }, { capture: true, passive: true });

  listen(window, 'change', (e) => {
    if (isOurs(e) || !state.settings.captureInteractions) return;
    const el = e.composedPath()[0];
    if (!el || !['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) return;
    const type = (el.type || '').toLowerCase();
    const label = X.labelFor(el) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || X.shortLabel(el);
    let detail;
    if (type === 'checkbox') detail = el.checked ? 'aktiviert' : 'deaktiviert';
    else if (type === 'radio') detail = 'ausgewählt';
    else if (el.tagName === 'SELECT') detail = el.multiple ? `${el.selectedOptions.length} von ${el.options.length} Optionen gewählt` : `Option ${el.selectedIndex + 1} von ${el.options.length} gewählt`; // option texts can be personal data
    else if (type === 'password') detail = 'Passwort eingegeben';
    else if (type === 'file') detail = 'Datei ausgewählt';
    else detail = el.value ? `${el.value.length} Zeichen eingegeben` : 'geleert';
    fillSelector(trail({ type: 'input', label: clip(label, 80), detail }), el);
    afterInteraction();
  }, { capture: true, passive: true });

  listen(window, 'submit', (e) => {
    if (isOurs(e)) return;
    const form = e.target;
    const label = form?.getAttribute?.('aria-label') || form?.getAttribute?.('name') || form?.id || '';
    if (form?.nodeType === 1) fillSelector(trail({ type: 'submit', label: clip(label || 'Formular', 80) }), form);
    else trail({ type: 'submit', label: clip(label || 'Formular', 80) });
    afterInteraction();
  }, { capture: true, passive: true });

  listen(window, 'pagehide', () => {
    flush();
    if (dictation) stopDictation();
    // leaving the page with an open dialog: keep what was typed as a draft
    if (drawer?.dirty?.()) drawer.park({ quiet: true });
  });
  listen(window, 'pointerdown', (e) => {
    if (draftMenu && !e.composedPath().includes(draftMenu) && !e.composedPath().includes(draftBtn)) closeDraftMenu();
  }, { capture: true });
  listen(document, 'visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });

  // Fallback for route changes the page-world hook could not see.
  const routePoll = setInterval(() => {
    if (!extensionAlive()) return destroy(); // extension disabled, removed or reloaded
    if (location.href !== state.lastUrl) onRoute();
    if (ready && (!host.isConnected || host.parentNode !== hostContainer())) placeHost();
    if (pins.length) positionPins();
  }, 1000);
  timers.add(routePoll);

  // ---------------------------------------------------------------------------
  // Commands, state sync, lifecycle
  // ---------------------------------------------------------------------------

  function onRuntimeMessage(msg, sender, sendResponse) {
    if (destroyed || !msg) return;
    if (msg.type === 'fl:ping') {
      sendResponse(true);
      return;
    }
    if (msg.type === 'fl:dictation') {
      onDictationEvent(msg.event || {});
      return;
    }
    if (msg.type === 'fl:changed') {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refreshState, 80);
      return;
    }
    if (msg.type !== 'fl:command' || !ready) return;
    if (state.ui.minimized && msg.action !== 'note') setMinimized(false);
    if (msg.action === 'pick') state.mode === 'pick' ? stopPick() : startPick();
    else if (msg.action === 'region') state.mode === 'region' ? stopRegion() : startRegion();
    else if (msg.action === 'note') startPageNote();
  }

  let refreshTimer = null;
  let ready = false;

  function applyState(st) {
    state.session = st.session;
    state.settings = { ...C.DEFAULT_SETTINGS, ...st.settings };
    state.annotations = Array.isArray(st.annotations) ? st.annotations : [];
    state.plan = Array.isArray(st.plan) ? st.plan : [];
    state.testPlan = st.testPlan && Array.isArray(st.testPlan.items) ? st.testPlan : null;
    state.drafts = Array.isArray(st.drafts) ? st.drafts : [];
    X.setMasking(state.settings.maskSensitiveParams, state.settings.stripUrlQuery);
    applyShortcuts(st.shortcuts);
  }

  async function refreshState() {
    if (destroyed) return;
    let st;
    try {
      st = await call('fl:getState', { url: location.href });
    } catch {
      return;
    }
    if (destroyed) return;
    if (!st.inSession) return leave();
    applyState(st);
    if (popover) closePopover();
    renderPins();
    renderRetest();
    updateToolbar();
  }

  // Top-layer elements (modal <dialog>, fullscreen) render above everything and
  // make the rest of the page inert, so the host has to move inside them.
  function hostContainer() {
    const fs = document.fullscreenElement;
    if (fs && !/^(video|img|canvas|iframe|svg)$/i.test(fs.tagName)) return fs;
    let modal = null;
    for (const dialog of document.querySelectorAll('dialog[open]')) {
      try {
        if (dialog.matches(':modal')) modal = dialog;
      } catch {
        /* :modal unsupported */
      }
    }
    return modal || document.documentElement;
  }

  function placeHost() {
    if (destroyed) return;
    const target = hostContainer();
    if (host.parentNode !== target) target.append(host);
    // Inside a transformed container "fixed" is relative to it: shift back to the viewport origin.
    host.style.transform = 'translate(0px, 0px)';
    const r = host.getBoundingClientRect();
    if (Math.abs(r.left) > 0.5 || Math.abs(r.top) > 0.5) host.style.transform = `translate(${-r.left}px, ${-r.top}px)`;
  }

  function destroy() {
    if (destroyed) return;
    try {
      // listeners in same-origin iframes are not covered by ac
      stopPick();
      stopRegion();
    } catch {
      /* not fully set up */
    }
    frameAc?.abort();
    destroyed = true;
    try {
      flush();
    } catch {
      /* ignore */
    }
    ac.abort();
    for (const t of timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    try {
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch {
      /* context invalidated */
    }
    document.documentElement.style.cursor = '';
    if (dictation) chrome.runtime.sendMessage({ type: 'fl:dictation', action: 'stop' }).catch(() => {});
    host.remove();
    rootObserver.disconnect();
    dialogObserver.disconnect();
    if (globalThis.__feedbackLensOverlay === api) delete globalThis.__feedbackLensOverlay;
  }

  /** The page is no longer part of a test run: also switch off the page-world hooks. */
  function leave() {
    // the run was stopped or paused while the dialog was open: keep it as a draft
    if (drawer?.dirty?.()) drawer.park({ quiet: true });
    destroy();
    toPage({ kind: 'bye' });
  }

  // Some apps replace large parts of the DOM; keep our host attached – but give
  // up for a while if the page keeps removing it (no endless tug of war).
  let reattach = { start: 0, count: 0 };
  const rootObserver = new MutationObserver(() => {
    if (destroyed || host.isConnected) return;
    if (!extensionAlive()) return destroy(); // orphaned after an extension reload
    const now = Date.now();
    if (now - reattach.start > 2000) reattach = { start: now, count: 0 };
    if (++reattach.count <= 5) placeHost();
  });
  const dialogObserver = new MutationObserver(() => {
    if (!destroyed && host.parentNode !== hostContainer()) placeHost();
  });
  listen(document, 'fullscreenchange', () => placeHost());

  const api = { destroy };
  globalThis.__feedbackLensOverlay = api;

  async function init() {
    // Listen right away, so a ping during start-up does not trigger a second injection.
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    let st;
    try {
      st = await call('fl:getState', { url: location.href });
    } catch {
      return destroy();
    }
    if (destroyed) return;
    if (!st.inSession) return leave();
    applyState(st);
    state.ui = { ...state.ui, ...(st.ui || {}) };
    root.append(pinsLayer, hl, hlLabel, hint, awaitBar, toolbar, fab, busy, toastEl);
    placeHost();
    rootObserver.observe(document.documentElement, { childList: true });
    dialogObserver.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['open'] });
    ready = true;
    updateToolbar();
    placeToolbar();
    renderPins();
    renderRetest();
    toPage({ kind: 'hello' });
    lastRouteLogged = X.maskUrl(location.href, state.settings.maskSensitiveParams);
    trail({ type: 'page', title: document.title }, true);
  }

  init();
})();
