// Gemini (gemini.google.com) message extractor.
// Gemini uses Angular-style component tags; selectors target those component names.

(async () => {
  const { htmlToMarkdown } = await import(chrome.runtime.getURL('src/lib/markdown.js'));
  const { makeMessage, makeConversation } = await import(chrome.runtime.getURL('src/lib/schema.js'));

  const SELECTORS = {
    // Each conversation turn is a <user-query> followed by <model-response>.
    userQuery: 'user-query, .user-query-bubble-with-background',
    modelResponse: 'model-response, .model-response-text',
    // Inside the model response, the rendered Markdown lives in .markdown.
    modelMarkdown: '.markdown, message-content',
    userText: '.query-text, [data-test-id="user-prompt"]',
    // Thinking / drafts.
    thinking: 'thought-process, [data-test-id="thinking-block"]',
  };

  function extractGemini() {
    // Walk turns in document order by selecting both kinds and sorting.
    const userNodes = Array.from(document.querySelectorAll(SELECTORS.userQuery));
    const modelNodes = Array.from(document.querySelectorAll(SELECTORS.modelResponse));

    const all = [...userNodes.map(n => ({ n, role: 'user' })),
                 ...modelNodes.map(n => ({ n, role: 'assistant' }))];

    all.sort((a, b) => {
      if (a.n === b.n) return 0;
      const pos = a.n.compareDocumentPosition(b.n);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    const messages = all.map(({ n, role }) => extractMessage(n, role)).filter(Boolean);

    return makeConversation({
      source: 'gemini',
      title: getTitle(),
      url: location.href,
      sessionId: getSessionId(),
      messages,
    });
  }

  function getSessionId() {
    // /app/{id}
    const m = location.pathname.match(/\/app\/([^/?#]+)/);
    return m ? m[1] : '';
  }

  function extractMessage(node, role) {
    let contentEl;
    if (role === 'user') {
      contentEl = node.querySelector(SELECTORS.userText) || node;
    } else {
      contentEl = node.querySelector(SELECTORS.modelMarkdown) || node;
    }

    let reasoning;
    const thinkingEl = node.querySelector(SELECTORS.thinking);
    if (thinkingEl && role === 'assistant') {
      reasoning = htmlToMarkdown(thinkingEl.cloneNode(true));
    }

    const clone = contentEl.cloneNode(true);
    stripJunk(clone);
    if (thinkingEl) {
      clone.querySelectorAll(SELECTORS.thinking).forEach(el => el.remove());
    }

    const html = clone.innerHTML;
    const content = htmlToMarkdown(clone);
    if (!content) return null;

    return makeMessage({ role, content, html, reasoning });
  }

  function stripJunk(root) {
    const junkSelectors = [
      'button',
      '[role="button"]',
      'mat-icon',
      '.action-buttons',
      '[aria-label="Copy"]',
    ];
    junkSelectors.forEach(sel => {
      root.querySelectorAll(sel).forEach(el => el.remove());
    });
  }

  function getTitle() {
    // Gemini's active conversation title sits in the side rail.
    const active = document.querySelector(
      '[data-test-id="conversation"][aria-current="page"], .conversation.selected, .gds-title-s.selected'
    );
    if (active) {
      const t = active.textContent.trim();
      if (t) return t;
    }
    const docTitle = document.title.replace(/\s*[-–|]\s*Gemini\s*$/, '').trim();
    return docTitle || 'Gemini conversation';
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'EXTRACT') {
      try {
        sendResponse({ ok: true, data: extractGemini() });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
      return true;
    }
  });
})();
