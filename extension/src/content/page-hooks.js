// Runs in the page's MAIN world from document_start on the origins under test.
// Records console errors, failed/slow requests, route changes and performance
// metrics, and answers "which component rendered this element?" probes.
// Talks to the isolated overlay script only through JSON strings in
// CustomEvents, so no object references cross the world boundary.
// When the test run ends the overlay says "bye": every wrapper becomes a plain
// pass-through, the originals are put back and all listeners are removed.
(() => {
  const FLAG = Symbol.for('feedback-lens.hooks');
  if (window[FLAG]) return;
  Object.defineProperty(window, FLAG, { value: true, configurable: true });

  // The name this script gets via the sourceURL line at the end. Without it, every
  // console.error/warn of the page – passed on by our wrapper – and every
  // unhandled rejection of a wrapped fetch would be listed by Chrome as an error
  // of the extension (chrome://extensions → „Fehler“), with this file as source.
  const SOURCE_NAME = 'feedback-lens/page-hooks.js';
  const TO_EXT = '__fl_from_page';
  const FROM_EXT = '__fl_to_page';
  const PROBE = '__fl_probe';
  const SLOW_MS = 3000;
  const RING = 60;

  const ring = []; // recent events, replayed to a (re)connecting overlay
  let seq = 0;
  let connected = false;
  let stopped = false;

  const ac = new AbortController();
  const on = (target, type, fn, capture = false) => target.addEventListener(type, fn, { capture, signal: ac.signal });
  const restore = []; // puts the original functions back
  const observers = [];
  /** Replaces obj[key]; on stop the original returns – unless the page wrapped it again meanwhile. */
  function wrap(obj, key, make) {
    const original = obj[key];
    if (typeof original !== 'function') return;
    const wrapper = make(original);
    obj[key] = wrapper;
    restore.push(() => {
      if (obj[key] === wrapper) obj[key] = original;
    });
  }

  const send = (msg) => {
    if (stopped) return;
    try {
      document.dispatchEvent(new CustomEvent(TO_EXT, { detail: JSON.stringify(msg) }));
    } catch {
      /* ignore */
    }
  };

  let inHook = false; // guards against getters that log while being described

  function emit(event) {
    if (stopped) return;
    event.seq = event.seq || ++seq;
    event.t = event.t || new Date().toISOString();
    event.url = location.href;
    event.delivered = connected;
    ring.push(event);
    if (ring.length > RING) ring.shift();
    if (connected) send({ kind: 'tech', event });
  }

  // --- serialisation ------------------------------------------------------

  function describe(value, depth = 0, seen = new WeakSet()) {
    if (value === null || value === undefined) return String(value);
    const type = typeof value;
    if (type === 'string') return value;
    if (type === 'number' || type === 'boolean' || type === 'bigint') return String(value);
    if (type === 'function') return `[Funktion ${value.name || 'anonym'}]`;
    if (type === 'symbol') return value.toString();
    if (value instanceof Error) return `${value.name}: ${value.message}${value.stack ? '\n' + shortStack(value.stack) : ''}`;
    if (typeof Element !== 'undefined' && value instanceof Element) {
      const id = value.id ? `#${value.id}` : '';
      const cls = typeof value.className === 'string' && value.className.trim() ? '.' + value.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
      return `<${value.tagName.toLowerCase()}${id}${cls}>`;
    }
    if (seen.has(value)) return '[zirkulär]';
    if (depth > 2) return Array.isArray(value) ? `[Array(${value.length})]` : '{…}';
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        return `[${value.slice(0, 10).map((v) => describe(v, depth + 1, seen)).join(', ')}${value.length > 10 ? ', …' : ''}]`;
      }
      // Only plain data properties: reading getters could run page code.
      const keys = Object.keys(value);
      const parts = [];
      for (const k of keys.slice(0, 12)) {
        const d = Object.getOwnPropertyDescriptor(value, k);
        parts.push(`${k}: ${d && 'value' in d ? describe(d.value, depth + 1, seen) : '[Getter]'}`);
      }
      return `{${parts.join(', ')}${keys.length > 12 ? ', …' : ''}}`;
    } catch {
      return '[Objekt]';
    }
  }

  // our own wrapper frames say nothing about the application – leave them out
  function shortStack(stack) {
    return String(stack).split('\n').filter((line) => !line.includes(SOURCE_NAME)).slice(0, 6).join('\n');
  }

  const clip = (s, max = 800) => (s.length > max ? s.slice(0, max) + '…' : s);

  function absUrl(url) {
    try {
      return new URL(url, location.href).href;
    } catch {
      return String(url);
    }
  }

  // --- console & errors ---------------------------------------------------

  for (const level of ['error', 'warn']) {
    wrap(console, level, (original) => function (...args) {
      if (!inHook && !stopped) {
        inHook = true;
        try {
          // head: the literal text the app logged, without serialised arguments (greppable in the source)
          const head = typeof args[0] === 'string' ? clip(args[0].replace(/%[sdifoOc]/g, '').replace(/\s+/g, ' ').trim(), 200) : undefined;
          emit({ type: 'console', level, message: clip(args.map((a) => describe(a)).join(' ')), head: head || undefined });
        } catch {
          /* never break the page */
        } finally {
          inHook = false;
        }
      }
      return original.apply(this, args);
    });
  }

  on(
    window,
    'error',
    (e) => {
      const target = e.target;
      if (target && target !== window && target.tagName) {
        const url = target.currentSrc || target.src || target.href;
        if (url) emit({ type: 'resource', tag: target.tagName.toLowerCase(), message: `Ressource konnte nicht geladen werden: ${url}`, requestUrl: absUrl(url) });
        return;
      }
      emit({
        type: 'error',
        message: clip(String(e.message || 'Unbekannter Fehler')),
        source: e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined,
        stack: e.error?.stack ? clip(shortStack(e.error.stack), 1200) : undefined,
      });
    },
    true,
  );

  on(window, 'unhandledrejection', (e) => {
    const reason = e.reason;
    emit({
      type: 'rejection',
      message: clip(reason instanceof Error ? `${reason.name}: ${reason.message}` : describe(reason)),
      stack: reason?.stack ? clip(shortStack(reason.stack), 1200) : undefined,
    });
  });

  // --- network --------------------------------------------------------------

  const ID_HEADERS = ['x-request-id', 'x-correlation-id', 'request-id', 'x-trace-id', 'traceparent', 'x-amzn-requestid', 'cf-ray'];
  const requestIdOf = (get) => {
    for (const name of ID_HEADERS) {
      try {
        const v = get(name);
        if (v) return clip(`${name}: ${v}`, 160);
      } catch {
        /* header not exposed */
      }
    }
    return undefined;
  };
  /** Start of an error response, e.g. {"error":"…"} or the text of an HTML error page. */
  function bodyExcerpt(text, type) {
    let s = String(text || '');
    if (/html/i.test(type || '') || /^\s*</.test(s)) s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    return s ? clip(s, 300) : undefined;
  }
  const readable = (type) => !type || /json|text|xml|html|problem/i.test(type);

  wrap(window, 'fetch', (originalFetch) => function (input, init) {
    if (stopped) return originalFetch.apply(this, arguments);
    const started = performance.now();
    let method = 'GET';
    let url = '';
    try {
      method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
      url = absUrl(typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url);
    } catch {
      /* ignore */
    }
    return originalFetch.apply(this, arguments).then(
      (response) => {
        const ms = Math.round(performance.now() - started);
        if (!response.ok && response.type !== 'opaque') {
          // seq/t now: the body is read asynchronously, but the response came before what the app logs about it
          const event = { type: 'network', method, requestUrl: url, status: response.status, statusText: response.statusText, ms, t: new Date().toISOString(), seq: ++seq };
          event.requestId = requestIdOf((n) => response.headers.get(n));
          const type = response.headers.get('content-type');
          const size = Number(response.headers.get('content-length') || 0);
          if (!readable(type) || size > 200_000) emit(event);
          else {
            // A clone leaves the app's own body stream untouched.
            let reader;
            try {
              reader = response.clone().text();
            } catch {
              reader = Promise.resolve('');
            }
            Promise.race([reader, new Promise((r) => setTimeout(() => r(''), 1500))])
              .catch(() => '')
              .then((text) => emit({ ...event, body: bodyExcerpt(String(text).slice(0, 20_000), type) }));
          }
        } else if (ms > SLOW_MS) {
          emit({ type: 'slow', method, requestUrl: url, status: response.status, ms });
        }
        return response;
      },
      (error) => {
        if (error?.name !== 'AbortError') {
          emit({ type: 'network', method, requestUrl: url, status: 0, statusText: clip(String(error?.message || error), 200), ms: Math.round(performance.now() - started) });
        }
        throw error;
      },
    );
  });

  const xhrInfo = new WeakMap();
  wrap(XMLHttpRequest.prototype, 'open', (xhrOpen) => function (method, url) {
    try {
      if (!stopped) xhrInfo.set(this, { method: String(method).toUpperCase(), url: absUrl(url) });
    } catch {
      /* ignore */
    }
    return xhrOpen.apply(this, arguments);
  });
  wrap(XMLHttpRequest.prototype, 'send', (xhrSend) => function () {
    const info = stopped ? null : xhrInfo.get(this);
    if (info) {
      const started = performance.now();
      let aborted = false;
      info.timedOut = false;
      // per request: an XHR object reused for polling must not fire old handlers again
      const done = new AbortController();
      const once = { signal: done.signal };
      this.addEventListener('abort', () => (aborted = true), once);
      this.addEventListener('timeout', () => (info.timedOut = true), once);
      // Read the result as soon as it is there: an app that re-opens the XHR in its own
      // load/loadend handler (polling) has reset status and body by the time loadend reaches us.
      let result = null;
      const read = () => {
        const r = { status: this.status, statusText: this.statusText };
        if (r.status >= 400) {
          r.requestId = requestIdOf((n) => this.getResponseHeader(n));
          try {
            const type = this.getResponseHeader('content-type');
            if ((this.responseType === '' || this.responseType === 'text') && readable(type)) r.body = bodyExcerpt(String(this.responseText).slice(0, 20_000), type);
          } catch {
            /* body not readable */
          }
        }
        return r;
      };
      this.addEventListener('readystatechange', () => {
        if (this.readyState === 4 && !result) result = read();
      }, once);
      this.addEventListener('loadend', () => {
        done.abort();
        const ms = Math.round(performance.now() - started);
        if (aborted) return; // cancelled on purpose, like fetch's AbortError
        const r = result || read();
        if (info.timedOut) {
          emit({ type: 'network', method: info.method, requestUrl: info.url, status: 0, statusText: 'Zeitüberschreitung', ms });
        } else if (r.status === 0 || r.status >= 400) {
          emit({ type: 'network', method: info.method, requestUrl: info.url, status: r.status, statusText: r.statusText || (r.status === 0 ? 'Netzwerkfehler / abgebrochen' : ''), ms, requestId: r.requestId, body: r.body });
        } else if (ms > SLOW_MS) {
          emit({ type: 'slow', method: info.method, requestUrl: info.url, status: r.status, ms });
        }
      }, once);
    }
    return xhrSend.apply(this, arguments);
  });

  // --- keep page focus traps away from the Feedback Lens UI ----------------
  // Modal libraries pull focus back when it "leaves" their dialog. Moving into
  // our drawer is not leaving the app, so hide those focus events from the page.
  // (Registered on window in the capture phase, i.e. before document listeners.)
  const isOverlay = (node) => node && node.nodeType === 1 && node.localName === 'feedback-lens-ui';
  for (const type of ['focusin', 'focusout']) {
    on(window, type, (e) => {
      if (isOverlay(e.target) || isOverlay(e.relatedTarget)) e.stopImmediatePropagation();
    }, true);
  }

  // --- routing (SPA navigation) -------------------------------------------

  let lastUrl = location.href;
  function routeChanged() {
    if (stopped || location.href === lastUrl) return;
    lastUrl = location.href;
    send({ kind: 'route', url: location.href });
  }
  for (const fn of ['pushState', 'replaceState']) {
    wrap(history, fn, (original) => function () {
      const result = original.apply(this, arguments);
      try {
        routeChanged();
      } catch {
        /* ignore */
      }
      return result;
    });
  }
  on(window, 'popstate', routeChanged);
  on(window, 'hashchange', routeChanged);

  // --- performance ------------------------------------------------------------

  const perf = { lcp: null, cls: 0, longTaskCount: 0, longTaskTotal: 0, slowestInteraction: 0 };
  const observe = (type, cb, extra = {}) => {
    try {
      const observer = new PerformanceObserver((list) => list.getEntries().forEach(cb));
      observer.observe({ type, buffered: true, ...extra });
      observers.push(observer);
    } catch {
      /* unsupported entry type */
    }
  };
  observe('largest-contentful-paint', (e) => (perf.lcp = Math.round(e.startTime)));
  observe('layout-shift', (e) => {
    if (!e.hadRecentInput) perf.cls += e.value;
  });
  observe('longtask', (e) => {
    perf.longTaskCount += 1;
    perf.longTaskTotal += e.duration;
  });
  observe('event', (e) => (perf.slowestInteraction = Math.max(perf.slowestInteraction, Math.round(e.duration))), { durationThreshold: 40 });

  function perfSnapshot() {
    const nav = performance.getEntriesByType('navigation')[0];
    const resources = performance.getEntriesByType('resource');
    const transfer = resources.reduce((sum, r) => sum + (r.transferSize || 0), 0);
    return {
      ttfb: nav ? Math.round(nav.responseStart) : null,
      domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
      load: nav && nav.loadEventEnd ? Math.round(nav.loadEventEnd) : null,
      lcp: perf.lcp,
      cls: Math.round(perf.cls * 1000) / 1000,
      longTasks: perf.longTaskCount,
      longTaskMs: Math.round(perf.longTaskTotal),
      slowestInteraction: perf.slowestInteraction || null,
      resources: resources.length,
      transferKB: Math.round(transfer / 1024),
      sinceLoadMs: Math.round(performance.now()),
    };
  }

  function stackHints() {
    const hints = [];
    try {
      if (window.__NEXT_DATA__ || document.getElementById('__next')) hints.push('Next.js');
      if (window.__NUXT__ || document.getElementById('__nuxt')) hints.push('Nuxt');
      if (document.querySelector('[ng-version]')) hints.push(`Angular ${document.querySelector('[ng-version]').getAttribute('ng-version')}`);
      if (window.React || document.querySelector('[data-reactroot]')) hints.push('React');
      if (window.Vue || document.querySelector('[data-v-app]')) hints.push('Vue');
      if (window.jQuery) hints.push(`jQuery ${window.jQuery.fn?.jquery || ''}`.trim());
      if (document.querySelector('[class*="svelte-"]')) hints.push('Svelte');
      if (window.Shopify) hints.push('Shopify');
      if (window.wp || document.querySelector('link[href*="wp-content"]')) hints.push('WordPress');
    } catch {
      /* ignore */
    }
    return hints;
  }

  // --- component lookup ---------------------------------------------------

  const usefulName = (name) => typeof name === 'string' && name.length > 2 && !/^(Anonymous|_c\d*|Fragment)$/.test(name);

  function reactInfo(el, out) {
    let node = el;
    for (let hops = 0; node && hops < 25; hops++, node = node.parentElement) {
      const key = Object.keys(node).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
      if (!key) continue;
      out.framework = 'React';
      let fiber = node[key];
      // Development builds carry _debug* fields; production builds minify most names.
      const dev = !!fiber && ['_debugOwner', '_debugSource', '_debugStack', '_debugInfo'].some((k) => k in fiber);
      if (!dev) out.minified = true;
      for (let i = 0; fiber && i < 300 && out.components.length < 6; i++, fiber = fiber.return) {
        const t = fiber.type;
        let name = null;
        if (typeof t === 'function') name = t.displayName || t.name;
        else if (t && typeof t === 'object') name = t.displayName || t.render?.displayName || t.render?.name || t.type?.displayName || t.type?.name;
        if (!dev && !/^[A-Z][a-z][A-Za-z0-9]{2,}$/.test(name || '')) continue;
        if (usefulName(name) && !out.components.includes(name)) {
          out.components.push(name);
          const src = fiber._debugSource;
          if (!out.source && src?.fileName) out.source = `${src.fileName}:${src.lineNumber}`;
        }
      }
      return true;
    }
    return false;
  }

  function vueInfo(el, out) {
    let node = el;
    for (let hops = 0; node && hops < 25; hops++, node = node.parentElement) {
      let instance = node.__vueParentComponent;
      if (instance) {
        out.framework = 'Vue 3';
        for (let i = 0; instance && i < 30 && out.components.length < 6; i++, instance = instance.parent) {
          const t = instance.type || {};
          const file = t.__file;
          const name = t.name || t.__name || (file ? file.split('/').pop().replace(/\.vue$/, '') : null);
          if (usefulName(name) && !out.components.includes(name)) out.components.push(name);
          if (!out.source && file) out.source = file;
        }
        return true;
      }
      let vm = node.__vue__;
      if (vm) {
        out.framework = 'Vue 2';
        for (let i = 0; vm && i < 30 && out.components.length < 6; i++, vm = vm.$parent) {
          const name = vm.$options?.name || vm.$options?._componentTag;
          if (usefulName(name) && !out.components.includes(name)) out.components.push(name);
          if (!out.source && vm.$options?.__file) out.source = vm.$options.__file;
        }
        return true;
      }
    }
    return false;
  }

  function angularInfo(el, out) {
    const ng = window.ng;
    if (!ng || typeof ng.getOwningComponent !== 'function') return false;
    try {
      let comp = ng.getComponent?.(el) || ng.getOwningComponent(el);
      if (!comp) return false;
      out.framework = 'Angular';
      for (let i = 0; comp && i < 10 && out.components.length < 6; i++) {
        const name = comp.constructor?.name;
        if (usefulName(name) && !out.components.includes(name)) out.components.push(name);
        const host = ng.getHostElement?.(comp);
        comp = host?.parentElement ? ng.getOwningComponent(host.parentElement) : null;
      }
      return true;
    } catch {
      return false;
    }
  }

  function svelteInfo(el, out) {
    let node = el;
    for (let hops = 0; node && hops < 10; hops++, node = node.parentElement) {
      const loc = node.__svelte_meta?.loc;
      if (loc?.file) {
        out.framework = 'Svelte';
        out.source = `${loc.file}:${loc.line + 1}`;
        out.components.push(loc.file.split('/').pop().replace(/\.svelte$/, ''));
        return true;
      }
    }
    return false;
  }

  function inspect(el) {
    const out = { framework: null, components: [], source: null };
    if (!el || el.nodeType !== 1) return out;
    try {
      reactInfo(el, out) || vueInfo(el, out) || angularInfo(el, out) || svelteInfo(el, out);
    } catch {
      /* ignore framework internals we do not understand */
    }
    return out;
  }

  // The overlay dispatches PROBE on the element itself; composedPath()[0] is
  // that element even when it lives inside an (open) shadow root.
  on(
    document,
    PROBE,
    (e) => {
      let request = {};
      try {
        request = JSON.parse(e.detail || '{}');
      } catch {
        /* ignore */
      }
      const el = request.element === false ? null : e.composedPath()[0];
      send({ kind: 'probe-result', id: request.id, component: inspect(el), perf: perfSnapshot(), stack: stackHints() });
    },
    true,
  );

  function stop() {
    stopped = true;
    connected = false;
    ring.length = 0;
    ac.abort();
    for (const observer of observers) observer.disconnect();
    for (const undo of restore) undo();
    delete window[FLAG]; // a new test run on this page installs fresh hooks
  }

  on(document, FROM_EXT, (e) => {
    let msg = {};
    try {
      msg = JSON.parse(e.detail || '{}');
    } catch {
      return;
    }
    if (msg.kind === 'hello') {
      send({ kind: 'replay', events: ring.slice() });
      for (const ev of ring) ev.delivered = true;
      connected = true;
    } else if (msg.kind === 'bye') {
      stop();
    }
  });
})();

// Keep this the last line (see SOURCE_NAME):
//# sourceURL=feedback-lens/page-hooks.js
