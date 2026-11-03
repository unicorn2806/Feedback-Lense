// Test plans: checkpoints written as a Markdown checklist – in the dashboard,
// as a file from the development, or by Claude Code for the next round.
//
//   # Testplan: Checkout 2.4
//   Domains: https://staging.shop.de, https://login.shop.de
//
//   ## Bestellung
//   - [ ] Als Gast bestellen
//     - Start: /warenkorb
//     - Erwartung: Bestätigung mit Bestellnummer
//     - weitere Zeilen sind Hinweise zum Vorgehen
//
// Start addresses given as a path (/warenkorb) apply to whichever domain the
// run takes place on – one plan serves staging and production alike.
import { originOf, isInjectableUrl, formatDateTime } from './util.js';

export const MAX_ITEMS = 300;

const ITEM = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const toOrigin = (s) => {
  const url = /^[a-z]+:\/\//i.test(s) ? s : `https://${s}`;
  const o = originOf(url.endsWith('/') ? url : `${url}/`);
  return o && isInjectableUrl(`${o}/`) ? o : null;
};

/** A start address: a path on the run's domain, or a full http(s) address. */
export function validStart(s) {
  const v = String(s || '').trim();
  if (/^\/[^\s]*$/.test(v)) return v;
  try {
    const u = new URL(v);
    return /^https?:$/.test(u.protocol) ? u.href : '';
  } catch {
    return '';
  }
}

function addDetail(item, text, warnings) {
  let m;
  if ((m = /^Start:\s*(.*)$/i.exec(text))) {
    item.start = validStart(m[1]);
    if (!item.start) warnings.push(`„${clip(item.title, 40)}“: Start „${clip(m[1], 60)}“ ist weder ein Pfad (/…) noch eine http(s)-Adresse.`);
  } else if ((m = /^(?:Erwartung|Erwartet|Expected):\s*(.+)$/i.exec(text))) {
    item.expected = clip(item.expected ? `${item.expected} ${m[1].trim()}` : m[1].trim(), 1000);
  } else if (/^Ergebnis:/i.test(text)) {
    // result of an earlier run (exported plan) – not part of the checkpoint
  } else if (item.notes.length < 12) {
    item.notes.push(clip(text, 300));
  }
}

/** Markdown → { name, domains, items: [{ group, title, start, expected, notes }], warnings }. */
export function parsePlan(text) {
  const plan = { name: '', domains: [], items: [], warnings: [] };
  let group = '';
  let current = null;
  for (const raw of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\t/g, '  ').replace(/\s+$/, '');
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    let m;
    if (indent === 0 && (m = /^#\s+(.+)$/.exec(body))) {
      plan.name = clip(m[1].replace(/^Testplan\s*:\s*/i, '').trim(), 200);
      current = null;
    } else if (indent === 0 && (m = /^#{2,6}\s+(.+)$/.exec(body))) {
      group = clip(m[1].trim(), 120);
      current = null;
    } else if (indent === 0 && (m = /^Domains?\s*:\s*(.+)$/i.exec(body))) {
      for (const part of m[1].split(/[\s,;]+/).filter(Boolean)) {
        const o = toOrigin(part);
        if (o && !plan.domains.includes(o)) plan.domains.push(o);
        else if (!o) plan.warnings.push(`Domain „${clip(part, 60)}“ nicht erkannt.`);
      }
    } else if ((m = ITEM.exec(body)) && (indent === 0 || !current)) {
      if (plan.items.length >= MAX_ITEMS) {
        plan.warnings.push(`Mehr als ${MAX_ITEMS} Prüfpunkte – der Rest wird ignoriert.`);
        break;
      }
      current = { group, title: clip(m[1].replace(/\*\*/g, '').trim(), 200), start: '', expected: '', notes: [] };
      plan.items.push(current);
    } else if (current && indent > 0) {
      addDetail(current, ITEM.exec(body)?.[1] ?? body, plan.warnings);
    }
    // anything else (introductory text) is ignored
  }
  return plan;
}

const resultLine = (r, problems) => {
  if (!r && !problems.length) return null;
  if (r?.status === 'ok') return `OK${r.t ? ` (${formatDateTime(r.t)})` : ''}${problems.length ? ` – Anmerkungen ${problems.join(', ')}` : ''}`;
  if (r?.status === 'skip') return `nicht testbar${r.note ? ` – ${r.note}` : ''}`;
  return `Problem${problems.length ? ` – Anmerkung${problems.length > 1 ? 'en' : ''} ${problems.join(', ')}` : ''}`;
};

/**
 * Plan → Markdown (the format parsePlan reads). With `results` (and the
 * annotations of the run) every checkpoint gets an „Ergebnis:“ line.
 */
export function serializePlan(plan, { results = null, annotations = [] } = {}) {
  const head = [`# Testplan: ${plan.name || 'Ohne Namen'}`];
  if (plan.domains?.length) head.push(`Domains: ${plan.domains.join(', ')}`);
  return `${[...head, '', serializeItems(plan.items, { results, annotations })].join('\n').trimEnd()}\n`;
}

/** Only the checkpoints (with ## groups) – what the editor in the dashboard shows. */
export function serializeItems(items, { results = null, annotations = [] } = {}) {
  const out = [];
  let group = '';
  for (const item of items) {
    if ((item.group || '') !== group) {
      group = item.group || '';
      if (out.length) out.push('');
      out.push(`## ${group || 'Weitere Prüfpunkte'}`, '');
    }
    const r = results?.[item.id];
    out.push(`- [${r?.status === 'ok' ? 'x' : ' '}] ${item.title}`);
    if (item.start) out.push(`  - Start: ${item.start}`);
    if (item.expected) out.push(`  - Erwartung: ${item.expected}`);
    for (const note of item.notes || []) out.push(`  - ${note}`);
    if (results) {
      const problems = annotations.filter((a) => a.planItem === item.id).map((a) => `#${a.number}`);
      out.push(`  - Ergebnis: ${resultLine(r, problems) || 'nicht geprüft'}`);
    }
  }
  return `${out.join('\n').trim()}\n`;
}

/** Where a checkpoint starts in this run: paths on the current domain, full addresses as they are. */
export function startUrl(item, origin) {
  if (!item.start) return null;
  try {
    return new URL(item.start, `${origin}/`).href;
  } catch {
    return null;
  }
}
