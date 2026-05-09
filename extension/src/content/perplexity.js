// Perplexity message extractor.
// Perplexity does not use data-testid for messages — the only stable anchors
// are class-based:
//   - User queries: any element whose class list contains the literal token
//     "group/query" (a Tailwind escaped class). The first turn renders as <h1>;
//     follow-ups render as <div>.
//   - Assistant answers: ".prose".
// Both interleave in document order, so we walk them together (same approach
// as the Claude extractor) to preserve turn sequence.

(async () => {
  const { htmlToMarkdown } = await import(chrome.runtime.getURL('src/lib/markdown.js'));
  const { makeMessage, makeConversation } = await import(chrome.runtime.getURL('src/lib/schema.js'));

  const SELECTORS = {
    // class~="group/query" matches the whole token even though it's inside
    // Tailwind's escaped form. Both <h1> and <div> queries carry it.
    userQuery: '[class~="group/query"]',
    assistantAnswer: '.prose',
  };

  function extractPerplexity() {
    const candidates = Array.from(document.querySelectorAll(
      `${SELECTORS.userQuery}, ${SELECTORS.assistantAnswer}`
    ));

    // Deduplicate: a .prose may live inside another .prose-styled wrapper in
    // future builds, and we never want to double-count.
    const seen = new WeakSet();
    const messages = [];

    for (const node of candidates) {
      let skip = false;
      for (const ancestor of ancestors(node)) {
        if (seen.has(ancestor)) { skip = true; break; }
      }
      if (skip) continue;
      seen.add(node);

      const msg = extractMessage(node);
      if (msg) messages.push(msg);
    }

    return makeConversation({
      source: 'perplexity',
      title: getTitle(),
      url: location.href,
      sessionId: getSessionId(),
      messages,
    });
  }

  function getSessionId() {
    // /search/{slug-or-uuid} — for slug threads this is "what-is-the-2QDzz06SQquIL5zD3uePgA"
    const m = location.pathname.match(/\/search\/([^/?#]+)/);
    return m ? m[1] : '';
  }

  function* ancestors(node) {
    let n = node.parentElement;
    while (n) { yield n; n = n.parentElement; }
  }

  function extractMessage(node) {
    const isUser = node.matches(SELECTORS.userQuery);
    const role = isUser ? 'user' : 'assistant';

    const clone = node.cloneNode(true);
    stripJunk(clone);

    const html = clone.innerHTML;
    const content = htmlToMarkdown(clone);
    if (!content) return null;

    return makeMessage({ role, content, html });
  }

  function stripJunk(root) {
    // Strip code-block copy buttons and language indicators (they sit inside
    // .prose). Other Perplexity chrome (Sources/Images/Videos tab buttons,
    // citation pills) lives outside the answer node, so we don't need to
    // filter it here.
    const junkSelectors = [
      '[data-testid="copy-code-button"]',
      '[data-testid="code-language-indicator"]',
      'button',
      '[role="button"]',
    ];
    junkSelectors.forEach(sel => {
      root.querySelectorAll(sel).forEach(el => el.remove());
    });
  }

  function getTitle() {
    const docTitle = document.title.replace(/\s*[-–|]\s*Perplexity\s*$/i, '').trim();
    return docTitle || 'Perplexity conversation';
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'EXTRACT') {
      try {
        sendResponse({ ok: true, data: extractPerplexity() });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
      return true;
    }
  });
})();
