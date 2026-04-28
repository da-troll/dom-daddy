import {
  exportMarkdown,
  exportText,
  exportJSON,
  exportCSV,
} from '../exporters/exporters.js';

const SUPPORTED_HOSTS = {
  'chatgpt.com': 'chatgpt',
  'chat.openai.com': 'chatgpt',
  'claude.ai': 'claude',
  'gemini.google.com': 'gemini',
};

const CONTENT_SCRIPTS = {
  chatgpt: 'src/content/chatgpt.js',
  claude: 'src/content/claude.js',
  gemini: 'src/content/gemini.js',
};

const els = {
  status: document.getElementById('status'),
  metaTitle: document.getElementById('meta-title'),
  metaSub: document.getElementById('meta-sub'),
  options: document.getElementById('options'),
  formats: document.getElementById('formats'),
  optReasoning: document.getElementById('opt-reasoning'),
  defaultFmt: document.getElementById('default-fmt'),
};

let cachedConv = null;
let cachedTab = null;

init();

async function init() {
  const tab = await getActiveTab();
  cachedTab = tab;
  if (!tab?.url) {
    setStatus('No active tab', 'error');
    return;
  }

  let host;
  try { host = new URL(tab.url).hostname; }
  catch { host = ''; }

  const source = SUPPORTED_HOSTS[host];
  if (!source) {
    setStatus('Open ChatGPT, Claude, or Gemini to export.', 'ok');
    return;
  }

  setStatus('Reading conversation…');

  try {
    const conv = await requestExtraction(tab.id, source);
    if (!conv || !conv.messages?.length) {
      setStatus('No messages found on this page.', 'error');
      return;
    }
    cachedConv = conv;
    populateMeta(conv);
    els.options.hidden = false;
    els.formats.hidden = false;
    setStatus('Ready', 'ok');
    // Auto-focus default format so Enter exports immediately.
    els.defaultFmt?.focus();
  } catch (err) {
    setStatus('Could not read conversation. Reload the page and try again.', 'error');
    console.error(err);
  }

  els.formats.addEventListener('click', onFormatClick);
}

function populateMeta(conv) {
  els.metaTitle.textContent = conv.title;
  els.metaTitle.title = conv.title;
  els.metaTitle.hidden = false;
  const n = conv.messages.length;
  els.metaSub.textContent = `${n} message${n === 1 ? '' : 's'} · ${conv.source}`;
  els.metaSub.hidden = false;
}

async function onFormatClick(e) {
  const btn = e.target.closest('button.fmt');
  if (!btn || !cachedConv) return;

  const format = btn.dataset.format;
  const opts = {
    includeReasoning: els.optReasoning.checked,
  };

  const source = SUPPORTED_HOSTS[new URL(cachedTab.url).hostname];

  // Re-extract on each export so users get the live state, not a stale snapshot.
  try {
    const fresh = await requestExtraction(cachedTab.id, source);
    if (fresh?.messages?.length) cachedConv = fresh;
  } catch { /* fall through with cached version */ }

  let result;
  switch (format) {
    case 'md':   result = exportMarkdown(cachedConv, opts); break;
    case 'txt':  result = exportText(cachedConv); break;
    case 'json': result = exportJSON(cachedConv); break;
    case 'csv':  result = exportCSV(cachedConv); break;
    default: return;
  }

  await downloadBlob(result.filename, result.blob);
  setStatus(`Saved ${result.filename}`, 'ok');
}

async function downloadBlob(filename, blob) {
  // Convert to data URL — service workers can't access createObjectURL on content blobs reliably,
  // but in the popup we can. We use chrome.downloads for a proper save dialog.
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename, saveAs: true });
  } finally {
    // Revoke after a delay so the download has time to start.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

async function requestExtraction(tabId, source) {
  try {
    return await sendExtractMessage(tabId);
  } catch (err) {
    // Most likely cause: content script wasn't injected (extension installed
    // after the tab was already open). Inject programmatically and retry once.
    const file = CONTENT_SCRIPTS[source];
    if (!file) throw err;
    await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
    return await sendExtractMessage(tabId);
  }
}

function sendExtractMessage(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_CONVERSATION' }, (resp) => {
      const lastErr = chrome.runtime.lastError;
      if (lastErr) return reject(new Error(lastErr.message));
      if (!resp?.ok) return reject(new Error(resp?.error || 'extraction failed'));
      resolve(resp.conversation);
    });
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.className = 'status' + (kind ? ` status--${kind}` : '');
}
