// Minimal, safe Markdown → HTML renderer for reports and the dashboard.
// Every piece of text is HTML-escaped before any formatting is applied, and
// links are limited to http(s)/mailto, so the output can be assigned to
// innerHTML without risk.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(text) {
  const codes = [];
  let s = String(text).replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(`<code>${esc(code)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
    const url = href.replace(/&amp;/g, '&');
    if (!/^(https?:|mailto:)/i.test(url)) return label;
    return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[+i]);
}

const FENCE = /^(\s*)(```+|~~~+)\s*([\w#+.-]*)\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function readFence(lines, i) {
  const m = FENCE.exec(lines[i]);
  const indent = m[1].length;
  const marker = m[2];
  const buf = [];
  i++;
  while (i < lines.length && !lines[i].trim().startsWith(marker)) {
    buf.push(lines[i].slice(Math.min(indent, lines[i].length - lines[i].trimStart().length)));
    i++;
  }
  const lang = m[3] ? ` data-lang="${esc(m[3])}"` : '';
  return { html: `<pre><code${lang}>${esc(buf.join('\n'))}</code></pre>`, next: i + 1 };
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function readTable(lines, i) {
  const head = splitRow(lines[i]);
  const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
  i += 2;
  const rows = [];
  while (i < lines.length && /^\s*\|/.test(lines[i])) {
    rows.push(splitRow(lines[i]));
    i++;
  }
  const cell = (tag, text, idx) => `<${tag}${align[idx] ? ` style="text-align:${align[idx]}"` : ''}>${inline(text)}</${tag}>`;
  const thead = `<tr>${head.map((c, idx) => cell('th', c, idx)).join('')}</tr>`;
  const tbody = rows.map((r) => `<tr>${head.map((_, idx) => cell('td', r[idx] ?? '', idx)).join('')}</tr>`).join('');
  return { html: `<div class="md-table"><table><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`, next: i };
}

function readList(lines, start) {
  const first = LIST_ITEM.exec(lines[start]);
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const startNum = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    const m = LIST_ITEM.exec(line);
    if (m && m[1].length === base && /\d/.test(m[2]) === ordered) {
      items.push({ text: [m[3]], extra: '' });
      i++;
      continue;
    }
    if (!items.length) break;
    const item = items[items.length - 1];
    if (m && m[1].length > base) {
      const sub = readList(lines, i);
      item.extra += sub.html;
      i = sub.next;
      continue;
    }
    if (FENCE.test(line) && FENCE.exec(line)[1].length > base) {
      const f = readFence(lines, i);
      item.extra += f.html;
      i = f.next;
      continue;
    }
    if (!line.trim()) {
      // A blank line continues the list only if more indented content or another item follows.
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const nm = j < lines.length ? LIST_ITEM.exec(lines[j]) : null;
      const indented = j < lines.length && lines[j].length - lines[j].trimStart().length > base;
      if ((nm && nm[1].length >= base && (nm[1].length > base || /\d/.test(nm[2]) === ordered)) || (indented && !nm)) {
        i = j;
        continue;
      }
      break;
    }
    if (line.length - line.trimStart().length > base && !m) {
      item.text.push(line.trim());
      i++;
      continue;
    }
    break;
  }
  const tag = ordered ? 'ol' : 'ul';
  const startAttr = ordered && startNum !== 1 ? ` start="${startNum}"` : '';
  const body = items
    .map((it) => {
      let text = it.text.join('\n');
      const task = /^\[([ xX])\]\s+/.exec(text);
      let prefix = '';
      if (task) {
        prefix = `<input type="checkbox" disabled${task[1].trim() ? ' checked' : ''}> `;
        text = text.slice(task[0].length);
      }
      return `<li>${prefix}${inline(text).replace(/\n/g, '<br>')}${it.extra}</li>`;
    })
    .join('');
  return { html: `<${tag}${startAttr}>${body}</${tag}>`, next: i };
}

export function renderMarkdown(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (FENCE.test(line)) {
      const f = readFence(lines, i);
      html += f.html;
      i = f.next;
      continue;
    }
    let m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) {
      const level = m[1].length;
      html += `<h${level}>${inline(m[2])}</h${level}>`;
      i++;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      html += '<hr>';
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      html += `<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`;
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const t = readTable(lines, i);
      html += t.html;
      i = t.next;
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const l = readList(lines, i);
      html += l.html;
      i = l.next;
      continue;
    }
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !/^\s{0,3}(#{1,6}\s|>)/.test(lines[i]) && !LIST_ITEM.test(lines[i]) && !(/^\s*\|/.test(lines[i]) && TABLE_SEP.test(lines[i + 1] || ''))) {
      buf.push(lines[i++]);
    }
    html += `<p>${inline(buf.join('\n')).replace(/\n/g, '<br>')}</p>`;
  }
  return html;
}

export const escapeHtml = esc;
