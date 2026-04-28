// ChatGPT message extractor.
// ChatGPT virtualizes the message list: persistent [data-turn] scroll anchors
// always exist, but the actual [data-message-author-role] content is only
// mounted for turns near the viewport. We scroll each turn into view, wait
// for its content to mount, extract, then move on.

(async () => {
  const { htmlToMarkdown } = await import(chrome.runtime.getURL('src/lib/markdown.js'));
  const { makeMessage, makeConversation } = await import(chrome.runtime.getURL('src/lib/schema.js'));

  const SELECTORS = {
    turnAnchor: '[data-turn]',
    messageNode: '[data-message-author-role]',
    roleAttr: 'data-message-author-role',
    messageIdAttr: 'data-message-id',
    messageContent: '.markdown, [data-message-content], .text-message',
    activeChatTitle: 'nav a[data-active="true"], nav [aria-current="page"]',
    reasoningBlock: '[data-testid="reasoning"], [data-message-author-role="tool"]',
  };

  const MOUNT_POLL_MS = 30;
  const MOUNT_TIMEOUT_MS = 600;

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function waitFor(predicate, timeoutMs = MOUNT_TIMEOUT_MS, intervalMs = MOUNT_POLL_MS) {
    const start = performance.now();
    while (performance.now() - start < timeoutMs) {
      const v = predicate();
      if (v) return v;
      await sleep(intervalMs);
    }
    return predicate();
  }

  async function extractChatGPT() {
    const anchors = Array.from(document.querySelectorAll(SELECTORS.turnAnchor));

    // Fallback: if there are no [data-turn] anchors but there are mounted
    // message nodes, use those directly (older ChatGPT layouts, edge cases).
    if (!anchors.length) {
      const nodes = Array.from(document.querySelectorAll(SELECTORS.messageNode));
      const messages = nodes.map(extractMessage).filter(Boolean);
      return makeConversation({
        source: 'chatgpt',
        title: getTitle(),
        url: location.href,
        messages,
      });
    }

    const savedScroll = window.scrollY;
    const byId = new Map();        // data-message-id -> message
    const byIndex = new Map();     // anchor index (fallback for missing ids)
    const order = [];              // order of insertion (anchor index)

    for (let i = 0; i < anchors.length; i++) {
      const anchor = anchors[i];
      anchor.scrollIntoView({ block: 'center', behavior: 'auto' });
      // Give React a tick to mount the content for this turn.
      const node = await waitFor(
        () => anchor.querySelector(SELECTORS.messageNode)
              || document.querySelector(SELECTORS.messageNode + '[data-turn-index="' + i + '"]'),
      );
      if (!node) continue;

      const msg = extractMessage(node);
      if (!msg) continue;

      const id = node.getAttribute(SELECTORS.messageIdAttr);
      if (id) {
        if (!byId.has(id)) {
          byId.set(id, msg);
          order.push({ kind: 'id', key: id });
        }
      } else {
        byIndex.set(i, msg);
        order.push({ kind: 'idx', key: i });
      }
    }

    // Restore the user's scroll position.
    window.scrollTo({ top: savedScroll, behavior: 'auto' });

    const messages = order.map(o => o.kind === 'id' ? byId.get(o.key) : byIndex.get(o.key));

    return makeConversation({
      source: 'chatgpt',
      title: getTitle(),
      url: location.href,
      messages,
    });
  }

  function extractMessage(node) {
    const role = node.getAttribute(SELECTORS.roleAttr);
    if (!role || (role !== 'user' && role !== 'assistant' && role !== 'system')) return null;

    const id = node.getAttribute(SELECTORS.messageIdAttr) || undefined;
    const contentEl = node.querySelector(SELECTORS.messageContent) || node;

    const reasoningEl = node.querySelector(SELECTORS.reasoningBlock);
    let reasoning;
    if (reasoningEl && reasoningEl !== contentEl) {
      reasoning = htmlToMarkdown(reasoningEl.cloneNode(true));
    }

    const clone = contentEl.cloneNode(true);
    stripJunk(clone);
    if (reasoningEl) {
      clone.querySelectorAll(SELECTORS.reasoningBlock).forEach(el => el.remove());
    }

    const html = clone.innerHTML;
    const content = htmlToMarkdown(clone);
    const attachments = extractAttachments(node);

    return makeMessage({ id, role, content, html, reasoning, attachments });
  }

  function extractAttachments(node) {
    const out = [];
    node.querySelectorAll('[data-testid*="attachment"], [data-attachment]').forEach(el => {
      const name = el.getAttribute('aria-label') || el.textContent.trim().slice(0, 100);
      if (name) out.push({ name, type: 'file' });
    });
    node.querySelectorAll('img').forEach(img => {
      const src = img.getAttribute('src');
      if (!src || src.startsWith('data:')) return;
      if (img.closest('[data-message-author-role="user"]')) {
        out.push({ name: img.getAttribute('alt') || 'image', type: 'image', url: src });
      }
    });
    return out;
  }

  function stripJunk(root) {
    const junkSelectors = [
      'button',
      '[role="button"]',
      '[data-testid="copy-turn-action-button"]',
      '[aria-label="Copy"]',
      '[aria-label="Edit message"]',
    ];
    junkSelectors.forEach(sel => {
      root.querySelectorAll(sel).forEach(el => el.remove());
    });
  }

  function getTitle() {
    const active = document.querySelector(SELECTORS.activeChatTitle);
    if (active) {
      const t = active.textContent.trim();
      if (t) return t;
    }
    const docTitle = document.title.replace(/^ChatGPT\s*[-–|]\s*/, '').trim();
    return docTitle || 'ChatGPT conversation';
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'EXTRACT_CONVERSATION') {
      extractChatGPT()
        .then(conv => sendResponse({ ok: true, conversation: conv }))
        .catch(err => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true; // async
    }
  });
})();
