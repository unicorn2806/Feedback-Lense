// Marks on screenshots, shared by the annotation dialog (content script, in
// the overlay's closed shadow root) and the dashboard: shapes (frame, ellipse,
// arrow, line) and freehand strokes in a choice of colours, numbered circles
// (the tester's recent clicks or set by hand) and blacked-out boxes – plus the
// full-window editor for them.
// Marks are kept in CSS pixels of the tested viewport, so one set of marks
// fits every view of the same screenshot (crop and full view).
// Classic script: no top-level bindings besides globalThis.FL_MARKS.
globalThis.FL_MARKS = globalThis.FL_MARKS || (() => {
  const PEN = '#f43f5e';
  const NUM = '#2563eb';
  const PEN_WIDTH = 4;
  const RADIUS = 12;
  const DEFAULT_TOOL = 'rect';
  // colours of shapes and strokes (numbers stay blue, blacked-out areas black)
  const COLORS = [
    { id: PEN, label: 'Rot' },
    { id: '#f59e0b', label: 'Orange' },
    { id: '#16a34a', label: 'Grün' },
    { id: '#7c3aed', label: 'Violett' },
  ];
  const STROKES = ['rect', 'ellipse', 'arrow', 'line', 'pen'];

  // ---------------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------------

  /**
   * Numbers in drawing order: the shown clicks first (oldest first), then the
   * numbers set by hand. `base` continues after numbers already burnt into a
   * stored image (dashboard).
   */
  function numbered(state) {
    let n = state.base || 0;
    const clicks = state.showClicks ? state.clicks.filter((c) => c.on !== false).map((c) => ({ ...c, n: ++n })) : [];
    const items = state.items.map((it) => (it.type === 'num' ? { ...it, n: ++n } : it));
    return { clicks, items };
  }

  function circle(ctx, x, y, n) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, RADIUS, 0, Math.PI * 2);
    ctx.shadowColor = 'rgba(2, 6, 23, .45)';
    ctx.shadowBlur = 4;
    ctx.fillStyle = NUM;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = `700 ${n > 9 ? 12 : 14}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(n), x, y + 0.5);
    ctx.restore();
  }

  function outline(ctx, it) {
    const [[x0, y0], [x1, y1] = [x0, y0]] = it.points;
    ctx.beginPath();
    if (it.type === 'rect') ctx.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    else if (it.type === 'ellipse') ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
    else if (it.type === 'line' || it.type === 'arrow') {
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      if (it.type === 'arrow') {
        const a = Math.atan2(y1 - y0, x1 - x0);
        const len = Math.min(18, Math.hypot(x1 - x0, y1 - y0) * 0.6);
        for (const side of [-1, 1]) {
          ctx.moveTo(x1, y1);
          ctx.lineTo(x1 - len * Math.cos(a + side * 0.5), y1 - len * Math.sin(a + side * 0.5));
        }
      }
    } else {
      ctx.moveTo(x0, y0);
      for (const [x, y] of it.points.slice(1)) ctx.lineTo(x, y);
      if (it.points.length === 1) ctx.lineTo(x0 + 0.1, y0);
    }
  }

  function stroke(ctx, it) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    outline(ctx, it);
    // a light halo keeps every colour visible on dark and on light backgrounds
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.lineWidth = PEN_WIDTH + 3;
    ctx.stroke();
    ctx.strokeStyle = it.color || PEN;
    ctx.lineWidth = PEN_WIDTH;
    ctx.stroke();
    ctx.restore();
  }

  /** Bounding box of a mark (CSS px of the viewport). */
  function bounds(it) {
    if (it.type === 'num') {
      const [[x, y]] = it.points;
      return { x0: x - RADIUS, y0: y - RADIUS, x1: x + RADIUS, y1: y + RADIUS };
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of it.points) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    return { x0, y0, x1, y1 };
  }

  /** The selected mark gets a dashed frame and a remove button (×) at its top right corner. */
  const handleOf = (it, k) => {
    const b = bounds(it);
    const pad = 6 / k;
    return { b, pad, x: b.x1 + pad, y: b.y0 - pad, r: 9 / k };
  };
  function paintSelection(ctx, it, k) {
    const { b, pad, x, y, r } = handleOf(it, k);
    ctx.save();
    ctx.setLineDash([5 / k, 4 / k]);
    ctx.lineWidth = 1.5 / k;
    ctx.strokeStyle = '#0f172a';
    ctx.strokeRect(b.x0 - pad, b.y0 - pad, b.x1 - b.x0 + pad * 2, b.y1 - b.y0 + pad * 2);
    ctx.strokeStyle = '#fff';
    ctx.lineDashOffset = 4.5 / k;
    ctx.strokeRect(b.x0 - pad, b.y0 - pad, b.x1 - b.x0 + pad * 2, b.y1 - b.y0 + pad * 2);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#dc2626';
    ctx.fill();
    ctx.lineWidth = 2 / k;
    ctx.stroke();
    ctx.beginPath();
    const d = r * 0.4;
    ctx.moveTo(x - d, y - d);
    ctx.lineTo(x + d, y + d);
    ctx.moveTo(x + d, y - d);
    ctx.lineTo(x - d, y + d);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Paints the marks; the context is transformed to CSS px of the viewport.
   * `ui` (screen px per CSS px) only on screen: shows the selection, which is never saved.
   */
  function paint(ctx, state, ui = null) {
    const { clicks, items } = numbered(state);
    const f = state.frame;
    if (f) {
      const pad = 3;
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(255,255,255,.95)';
      ctx.lineWidth = 6;
      ctx.strokeRect(f.x - pad, f.y - pad, f.width + pad * 2, f.height + pad * 2);
      ctx.strokeStyle = PEN;
      ctx.lineWidth = 3;
      ctx.strokeRect(f.x - pad, f.y - pad, f.width + pad * 2, f.height + pad * 2);
      ctx.restore();
    }
    for (const it of items) if (STROKES.includes(it.type) && it.points.length) stroke(ctx, it);
    for (const c of clicks) circle(ctx, c.x, c.y, c.n);
    for (const it of items) if (it.type === 'num') circle(ctx, it.points[0][0], it.points[0][1], it.n);
    // Blacked-out areas last: they cover everything else and end up in every saved image.
    ctx.save();
    ctx.fillStyle = '#000';
    for (const it of items) {
      if (it.type !== 'box') continue;
      const [[x0, y0], [x1, y1]] = it.points;
      ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    }
    ctx.restore();
    if (ui && state.selected && state.items.includes(state.selected)) paintSelection(ctx, state.selected, ui.k);
  }

  /**
   * A view shows part of a screenshot image: the source rectangle sx/sy/sw/sh
   * (image px) covers x/y/w/h in CSS px of the viewport.
   */
  function draw(ctx, view, state, width, height, ui = null) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(view.image, view.sx, view.sy, view.sw, view.sh, 0, 0, width, height);
    const fx = width / view.w;
    const fy = height / view.h;
    ctx.setTransform(fx, 0, 0, fy, -view.x * fx, -view.y * fy);
    paint(ctx, state, ui);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Shows a view in a canvas element, fitted into maxW × maxH CSS px. */
  function render(canvas, view, state, maxW, maxH) {
    const k = Math.max(0.01, Math.min(maxW / view.w, maxH / view.h));
    const cssW = Math.max(1, Math.round(view.w * k));
    const cssH = Math.max(1, Math.round(view.h * k));
    const dpr = globalThis.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    draw(canvas.getContext('2d'), view, state, canvas.width, canvas.height, { k });
  }

  /** The view as an image (at most maxEdge px on the longer side) with the marks burnt in. */
  function toDataUrl(view, state, maxEdge, type, quality) {
    const k = Math.min(1, maxEdge / Math.max(view.sw, view.sh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(view.sw * k));
    canvas.height = Math.max(1, Math.round(view.sh * k));
    draw(canvas.getContext('2d'), view, state, canvas.width, canvas.height);
    return canvas.toDataURL(type, quality);
  }

  // Editing with undo: every change is recorded, so undo also brings back a
  // removed number together with its note.
  const history = (state) => (state.history ||= []);
  function removeItem(state, item) {
    const index = state.items.indexOf(item);
    if (index < 0) return;
    state.items.splice(index, 1);
    if (state.selected === item) state.selected = null;
    history(state).push({ op: 'remove', item, index });
  }
  function clearItems(state) {
    if (!state.items.length) return;
    state.selected = null;
    history(state).push({ op: 'clear', items: state.items.splice(0) });
  }
  function undo(state) {
    const last = history(state).pop();
    if (!last) return;
    if (last.op === 'add') {
      const i = state.items.indexOf(last.item);
      if (i >= 0) state.items.splice(i, 1);
    } else if (last.op === 'remove') state.items.splice(Math.min(last.index, state.items.length), 0, last.item);
    else if (last.op === 'clear') state.items.push(...last.items);
    else if (last.op === 'move') last.item.points = last.from;
    else if (last.op === 'color') last.item.color = last.from;
  }
  /** New colour for the next shapes – and for the selected one. */
  function setColor(state, color) {
    state.color = color;
    const sel = state.selected;
    if (sel && state.items.includes(sel) && STROKES.includes(sel.type) && sel.color !== color) {
      history(state).push({ op: 'color', item: sel, from: sel.color });
      sel.color = color;
    }
  }

  const segDist = (p, a, b) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = dx * dx + dy * dy;
    const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  };
  function hits(it, p, tol) {
    const b = bounds(it);
    if (p[0] < b.x0 - tol || p[0] > b.x1 + tol || p[1] < b.y0 - tol || p[1] > b.y1 + tol) return false;
    if (it.type === 'num') return Math.hypot(p[0] - it.points[0][0], p[1] - it.points[0][1]) <= RADIUS + tol;
    if (it.type === 'rect' || it.type === 'box') return true; // on the border or inside
    if (it.type === 'ellipse') {
      const rx = (b.x1 - b.x0) / 2 + tol;
      const ry = (b.y1 - b.y0) / 2 + tol;
      return ((p[0] - (b.x0 + b.x1) / 2) / rx) ** 2 + ((p[1] - (b.y0 + b.y1) / 2) / ry) ** 2 <= 1;
    }
    const pts = it.points;
    if (pts.length === 1) return Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) <= tol;
    for (let i = 1; i < pts.length; i++) if (segDist(p, pts[i - 1], pts[i]) <= tol) return true;
    return false;
  }
  /** The topmost mark at p – in reverse painting order (boxes, numbers, strokes). */
  function markAt(state, p, tol) {
    const rev = state.items.slice().reverse();
    return rev.find((it) => it.type === 'box' && hits(it, p, tol)) || rev.find((it) => it.type === 'num' && hits(it, p, tol)) || rev.find((it) => STROKES.includes(it.type) && hits(it, p, tol)) || null;
  }

  /** Shift: squares and circles, lines in steps of 45°. */
  function constrain(type, [x0, y0], [x, y]) {
    const dx = x - x0;
    const dy = y - y0;
    if (type === 'line' || type === 'arrow') {
      const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const l = Math.hypot(dx, dy);
      return [x0 + l * Math.cos(a), y0 + l * Math.sin(a)];
    }
    const d = Math.max(Math.abs(dx), Math.abs(dy));
    return [x0 + Math.sign(dx || 1) * d, y0 + Math.sign(dy || 1) * d];
  }

  /** Drawing with the pointer on a canvas that currently shows getView(). */
  function attach(canvas, getView, state, redraw, changed = () => {}) {
    let active = null;
    let moving = null;
    canvas.tabIndex = 0; // Entf removes the selected mark
    const at = (e) => {
      const v = getView();
      const r = canvas.getBoundingClientRect();
      return [v.x + ((e.clientX - r.left) / r.width) * v.w, v.y + ((e.clientY - r.top) / r.height) * v.h];
    };
    const scale = () => canvas.getBoundingClientRect().width / getView().w; // screen px per CSS px of the viewport
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      canvas.focus({ preventScroll: true });
      canvas.setPointerCapture(e.pointerId);
      const p = at(e);
      const tool = state.tool || DEFAULT_TOOL;
      const k = scale();
      if (tool === 'move') {
        const sel = state.selected && state.items.includes(state.selected) ? state.selected : null;
        const handle = sel && handleOf(sel, k);
        if (handle && Math.hypot(p[0] - handle.x, p[1] - handle.y) <= handle.r + 2 / k) {
          removeItem(state, sel);
          redraw();
          changed();
          return;
        }
        state.selected = markAt(state, p, 8 / k);
        moving = state.selected ? { item: state.selected, from: state.selected.points.map((q) => [...q]), start: p, moved: false } : null;
        redraw();
        return;
      }
      state.selected = null;
      const color = state.color || PEN;
      active = tool === 'num' ? { type: 'num', points: [p] } : tool === 'pen' ? { type: 'pen', points: [p], color } : tool === 'box' ? { type: 'box', points: [p, p] } : { type: tool, points: [p, p], color };
      state.items.push(active);
      redraw();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (moving) {
        const p = at(e);
        const [dx, dy] = [p[0] - moving.start[0], p[1] - moving.start[1]];
        moving.item.points = moving.from.map(([x, y]) => [x + dx, y + dy]);
        moving.moved = true;
        redraw();
        return;
      }
      if (!active) return;
      const p = at(e);
      if (active.type === 'pen') active.points.push(p);
      else if (active.type === 'num') active.points[0] = p; // drag to place
      else active.points[1] = e.shiftKey && active.type !== 'box' ? constrain(active.type, active.points[0], p) : p;
      redraw();
    });
    const end = () => {
      if (moving) {
        if (moving.moved) history(state).push({ op: 'move', item: moving.item, from: moving.from });
        moving = null;
        changed();
        return;
      }
      if (!active) return;
      const [[x0, y0], [x1, y1] = [x0, y0]] = active.points;
      // a click without dragging is no shape
      const tiny = ['box', 'rect', 'ellipse'].includes(active.type) ? Math.abs(x1 - x0) < 3 || Math.abs(y1 - y0) < 3 : ['line', 'arrow'].includes(active.type) && Math.hypot(x1 - x0, y1 - y0) < 4;
      if (tiny) state.items.splice(state.items.indexOf(active), 1);
      else history(state).push({ op: 'add', item: active });
      active = null;
      redraw();
      changed();
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('keydown', (e) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected && state.items.includes(state.selected)) {
        e.preventDefault();
        e.stopPropagation();
        removeItem(state, state.selected);
        redraw();
        changed();
      }
    });
  }

  /**
   * What the marks mean, for storing with the annotation: every offered click
   * (n set if it is drawn – the dashboard can add the others later) and the
   * numbers set by hand.
   */
  function legend(state) {
    const { items } = numbered(state);
    let n = state.base || 0;
    return {
      clicks: state.clicks.map((c) => ({ x: c.x, y: c.y, label: c.label, role: c.role, selector: c.selector, t: c.t, n: state.showClicks && c.on !== false ? ++n : undefined, note: c.note?.trim() || undefined })),
      numbers: items.filter((it) => it.type === 'num').map((it) => ({ n: it.n, note: it.note?.trim() || undefined })),
      drawn: items.some((it) => STROKES.includes(it.type)),
      redacted: items.some((it) => it.type === 'box'),
    };
  }

  // ---------------------------------------------------------------------------
  // UI (own tiny DOM helpers: the module runs in the page overlay and the dashboard)
  // ---------------------------------------------------------------------------

  function h(tag, props, ...children) {
    const [name, ...classes] = tag.split('.');
    const el = document.createElement(name);
    if (classes.length) el.className = classes.join(' ');
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'text') el.textContent = value;
      else if (key === 'on') for (const [ev, fn] of Object.entries(value)) el.addEventListener(ev, fn);
      else el.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) el.append(child instanceof Node ? child : String(child));
    return el;
  }

  const PATHS = {
    move: 'M5 3l14 8-6 2-2 6zM13 13l6 6',
    rect: 'M4 6h16v12H4z',
    ellipse: 'M12 5c4.97 0 9 3.13 9 7s-4.03 7-9 7-9-3.13-9-7 4.03-7 9-7z',
    arrow: 'M5 19L19 5M10 5h9v9',
    line: 'M4 20L20 4',
    pen: 'M4 20l4-1L19 8l-3-3L5 16l-1 4zM14 6l3 3',
    num: 'M12 3a9 9 0 100 18 9 9 0 000-18zM10.5 9l2-1.5V16',
    box: 'M4 6h16v12H4zM4 11l5-5M4 16l10-10M8 18l12-12M13 18l7-7M18 18l2-2',
    undo: 'M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 010 11H11',
    trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
    expand: 'M4 10V4h6M20 14v6h-6M4 4l6 6M20 20l-6-6',
    cursor: 'M5 3l14 8-6 2-2 6z',
    check: 'M5 12.5l4.5 4.5L19 7.5',
  };
  function icon(name, size = 16) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, String(v));
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', PATHS[name]);
    svg.append(path);
    return svg;
  }

  const TOOLS = [
    { id: 'move', label: 'Auswählen', title: 'Markierung anklicken: verschieben, Farbe ändern oder mit × bzw. Entf entfernen' },
    { id: 'rect', label: 'Rahmen', title: 'Rahmen um etwas ziehen' },
    { id: 'ellipse', label: 'Kreis', title: 'Kreis oder Ellipse um etwas ziehen' },
    { id: 'arrow', label: 'Pfeil', title: 'Pfeil auf eine Stelle ziehen' },
    { id: 'line', label: 'Linie', title: 'Gerade Linie, z. B. zum Unterstreichen' },
    { id: 'pen', label: 'Freihand', title: 'Freihand zeichnen' },
    { id: 'num', label: 'Nummern', title: 'Nummern setzen (1, 2, 3 …), z. B. für die Reihenfolge von Schritten' },
    { id: 'box', label: 'Schwärzen', title: 'Vertrauliches schwarz übermalen' },
  ];
  const HINTS = {
    move: 'Markierung anklicken und ziehen zum Verschieben; × oder Entf entfernt sie, ein Farbfeld färbt sie um.',
    rect: 'Rahmen aufziehen – mit Umschalt (⇧) wird er quadratisch.',
    ellipse: 'Kreis aufziehen – mit Umschalt (⇧) wird er rund.',
    arrow: 'Vom Ausgangspunkt zur Stelle ziehen, auf die der Pfeil zeigen soll – mit Umschalt (⇧) gerade.',
    line: 'Linie ziehen, z. B. zum Unterstreichen – mit Umschalt (⇧) waagerecht, senkrecht oder 45°.',
    pen: 'Freihand zeichnen.',
    num: 'Klicken setzt die nächste Nummer (gedrückt halten zum Verschieben) – daneben steht ein Feld für deine Notiz dazu.',
    box: 'Rechteck über Vertrauliches ziehen – es wird in allen gespeicherten Bildern schwarz übermalt.',
  };
  const toolHint = (tool) => HINTS[tool || DEFAULT_TOOL];
  const ordinal = (n) => (n >= 1 && n <= 20 ? String.fromCodePoint(0x245f + n) : `(${n})`);
  const clip = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));
  const clickName = (c) => clip(c.label || c.role || 'Klick', 34);

  /** The numbered marks in drawing order, each with the object its note belongs to. */
  function numberedMarks(state) {
    let n = state.base || 0;
    const out = [];
    if (state.showClicks) for (const c of state.clicks) if (c.on !== false) out.push({ n: ++n, mark: c, kind: 'click', label: `Klick auf ${c.label ? `„${clip(c.label, 40)}“` : c.role || 'ein Element'}` });
    for (const it of state.items) if (it.type === 'num') out.push({ n: ++n, mark: it, kind: 'num', label: '' });
    return out;
  }

  /**
   * A text field per number. The note belongs to the circle, not to the
   * number: removing ② turns ③ into ② and its note moves along.
   * onChange(structural) – structural when a number was removed or left out.
   */
  function noteList(state, { onChange = () => {}, title = 'Zu den Nummern im Screenshot', decorate = null } = {}) {
    const rows = new Map(); // mark → { row, input, num, label }
    const list = h('div.flm-note-rows');
    const el = h('div.flm-notes', null, h('div.flm-notes-head', { text: title }), list);
    function update() {
      const marks = numberedMarks(state);
      el.hidden = !marks.length;
      const ordered = [];
      for (const m of marks) {
        let r = rows.get(m.mark);
        if (!r) {
          const input = h('input', { type: 'text', maxlength: '300', placeholder: m.kind === 'click' ? 'Kommentar dazu (optional)' : 'Was ist hier?' });
          input.addEventListener('input', () => {
            m.mark.note = input.value;
            onChange(false);
          });
          const remove = h('button.flm-note-x', { type: 'button', title: m.kind === 'click' ? 'Diesen Klick weglassen' : 'Nummer entfernen (Rückgängig holt sie zurück)', 'aria-label': m.kind === 'click' ? 'Klick weglassen' : 'Nummer entfernen' }, '×');
          remove.addEventListener('click', () => {
            if (m.kind === 'click') m.mark.on = false;
            else removeItem(state, m.mark);
            onChange(true);
          });
          // decorate: e.g. a dictation button around the field (annotation dialog)
          r = { row: h('div.flm-note', null, h('b.flm-note-n'), h('span.flm-note-label'), decorate ? decorate(input) : input, remove), input };
          [r.num, r.label] = r.row.children;
          rows.set(m.mark, r);
        }
        r.num.textContent = ordinal(m.n);
        r.label.textContent = m.label;
        r.label.hidden = !m.label;
        r.input.setAttribute('aria-label', `Notiz zu Nummer ${m.n}`);
        if (r.input.getRootNode().activeElement !== r.input && r.input.value !== (m.mark.note || '')) r.input.value = m.mark.note || '';
        ordered.push(r.row);
      }
      // moving the focused field would blur it: only rebuild when the order changed
      if (ordered.length !== list.children.length || ordered.some((row, i) => list.children[i] !== row)) list.replaceChildren(...ordered);
    }
    update();
    return { el, update };
  }

  /**
   * Toggle group of the tools; returns {buttons, update()}.
   * labels: true (all), 'selected' (only the chosen tool's) or false.
   */
  function toolButtons(state, { labels = true, onChange = () => {} } = {}) {
    const buttons = TOOLS.map((t) => {
      const b = h('button', { type: 'button', title: t.title, 'aria-label': t.label, 'data-tool': t.id }, icon(t.id, 15), labels ? h('span', { text: t.label }) : null);
      b.addEventListener('click', () => {
        state.tool = t.id;
        if (t.id !== 'move') state.selected = null;
        update();
        onChange();
      });
      return b;
    });
    function update() {
      for (const b of buttons) {
        const on = b.dataset.tool === (state.tool || DEFAULT_TOOL);
        b.classList.toggle('sel', on);
        b.setAttribute('aria-pressed', String(on));
        if (labels === 'selected') b.querySelector('span').hidden = !on;
      }
    }
    update();
    return { buttons, update };
  }

  /** The colour swatches; returns {el, update()}. */
  function colorButtons(state, { onChange = () => {} } = {}) {
    const buttons = COLORS.map((c) => {
      const b = h('button.flm-color', { type: 'button', title: `Farbe ${c.label}`, 'aria-label': `Farbe ${c.label}`, 'data-color': c.id, style: `--c:${c.id}` });
      b.addEventListener('click', () => {
        setColor(state, c.id);
        update();
        onChange();
      });
      return b;
    });
    const el = h('div.flm-colors', { role: 'group', 'aria-label': 'Farbe' }, buttons);
    function update() {
      const sel = state.selected && state.items.includes(state.selected) && STROKES.includes(state.selected.type) ? state.selected : null;
      const current = sel ? sel.color || PEN : state.color || PEN;
      for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.color === current));
      // numbers and blacked-out areas have fixed colours
      el.classList.toggle('off', ['num', 'box'].includes(state.tool) || (state.tool === 'move' && !sel));
    }
    update();
    return { el, update };
  }

  /**
   * Full-window editor for the marks of one screenshot.
   * views: [{id, label, image, sx, sy, sw, sh, x, y, w, h}], state is edited in place.
   * Without onCancel, Esc and „Fertig“ both keep the marks (annotation dialog).
   */
  function openEditor({ mount, views, state, title = 'Screenshot bearbeiten', note = '', doneLabel = 'Fertig', onDone = () => {}, onCancel = null, onChange = () => {}, notes = true, decorateNote = null }) {
    const opener = mount.getRootNode()?.activeElement || document.activeElement;
    let view = views.find((v) => v.id === state.view) || views[0];
    const canvas = h('canvas.flm-canvas');
    const stage = h('div.flm-stage', null, canvas);
    const hint = h('div.flm-hint');
    const chips = h('div.flm-chips');

    const viewButtons = views.map((v) => {
      const b = h('button', { type: 'button', text: v.label });
      b.addEventListener('click', () => {
        view = v;
        state.view = v.id;
        refresh();
      });
      return b;
    });
    const tools = toolButtons(state, { labels: 'selected', onChange: () => refresh() });
    const colors = colorButtons(state, {
      onChange: () => {
        refresh();
        onChange();
      },
    });

    let clickToggle = null;
    if (state.clicks.length) {
      const input = h('input', { type: 'checkbox' });
      input.checked = Boolean(state.showClicks);
      input.addEventListener('change', () => {
        state.showClicks = input.checked;
        refresh();
        onChange();
      });
      clickToggle = h('label.flm-check', { title: 'Wo du auf dieser Seite zuletzt geklickt hast, nummeriert in der Reihenfolge' }, input, icon('cursor', 14), `Letzte Klicks (${state.clicks.length})`);
    }

    const button = (cls, iconName, label, fn, titleText) => {
      const b = h(`button.${cls}`, { type: 'button', title: titleText || label, 'aria-label': label }, icon(iconName, 16), cls.includes('icon') ? null : h('span', { text: label }));
      b.addEventListener('click', fn);
      return b;
    };
    const undoButton = button('flm-icon', 'undo', 'Rückgängig', () => {
      undo(state);
      refresh();
      onChange();
    }, 'Letzten Schritt zurücknehmen (Strg+Z)');
    const clear = button('flm-icon', 'trash', 'Alles entfernen', () => {
      clearItems(state);
      refresh();
      onChange();
    }, 'Alle neuen Markierungen entfernen (Rückgängig holt sie zurück)');
    const noteBox = notes
      ? noteList(state, {
          decorate: decorateNote,
          onChange: (structural) => {
            if (structural) refresh();
            onChange();
          },
        })
      : null;
    const side = noteBox ? h('aside.flm-side', null, noteBox.el) : null;
    const done = button('flm-done', 'check', doneLabel, () => close(true));
    const cancel = onCancel ? h('button.flm-cancel', { type: 'button', text: 'Abbrechen', on: { click: () => close(false) } }) : null;

    const box = h(
      'div.flm-editor',
      { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h(
        'div.flm-bar',
        null,
        h('strong.flm-title', { text: title }),
        views.length > 1 ? h('div.flm-seg', null, viewButtons) : null,
        h('div.flm-seg', null, tools.buttons),
        colors.el,
        clickToggle,
        h('div.flm-grow'),
        undoButton,
        clear,
        cancel,
        done,
      ),
      chips,
      hint,
      h('div.flm-body', null, stage, side),
    );

    function refresh() {
      viewButtons.forEach((b, i) => b.classList.toggle('sel', views[i] === view));
      tools.update();
      colors.update();
      // the clicks with the number each one gets; click a chip to leave it out
      chips.replaceChildren();
      chips.hidden = !(state.showClicks && state.clicks.length);
      if (!chips.hidden) {
        chips.append(h('span.flm-chips-label', { text: 'Klicks im Bild:' }));
        let n = state.base || 0; // as numbered(): shown clicks come first
        for (const c of state.clicks) {
          const num = c.on !== false ? ++n : null;
          const chip = h(`button.flm-chip${c.on === false ? '.off' : ''}`, { type: 'button', title: c.on === false ? 'Wieder einzeichnen' : 'Diesen Klick weglassen', 'aria-pressed': String(c.on !== false) }, num ? h('b', { text: ordinal(num) }) : null, clickName(c));
          chip.addEventListener('click', () => {
            c.on = c.on === false;
            refresh();
            onChange();
          });
          chips.append(chip);
        }
      }
      hint.textContent = [toolHint(state.tool), state.tool === 'box' && views.length > 1 ? 'Ausschnitt und ganze Ansicht werden gespeichert – beide prüfen.' : '', note].filter(Boolean).join(' ');
      if (noteBox) {
        noteBox.update();
        side.hidden = noteBox.el.hidden;
      }
      redraw();
    }
    function redraw() {
      const r = stage.getBoundingClientRect();
      render(canvas, view, state, Math.max(100, r.width - 32), Math.max(80, r.height - 32));
    }

    attach(canvas, () => view, state, redraw, () => {
      colors.update();
      if (noteBox) {
        noteBox.update();
        side.hidden = noteBox.el.hidden;
        if (!side.hidden) redraw(); // the side panel may just have appeared
      }
      onChange();
    });
    const resize = new ResizeObserver(() => redraw());
    box.addEventListener('keydown', (e) => {
      e.stopPropagation(); // not to the annotation dialog underneath
      if (e.key === 'Escape') {
        e.preventDefault();
        close(!onCancel);
      } else if (e.key === 'z' && (e.ctrlKey || e.metaKey) && !e.target.matches?.('input')) {
        e.preventDefault();
        undoButton.click();
      } else if (e.key === 'Enter' && e.target.matches?.('.flm-note input')) {
        e.preventDefault(); // Enter in a note field: next field, not „Fertig“
        const fields = [...box.querySelectorAll('.flm-note input')];
        fields[fields.indexOf(e.target) + 1]?.focus();
      }
    });
    mount.append(box);
    resize.observe(stage);
    refresh();
    requestAnimationFrame(redraw); // sizes are final only after the first layout
    done.focus();

    function close(keep) {
      resize.disconnect();
      box.remove();
      if (opener?.isConnected) opener.focus?.({ preventScroll: true });
      if (keep) onDone();
      else onCancel?.();
    }
    return { close: () => close(!onCancel) };
  }

  const CSS = `
.flm-editor { position: fixed; inset: 0; z-index: 35; display: flex; flex-direction: column; background: rgba(15,23,42,.94); color: #e2e8f0; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; pointer-events: auto; }
.flm-editor button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
.flm-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 14px; background: #0f172a; border-bottom: 1px solid rgba(255,255,255,.08); }
.flm-title { font-size: 14px; margin-right: 6px; color: #fff; }
.flm-seg { display: flex; background: rgba(255,255,255,.08); border-radius: 9px; padding: 2px; }
.flm-seg button { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 7px; color: #cbd5e1; white-space: nowrap; }
.flm-seg button:hover { color: #fff; }
.flm-seg button.sel { background: #fff; color: #0f172a; font-weight: 600; }
.flm-check { display: inline-flex; align-items: center; gap: 6px; padding: 5px 8px; border-radius: 8px; cursor: pointer; white-space: nowrap; }
.flm-check:hover { background: rgba(255,255,255,.08); }
.flm-check input { accent-color: #6366f1; margin: 0; }
.flm-grow { flex: 1; }
.flm-icon { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 8px; }
.flm-icon:hover, .flm-cancel:hover { background: rgba(255,255,255,.1); }
.flm-cancel { padding: 7px 12px; border-radius: 9px; }
.flm-done { display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: 9px; background: #4f46e5 !important; color: #fff !important; font-weight: 600 !important; }
.flm-done:hover { background: #4338ca !important; }
.flm-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 14px 0; }
.flm-chips[hidden] { display: none; }
.flm-chips-label { color: #94a3b8; font-size: 12px; }
.flm-chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 999px; background: rgba(37,99,235,.25); color: #dbeafe; font-size: 12px; box-shadow: 0 0 0 1px rgba(147,197,253,.35) inset; }
.flm-chip b { color: #fff; font-size: 13px; }
.flm-chip.off { background: transparent; color: #64748b; text-decoration: line-through; box-shadow: 0 0 0 1px rgba(100,116,139,.5) inset; }
.flm-hint { padding: 8px 14px 0; color: #94a3b8; font-size: 12px; }
.flm-body { flex: 1; min-height: 0; display: flex; }
.flm-stage { flex: 1; min-width: 0; min-height: 0; display: grid; place-items: center; padding: 16px; }
.flm-side { width: 320px; flex: none; overflow: auto; padding: 14px 14px 14px 0; }
.flm-side[hidden] { display: none; }
.flm-notes { display: grid; gap: 6px; }
.flm-notes[hidden] { display: none; }
.flm-notes-head { font-weight: 600; font-size: 12.5px; }
.flm-note-rows { display: grid; gap: 6px; }
.flm-note { display: grid; grid-template-columns: 22px minmax(0, 1fr) 24px; align-items: center; gap: 2px 6px; }
.flm-note-n { color: #2563eb; font-size: 16px; line-height: 1; text-align: center; }
.flm-note-label { grid-column: 2 / 4; font-size: 11.5px; color: #64748b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.flm-note-label[hidden] { display: none; }
.flm-note input { grid-column: 2; min-width: 0; font: inherit; font-size: 13px; padding: 6px 8px; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff; color: #0f172a; }
.flm-note input:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,.18); }
.flm-note-x { grid-column: 3; width: 24px; height: 24px; border-radius: 6px; color: #94a3b8; font-size: 16px; line-height: 1; background: none; border: 0; cursor: pointer; }
.flm-note-x:hover { color: #dc2626; background: rgba(220,38,38,.08); }
.flm-note b.flm-note-n { grid-row: 1 / 3; }
.flm-editor .flm-notes-head { color: #fff; }
.flm-editor .flm-note-n { color: #93c5fd; }
.flm-editor .flm-note-label { color: #94a3b8; }
.flm-editor .flm-note input { background: rgba(255,255,255,.08); border-color: rgba(255,255,255,.16); color: #f8fafc; }
.flm-editor .flm-note input::placeholder { color: #94a3b8; }
.flm-canvas { display: block; border-radius: 6px; cursor: crosshair; touch-action: none; background: #fff; box-shadow: 0 10px 40px rgba(0,0,0,.5); outline: none; }
.flm-colors { display: inline-flex; align-items: center; gap: 5px; padding: 0 4px; transition: opacity .12s; }
.flm-colors.off { opacity: .35; }
.flm-colors .flm-color { width: 20px; height: 20px; padding: 0; border-radius: 50%; background: var(--c) !important; border: 2px solid rgba(255,255,255,.9); box-shadow: 0 0 0 1px rgba(15,23,42,.25); cursor: pointer; }
.flm-colors .flm-color[aria-pressed="true"] { box-shadow: 0 0 0 2px #0f172a, 0 0 0 4px #fff; }
.flm-editor .flm-colors .flm-color[aria-pressed="true"] { box-shadow: 0 0 0 2px #0f172a, 0 0 0 4px #a5b4fc; }
`;

  return Object.freeze({ DEFAULT_TOOL, numbered, numberedMarks, paint, draw, render, toDataUrl, attach, undo, removeItem, clearItems, setColor, legend, noteList, openEditor, toolButtons, colorButtons, hint: toolHint, icon, ordinal, CSS });
})();
