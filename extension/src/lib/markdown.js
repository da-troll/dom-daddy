// HTML -> Markdown converter, intentionally narrow in scope.
// Tuned for the specific subset of HTML that ChatGPT, Claude, and Gemini
// produce in their message bubbles. Not a general-purpose tool.
//
// Handles:
//   - Headings (h1-h6)
//   - Paragraphs, line breaks
//   - Strong/em/code (inline)
//   - Links
//   - Ordered/unordered/nested lists
//   - Code blocks (preserves language from class="language-xyz")
//   - Tables (GFM)
//   - Block & inline KaTeX (extracts source TeX from <annotation encoding="application/x-tex">)
//   - Blockquotes
//   - Horizontal rules
//   - Images
//
// Anything unrecognized falls back to its text content.

export function htmlToMarkdown(node) {
  if (!node) return '';
  if (typeof node === 'string') {
    const tmp = document.createElement('div');
    tmp.innerHTML = node;
    node = tmp;
  }
  return convert(node).replace(/\n{3,}/g, '\n\n').trim();
}

function convert(node, ctx = { listDepth: 0, inPre: false }) {
  if (node.nodeType === Node.TEXT_NODE) {
    if (ctx.inPre) return node.nodeValue;
    return escapeInline(node.nodeValue.replace(/\s+/g, ' '));
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const tag = node.tagName.toLowerCase();

  // KaTeX rendered math: pull the original TeX source if present.
  if (node.classList?.contains('katex')) {
    const tex = node.querySelector('annotation[encoding="application/x-tex"]');
    if (tex) {
      const isDisplay = node.closest('.katex-display') || node.classList.contains('katex-display');
      return isDisplay ? `\n\n$$${tex.textContent}$$\n\n` : `$${tex.textContent}$`;
    }
  }
  if (tag === 'annotation' && node.getAttribute('encoding') === 'application/x-tex') {
    return ''; // already handled by parent
  }

  switch (tag) {
    case 'h1': return `\n\n# ${childText(node, ctx)}\n\n`;
    case 'h2': return `\n\n## ${childText(node, ctx)}\n\n`;
    case 'h3': return `\n\n### ${childText(node, ctx)}\n\n`;
    case 'h4': return `\n\n#### ${childText(node, ctx)}\n\n`;
    case 'h5': return `\n\n##### ${childText(node, ctx)}\n\n`;
    case 'h6': return `\n\n###### ${childText(node, ctx)}\n\n`;

    case 'p':   return `\n\n${childText(node, ctx)}\n\n`;
    case 'br':  return '  \n';
    case 'hr':  return '\n\n---\n\n';

    case 'strong':
    case 'b':   return `**${childText(node, ctx)}**`;
    case 'em':
    case 'i':   return `*${childText(node, ctx)}*`;
    case 'del':
    case 's':   return `~~${childText(node, ctx)}~~`;

    case 'a': {
      const href = node.getAttribute('href') || '';
      const text = childText(node, ctx) || href;
      return href ? `[${text}](${href})` : text;
    }

    case 'img': {
      const alt = node.getAttribute('alt') || '';
      const src = node.getAttribute('src') || '';
      return src ? `![${alt}](${src})` : '';
    }

    case 'code': {
      // Inline code only when not inside a <pre>.
      if (node.closest('pre')) return childText(node, { ...ctx, inPre: true });
      return '`' + node.textContent + '`';
    }

    case 'pre': {
      const codeEl = node.querySelector('code');
      const lang = detectLanguage(codeEl || node);
      const body = (codeEl || node).textContent.replace(/\n$/, '');
      return `\n\n\`\`\`${lang}\n${body}\n\`\`\`\n\n`;
    }

    case 'blockquote': {
      const inner = childText(node, ctx).trim();
      return '\n\n' + inner.split('\n').map(l => `> ${l}`).join('\n') + '\n\n';
    }

    case 'ul':
    case 'ol': {
      const ordered = tag === 'ol';
      const depth = ctx.listDepth;
      const indent = '  '.repeat(depth);
      const items = Array.from(node.children).filter(c => c.tagName.toLowerCase() === 'li');
      const lines = items.map((li, i) => {
        const marker = ordered ? `${i + 1}.` : '-';
        const content = childText(li, { ...ctx, listDepth: depth + 1 }).trim();
        // For nested lists, indent subsequent lines and drop blank padding.
        const [first, ...rest] = content.split('\n');
        const restNonBlank = rest.filter(r => r.trim() !== '');
        const restIndented = restNonBlank.map(r => `${indent}  ${r.replace(/^\s+/, '')}`).join('\n');
        return `${indent}${marker} ${first}${restNonBlank.length ? '\n' + restIndented : ''}`;
      });
      return '\n\n' + lines.join('\n') + '\n\n';
    }

    case 'table': {
      return convertTable(node, ctx);
    }

    case 'thead':
    case 'tbody':
    case 'tfoot':
    case 'tr':
    case 'th':
    case 'td':
      // Handled by convertTable.
      return childText(node, ctx);

    case 'script':
    case 'style':
    case 'noscript':
      return '';

    default:
      return childText(node, ctx);
  }
}

function childText(node, ctx) {
  let out = '';
  for (const child of node.childNodes) out += convert(child, ctx);
  return out;
}

function convertTable(table, ctx) {
  const rows = Array.from(table.querySelectorAll('tr'));
  if (!rows.length) return '';

  const matrix = rows.map(tr =>
    Array.from(tr.children).map(cell =>
      childText(cell, ctx).replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim()
    )
  );

  const colCount = Math.max(...matrix.map(r => r.length));
  matrix.forEach(r => { while (r.length < colCount) r.push(''); });

  // Detect header: first row has <th> children, or use first row as header.
  const firstHasTh = rows[0].querySelector('th') !== null;
  const header = firstHasTh ? matrix.shift() : new Array(colCount).fill('');
  const sep = new Array(colCount).fill('---');

  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${sep.join(' | ')} |`,
    ...matrix.map(r => `| ${r.join(' | ')} |`),
  ];
  return '\n\n' + lines.join('\n') + '\n\n';
}

function detectLanguage(codeEl) {
  if (!codeEl || !codeEl.className) return '';
  const m = codeEl.className.match(/language-([\w+-]+)/);
  if (m) return m[1];
  // ChatGPT also stores language on a sibling header element sometimes.
  const langAttr = codeEl.getAttribute('data-language');
  return langAttr || '';
}

function escapeInline(text) {
  // Don't aggressively escape — we're optimizing for readable Markdown,
  // not perfectly round-trippable Markdown.
  return text;
}
