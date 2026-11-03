// Context extraction for annotations (isolated world). Everything here only
// reads the DOM; nothing is cloned or mutated, so custom elements on the page
// never run constructors because of us.
(() => {
  if (globalThis.FL_CTX) return;
  const LIMITS = globalThis.FL_CONST.LIMITS;

  // ---------------------------------------------------------------------------
  // Traversal across shadow roots and same-origin iframes
  // ---------------------------------------------------------------------------

  const isShadowRoot = (node) => node && node.nodeType === 11 && 'host' in node;

  function frameElementOf(doc) {
    try {
      return doc.defaultView?.frameElement || null;
    } catch {
      return null;
    }
  }

  /** Element under a viewport point, descending into open shadow roots and same-origin iframes. */
  function deepElementFromPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    let ox = 0;
    let oy = 0;
    for (let guard = 0; el && guard < 30; guard++) {
      if (el.shadowRoot) {
        const inner = el.shadowRoot.elementFromPoint(x - ox, y - oy);
        if (inner && inner !== el) {
          el = inner;
          continue;
        }
      }
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        let doc = null;
        try {
          doc = el.contentDocument;
        } catch {
          doc = null;
        }
        if (doc) {
          const r = el.getBoundingClientRect();
          ox += r.left + el.clientLeft;
          oy += r.top + el.clientTop;
          const inner = doc.elementFromPoint(x - ox, y - oy);
          if (inner) {
            el = inner;
            continue;
          }
        }
      }
      break;
    }
    return el;
  }

  /** Parent across shadow and frame boundaries (null at the top document root). */
  function parentOf(el) {
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode();
    if (isShadowRoot(root)) return root.host;
    if (el.ownerDocument !== document && el === el.ownerDocument.documentElement) return frameElementOf(el.ownerDocument);
    return null;
  }

  /** Bounding rect in top-level viewport coordinates. */
  function rectOf(el) {
    const r = el.getBoundingClientRect();
    let x = r.left;
    let y = r.top;
    let doc = el.ownerDocument;
    while (doc && doc !== document) {
      const frame = frameElementOf(doc);
      if (!frame) break;
      const fr = frame.getBoundingClientRect();
      x += fr.left + frame.clientLeft;
      y += fr.top + frame.clientTop;
      doc = frame.ownerDocument;
    }
    return { x, y, width: r.width, height: r.height };
  }

  // ---------------------------------------------------------------------------
  // Selectors
  // ---------------------------------------------------------------------------

  const TEST_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa', 'data-e2e', 'data-automation-id'];

  const looksGenerated = (value) =>
    /\d{4,}|^[a-f0-9-]{10,}$|^(ember|react-|radix-|headlessui-|mui-|downshift-|rc_|cdk-|mat-)|[:]/i.test(value);

  const stableClass = (c) =>
    c.length < 40 &&
    !/[:[\]/@!]/.test(c) &&
    !/^(css|sc|jsx|emotion|jss|makeStyles|svelte|ng-tns|ng-star|v-)-/.test(c) &&
    !/(__|_)[a-zA-Z0-9]{5,}$/.test(c) &&
    !/\d{3,}/.test(c) &&
    !/^(active|focus|focused|hover|hovered|selected|open|show|visible|is-|has-)/.test(c);

  const attrValue = (v) => CSS.escape(String(v));
  /** Selectors are kept unredacted (they must keep working), so they must not be built from secrets. */
  const secretFree = (v) => !masking || globalThis.FL_SAN.redact(String(v)) === String(v);

  function uniqueIn(root, selector, el) {
    try {
      const found = root.querySelectorAll(selector);
      return found.length === 1 && found[0] === el;
    } catch {
      return false;
    }
  }

  function segmentFor(el, root) {
    const tag = el.tagName.toLowerCase();
    // Test attributes are the most stable hooks and easy to grep for in the code base.
    let testSel = null;
    for (const attr of TEST_ATTRS) {
      const v = el.getAttribute(attr);
      if (v && secretFree(v)) {
        testSel = `[${attr}="${attrValue(v)}"]`;
        if (uniqueIn(root, testSel, el)) return { sel: testSel, unique: true };
        break;
      }
    }
    if (el.id && !looksGenerated(el.id) && secretFree(el.id)) {
      const sel = `#${CSS.escape(el.id)}`;
      if (uniqueIn(root, sel, el)) return { sel, unique: true };
    }
    for (const attr of ['name', 'aria-label', 'for', 'placeholder']) {
      const v = el.getAttribute(attr);
      if (v && v.length < 60 && secretFree(v)) {
        const sel = `${tag}[${attr}="${attrValue(v)}"]`;
        if (uniqueIn(root, sel, el)) return { sel, unique: true };
      }
    }
    const classes = Array.from(el.classList).filter(stableClass).slice(0, 2);
    let sel = tag + (testSel || classes.map((c) => `.${CSS.escape(c)}`).join(''));
    const parent = el.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children);
      const matches = (node) => {
        try {
          return node.matches(sel);
        } catch {
          return false;
        }
      };
      if (siblings.filter((node) => node !== el && matches(node)).length) {
        const sameTag = siblings.filter((s) => s.tagName === el.tagName);
        sel += `:nth-of-type(${sameTag.indexOf(el) + 1})`;
      }
    }
    return { sel, unique: false };
  }

  /** Shortest unique selector within the element's own document or shadow root. */
  function scopedSelector(el) {
    const root = el.getRootNode();
    const parts = [];
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      const seg = segmentFor(cur, root);
      parts.unshift(seg.sel);
      const candidate = parts.join(' > ');
      if (seg.unique || uniqueIn(root, candidate, el)) return candidate;
      if (cur.tagName === 'HTML') break;
    }
    return parts.join(' > ');
  }

  /** Selector across shadow/iframe boundaries, scopes joined with " >>> ". */
  function deepSelector(el) {
    const scopes = [];
    let cur = el;
    for (let guard = 0; cur && guard < 10; guard++) {
      scopes.unshift(scopedSelector(cur));
      const root = cur.getRootNode();
      if (isShadowRoot(root)) cur = root.host;
      else if (root !== document) cur = frameElementOf(root);
      else cur = null;
    }
    return scopes.join(' >>> ');
  }

  function xpathOf(el) {
    const parts = [];
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      let index = 1;
      for (let sib = cur.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (sib.tagName === cur.tagName) index++;
      }
      parts.unshift(`${cur.tagName.toLowerCase()}[${index}]`);
    }
    return '/' + parts.join('/');
  }

  /** Resolves a selector produced by deepSelector(). */
  function querySelectorDeep(selector) {
    if (!selector) return null;
    let root = document;
    let el = null;
    for (const part of selector.split(' >>> ')) {
      try {
        el = root.querySelector(part);
      } catch {
        return null;
      }
      if (!el) return null;
      if (el.shadowRoot) root = el.shadowRoot;
      else if (el.tagName === 'IFRAME') {
        try {
          root = el.contentDocument || root;
        } catch {
          /* cross origin */
        }
      }
    }
    return el;
  }

  // ---------------------------------------------------------------------------
  // Text, HTML and styles
  // ---------------------------------------------------------------------------

  const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const clip = (s, max) => (s.length > max ? s.slice(0, max - 1) + '…' : s);

  function visibleText(el, max = LIMITS.text) {
    const text = el.innerText !== undefined ? el.innerText : el.textContent;
    return clip(collapse(text), max);
  }

  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

  const BUTTON_TYPES = ['button', 'submit', 'reset', 'image'];
  const URL_ATTRS = ['href', 'src', 'action', 'formaction', 'poster', 'data', 'cite', 'background'];

  /** Value attributes of form fields can hold what the user typed (React keeps them in sync). */
  const hidesValue = (el) => (el.tagName === 'INPUT' && !BUTTON_TYPES.includes((el.getAttribute('type') || '').toLowerCase())) || el.tagName === 'OPTION' || el.tagName === 'TEXTAREA';

  function openTag(el) {
    const tag = el.tagName.toLowerCase();
    let attrs = '';
    for (const a of Array.from(el.attributes)) {
      if (attrs.length > 500) {
        attrs += ' …';
        break;
      }
      let v = a.value;
      if (a.name === 'style' && !v.trim()) continue;
      if (a.name === 'value' && hidesValue(el)) {
        if (el.tagName === 'OPTION') continue;
        v = v ? '***' : '';
      }
      if (URL_ATTRS.includes(a.name)) v = maskUrl(v, masking);
      else if (a.name === 'srcset') v = v.split(',').map((part) => part.trim().replace(/^\S+/, (u) => maskUrl(u, masking))).join(', ');
      else if (masking && v && SENSITIVE_ATTR.test(a.name)) v = '***'; // data-token, data-session-id, nonce …
      if (v.length > 120) v = v.slice(0, 120) + '…';
      attrs += v === '' ? ` ${a.name}` : ` ${a.name}="${escAttr(v)}"`;
    }
    return `<${tag}${attrs}>`;
  }

  function serialize(node, depth, maxDepth, indent) {
    const pad = '  '.repeat(indent);
    if (node.nodeType === 3) {
      const t = collapse(node.textContent);
      return t ? pad + escText(clip(t, 140)) : '';
    }
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    if (['script', 'style', 'noscript', 'template'].includes(tag)) return '';
    if (tag === 'input' && (node.getAttribute('type') || '').toLowerCase() === 'hidden') return ''; // CSRF tokens & co.
    if (tag === 'textarea') return `${pad}${openTag(node)}…</textarea>`; // its text is the typed value
    const open = openTag(node);
    if (VOID.has(tag)) return pad + open;
    if (tag === 'svg') return `${pad}${open}…</svg>`;
    const children = [];
    if (node.shadowRoot) children.push({ shadow: node.shadowRoot });
    children.push(...Array.from(node.childNodes).filter((c) => c.nodeType === 1 || (c.nodeType === 3 && collapse(c.textContent))));
    if (!children.length) return `${pad}${open}</${tag}>`;
    if (depth >= maxDepth) {
      const text = clip(collapse(node.textContent), 80);
      return `${pad}${open}${text ? escText(text) : '…'}</${tag}>`;
    }
    if (children.length === 1 && children[0].nodeType === 3) {
      return `${pad}${open}${escText(clip(collapse(children[0].textContent), 140))}</${tag}>`;
    }
    const lines = [pad + open];
    let shown = 0;
    for (const child of children) {
      if (shown >= 10) {
        lines.push(`${pad}  <!-- … ${children.length - shown} weitere Knoten -->`);
        break;
      }
      if (child.shadow) {
        lines.push(`${pad}  <!-- #shadow-root -->`);
        for (const sc of Array.from(child.shadow.children).slice(0, 8)) {
          const s = serialize(sc, depth + 1, maxDepth, indent + 2);
          if (s) lines.push(s);
        }
      } else {
        const s = serialize(child, depth + 1, maxDepth, indent + 1);
        if (s) lines.push(s);
      }
      shown++;
    }
    lines.push(`${pad}</${tag}>`);
    return lines.join('\n');
  }

  function htmlSnippet(el, max = LIMITS.htmlSnippet) {
    for (let maxDepth = 4; maxDepth >= 0; maxDepth--) {
      const html = serialize(el, 0, maxDepth, 0);
      if (html.length <= max) return html;
    }
    return clip(openTag(el), max);
  }

  const STYLE_PROPS = [
    'display', 'position', 'width', 'height', 'margin', 'padding', 'color', 'background-color', 'background-image',
    'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align', 'text-transform',
    'border', 'border-radius', 'box-shadow', 'opacity', 'z-index', 'overflow', 'cursor', 'visibility',
    'flex-direction', 'justify-content', 'align-items', 'gap', 'outline',
  ];
  const BORING = new Set(['none', 'normal', 'auto', '0px', 'visible', 'static', 'rgba(0, 0, 0, 0)', '1', 'start']);

  function computedStyles(el) {
    const cs = getComputedStyle(el);
    const out = {};
    for (const prop of STYLE_PROPS) {
      let v = cs.getPropertyValue(prop);
      if (!v || BORING.has(v)) continue;
      if (prop === 'font-family') v = v.split(',').slice(0, 3).join(',');
      if (prop === 'background-image') v = v.replace(/url\((["']?)(.*?)\1\)/g, (m, q, u) => `url(${q}${maskUrl(u, masking)}${q})`);
      v = v.replace(/(\d+\.\d{2})\d+px/g, '$1px');
      out[prop] = clip(v, 120);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Colour contrast (WCAG 2.x)
  // ---------------------------------------------------------------------------

  let colorCtx = null;
  /** Parses any CSS colour (incl. oklch/color()) via a 1×1 canvas. */
  function parseColor(value) {
    if (!value) return null;
    const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(value);
    if (m) {
      let a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      return { r: +m[1], g: +m[2], b: +m[3], a };
    }
    try {
      colorCtx = colorCtx || new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
      colorCtx.clearRect(0, 0, 1, 1);
      colorCtx.fillStyle = '#000';
      colorCtx.fillStyle = value;
      colorCtx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = colorCtx.getImageData(0, 0, 1, 1).data;
      return { r, g, b, a: a / 255 };
    } catch {
      return null;
    }
  }

  const blend = (top, bottom) => {
    const a = top.a + bottom.a * (1 - top.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    const mix = (c) => (top[c] * top.a + bottom[c] * bottom.a * (1 - top.a)) / a;
    return { r: mix('r'), g: mix('g'), b: mix('b'), a };
  };

  const luminance = ({ r, g, b }) => {
    const lin = (c) => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };

  const hex = ({ r, g, b }) => '#' + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');

  function effectiveBackground(el) {
    const layers = [];
    let uncertain = false;
    for (let cur = el; cur; cur = parentOf(cur)) {
      const cs = getComputedStyle(cur);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') uncertain = true;
      const c = parseColor(cs.backgroundColor);
      if (c && c.a > 0) {
        layers.push(c);
        if (c.a >= 1) break;
      }
    }
    let color = { r: 255, g: 255, b: 255, a: 1 }; // assume a white canvas below everything
    for (let i = layers.length - 1; i >= 0; i--) color = blend(layers[i], color);
    return { color, uncertain };
  }

  function textHost(el) {
    const hasOwnText = (n) => Array.from(n.childNodes).some((c) => c.nodeType === 3 && c.textContent.trim());
    if (hasOwnText(el)) return el;
    const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_ELEMENT);
    for (let i = 0, n = walker.nextNode(); n && i < 80; i++, n = walker.nextNode()) {
      if (hasOwnText(n) && n.getClientRects().length) return n;
    }
    return null;
  }

  function contrastInfo(el) {
    const target = textHost(el);
    if (!target) return null;
    const cs = getComputedStyle(target);
    const fgRaw = parseColor(cs.color);
    if (!fgRaw) return null;
    const { color: bg, uncertain } = effectiveBackground(target);
    const fg = fgRaw.a < 1 ? blend(fgRaw, bg) : fgRaw;
    const [l1, l2] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
    const ratio = Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100;
    const size = parseFloat(cs.fontSize);
    const bold = parseInt(cs.fontWeight, 10) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    return {
      foreground: hex(fg),
      background: hex(bg),
      ratio,
      largeText: large,
      passesAA: ratio >= (large ? 3 : 4.5),
      passesAAA: ratio >= (large ? 4.5 : 7),
      uncertain,
      fontSize: cs.fontSize,
      measuredOn: target === el ? 'Element' : 'Textinhalt im Element',
    };
  }

  // ---------------------------------------------------------------------------
  // Accessibility
  // ---------------------------------------------------------------------------

  const IMPLICIT_ROLES = {
    a: (el) => (el.hasAttribute('href') ? 'link' : null),
    button: () => 'button',
    nav: () => 'navigation',
    main: () => 'main',
    header: () => 'banner',
    footer: () => 'contentinfo',
    aside: () => 'complementary',
    form: () => 'form',
    dialog: () => 'dialog',
    img: (el) => (el.getAttribute('alt') === '' ? 'presentation' : 'img'),
    ul: () => 'list',
    ol: () => 'list',
    li: () => 'listitem',
    table: () => 'table',
    select: () => 'combobox',
    textarea: () => 'textbox',
    h1: () => 'heading', h2: () => 'heading', h3: () => 'heading', h4: () => 'heading', h5: () => 'heading', h6: () => 'heading',
    input: (el) => {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      return { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', image: 'button', range: 'slider', search: 'searchbox', hidden: null }[t] ?? 'textbox';
    },
  };

  const roleOf = (el) => el.getAttribute('role') || IMPLICIT_ROLES[el.tagName.toLowerCase()]?.(el) || null;

  function labelFor(el) {
    const doc = el.ownerDocument;
    if (el.id) {
      let label = null;
      try {
        label = doc.querySelector(`label[for="${attrValue(el.id)}"]`);
      } catch {
        label = null;
      }
      if (label) return visibleText(label, 120);
    }
    const wrapping = el.closest('label');
    return wrapping ? visibleText(wrapping, 120) : '';
  }

  function accessibleName(el) {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => el.ownerDocument.getElementById(id))
        .filter(Boolean)
        .map((n) => visibleText(n, 120))
        .join(' ');
      if (text) return { name: text, source: 'aria-labelledby' };
    }
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return { name: aria.trim(), source: 'aria-label' };
    const tag = el.tagName.toLowerCase();
    if (['input', 'select', 'textarea'].includes(tag)) {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (['submit', 'button', 'reset'].includes(type) && el.value) return { name: el.value, source: 'value' };
      const label = labelFor(el);
      if (label) return { name: label, source: 'label' };
    }
    if (tag === 'img' || (tag === 'input' && el.type === 'image')) {
      const alt = el.getAttribute('alt');
      if (alt !== null) return { name: alt, source: 'alt' };
    }
    if (['button', 'a', 'summary', 'option', 'label', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag) || ['button', 'link', 'tab', 'menuitem', 'heading'].includes(el.getAttribute('role'))) {
      const text = visibleText(el, 120);
      if (text) return { name: text, source: 'Inhalt' };
      const img = el.querySelector('img[alt], svg title, [aria-label]');
      if (img) {
        const n = img.getAttribute?.('alt') || img.getAttribute?.('aria-label') || img.textContent;
        if (n) return { name: collapse(n), source: 'Bild/Icon im Element' };
      }
    }
    const title = el.getAttribute('title');
    if (title) return { name: title, source: 'title' };
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return { name: placeholder, source: 'placeholder (kein echtes Label)' };
    return { name: '', source: null };
  }

  const INTERACTIVE = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [tabindex], [contenteditable=""], [contenteditable=true], [role=button], [role=link], [role=checkbox], [role=menuitem], [role=tab], [role=switch]';

  function a11yInfo(el, styles) {
    const role = roleOf(el);
    const { name, source } = accessibleName(el);
    const interactive = el.matches(INTERACTIVE);
    const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
    const info = {
      role,
      name: clip(name, 160),
      nameSource: source,
      focusable: el.tabIndex >= 0 && !disabled,
      tabIndex: el.tabIndex,
      disabled,
      ariaAttributes: {},
    };
    for (const a of Array.from(el.attributes)) {
      if (a.name.startsWith('aria-') && a.name !== 'aria-label') info.ariaAttributes[a.name] = clip(a.value, 80);
    }
    if (!Object.keys(info.ariaAttributes).length) delete info.ariaAttributes;
    return { info, hints: a11yHints(el, info, interactive, styles) };
  }

  function a11yHints(el, info, interactive, styles) {
    const hints = [];
    const tag = el.tagName.toLowerCase();
    const rect = el.getBoundingClientRect();
    if (tag === 'img' && !el.hasAttribute('alt')) hints.push('Bild ohne alt-Attribut (Screenreader können es nicht beschreiben).');
    if ((interactive || ['button', 'link'].includes(info.role)) && !info.name) hints.push(`Interaktives Element (${info.role || tag}) ohne zugänglichen Namen.`);
    if (['input', 'select', 'textarea'].includes(tag) && el.type !== 'hidden' && !['aria-label', 'aria-labelledby', 'label', 'value'].includes(info.nameSource)) {
      hints.push('Formularfeld ohne sichtbares/verknüpftes Label.');
    }
    if (!interactive && styles.cursor === 'pointer' && !info.focusable && !el.closest('a[href],button,label,summary')) {
      hints.push('Sieht klickbar aus (cursor: pointer), ist aber kein Button/Link und nicht per Tastatur erreichbar.');
    }
    if ((interactive || styles.cursor === 'pointer') && rect.width > 0 && (rect.width < 24 || rect.height < 24)) {
      hints.push(`Kleine Klickfläche (${Math.round(rect.width)}×${Math.round(rect.height)} px, WCAG 2.2 empfiehlt mind. 24×24 px).`);
    }
    const fontSize = parseFloat(styles['font-size']);
    if (fontSize && fontSize < 12 && visibleText(el, 20)) hints.push(`Sehr kleine Schrift (${styles['font-size']}).`);
    if (styles.outline && /none|0px/.test(styles.outline) && interactive) {
      // only informative: focus outlines are often restyled on :focus-visible
    }
    return hints;
  }

  // ---------------------------------------------------------------------------
  // Where on the page is it?
  // ---------------------------------------------------------------------------

  const LANDMARK_TAGS = { main: 'Hauptbereich', nav: 'Navigation', header: 'Kopfbereich', footer: 'Fußbereich', aside: 'Seitenleiste', form: 'Formular', dialog: 'Dialog', section: 'Abschnitt' };
  const LANDMARK_ROLES = { main: 'Hauptbereich', navigation: 'Navigation', banner: 'Kopfbereich', contentinfo: 'Fußbereich', complementary: 'Seitenleiste', form: 'Formular', dialog: 'Dialog', alertdialog: 'Dialog', search: 'Suche', tabpanel: 'Tab-Inhalt', region: 'Bereich' };

  function landmarkLabel(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const n = el.ownerDocument.getElementById(by.split(/\s+/)[0]);
      if (n) return visibleText(n, 60);
    }
    const heading = el.querySelector('h1,h2,h3,legend,[role=heading]');
    if (heading) return visibleText(heading, 60);
    if (el.tagName === 'FORM') return el.getAttribute('name') || el.id || '';
    return '';
  }

  function nearestHeading(el) {
    const doc = el.ownerDocument;
    const walker = doc.createTreeWalker(doc.body || doc.documentElement, NodeFilter.SHOW_ELEMENT);
    walker.currentNode = el;
    for (let i = 0, n = el; n && i < 2000; i++, n = walker.previousNode()) {
      if (/^H[1-6]$/.test(n.tagName) || n.getAttribute?.('role') === 'heading') {
        const text = visibleText(n, 120);
        if (text) return { level: n.tagName.startsWith('H') ? +n.tagName[1] : +(n.getAttribute('aria-level') || 2), text };
      }
    }
    return null;
  }

  /** Outermost shadow host, so document-order lookups work for shadow content. */
  function lightDomAnchor(el) {
    let cur = el;
    for (let guard = 0; guard < 10; guard++) {
      const root = cur.getRootNode();
      if (!isShadowRoot(root)) break;
      cur = root.host;
    }
    return cur;
  }

  function locationContext(el) {
    const landmarks = [];
    for (let cur = el; cur && cur !== el.ownerDocument.body; cur = parentOf(cur)) {
      if (cur.nodeType !== 1) break;
      const role = cur.getAttribute('role');
      const kind = LANDMARK_ROLES[role] || LANDMARK_TAGS[cur.tagName.toLowerCase()];
      if (!kind) continue;
      if (cur.tagName === 'SECTION' && !cur.getAttribute('aria-label') && !cur.getAttribute('aria-labelledby')) continue;
      const label = landmarkLabel(cur);
      landmarks.unshift(label ? `${kind} „${label}“` : kind);
    }
    return { landmarks, heading: nearestHeading(lightDomAnchor(el)) };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  function shortLabel(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id && !looksGenerated(el.id) && secretFree(el.id) ? `#${el.id}` : '';
    const cls = Array.from(el.classList).filter(stableClass).slice(0, 2).map((c) => `.${c}`).join('');
    return `${tag}${id}${cls}`;
  }

  function describeElement(el) {
    const styles = computedStyles(el);
    const rect = rectOf(el);
    const { info: a11y, hints } = a11yInfo(el, styles);
    const contrast = contrastInfo(el);
    if (contrast && !contrast.passesAA) {
      hints.unshift(`Kontrast ${contrast.ratio}:1 (${contrast.foreground} auf ${contrast.background}) unterschreitet WCAG AA (${contrast.largeText ? '3' : '4,5'}:1).`);
    }
    const attributes = {};
    for (const name of ['type', 'name', 'role', 'href', 'src', 'alt', 'title', 'placeholder', 'aria-label', 'for', 'action', 'method', ...TEST_ATTRS]) {
      let v = el.getAttribute(name);
      if (v === null) continue;
      if (URL_ATTRS.includes(name)) v = maskUrl(v, masking);
      attributes[name] = clip(v, 200);
    }
    const root = el.getRootNode();
    return {
      tag: el.tagName.toLowerCase(),
      label: shortLabel(el),
      id: el.id ? (secretFree(el.id) ? el.id : '***') : undefined,
      classes: Array.from(el.classList).slice(0, 12),
      selector: deepSelector(el),
      xpath: xpathOf(el),
      inShadowDom: isShadowRoot(root),
      inIframe: el.ownerDocument !== document,
      text: visibleText(el),
      attributes,
      html: htmlSnippet(el),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      styles,
      contrast,
      a11y,
      hints,
      location: locationContext(el),
    };
  }

  function briefElement(el) {
    const brief = { selector: deepSelector(el), label: shortLabel(el), role: roleOf(el), text: visibleText(el, 80) };
    // Form fields have no visible text; their name/placeholder is what the code contains.
    for (const attr of ['name', 'placeholder', 'aria-label']) {
      const v = el.getAttribute?.(attr);
      if (v) brief[attr === 'aria-label' ? 'ariaLabel' : attr] = clip(v, 80);
    }
    return brief;
  }

  /** Summarises what lies inside a viewport rectangle (overlay must be hidden). */
  function describeRegion(rect) {
    const found = new Set();
    const cols = 6;
    const rows = 4;
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        const x = rect.x + ((i + 0.5) / cols) * rect.width;
        const y = rect.y + ((j + 0.5) / rows) * rect.height;
        const el = deepElementFromPoint(x, y);
        if (el && el !== document.documentElement && el !== document.body) found.add(el);
      }
    }
    const elements = Array.from(found);
    // lowest common ancestor = probably the component the region shows
    let common = elements[0] || null;
    const contains = (a, b) => {
      for (let cur = b; cur; cur = parentOf(cur)) if (cur === a) return true;
      return false;
    };
    for (const el of elements.slice(1)) {
      while (common && !contains(common, el)) common = parentOf(common);
    }
    let container = null;
    if (common && common !== document.body && common !== document.documentElement) {
      const r = rectOf(common);
      const ratio = (r.width * r.height) / Math.max(1, rect.width * rect.height);
      if (ratio < 6) container = { ...briefElement(common), html: htmlSnippet(common, 1800), location: locationContext(common) };
    }
    // Form fields and buttons inside the region count even if no sample point hit them.
    const centered = (el) => {
      const r = rectOf(el);
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      return r.width > 0 && r.height > 0 && cx >= rect.x && cx <= rect.x + rect.width && cy >= rect.y && cy <= rect.y + rect.height;
    };
    const controls = common?.querySelectorAll ? Array.from(common.querySelectorAll(INTERACTIVE)).slice(0, 400).filter(centered) : [];
    const meaningful = [...controls, ...elements.map((el) => el.closest?.(INTERACTIVE) || el)]
      .filter((el, i, arr) => arr.indexOf(el) === i)
      .slice(0, 15)
      .map(briefElement)
      .filter((b) => b.text || b.role);
    return { container, elements: meaningful };
  }

  const SENSITIVE_EXACT = /^(?:.*[_-])?(token|secret|password|passwd|pwd|pass|auth|authorization|session|sessionid|sid|sessid|phpsessid|jsessionid|aspsessionid|code|signature|sig|jwt|bearer|credentials?|apikey|key|otp|ticket|nonce|email|mail|iban)$/i;
  const SENSITIVE_SUFFIX = /(token|secret|password|apikey|signature|credential)s?$/i;
  const isSensitiveParam = (key) => SENSITIVE_EXACT.test(key) || SENSITIVE_SUFFIX.test(key);
  const SENSITIVE_ATTR = /token|secret|passw|pwd|api-?key|auth|session|csrf|xsrf|nonce|signature|credential|otp/i;
  const safeDecode = (text) => {
    try {
      return decodeURIComponent(text);
    } catch {
      return text;
    }
  };

  let masking = true;
  let stripQuery = false;
  const setMasking = (enabled, strip = false) => {
    masking = enabled !== false;
    stripQuery = strip === true;
  };

  /** Without query parameters at all – also those of hash routes (#/x?…). */
  function withoutQuery(url) {
    try {
      const u = new URL(url, location.href);
      if (!u.search && !/[?&;=]/.test(u.hash)) return url;
      u.search = '';
      u.hash = u.hash.replace(/[?&;].*$/, '').replace(/=.*$/, '');
      return u.href;
    } catch {
      return url;
    }
  }

  function maskUrl(url, enabled = true, nested = false) {
    if (!url || typeof url !== 'string') return url;
    // inline data (SVG icons, images) is noise – and can be huge
    if (/^\s*data:/i.test(url)) return `${url.trim().slice(0, Math.min(60, url.indexOf(',') + 1 || 60))}…`;
    if (url.length > 4000) url = url.slice(0, 4000);
    if (stripQuery) url = withoutQuery(url);
    if (!enabled) return url;
    try {
      const u = new URL(url, location.href);
      let changed = false;
      if (u.username || u.password) {
        // https://user:password@host/
        u.username = u.username && '***';
        u.password = u.password && '***';
        changed = true;
      }
      for (const key of new Set(u.searchParams.keys())) {
        const value = u.searchParams.get(key);
        if (isSensitiveParam(key)) {
          u.searchParams.set(key, '***');
          changed = true;
        } else if (!nested && /^https?:\/\//i.test(value)) {
          // an address inside the address: ?redirect=https%3A%2F%2F…%3Ftoken%3D…
          const inner = maskUrl(value, true, true);
          if (inner !== value) {
            u.searchParams.set(key, inner);
            changed = true;
          }
        }
      }
      // path parameters: /shop;jsessionid=…
      const path = u.pathname.replace(/;([^;=/]+)=([^;/]*)/g, (m, key) => (isSensitiveParam(safeDecode(key)) ? `;${key}=***` : m));
      if (path !== u.pathname) {
        u.pathname = path;
        changed = true;
      }
      // Fragments carry tokens too (OAuth/OIDC implicit flow, hash routers: #/x?token=…).
      const hash = u.hash.replace(/([#?&;])([^=&#?;]+)=([^&#;]*)/g, (m, sep, key) => {
        if (!isSensitiveParam(safeDecode(key))) return m;
        changed = true;
        return `${sep}${key}=***`;
      });
      if (changed) u.hash = hash;
      // tokens and e-mail addresses in the path: /reset/eyJ…, /users/max@firma.de
      return globalThis.FL_SAN.redact(changed ? u.href.replace(/%2A%2A%2A/g, '***') : url, { marker: '***' });
    } catch {
      return url;
    }
  }

  const MESSAGE_SELECTOR = [
    '[role="alert"]', '[role="alertdialog"]', '[role="status"]', '[aria-live="assertive"]', '[aria-live="polite"]',
    '.error', '.errors', '.error-message', '.error-box', '.alert', '.invalid-feedback', '.field-error', '.form-error', '.notification', '.toast', '.snackbar',
  ].join(', ');

  /** Visible status and error messages (validation errors, toasts, alerts): verbatim texts the developer can grep for. */
  function visibleMessages(max = 5) {
    const out = [];
    for (const el of document.querySelectorAll(MESSAGE_SELECTOR)) {
      if (out.length >= max) break;
      if (el.querySelector(MESSAGE_SELECTOR)) continue; // report the innermost message only
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      const text = visibleText(el, 200);
      if (text.length >= 3 && !out.includes(text)) out.push(text);
    }
    return out;
  }

  /** Version/build/commit the app announces about itself, if any. */
  function appVersion() {
    for (const name of ['version', 'app-version', 'application-version', 'build', 'build-id', 'build-version', 'release', 'commit', 'git-commit', 'git-sha', 'revision']) {
      const v = document.querySelector(`meta[name="${name}" i]`)?.getAttribute('content')?.trim();
      if (v) return clip(`${name}: ${v}`, 120);
    }
    const data = document.documentElement.dataset;
    for (const key of ['version', 'build', 'commit', 'release']) if (data?.[key]) return clip(`data-${key}: ${data[key]}`, 120);
    return undefined;
  }

  function pageInfo(maskEnabled) {
    const messages = visibleMessages();
    return {
      url: maskUrl(location.href, maskEnabled),
      path: maskUrl(location.href, maskEnabled).replace(location.origin, ''),
      origin: location.origin,
      title: document.title,
      h1: (() => {
        const h = document.querySelector('h1');
        return h ? visibleText(h, 150) : undefined;
      })(),
      lang: document.documentElement.lang || undefined,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      dpr: window.devicePixelRatio,
      scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
      documentSize: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
      userAgent: navigator.userAgent,
      language: navigator.language,
      colorScheme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      messages: messages.length ? messages : undefined,
      appVersion: appVersion(),
      // file names of bundles usually carry a build hash: identifies the tested build
      scripts: Array.from(document.scripts, (s) => s.src).filter(Boolean).slice(0, 8).map((u) => maskUrl(u, maskEnabled)),
    };
  }

  globalThis.FL_CTX = Object.freeze({
    deepElementFromPoint,
    parentOf,
    rectOf,
    deepSelector,
    querySelectorDeep,
    describeElement,
    describeRegion,
    briefElement,
    shortLabel,
    visibleText,
    accessibleName,
    roleOf,
    labelFor,
    maskUrl,
    setMasking,
    pageInfo,
    visibleMessages,
    INTERACTIVE,
  });
})();
