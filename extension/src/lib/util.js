// Small helpers shared by the service worker and the extension pages.
import '../shared/constants.js';

export const C = globalThis.FL_CONST;

export function uid(prefix = '') {
  const rnd = crypto.getRandomValues(new Uint8Array(9));
  return prefix + Array.from(rnd, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 14);
}

export const nowIso = () => new Date().toISOString();

/** Origin of a URL, or null for pages an extension cannot script. */
export function originOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
    if (u.protocol === 'file:') return 'file://';
    return null;
  } catch {
    return null;
  }
}

/** Chrome match pattern covering every page of an origin (ports included). */
export function matchPatternFor(origin) {
  if (origin === 'file://') return 'file:///*';
  const u = new URL(origin);
  return `${u.protocol}//${u.host}/*`;
}

const BLOCKED_HOSTS = ['chrome.google.com', 'chromewebstore.google.com', 'microsoftedge.microsoft.com'];

export function isInjectableUrl(url) {
  const origin = originOf(url);
  if (!origin) return false;
  if (origin === 'file://') return true;
  return !BLOCKED_HOSTS.includes(new URL(url).hostname);
}

export function categoryOf(id) {
  return C.CATEGORIES.find((c) => c.id === id) || C.CATEGORIES[C.CATEGORIES.length - 1];
}

export function priorityOf(id) {
  return C.PRIORITIES.find((p) => p.id === id) || C.PRIORITIES[1];
}

export function statusOf(id) {
  return C.STATUSES.find((s) => s.id === id) || C.STATUSES[0];
}

const dateFmt = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
const timeFmt = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const validDate = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};
export const formatDateTime = (iso) => (validDate(iso) ? dateFmt.format(validDate(iso)) : '–');
export const formatTime = (iso) => (validDate(iso) ? timeFmt.format(validDate(iso)) : '–');

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '–';
  const min = Math.round(ms / 60000);
  if (min < 1) return '< 1 Min.';
  if (min < 60) return `${min} Min.`;
  return `${Math.floor(min / 60)} Std. ${min % 60} Min.`;
}

export function slugify(text, max = 40) {
  const s = String(text || '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, max).replace(/-+$/, '') || 'feedback';
}

export function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export const pad = (n, len = 2) => String(n).padStart(len, '0');

export function annotationLabel(a) {
  return `#${a.number}`;
}

/** Title shown for an annotation, derived from the description when empty. */
export function annotationTitle(a) {
  if (a.title && a.title.trim()) return a.title.trim();
  const first = String(a.description || '').trim().split(/\n/)[0];
  return first ? truncate(first, 90) : '(ohne Titel)';
}

/** Only web/file URLs may become links (imported backups are untrusted). */
export function safeUrl(url) {
  return /^(https?|file):/i.test(String(url || '')) ? url : '#';
}

export function hostOf(url) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export function pathOf(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search + u.hash;
  } catch {
    return url;
  }
}

export function bytesToSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * A shortcut as single keys, for compact key caps: Chrome writes it in the
 * browser's language („Alt+Umschalttaste+E“ on German Windows, „⌥⇧E“ on macOS).
 */
export function shortcutKeys(shortcut) {
  const s = String(shortcut || '').trim();
  if (!s) return [];
  const mac = /^([⌃⌥⇧⌘]+)(.+)$/.exec(s);
  const keys = mac ? [...mac[1], mac[2]] : s.split('+').map((k) => k.trim()).filter(Boolean);
  return keys.map((k) => (/^(shift|umschalt(taste)?)$/i.test(k) ? '⇧' : k));
}

/** Longer than this without any activity counts as a break, not as test time. */
export const IDLE_MS = 30 * 60_000;

/**
 * The time actually spent testing: the session's sections (start or resume →
 * stop) without breaks – gaps of more than IDLE_MS between two activities
 * (clicks, inputs, page changes, annotations, checkpoint results).
 * Sessions from before 1.7 have no sections; their pauses show up as idle gaps.
 */
export function testTime(session, { trail = [], annotations = [], results = null } = {}, now = Date.now()) {
  const end = Date.parse(session.endedAt || '') || now;
  const runs = (Array.isArray(session.runs) && session.runs.length ? session.runs : [{ from: session.createdAt, to: session.endedAt }])
    .map((r) => [Date.parse(r.from), Math.min(Date.parse(r.to || '') || end, end)])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b >= a);
  const times = [
    ...trail.filter((e) => e.type !== 'message').map((e) => e.t),
    ...annotations.flatMap((a) => [a.createdAt, a.updatedAt]),
    ...Object.values(results || {}).map((r) => r?.t),
  ]
    .map((t) => Date.parse(t || ''))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  // the click path keeps only the newest entries: before its first one there is no telling
  const judgeFrom = trail.length >= (globalThis.FL_CONST?.LIMITS?.trailPerSession ?? Infinity) ? Date.parse(trail[0]?.t || '') || 0 : 0;
  let ms = 0;
  let idle = 0;
  for (const [a, b] of runs) {
    const points = [a, ...times.filter((t) => t > a && t < b), b];
    for (let i = 1; i < points.length; i++) {
      const gap = points[i] - points[i - 1];
      if (gap > IDLE_MS && points[i - 1] >= judgeFrom) idle += gap;
      else ms += gap;
    }
  }
  return {
    ms,
    idle,
    sections: runs.map(([a, b]) => ({ from: new Date(a).toISOString(), to: new Date(b).toISOString() })),
    estimated: !(Array.isArray(session.runs) && session.runs.length),
  };
}

/** „1 Std. 25 Min.“ plus what was left out, for one line of text. */
export function testTimeText(tt) {
  const parts = [];
  if (tt.sections.length > 1) parts.push(`${tt.sections.length} Abschnitte`);
  if (tt.idle >= 60_000) parts.push(`ohne ${formatDuration(tt.idle)} Pause`);
  return `${formatDuration(tt.ms)}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

const hmFmt = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });

/** The sections as „29.10.2026, 17:58 – 18:40“, the date only where it changes. */
export function sectionsText(tt) {
  return tt.sections.map((s) => {
    const sameDay = new Date(s.from).toDateString() === new Date(s.to).toDateString();
    return `${formatDateTime(s.from)} – ${sameDay ? hmFmt.format(new Date(s.to)) : formatDateTime(s.to)}`;
  });
}
