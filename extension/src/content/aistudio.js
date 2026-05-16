// Google AI Studio (aistudio.google.com) chat extractor.
// AI Studio uses Angular Material components (ms-* tags). Role is read from
// data-turn-role / class on ms-chat-turn; rendered model output lives inside
// ms-cmark-node (its KaTeX/markdown renderer).

(async () => {
  const { htmlToMarkdown } = await import(chrome.runtime.getURL('src/lib/markdown.js'));
  const { makeMessage, makeConversation } = await import(chrome.runtime.getURL('src/lib/schema.js'));

  const SELECTORS = {
    turn: 'ms-chat-turn',
    // Rendered markdown content (model side, but also wraps user text once committed).
    rendered: 'ms-cmark-node, ms-text-chunk, .turn-content, .very-large-text-container',
    // User-side raw text containers seen across AI Studio revisions.
    userText: '.user-prompt-container, [data-turn-role="User"] .turn-content, ms-prompt-chunk',
    // Thinking / "thought" sections collapse by default; capture if expanded.
    thinking: 'ms-thought-chunk, [data-thought], details.thinking',
  };

  function extractAIStudio() {
    const turns = Array.from(document.querySelectorAll(SELECTORS.turn));
    const messages = turns.map(extractMessage).filter(Boolean);

    return makeConversation({
      source: 'aistudio',
      title: getTitle(),
      url: location.href,
      sessionId: getSessionId(),
      messages,
    });
  }

  function getRole(turn) {
    const attr = (turn.getAttribute('data-turn-role') || '').toLowerCase();
    if (attr.includes('user')) return 'user';
    if (attr.includes('model')) return 'assistant';
    // Fall back to class / nested markers.
    if (turn.classList.contains('user') || turn.querySelector('[data-turn-role="User"], .user-prompt-container')) return 'user';
    if (turn.classList.contains('model') || turn.querySelector('[data-turn-role="Model"], .model-prompt-container')) return 'assistant';
    // Final fallback: presence of rendered markdown suggests the model.
    return turn.querySelector('ms-cmark-node') ? 'assistant' : 'user';
  }

  function extractMessage(turn) {
    const role = getRole(turn);

    let reasoning;
    const thinkingEl = turn.querySelector(SELECTORS.thinking);
    if (thinkingEl && role === 'assistant') {
      const tClone = thinkingEl.cloneNode(true);
      stripJunk(tClone);
      reasoning = htmlToMarkdown(tClone);
    }

    // Pick the best content container. Prefer rendered markdown when present.
    let contentEl = turn.querySelector(SELECTORS.rendered);
    if (!contentEl && role === 'user') contentEl = turn.querySelector(SELECTORS.userText);
    if (!contentEl) contentEl = turn;

    const clone = contentEl.cloneNode(true);
    stripJunk(clone);
    clone.querySelectorAll(SELECTORS.thinking).forEach(el => el.remove());

    const html = clone.innerHTML;
    const content = htmlToMarkdown(clone);
    if (!content) return null;

    return makeMessage({ role, content, html, reasoning });
  }

  function stripJunk(root) {
    const junk = [
      'button',
      '[role="button"]',
      'mat-icon',
      '.actions, .turn-actions, .action-buttons',
      '[aria-label="Copy"]',
      '[aria-label="More"]',
      // Grounding "Google Search Suggestions" block — Google requires it be
      // shown in the live UI, but it's noise in an exported transcript.
      'ms-search-entry-point, .search-entry-point',
      'ms-grounded-search-suggestions, .grounded-search-suggestions',
      '[class*="search-entry-point"]',
      '[class*="grounded-search-suggestions"]',
    ];
    junk.forEach(sel => root.querySelectorAll(sel).forEach(el => el.remove()));

    // Heading-based fallback: if a heading literally reads "Google Search
    // Suggestions", drop it and everything after it inside the same parent.
    root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(h => {
      if (/^\s*google search suggestions\s*$/i.test(h.textContent || '')) {
        let n = h;
        while (n) {
          const next = n.nextSibling;
          n.remove();
          n = next;
        }
      }
    });
  }

  function getSessionId() {
    // /prompts/{id} or /app/prompts/{id}
    const m = location.pathname.match(/\/prompts\/([^/?#]+)/);
    return m ? m[1] : '';
  }

  function getTitle() {
    // AI Studio shows the prompt title in the side rail; falls back to document.title.
    const active = document.querySelector(
      '.prompt-title, [data-test-id="prompt-title"], .conversation-title.selected'
    );
    if (active) {
      const t = active.textContent.trim();
      if (t) return t;
    }
    const docTitle = document.title.replace(/\s*[-–|]\s*(Google\s+)?AI\s*Studio\s*$/i, '').trim();
    return docTitle || 'AI Studio conversation';
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'EXTRACT') {
      try {
        sendResponse({ ok: true, data: extractAIStudio() });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
      return true;
    }
  });
})();
