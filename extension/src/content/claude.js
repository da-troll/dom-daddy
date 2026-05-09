// Claude.ai message extractor.
// Claude's DOM is less stable than ChatGPT's — class names are largely Tailwind
// utility classes, so we rely on data-testid and structural cues where possible.

(async () => {
  const { htmlToMarkdown } = await import(chrome.runtime.getURL('src/lib/markdown.js'));
  const { makeMessage, makeConversation } = await import(chrome.runtime.getURL('src/lib/schema.js'));

  const SELECTORS = {
    // User messages have data-testid="user-message".
    userMessage: '[data-testid="user-message"]',
    // Assistant messages: the rendered content lives inside .font-claude-message
    // or, in newer builds, [data-is-streaming] containers.
    assistantMessage: '.font-claude-message, [data-is-streaming]',
    // Conversation turns wrap both — used to walk in document order.
    turn: '[data-test-render-count], [data-testid="conversation-turn"]',
    // Thinking / extended-thinking blocks are collapsible details elements.
    thinking: 'details[data-testid="thinking-block"], [data-testid="extended-thinking"]',
  };

  function extractClaude() {
    // Walk all messages in DOM order rather than querying user/assistant separately,
    // so we preserve the conversation sequence.
    const allCandidates = Array.from(document.querySelectorAll(
      `${SELECTORS.userMessage}, ${SELECTORS.assistantMessage}`
    ));

    // Deduplicate: assistant selector may match both an outer and inner node.
    const seen = new WeakSet();
    const messages = [];

    for (const node of allCandidates) {
      // Skip if a parent in our list already covers this node.
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
      source: 'claude',
      title: getTitle(),
      url: location.href,
      sessionId: getSessionId(),
      messages,
    });
  }

  function getSessionId() {
    // /chat/{uuid} or /project/{pid}/chat/{cid} — we want the chat id
    const m = location.pathname.match(/\/chat\/([^/?#]+)/);
    return m ? m[1] : '';
  }

  function* ancestors(node) {
    let n = node.parentElement;
    while (n) { yield n; n = n.parentElement; }
  }

  function extractMessage(node) {
    const isUser = node.matches(SELECTORS.userMessage);
    const role = isUser ? 'user' : 'assistant';

    let reasoning;
    const thinkingEl = node.querySelector(SELECTORS.thinking);
    if (thinkingEl && !isUser) {
      reasoning = htmlToMarkdown(thinkingEl.cloneNode(true));
    }

    const clone = node.cloneNode(true);
    stripJunk(clone);
    if (thinkingEl) {
      clone.querySelectorAll(SELECTORS.thinking).forEach(el => el.remove());
    }

    const html = clone.innerHTML;
    const content = htmlToMarkdown(clone);
    const attachments = extractAttachments(node);

    if (!content && !attachments.length) return null;

    return makeMessage({ role, content, html, reasoning, attachments });
  }

  function extractAttachments(node) {
    const out = [];
    // Claude renders attachments as cards above user messages.
    node.querySelectorAll('[data-testid="file-thumbnail"], [data-testid*="attachment"]').forEach(el => {
      const name = el.getAttribute('aria-label')
        || el.querySelector('[data-testid="file-name"]')?.textContent?.trim()
        || el.textContent.trim().slice(0, 100);
      if (name) out.push({ name, type: 'file' });
    });
    return out;
  }

  function stripJunk(root) {
    const junkSelectors = [
      'button',
      '[role="button"]',
      '[aria-label="Copy"]',
      '[aria-label="Retry"]',
      '[data-testid="action-bar-copy"]',
    ];
    junkSelectors.forEach(sel => {
      root.querySelectorAll(sel).forEach(el => el.remove());
    });
  }

  function getTitle() {
    // Claude puts the conversation title in the header area.
    const header = document.querySelector('header [data-testid="chat-menu-trigger"], header h1, header button[aria-haspopup]');
    if (header) {
      const t = header.textContent.trim();
      if (t && t.toLowerCase() !== 'new chat') return t;
    }
    const docTitle = document.title.replace(/\s*[-–|]\s*Claude\s*$/, '').trim();
    return docTitle || 'Claude conversation';
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'EXTRACT') {
      try {
        sendResponse({ ok: true, data: extractClaude() });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
      return true;
    }
  });
})();
