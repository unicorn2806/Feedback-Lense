// Shared constants. Loaded as a classic script (content scripts, popup, dashboard)
// and as a side-effect module import (service worker), so it must not declare
// top-level bindings — injecting it twice into the same world would throw.
globalThis.FL_CONST = globalThis.FL_CONST || Object.freeze({
  APP_NAME: 'Feedback Lens',
  SCHEMA: 'feedback-lens/v1',

  CATEGORIES: Object.freeze([
    { id: 'bug', label: 'Fehler', hint: 'Etwas funktioniert nicht wie vorgesehen', color: '#e11d48', long: 'Funktionaler Fehler (Bug)' },
    { id: 'usability', label: 'Bedienbarkeit', hint: 'Umständlich, unklar oder verwirrend', color: '#7c3aed', long: 'Usability-/UX-Problem' },
    { id: 'design', label: 'Design / Layout', hint: 'Optik, Abstände, Ausrichtung, Responsive', color: '#0891b2', long: 'Visuelles Design / Layout' },
    { id: 'content', label: 'Text / Inhalt', hint: 'Formulierung, Rechtschreibung, fehlende Infos', color: '#ca8a04', long: 'Text, Inhalt oder Microcopy' },
    { id: 'a11y', label: 'Barrierefreiheit', hint: 'Kontrast, Tastatur, Screenreader', color: '#16a34a', long: 'Barrierefreiheit (Accessibility)' },
    { id: 'performance', label: 'Performance', hint: 'Langsam, ruckelig, lange Ladezeit', color: '#ea580c', long: 'Performance' },
    { id: 'feature', label: 'Idee / Wunsch', hint: 'Neue Funktion oder Verbesserungsidee', color: '#2563eb', long: 'Feature-Wunsch / Verbesserungsidee' },
    { id: 'other', label: 'Sonstiges', hint: 'Passt nirgends sonst', color: '#64748b', long: 'Sonstiges' },
  ]),

  PRIORITIES: Object.freeze([
    { id: 'low', label: 'Niedrig', rank: 1, color: '#64748b' },
    { id: 'medium', label: 'Mittel', rank: 2, color: '#2563eb' },
    { id: 'high', label: 'Hoch', rank: 3, color: '#ea580c' },
    { id: 'critical', label: 'Kritisch', rank: 4, color: '#dc2626' },
  ]),

  STATUSES: Object.freeze([
    { id: 'open', label: 'Offen' },
    { id: 'done', label: 'Erledigt' },
    { id: 'wontfix', label: 'Verworfen' },
  ]),

  // Re-test of an earlier test run: what became of each earlier annotation?
  VERDICTS: Object.freeze([
    { id: 'fixed', label: 'Behoben', hint: 'Tritt nicht mehr auf', color: '#16a34a' },
    { id: 'open', label: 'Besteht weiter', hint: 'Unverändert vorhanden', color: '#dc2626' },
    { id: 'changed', label: 'Verändert', hint: 'Anders als vorher, aber noch nicht gut', color: '#d97706' },
    { id: 'untestable', label: 'Nicht prüfbar', hint: 'Stelle nicht erreichbar oder entfernt', color: '#64748b' },
  ]),

  // Results the development notes in the package README (see report.js).
  DEV_RESULTS: Object.freeze([
    { id: 'done', label: 'erledigt' },
    { id: 'partial', label: 'vorläufig' },
    { id: 'question', label: 'Rückfrage' },
    { id: 'rejected', label: 'abgelehnt' },
  ]),

  KINDS: Object.freeze({
    element: 'Element',
    region: 'Bereich',
    page: 'Ganze Seite',
  }),

  DEFAULT_SETTINGS: Object.freeze({
    captureConsole: true,
    captureNetwork: true,
    captureInteractions: true,
    maskSensitiveParams: true, // since 1.2 also: secrets and personal data in captured texts
    stripUrlQuery: false,
    showPins: true,
    dictationLang: 'de-DE',
    quickFormat: 'ai', // how a single annotation is copied for a chat (see QUICK_FORMATS)
  }),

  // Copying one annotation (Schnell-Anmerkung, „Speichern & kopieren“): where it is pasted
  QUICK_FORMATS: Object.freeze([
    { id: 'ai', label: 'KI-Chat (Claude, ChatGPT) – ein Bild', short: 'Claude / ChatGPT', hint: 'Screenshot und alle Angaben in einem Bild – ein Einfügen genügt', where: 'Claude oder ChatGPT', card: true },
    { id: 'ai-text', label: 'KI-Chat – Text und Bild getrennt', short: 'KI-Chat: Text + Bild', hint: 'Markdown-Text und Screenshot (je nach Chat zweimal einfügen)', where: 'den Chat' },
    { id: 'rich', label: 'Teams, Outlook, Word', short: 'Teams / Outlook / Word', hint: 'formatierter Text, Screenshot im Text', where: 'Teams, Outlook oder Word' },
    { id: 'plain', label: 'Ticket, E-Mail', short: 'Ticket / E-Mail', hint: 'schlichter Text und Screenshot', where: 'das Ticket oder die E-Mail' },
  ]),

  DICTATION_LANGS: Object.freeze([
    { id: 'de-DE', label: 'Deutsch' },
    { id: 'en-US', label: 'Englisch (USA)' },
    { id: 'en-GB', label: 'Englisch (UK)' },
    { id: 'fr-FR', label: 'Französisch' },
    { id: 'es-ES', label: 'Spanisch' },
    { id: 'it-IT', label: 'Italienisch' },
    { id: 'nl-NL', label: 'Niederländisch' },
  ]),

  LIMITS: Object.freeze({
    trailPerSession: 3000,
    techPerSession: 1000,
    techPerAnnotation: 15,
    stepsPerAnnotation: 15,
    htmlSnippet: 2500,
    text: 400,
    imageMaxEdge: 2576, // keeps text in screenshots sharp while bounding file size
    extraImages: 7, // further screenshots per annotation (besides the first one)
  }),

  // Storage keys (chrome.storage.local)
  KEYS: Object.freeze({
    settings: 'fl:settings',
    active: 'fl:active',
    sessions: 'fl:sessions',
    ui: 'fl:ui',
    ann: (sid) => `fl:ann:${sid}`,
    trail: (sid) => `fl:trail:${sid}`,
    tech: (sid) => `fl:tech:${sid}`,
    img: (annId, variant) => `fl:img:${annId}:${variant}`,
    plan: (sid) => `fl:plan:${sid}`, // re-test: snapshot of the earlier annotations
    templates: 'fl:templates', // test plan templates
    testPlan: (sid) => `fl:tp:${sid}`, // test plan of a run: snapshot + results
    planImg: (sid, itemId) => `fl:img:${sid}.${itemId}:full`, // screenshot of a checkpoint found OK
    drafts: (sid) => `fl:drafts:${sid}`, // parked (unsaved) annotations: summaries
    draft: (id) => `fl:draft:${id}`, // … and each one's content incl. screenshot
  }),

  // Results of a test plan checkpoint (problem: also set by a linked annotation)
  PLAN_STATUSES: Object.freeze([
    { id: 'ok', label: 'In Ordnung', mark: '✓', color: '#16a34a' },
    { id: 'problem', label: 'Problem', mark: '✗', color: '#dc2626' },
    { id: 'skip', label: 'Nicht testbar', mark: '–', color: '#64748b' },
  ]),
});
