'use strict';
/**
 * Session persistence for the agent panel.
 *
 * Conversations are kept in the workspace state so they survive closing the panel,
 * switching views and reloading the window — without them, "New chat" is
 * destructive and every reload silently loses the transcript.
 *
 * Each session is a small record: id, title, messages, created/updated time.
 * Only a bounded number are kept, and transcripts are capped so a very long
 * session cannot bloat workspace storage.
 */

const MAX_SESSIONS = 20;
const MAX_MESSAGES_PER_SESSION = 200;
const MAX_SESSION_CHARS = 2_000_000;

const KEY = 'workbuddyAgent.sessions';
const ACTIVE_KEY = 'workbuddyAgent.activeSession';

function newId() {
  return 's-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/** First meaningful user utterance, used as the session title. */
function deriveTitle(messages) {
  for (const m of messages || []) {
    if (m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
      const t = m.content.trim().replace(/\s+/g, ' ');
      return t.length > 60 ? t.slice(0, 60) + '…' : t;
    }
  }
  return 'New chat';
}

/** Rough size guard: drop the oldest turns until the transcript fits. */
function trimMessages(messages) {
  let out = messages.slice(-MAX_MESSAGES_PER_SESSION);
  const size = (arr) => JSON.stringify(arr).length;
  while (out.length > 4 && size(out) > MAX_SESSION_CHARS) out = out.slice(-Math.floor(out.length * 0.8));
  return out;
}

class SessionStore {
  constructor(state) {
    this.state = state;
  }

  all() {
    return this.state.get(KEY, []) || [];
  }

  /** Sessions newest-first, for display. */
  list() {
    return this.all()
      .slice()
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .map(s => ({
        id: s.id,
        title: s.title || 'New chat',
        updatedAt: s.updatedAt || 0,
        turns: (s.messages || []).filter(m => m.role === 'user').length,
      }));
  }

  get(id) {
    return this.all().find(s => s.id === id) || null;
  }

  activeId() {
    return this.state.get(ACTIVE_KEY, null);
  }

  async setActive(id) {
    await this.state.update(ACTIVE_KEY, id);
  }

  create() {
    const now = Date.now();
    return { id: newId(), title: 'New chat', messages: [], createdAt: now, updatedAt: now };
  }

  async save(session) {
    session.messages = trimMessages(session.messages || []);
    session.title = deriveTitle(session.messages);
    session.updatedAt = Date.now();

    let all = this.all().filter(s => s.id !== session.id);
    all.push(session);
    all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    all = all.slice(0, MAX_SESSIONS);
    await this.state.update(KEY, all);
    await this.state.update(ACTIVE_KEY, session.id);
    return session;
  }

  async remove(id) {
    const all = this.all().filter(s => s.id !== id);
    await this.state.update(KEY, all);
    if (this.activeId() === id) await this.state.update(ACTIVE_KEY, all.length ? all[0].id : null);
  }

  async clearAll() {
    await this.state.update(KEY, []);
    await this.state.update(ACTIVE_KEY, null);
  }
}

module.exports = { SessionStore, deriveTitle, KEY, ACTIVE_KEY };
