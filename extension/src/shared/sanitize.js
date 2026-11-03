// Normalises data that crosses a trust boundary: events from the tested page,
// annotations sent by content scripts and imported backup files. Unknown
// fields are dropped, strings are clipped and types are coerced, so later
// rendering code can rely on the shapes. Classic script (also imported as a
// side-effect module by the service worker): no top-level bindings.
globalThis.FL_SAN = globalThis.FL_SAN || (() => {
  const C = globalThis.FL_CONST;

  const str = (v, max) => {
    if (typeof v === 'number' || typeof v === 'boolean') v = String(v);
    if (typeof v !== 'string') return undefined;
    return v.length > max ? v.slice(0, max - 1) + '…' : v;
  };
  const num = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
    return undefined;
  };
  const bool = (v) => v === true;
  const iso = (v) => {
    if (typeof v !== 'string' && typeof v !== 'number') return undefined;
    const t = typeof v === 'number' ? v : Date.parse(v);
    return Number.isNaN(t) || t < 0 || t > 8.64e15 ? undefined : new Date(t).toISOString();
  };
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
  const arr = (v) => (Array.isArray(v) ? v : []);
  const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
  const clean = (o) => {
    for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
    return o;
  };
  const strList = (v, n, max) => arr(v).slice(0, n).map((x) => str(x, max)).filter((x) => x !== undefined);
  const strMap = (v, n, max) => {
    const o = obj(v);
    if (!o) return undefined;
    const out = {};
    for (const k of Object.keys(o).slice(0, n)) {
      const s = str(o[k], max);
      if (s !== undefined) out[String(k).slice(0, 60)] = s;
    }
    return out;
  };
  const rect = (v) => {
    const o = obj(v);
    if (!o) return undefined;
    const r = { x: num(o.x), y: num(o.y), width: num(o.width), height: num(o.height) };
    return Object.values(r).every((x) => x !== undefined) ? r : undefined;
  };

  const TECH_TYPES = ['console', 'error', 'rejection', 'resource', 'network', 'slow'];

  function techEvent(ev) {
    const o = obj(ev);
    if (!o || !TECH_TYPES.includes(o.type)) return null;
    return clean({
      type: o.type,
      level: str(o.level, 10),
      message: str(o.message, 1500),
      head: str(o.head, 300),
      source: str(o.source, 400),
      stack: str(o.stack, 2000),
      method: str(o.method, 12),
      requestUrl: str(o.requestUrl, 800),
      status: num(o.status),
      statusText: str(o.statusText, 200),
      body: str(o.body, 400),
      requestId: str(o.requestId, 200),
      ms: num(o.ms),
      tag: str(o.tag, 20),
      t: iso(o.t) || new Date().toISOString(),
      url: str(o.url, 800),
      seq: num(o.seq),
      delivered: o.delivered === true ? true : undefined,
    });
  }

  function component(c) {
    const o = obj(c);
    const framework = o && str(o.framework, 40);
    if (!framework) return undefined;
    return clean({ framework, components: strList(o.components, 8, 80), source: str(o.source, 300), minified: o.minified === true || undefined });
  }

  const PERF_KEYS = ['ttfb', 'domContentLoaded', 'load', 'lcp', 'cls', 'longTasks', 'longTaskMs', 'slowestInteraction', 'resources', 'transferKB', 'sinceLoadMs'];
  function perf(p) {
    const o = obj(p);
    if (!o) return undefined;
    const out = {};
    for (const k of PERF_KEYS) {
      const n = num(o[k]);
      if (n !== undefined) out[k] = n;
    }
    return out;
  }

  function probe(msg) {
    const o = obj(msg) || {};
    return { component: component(o.component), perf: perf(o.perf), stack: strList(o.stack, 10, 40) };
  }

  function location(l) {
    const o = obj(l);
    if (!o) return undefined;
    const h = obj(o.heading);
    const text = h && str(h.text, 200);
    return clean({ landmarks: strList(o.landmarks, 8, 160), heading: text ? { level: num(h.level) || 2, text } : undefined });
  }

  function contrast(c) {
    const o = obj(c);
    if (!o || num(o.ratio) === undefined) return null;
    return clean({
      foreground: str(o.foreground, 20),
      background: str(o.background, 20),
      ratio: num(o.ratio),
      largeText: bool(o.largeText),
      passesAA: bool(o.passesAA),
      passesAAA: bool(o.passesAAA),
      uncertain: bool(o.uncertain),
      fontSize: str(o.fontSize, 20),
      measuredOn: str(o.measuredOn, 40),
    });
  }

  function a11y(a) {
    const o = obj(a);
    if (!o) return undefined;
    return clean({
      role: str(o.role, 40) || null,
      name: str(o.name, 200) || '',
      nameSource: str(o.nameSource, 60) || null,
      focusable: bool(o.focusable),
      tabIndex: num(o.tabIndex),
      disabled: bool(o.disabled),
      ariaAttributes: strMap(o.ariaAttributes, 20, 120),
    });
  }

  function element(e) {
    const o = obj(e);
    const selector = o && str(o.selector, 1000);
    if (!selector) return undefined;
    return clean({
      tag: str(o.tag, 40) || '',
      label: str(o.label, 200) || selector,
      id: str(o.id, 200),
      classes: strList(o.classes, 12, 100),
      selector,
      xpath: str(o.xpath, 1000),
      inShadowDom: bool(o.inShadowDom),
      inIframe: bool(o.inIframe),
      text: str(o.text, 500) || '',
      attributes: strMap(o.attributes, 30, 300) || {},
      html: str(o.html, 4000) || '',
      rect: rect(o.rect),
      styles: strMap(o.styles, 40, 200) || {},
      contrast: contrast(o.contrast),
      a11y: a11y(o.a11y),
      hints: strList(o.hints, 12, 300),
      location: location(o.location),
    });
  }

  function brief(x) {
    const o = obj(x);
    if (!o) return null;
    return clean({
      selector: str(o.selector, 1000) || '',
      label: str(o.label, 200) || '',
      role: str(o.role, 40) || null,
      text: str(o.text, 200) || '',
      name: str(o.name, 80),
      placeholder: str(o.placeholder, 80),
      ariaLabel: str(o.ariaLabel, 80),
    });
  }

  function region(r) {
    const o = obj(r);
    if (!o) return undefined;
    const c = obj(o.container);
    const container = c && str(c.selector, 1000) ? clean({ ...brief(c), html: str(c.html, 4000), location: location(c.location) }) : null;
    return clean({ rect: rect(o.rect), container, elements: arr(o.elements).slice(0, 20).map(brief).filter(Boolean) });
  }

  function page(p) {
    const o = obj(p) || {};
    const vp = obj(o.viewport) || {};
    const sc = obj(o.scroll) || {};
    const ds = obj(o.documentSize) || {};
    const messages = strList(o.messages, 5, 300);
    const scripts = strList(o.scripts, 8, 500);
    return clean({
      url: str(o.url, 2000) || '',
      path: str(o.path, 2000),
      origin: str(o.origin, 300),
      title: str(o.title, 300) || '',
      h1: str(o.h1, 300),
      lang: str(o.lang, 20),
      viewport: { width: num(vp.width) || 0, height: num(vp.height) || 0 },
      dpr: num(o.dpr) || 1,
      scroll: { x: num(sc.x) || 0, y: num(sc.y) || 0 },
      documentSize: { width: num(ds.width) || 0, height: num(ds.height) || 0 },
      userAgent: str(o.userAgent, 400) || '',
      language: str(o.language, 20) || '',
      colorScheme: oneOf(o.colorScheme, ['dark', 'light'], 'light'),
      reducedMotion: bool(o.reducedMotion),
      messages: messages.length ? messages : undefined,
      appVersion: str(o.appVersion, 160),
      scripts: scripts.length ? scripts : undefined,
    });
  }

  function devResult(d) {
    const o = obj(d);
    const result = o && oneOf(o.result, C.DEV_RESULTS.map((r) => r.id), undefined);
    if (!result) return undefined;
    return clean({ result, done: bool(o.done), notes: strList(o.notes, 12, 600), importedAt: iso(o.importedAt) });
  }

  function retest(r) {
    const o = obj(r);
    const number = o && num(o.number);
    if (!Number.isInteger(number) || number < 1) return undefined;
    return { number, verdict: oneOf(o.verdict, C.VERDICTS.map((v) => v.id), 'open') };
  }

  /** One checkpoint of a test plan (template, snapshot or backup); position-based id c1, c2 … */
  function checkpoint(raw, i) {
    const o = obj(raw);
    const title = o && str(o.title, 200);
    if (!title) return null;
    const start = str(o.start, 2000) || '';
    return {
      id: typeof o.id === 'string' && /^c\d{1,4}$/.test(o.id) ? o.id : `c${i + 1}`,
      group: str(o.group, 120) || '',
      title,
      start: /^\/\S*$/.test(start) || /^https?:\/\/\S+$/i.test(start) ? start : '',
      expected: str(o.expected, 1000) || '',
      notes: strList(o.notes, 12, 300),
    };
  }

  /** Result of a checkpoint: ok (with screenshot), problem (linked annotations), skip (not testable). */
  function checkResult(raw) {
    const o = obj(raw);
    const status = o && oneOf(o.status, C.PLAN_STATUSES.map((x) => x.id), undefined);
    if (!status) return null;
    return clean({ status, t: iso(o.t) || new Date().toISOString(), note: str(o.note, 500), image: o.image === true || undefined, url: str(o.url, 2000) });
  }

  /** Test sections from a backup: closed, in order, within start and end of the session. */
  function runs(raw, from, to) {
    if (!Array.isArray(raw)) return undefined;
    const lo = Date.parse(from);
    const hi = Date.parse(to);
    const out = [];
    for (const r of raw.slice(-500)) {
      const a = Math.max(Date.parse(iso(obj(r)?.from) || ''), lo, out.length ? Date.parse(out[out.length - 1].to) : -Infinity);
      const b = Math.min(Date.parse(iso(obj(r)?.to) || '') || hi, hi);
      if (Number.isFinite(a) && Number.isFinite(b) && b >= a) out.push({ from: new Date(a).toISOString(), to: new Date(b).toISOString() });
    }
    return out.length ? out : undefined;
  }

  const AFTER_KINDS = ['network', 'slow', 'console', 'error', 'rejection', 'resource', 'message', 'route', 'page'];
  function afterItem(x) {
    const o = obj(x);
    if (!o || !AFTER_KINDS.includes(o.kind)) return null;
    return clean({ kind: o.kind, text: str(o.text, 400) || '', status: num(o.status), dt: num(o.dt) });
  }

  /** One earlier annotation as the re-test checks it (snapshot, so the plan survives the original). */
  function planItem(raw) {
    const o = obj(raw);
    const number = o && num(o.number);
    if (!Number.isInteger(number) || number < 1) return null;
    const b = obj(o.baseline) || {};
    const images = obj(o.images) || {};
    return clean({
      id: str(o.id, 80) || `p${number}`,
      number,
      kind: oneOf(o.kind, ['element', 'region', 'page'], 'page'),
      category: oneOf(o.category, C.CATEGORIES.map((c) => c.id), 'other'),
      priority: oneOf(o.priority, C.PRIORITIES.map((p) => p.id), 'medium'),
      status: oneOf(o.status, C.STATUSES.map((s) => s.id), 'open'),
      title: str(o.title, 300) || '',
      description: str(o.description, 10000) || '',
      expected: str(o.expected, 10000) || '',
      url: str(o.url, 2000) || '',
      pageTitle: str(o.pageTitle, 300),
      selector: str(o.selector, 1000),
      text: str(o.text, 200),
      tag: str(o.tag, 40),
      role: str(o.role, 40),
      steps: strList(o.steps, 20, 400),
      baseline: clean({
        contrast: contrast(b.contrast) || undefined,
        name: str(b.name, 200),
        hints: strList(b.hints, 12, 300),
        messages: strList(b.messages, 5, 300),
        interaction: str(b.interaction, 200),
        after: arr(b.after).slice(0, 12).map(afterItem).filter(Boolean),
      }),
      devResult: devResult(o.devResult),
      images: { crop: bool(images.crop), full: bool(images.full), redacted: bool(images.redacted) },
      createdAt: iso(o.createdAt),
    });
  }

  /** A click offered for numbering on the screenshot; n if it is drawn in. */
  function markedClick(c) {
    const o = obj(c);
    if (!o || num(o.x) === undefined || num(o.y) === undefined) return null;
    const n = num(o.n);
    return clean({ x: num(o.x), y: num(o.y), label: str(o.label, 120) || '', role: str(o.role, 40), selector: str(o.selector, 1000), t: iso(o.t), n: Number.isInteger(n) && n > 0 && n < 100 ? n : undefined, note: str(o.note, 300) || undefined });
  }

  /** A number set by hand on the screenshot, with the tester's note (older data: just the number). */
  function markedNumber(x) {
    const o = obj(x);
    const n = num(o ? o.n : x);
    return Number.isInteger(n) && n > 0 && n < 100 ? clean({ n, note: (o && str(o.note, 300)) || undefined }) : null;
  }

  /** A further screenshot of an annotation (the image itself is stored under its id). */
  function extraImage(x) {
    const o = obj(x);
    if (!o) return null;
    return clean({
      id: typeof o.id === 'string' && /^x\d{1,2}$/.test(o.id) ? o.id : undefined,
      caption: str(o.caption, 300) || '',
      url: str(o.url, 2000),
      kind: oneOf(o.kind, ['element', 'region', 'page', 'file'], 'page'),
      t: iso(o.t),
      drawn: bool(o.drawn) || undefined,
      redacted: bool(o.redacted) || undefined,
      clicks: arr(o.clicks).slice(0, 9).map(markedClick).filter(Boolean),
      numbers: arr(o.numbers).slice(0, 50).map(markedNumber).filter(Boolean),
    });
  }

  function annotation(raw) {
    const o = obj(raw) || {};
    const images = obj(o.images) || {};
    const anchor = obj(o.anchor);
    const now = new Date().toISOString();
    return clean({
      kind: oneOf(o.kind, ['element', 'region', 'page'], 'page'),
      category: oneOf(o.category, C.CATEGORIES.map((c) => c.id), 'other'),
      priority: oneOf(o.priority, C.PRIORITIES.map((p) => p.id), 'medium'),
      status: oneOf(o.status, C.STATUSES.map((s) => s.id), 'open'),
      title: str(o.title, 300) || '',
      description: str(o.description, 10000) || '',
      expected: str(o.expected, 10000) || '',
      page: page(o.page),
      element: element(o.element),
      region: region(o.region),
      component: component(o.component),
      performance: perf(o.performance),
      techStack: strList(o.techStack, 10, 40),
      techEvents: arr(o.techEvents).slice(0, 30).map(techEvent).filter(Boolean),
      anchor: anchor ? clean({ selector: str(anchor.selector, 1000), docRect: rect(anchor.docRect) }) : undefined,
      images: {
        cropRect: rect(images.cropRect) || null,
        markRect: rect(images.markRect) || null,
        drawn: bool(images.drawn),
        redacted: bool(images.redacted),
        clicks: arr(images.clicks).slice(0, 9).map(markedClick).filter(Boolean),
        numbers: arr(images.numbers).slice(0, 50).map(markedNumber).filter(Boolean),
        crop: false,
        full: false,
        extra: arr(images.extra).slice(0, C.LIMITS.extraImages || 7).map(extraImage).filter(Boolean),
      },
      retest: retest(o.retest),
      planItem: str(o.planItem, 40),
      devResult: devResult(o.devResult),
      createdAt: iso(o.createdAt) || now,
      updatedAt: iso(o.updatedAt) || iso(o.createdAt) || now,
    });
  }

  const TRAIL_TYPES = ['page', 'route', 'click', 'input', 'submit', 'message', 'annotation'];
  function trailEntry(e) {
    const o = obj(e);
    const t = o && iso(o.t);
    if (!t || !TRAIL_TYPES.includes(o.type)) return null;
    return clean({
      t,
      type: o.type,
      url: str(o.url, 2000),
      title: str(o.title, 300),
      label: str(o.label, 300),
      role: str(o.role, 40),
      selector: str(o.selector, 1000),
      detail: str(o.detail, 200),
      number: num(o.number),
    });
  }

  // --- secrets and personal data in texts taken from the page ----------------
  // Applied to everything captured from the tested page (element text and HTML,
  // messages, console output, error responses, click trail) – not to what the
  // tester types. Recognisers err on the side of removing.

  const luhn = (digits) => {
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
      sum += d;
    }
    return sum % 10 === 0;
  };
  const validIban = (raw) => {
    const s = raw.replace(/ /g, '');
    if (s.length < 15 || s.length > 34) return false;
    let rest = 0;
    for (const ch of s.slice(4) + s.slice(0, 4)) {
      const v = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
      for (const d of v) rest = (rest * 10 + Number(d)) % 97;
    }
    return rest === 1;
  };
  /** Mixed-case letters and digits in a long run – an access token, not a word or hash. */
  const opaque = (s) => {
    if (!/[a-z].*[a-z]/.test(s) || !/[A-Z].*[A-Z]/.test(s) || !/\d.*\d/.test(s) || /--|__/.test(s)) return false;
    let changes = 0;
    for (let i = 1; i < s.length; i++) if (/\d/.test(s[i]) !== /\d/.test(s[i - 1]) && /[A-Za-z\d]/.test(s[i]) && /[A-Za-z\d]/.test(s[i - 1])) changes++;
    return changes >= 3;
  };

  // key names whose value is secret: password, api_key, accessToken, X-Auth-Token, sessionid, csrftoken …
  const SECRET_WORDS = new Set(['password', 'passwort', 'passwd', 'pwd', 'pass', 'kennwort', 'secret', 'token', 'apikey', 'auth', 'authorization', 'sid', 'sessid', 'sessionid', 'session', 'phpsessid', 'jsessionid', 'aspsessionid', 'csrf', 'xsrf', 'cookie', 'credential', 'credentials', 'otp', 'pin', 'tan', 'cvc', 'cvv', 'privatekey', 'accesskey', 'clientsecret', 'signature']);
  // … unless the key names something about it: tokenExpiry, sessionTimeout, AuthContext.Provider, passwordHint
  const NOT_SECRET_TAIL = new Set(['expiry', 'expires', 'expiration', 'exp', 'expired', 'timeout', 'ttl', 'lifetime', 'age', 'length', 'len', 'count', 'size', 'type', 'kind', 'name', 'label', 'title', 'hint', 'placeholder', 'field', 'url', 'uri', 'endpoint', 'path', 'route', 'required', 'valid', 'invalid', 'error', 'errors', 'message', 'status', 'enabled', 'disabled', 'visible', 'policy', 'strength', 'rules', 'min', 'max', 'at', 'date', 'time', 'version', 'provider', 'context', 'consumer', 'format', 'mode', 'header', 'store', 'storage', 'service', 'manager', 'handler', 'guard', 'hook', 'module', 'component', 'button', 'input', 'form', 'page', 'view', 'modal', 'dialog', 'link', 'icon', 'reset', 'forgot', 'changed', 'id']);
  const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|css|s[ac]ss|less|html?|php|py|rb|java|kt|go|cs|swift|dart|rs)$/i;
  const ONLY_DIGITS_SECRET = /^(?:pin|otp|tan|cvc|cvv|passw|pwd|kennwort|secret|code)/;
  function secretKey(key) {
    if (SOURCE_FILE.test(key)) return null; // useAuth.ts:12:5 is a stack frame
    const parts = key.replace(/([a-z\d])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z\d]+/).filter(Boolean);
    if (!parts.length || parts.length > 6) return null;
    const last = parts[parts.length - 1];
    // "sessionId" is the session; "userId", "tokenExpiry" are not secrets
    if (NOT_SECRET_TAIL.has(last) && !(last === 'id' && /^(session|sess)$/.test(parts[parts.length - 2] || ''))) return null;
    return parts.find((w, i) => SECRET_WORDS.has(w) || SECRET_WORDS.has(w + (parts[i + 1] || '')) || /(token|secret|password)$/.test(w)) || null;
  }
  const HARMLESS_VALUE = /^(?:\*+|true|false|null|undefined|none|nil|required|optional|invalid|missing|expired|empty|bearer|basic|\[.*)$/i;
  const keyValue = (stop) => new RegExp(`([A-Za-z][\\w.-]{0,40})(["']?)(\\s*[:=]\\s*)(?!//)("(?:[^"\\\\]|\\\\.){0,500}"|'(?:[^'\\\\]|\\\\.){0,500}'|[^\\s"',;&}\\]<>)${stop}]{1,500})`, 'g');
  const KEY_VALUE = keyValue('');
  const KEY_VALUE_URL = keyValue('?#/'); // inside an address the value ends at the next part of it
  const CARD_CONTEXT = /(karte|card|kredit|credit|visa|master|amex|maestro|zahlung|payment|\bpan\b|cc[-_ ]?(?:num|no))/i;
  const FILE_TLD = /^(png|jpe?g|gif|svg|webp|avif|ico|js|mjs|cjs|css|map|json|woff2?|ttf|html?)$/i;

  /**
   * Removes secrets and personal data from a captured text. With `marker`
   * (e.g. '***' inside URLs) every finding is replaced by that marker.
   */
  function redact(text, { marker } = {}) {
    if (typeof text !== 'string' || text.length < 3) return text;
    const say = (what) => marker || `[${what} entfernt]`;
    let s = text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, say('privater Schlüssel'));
    // password=…, "apiKey": "…", {token: …}, X-Api-Key: …
    s = s.replace(marker ? KEY_VALUE_URL : KEY_VALUE, (m, key, quote, sep, value, offset, whole) => {
      const word = secretKey(key);
      if (!word) return m;
      const inner = /^["']/.test(value) ? value.slice(1, -1) : value;
      if (inner.length < 3 || HARMLESS_VALUE.test(inner) || /^\d+(?::\d+)+$/.test(inner)) return m;
      if (/^\d+$/.test(inner) && !ONLY_DIGITS_SECRET.test(word)) return m; // "sessionCount": 3600
      // free text ("Passwort: zu kurz", "Token: läuft ab") only counts if the value looks like a secret
      const structured = sep.includes('=') || /^["']/.test(value) || /[{,[;&?"']\s*$/.test(whole.slice(Math.max(0, offset - 2), offset));
      if (!structured && !/[\d_]|[^\p{L}\s]/u.test(inner)) return m;
      const masked = marker || '***';
      return `${key}${quote}${sep}${/^["']/.test(value) ? value[0] + masked + value[0] : masked}`;
    });
    s = s
      .replace(/\b(Bearer|Basic|Token)(\s+)([\w.~+/=-]{8,})/g, (m, kind, space, v) => (/[\d.~+/=-]/.test(v) || v.length >= 20 ? `${kind}${space}${marker || '[entfernt]'}` : m))
      .replace(/(?<![\w-])eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g, say('Token'))
      .replace(/\b(?:(?:sk|pk|rk)_(?:live|test)_[A-Za-z\d]{8,}|sk-[\w-]{20,}|(?:AKIA|ASIA)[A-Z\d]{16}|gh[pousr]_[A-Za-z\d]{30,}|github_pat_\w{30,}|xox[abposr]-[A-Za-z\d-]{10,}|AIza[\w-]{35}|glpat-[\w-]{20,})/g, say('Schlüssel'))
      .replace(/\b[A-Z]{2}\d{2}(?: ?[A-Z\d]{4}){2,7}(?: ?[A-Z\d]{1,3})?\b/g, (m) => (validIban(m) ? say('IBAN') : m))
      .replace(/(?<![\d.,-])[2-6]\d(?:[ -]?\d){11,17}(?![\d,.-]?\d)/g, (m, offset, whole) => {
        const digits = m.replace(/\D/g, '');
        if (digits.length < 13 || digits.length > 19 || !luhn(digits)) return m;
        // written like a card number, or said to be one – not just any long number (EAN, order number)
        const looksLikeCard = /^\d{4}([ -])\d{4}\1\d{4}\1\d{1,7}$|^\d{4}([ -])\d{6}\2\d{4,5}$/.test(m);
        return looksLikeCard || CARD_CONTEXT.test(whole.slice(Math.max(0, offset - 40), offset)) ? say('Kartennummer') : m;
      })
      .replace(/(?<![\w.%+-])[\w.%+-]{1,64}@[A-Za-z\d-]{1,63}(?:\.[A-Za-z\d-]{1,63}){0,8}\.([A-Za-z]{2,24})\b/g, (m, tld) => (FILE_TLD.test(tld) ? m : say('E-Mail')))
      .replace(/(?<![\w+=-])[\w+-]{32,}={0,2}(?![\w+=-])/g, (m) => (opaque(m) ? say('Token') : m)); // not across "/": file paths
    return s;
  }

  // fields that hold structure (selectors, geometry, styles) or URLs masked on their own
  const STRUCTURE = new Set(['selector', 'xpath', 'styles', 'rect', 'url', 'path', 'origin', 'requestUrl', 'userAgent', 'scripts', 'id', 'classes', 'tag', 'label', 'role', 'framework', 'components', 'source', 'contrast', 'viewport', 'scroll', 'documentSize']);
  function redactDeep(value, keep = STRUCTURE) {
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map((v) => redactDeep(v, keep));
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = keep.has(k) ? v : redactDeep(v, keep);
    return out;
  }

  const IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
  const isImage = (v) => typeof v === 'string' && v.length < 30e6 && IMAGE.test(v);

  return Object.freeze({ str, num, iso, clean, techEvent, probe, annotation, extraImage, trailEntry, isImage, page, planItem, devResult, redact, redactDeep, checkpoint, checkResult, runs });
})();
