// ─────────────────────────────────────────────────────────────
// markdown.js — a very small Markdown → HTML renderer.
//
// Only what the legal documents actually use: headings, bold,
// italics, inline code, links, bullet and numbered lists, block
// quotes, horizontal rules and paragraphs.
//
// Everything is HTML-escaped FIRST, so nothing in a source file can
// inject markup — the conversion only ever adds tags we chose.
// ─────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Only http(s) and same-site links are allowed to become anchors.
function safeHref(url) {
  const u = String(url).trim();
  if (/^https?:\/\//i.test(u)) return u;
  if (/^\/[^/]/.test(u) || /^#/.test(u)) return u;
  if (/^mailto:[^\s@]+@[^\s@]+$/i.test(u)) return u;
  return null;
}

// Inline formatting, applied to already-escaped text.
function inline(text) {
  let out = text;
  // `code`
  out = out.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  // [label](href)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, href) => {
    const safe = safeHref(href.replace(/&amp;/g, '&'));
    if (!safe) return label;
    const external = /^https?:\/\//i.test(safe);
    return `<a href="${escapeHtml(safe)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${label}</a>`;
  });
  // Bare <https://…> style links written as &lt;https://…&gt; after escaping
  out = out.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, (whole, href) =>
    `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${href}</a>`);
  // **bold** then *italic* (bold first so ** is not eaten by *)
  out = out.replace(/\*\*([^*]+)\*\*/g, (_, b) => `<strong>${b}</strong>`);
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, (_, pre, i) => `${pre}<em>${i}</em>`);
  return out;
}

function toHtml(markdown) {
  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let list = null;          // 'ul' | 'ol' | null
  let paragraph = [];
  let quote = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (!list) return;
    out.push(`</${list}>`);
    list = null;
  };
  const flushQuote = () => {
    if (!quote.length) return;
    out.push(`<blockquote>${quote.map(q => `<p>${inline(q)}</p>`).join('')}</blockquote>`);
    quote = [];
  };

  for (const raw of lines) {
    const line = escapeHtml(raw.replace(/\s+$/, ''));
    const trimmed = line.trim();

    if (!trimmed) { flushParagraph(); closeList(); flushQuote(); continue; }

    const q = trimmed.match(/^&gt;\s?(.*)$/);
    if (q) { flushParagraph(); closeList(); quote.push(q[1]); continue; }
    flushQuote();

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph(); closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph(); closeList();
      out.push('<hr />');
      continue;
    }

    const bullet = trimmed.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      flushParagraph();
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }

    const numbered = trimmed.match(/^\d+\.\s+(.*)$/);
    if (numbered) {
      flushParagraph();
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(numbered[1])}</li>`);
      continue;
    }

    // A plain line continues the current paragraph (or a list item's text).
    if (list) { out.push(`<li>${inline(trimmed)}</li>`); continue; }
    paragraph.push(trimmed);
  }

  flushParagraph();
  closeList();
  flushQuote();
  return out.join('\n');
}

// Pull the first '# Heading' out for use as a title.
function title(markdown, fallback) {
  const m = String(markdown).match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : (fallback || 'Document');
}

module.exports = { toHtml, title, escapeHtml };
