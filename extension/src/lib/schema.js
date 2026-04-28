// Shared schema for normalized conversation messages.
// All extractors must produce objects matching this shape.
//
// Conversation = {
//   source: 'chatgpt' | 'claude' | 'gemini',
//   title: string,
//   url: string,
//   exportedAt: ISO8601 string,
//   messages: Message[]
// }
//
// Message = {
//   id: string,                      // stable per-message id from DOM if available
//   role: 'user' | 'assistant' | 'system',
//   content: string,                 // Markdown-rendered text
//   html: string,                    // raw HTML snapshot (for PDF rendering)
//   reasoning?: string,              // Markdown of "thinking" / extended reasoning blocks
//   attachments?: Array<{ name: string, type: string, url?: string }>,
//   timestamp?: string               // ISO8601 if extractable, else undefined
// }

export const SCHEMA_VERSION = 1;

export function makeConversation({ source, title, url, messages }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    source,
    title: title || 'Untitled conversation',
    url: url || (typeof location !== 'undefined' ? location.href : ''),
    exportedAt: new Date().toISOString(),
    messages: messages || [],
  };
}

export function makeMessage({ id, role, content, html, reasoning, attachments, timestamp }) {
  return {
    id: id || cryptoRandomId(),
    role,
    content: content || '',
    html: html || '',
    ...(reasoning ? { reasoning } : {}),
    ...(attachments && attachments.length ? { attachments } : {}),
    ...(timestamp ? { timestamp } : {}),
  };
}

function cryptoRandomId() {
  // Short, sortable, unique enough for export purposes.
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}
