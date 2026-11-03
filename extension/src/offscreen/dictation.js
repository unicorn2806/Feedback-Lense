// Offscreen document for the dictation button in the annotation dialog.
// Speech is recognised strictly on this device (Web Speech API with
// processLocally); without a local language pack there is no dictation – audio
// never goes to a server. Running here (not in the tested page) means the
// microphone permission belongs to the extension, not to the site under test.
(() => {
  const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  const MAX_MS = 5 * 60_000; // never listen longer than this …
  const IDLE_MS = 45_000; // … or this long without any recognised speech
  let current = null; // { r, runId, timers }

  /** How this browser is told to stay on the device – or null if it can't be. */
  function localMode() {
    if (!SR) return null;
    if ('processLocally' in SR.prototype && typeof SR.available === 'function') return 'processLocally';
    if ('mode' in SR.prototype && typeof SR.availableOnDevice === 'function') return 'mode'; // earlier Chrome API
    return null;
  }

  /** 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unsupported' */
  async function status(lang) {
    const mode = localMode();
    if (!mode) return 'unsupported';
    try {
      const res = mode === 'processLocally' ? await SR.available({ langs: [lang], processLocally: true }) : await SR.availableOnDevice(lang);
      return typeof res === 'string' ? res : res ? 'available' : 'unavailable';
    } catch {
      return 'unavailable';
    }
  }

  const emit = (runId, event) => chrome.runtime.sendMessage({ type: 'fl:dictationEvent', event: { ...event, runId } }).catch(() => {});

  function stop() {
    const run = current;
    current = null;
    if (!run) return;
    clearTimeout(run.max);
    clearTimeout(run.idle);
    try {
      run.r.stop();
    } catch {
      /* already stopped */
    }
  }

  async function start(lang, runId) {
    stop();
    const st = await status(lang);
    if (st !== 'available') return { ok: false, status: st };
    const r = new SR();
    const run = { r, runId, max: setTimeout(() => current === run && stop(), MAX_MS), idle: 0 };
    const idle = () => {
      clearTimeout(run.idle);
      run.idle = setTimeout(() => current === run && stop(), IDLE_MS);
    };
    idle();
    if (localMode() === 'processLocally') r.processLocally = true;
    else r.mode = 'ondevice-only';
    r.lang = lang;
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      idle();
      let final = '';
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const text = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += text;
        else interim += text;
      }
      emit(runId, { kind: 'result', final: final.trim(), interim: interim.trim() });
    };
    r.onerror = (e) => emit(runId, { kind: 'error', error: String(e.error || 'error') });
    r.onend = () => {
      if (current === run) stop();
      emit(runId, { kind: 'end' });
    };
    current = run;
    r.start();
    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Only the service worker gives orders – content scripts share the extension id but have a tab.
    if (msg?.target !== 'fl-dictation' || sender.id !== chrome.runtime.id || sender.tab) return false;
    const run = msg.action === 'start' ? start(msg.lang, msg.runId) : msg.action === 'status' ? status(msg.lang).then((s) => ({ ok: s === 'available', status: s })) : Promise.resolve((stop(), { ok: true }));
    run.then(sendResponse, (err) => sendResponse({ ok: false, status: 'error', error: String(err?.message || err) }));
    return true;
  });
})();
