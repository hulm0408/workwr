// ============================================================================
// rich-text.js — Free Telegram rich-message helpers (HTML parse_mode)
// ============================================================================
// Provides Telegram blockquote sections, bold headings, and readable field lists.
// Telegram messages do not support real tables, so data is rendered as compact
// item/field lines instead of fake monospace grids and separator rules.

export const DIVIDER = '';
export const SECTION_GAP = '\n';

// ---------------------------------------------------------------------------
// 🔤 FANCY FONT (Unicode "bold sans") — owner ne in bots jaisa alag font manga:
//   "inke bot me kya alag font use ki gayi hai, mere bot me wohi tatti font"
// Ye maths bold glyphs hain (𝗧𝗛𝗜𝗦 𝗝𝗔𝗜𝗦𝗔) — Telegram har device par dikhata hai.
// Sirf HEADINGS/labels par lagta hai; numbers/OTP/JSON bilkul plain rehte hain
// taaki copy-paste aur padhna kharab na ho.
// ---------------------------------------------------------------------------
const FANCY_BOLD_OFFSETS = {
  upperA: 0x1D5D4, // 𝐀..𝐙 sans-serif bold
  lowerA: 0x1D5EE, // 𝐚..𝐳
  digit0: 0x1D7EC, // 𝟎..𝟗
};

export function fancy(text = '') {
  return String(text ?? '').replace(/[A-Za-z0-9]/g, (ch) => {
    const code = ch.charCodeAt(0);
    if (ch >= 'A' && ch <= 'Z') return String.fromCodePoint(FANCY_BOLD_OFFSETS.upperA + (code - 65));
    if (ch >= 'a' && ch <= 'z') return String.fromCodePoint(FANCY_BOLD_OFFSETS.lowerA + (code - 97));
    return String.fromCodePoint(FANCY_BOLD_OFFSETS.digit0 + (code - 48));
  });
}

// Ulta: fancy glyphs ko wapas ASCII me (stage/regex matching ke liye).
const FANCY_TO_ASCII = (() => {
  const map = new Map();
  const pairs = [
    [0x1D5D4, 'A'], [0x1D5EE, 'a'], [0x1D7EC, '0'], // sans-serif bold
    [0x1D400, 'A'], [0x1D41A, 'a'], [0x1D7CE, '0'], // bold
    [0x1D63C, 'A'], [0x1D656, 'a'], [0x1D7F6, '0'], // sans-serif bold italic
  ];
  for (const [base, start] of pairs) {
    const size = start === '0' ? 10 : 26;
    for (let i = 0; i < size; i += 1) {
      map.set(base + i, String.fromCharCode(start.charCodeAt(0) + i));
    }
  }
  return map;
})();

export function plain(text = '') {
  return String(text ?? '').replace(/[\uD835][\uDC00-\uDFFF]/g, (ch) => FANCY_TO_ASCII.get(ch.codePointAt(0)) || ch);
}

// Header line: —[ ⚡ YOUR NUMBER ]—   (jaisa in bots ka style hai)
export function bracketHeader(title, { time = '', width = 14 } = {}) {
  const head = `—[ ${esc(fancy(String(title || '')))} ]—`;
  return time ? `${head} <code>${esc(time)}</code>` : head;
}

export function headerRule(width = 14) {
  return '─'.repeat(Math.max(3, Number(width) || 14));
}

// "02:28" jaisa chhota timestamp (owner IST me padhta hai).
export function stamp(date = new Date(), { timeZone = 'Asia/Kolkata' } = {}) {
  try {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone,
    }).format(d);
  } catch {
    return '';
  }
}

// Collapsible detail block (Telegram expandable blockquote) — lambi "poori
// duniya ki information" chhup jati hai, card saaf rehta hai.
export function details(lines = [], { title = '' } = {}) {
  const body = (Array.isArray(lines) ? lines : [lines]).filter(Boolean).join('\n');
  if (!body) return '';
  const head = title ? `${heading(title)}\n` : '';
  return `<blockquote expandable>${head}${body}</blockquote>`;
}

export function esc(str = '') {
  return String(str ?? '')
    .replace(/&(?!(?:amp|lt|gt|quot|apos|#39|#\d+);)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Bold heading. Body ke andar wala text plain bold rehta hai (search/copy
// ke liye), fancy font sirf card header (section) aur field labels par lagta hai.
export function heading(text) {
  return `<b>${esc(text)}</b>`;
}

// Subtle subtext line
export function sub(text) {
  return `<i>${esc(text)}</i>`;
}

// Short machine-readable values (numbers, counts, timers, modes) mono me
// dikhte hain — live card par aankh seedha wahi padhti hai jo badal raha hai.
export function mono(value) {
  return `<code>${esc(value)}</code>`;
}

// Reference-style bar: soft blocks + percentage, numbers chhote rakho.
export function progressBar(done = 0, total = 0, width = 10) {
  const safeTotal = Math.max(0, Number(total) || 0);
  const safeDone = Math.max(0, Number(done) || 0);
  const ratio = safeTotal > 0 ? Math.min(safeDone, safeTotal) / safeTotal : 0;
  const filled = Math.min(width, Math.round(ratio * width));
  const percent = Math.round(ratio * 100);
  const bar = `${'▰'.repeat(filled)}${'▱'.repeat(Math.max(0, width - filled))}`;
  return `${mono(`${bar} ${percent}%`)} <i>${safeDone}/${safeTotal}</i>`;
}

// Ek hi compact status card: title + flow + abhi kya ho raha hai + progress.
// Body pehle se trusted internal HTML hai; caller sirf chhoti lines dega.
// `stamp` (Date) do to header par right-side time chip aa jata hai.
export function statusCard(title, lines = [], { stamp: when = null } = {}) {
  const body = (Array.isArray(lines) ? lines : [lines]).filter(Boolean).join('\n');
  return when ? sectionStamp(title, body, when) : section(title, body);
}

// Field line: <b>LABEL:</b> value  (label fancy font me, value plain)
export function field(label, value) {
  return `<b>${esc(fancy(label))}:</b> ${esc(value)}`;
}

// Bullet item
export function bullet(text) {
  return `▪ ${esc(text)}`;
}

// Bordered section block (Telegram <blockquote> renders as a card with a left border).
// Title ab in bots jaisa:  —[ ⚡ TITLE ]—  + niche patli line.
// `body` is trusted internal HTML already built with esc()/field()/table()/heading()/sub().
export function section(title, body) {
  const t = title ? `${bracketHeader(title)}\n${headerRule()}\n` : '';
  return `<blockquote>${t}${body}</blockquote>\n`;
}

// Same card, par header ke saath time chip (in bots ka right-side timestamp).
export function sectionStamp(title, body, date = new Date()) {
  const time = stamp(date);
  const t = title ? `${bracketHeader(title, { time })}\n${headerRule()}\n` : '';
  return `<blockquote>${t}${body}</blockquote>\n`;
}

// Bordered card: title + multiple body lines joined by newline
export function card(title, ...lines) {
  return section(title, lines.filter(Boolean).join('\n'));
}

function safeTableCell(value) {
  const input = String(value ?? '');
  const allowedTags = [];
  let safe = input.replace(/<\/?(?:b|i|code|s|u|tg-spoiler)>|<a href="(?:https:\/\/|tg:\/\/)[^"]+">|<\/a>/gi, tag => {
    const token = `\u0000SAFE_TAG_${allowedTags.length}\u0000`;
    allowedTags.push(tag);
    return token;
  });
  safe = safe
    .replace(/&(?!(?:amp|lt|gt|quot|#39|#\d+);)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return safe.replace(/\u0000SAFE_TAG_(\d+)\u0000/g, (_match, idx) => allowedTags[Number(idx)] || '');
}

// Telegram has no table primitive. Render data as readable list entries with no
// fake columns, dash rules, or monospace border art.
export function table(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const normalized = rows.map(row => Array.isArray(row) ? row : [row]);
  const headers = normalized[0].map(value => String(value ?? '').replace(/<[^>]+>/g, '').trim());
  const isItemList = headers.some(h => /^item$/i.test(h));
  const hasColumnHeaders = normalized.length > 1 && headers.length >= 3;

  if (hasColumnHeaders && isItemList) {
    const itemIndex = headers.findIndex(h => /^item$/i.test(h));
    const qtyIndex = headers.findIndex(h => /^qty|quantity$/i.test(h));
    const priceIndex = headers.findIndex(h => /^(?:unit )?price$/i.test(h));
    const totalIndex = headers.findIndex(h => /total/i.test(h) && h !== '#');
    const numberIndex = headers.findIndex(h => /^#|no\.?$/i.test(h));
    return normalized.slice(1).map((row, index) => {
      const item = safeTableCell(row[itemIndex] ?? 'Item');
      const itemNumber = numberIndex >= 0 ? String(row[numberIndex] || index + 1) : String(index + 1);
      const details = [];
      if (qtyIndex >= 0 && row[qtyIndex] !== undefined) details.push(`Qty: ${safeTableCell(row[qtyIndex])}`);
      if (priceIndex >= 0 && row[priceIndex] !== undefined) details.push(`Unit price: ${safeTableCell(row[priceIndex])}`);
      if (totalIndex >= 0 && totalIndex !== priceIndex && row[totalIndex] !== undefined) {
        details.push(`${safeTableCell(headers[totalIndex])}: ${safeTableCell(row[totalIndex])}`);
      }
      return `${itemNumber}. <b>${item}</b>${details.length ? `\n  ${details.join(' · ')}` : ''}`;
    }).join('\n');
  }

  if (hasColumnHeaders) {
    const titleIndex = headers.findIndex(h => !/^#|no\.?$/i.test(h));
    return normalized.slice(1).map(row => {
      const rawTitle = titleIndex >= 0 ? String(row[titleIndex] ?? '') : '';
      const title = safeTableCell(rawTitle);
      const titleMarkup = /<\/?(?:b|i|code|s|u|tg-spoiler)>/i.test(rawTitle) ? title : `<b>${title}</b>`;
      const details = headers
        .map((header, idx) => ({ header, value: row[idx], idx }))
        .filter(({ header, value, idx }) => idx !== titleIndex && !/^#|no\.?$/i.test(header) && value !== undefined && value !== '')
        .map(({ header, value }) => `  <b>${safeTableCell(header)}:</b> ${safeTableCell(value)}`);
      return `${title ? `▪ ${titleMarkup}` : '▪'}${details.length ? `\n${details.join('\n')}` : ''}`;
    }).join('\n');
  }

  const dataRows = normalized.filter((row, idx) => !(idx === 0 && /^final bill$/i.test(String(row[0] || '').trim()) && !String(row[1] || '').trim()));
  return dataRows.map(row => {
    const rawLabel = String(row[0] ?? '');
    const label = safeTableCell(rawLabel);
    const labelMarkup = /<\/?(?:b|i|code|s|u|tg-spoiler)>/i.test(rawLabel) ? label : `<b>${label}</b>`;
    const value = row.length > 1 ? safeTableCell(row[1] ?? '') : '';
    return `▪ ${labelMarkup}${value ? `: ${value}` : ''}`;
  }).join('\n');
}

// Standalone section divider — leave breathing room rather than drawing a fake rule.
export function divider() {
  return '\n';
}

// A full clean message wrapper: heading + sections + footer note
export function message(title, sections = [], footer = '') {
  const parts = [];
  if (title) parts.push(heading(title), divider());
  for (const s of sections) parts.push(s);
  if (footer) parts.push(divider(), sub(footer));
  return parts.join('\n');
}

// Clean OTP Sent card — matches ORDER PLACER style: bold label + value, no ━━━
export function otpSentCard(phone, extraLines = []) {
  const lines = [
    `<b>☎ OTP Sent</b>`,
    `☎ <b>Number:</b> <code>${esc(phone)}</code>`,
    ...extraLines
  ];
  return section('◈ Swiggy Login OTP', lines.join('\n'));
}

// Clean OTP error / verification failed card — matches ORDER PLACER style
export function otpErrorCard(phone, swiggyResponse, hint = 'Sahi 6-digit OTP dubara type karein ya neeche Re-enter OTP dabayein:') {
  return section('× OTP Request Failed', [
    `☎ <b>Number:</b> <code>${esc(phone)}</code>`,
    '',
    `! <b>Swiggy Response:</b>`,
    `<blockquote>${esc(swiggyResponse)}</blockquote>`,
    '',
    `› <i>${esc(hint)}</i>`,
  ].join('\n'));
}

// Clean Boss Panel fallback card
export function bossPanelCard(bodyLines = []) {
  return section('★ Boss Panel', [
    `→ Boss, use the menu buttons below:`,
    ...bodyLines,
  ].filter(Boolean).join('\n'));
}
