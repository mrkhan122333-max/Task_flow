// Messages — 1:1 chat between any two active accounts (Admin ↔ Employee or
// Employee ↔ Employee), with near-real-time polling.

import { api } from '../api.js';
import { store } from '../store.js';
import { icon, avatar, spinner, emptyState, toast } from '../components.js';
import { esc, timeAgo, fmtDateTime, roleLabel } from '../util.js';

const PAGE_TITLE = 'Task Management · Cosmic Info Solutions';

export function renderMessages(main, opts = {}) {
  const me = store.user.id;
  const state = {
    conversations: [],
    selectedId: opts.selectedId || null,
    messages: [],
    lastInboxSig: '',
    lastThreadSig: '',
    threadBottom: true,
    sending: false,
  };

  main.innerHTML =
    '<div class="content-narrow">' +
      '<div class="messages-layout">' +
        '<div class="convo-pane">' +
          '<div class="thread-head" style="border-bottom:1px solid var(--c-border)"><strong>Messages</strong></div>' +
          '<div class="convo-list" id="convo-list">' + spinner() + '</div>' +
        '</div>' +
        '<div class="thread-pane" id="thread-pane">' +
          '<div id="thread-inner">' +
            '<div class="empty-state" style="padding:40px 20px">' +
              '<div class="empty-ic">' + icon('chat', 28) + '</div>' +
              '<h3>Select a conversation</h3>' +
              '<p>Choose a teammate on the left to start messaging.</p>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';

  const convoList = document.getElementById('convo-list');
  const threadPane = document.getElementById('thread-pane');
  const threadInner = document.getElementById('thread-inner');

  // ---------- inbox ----------
  async function loadInbox(silent) {
    let data;
    try {
      data = await api.get('/api/inbox');
    } catch (err) {
      if (!silent) toast(err.message, 'error');
      return;
    }
    const sig = JSON.stringify(data.conversations.map((c) => ({ id: c.user.id, last: c.last && c.last.id, unread: c.unread })));
    state.conversations = data.conversations;
    if (sig !== state.lastInboxSig) {
      state.lastInboxSig = sig;
      renderConvos();
    } else if (!convoList.dataset.rendered) {
      renderConvos();
    }
    // If the previously selected conversation got messages, refresh it.
    if (state.selectedId && sigChangedFor(state.selectedId)) refreshThread();
  }

  function sigChangedFor(userId) {
    const convo = state.conversations.find((c) => c.user.id === userId);
    if (!convo || !convo.last) return false;
    const existing = state.messages.find((m) => m.id === convo.last.id);
    return !existing;
  }

  function renderConvos() {
    convoList.dataset.rendered = '1';
    const unreadTotal = state.conversations.reduce((n, c) => n + c.unread, 0);
    document.title = unreadTotal ? '(' + unreadTotal + ') ' + PAGE_TITLE : PAGE_TITLE;

    if (!state.conversations.length) {
      convoList.innerHTML = emptyState('chat', 'No conversations yet',
        'Pick anyone from the list after you search, or an admin can message you first.');
      return;
    }

    convoList.innerHTML = state.conversations.map((c) =>
      '<div class="convo-item' + (c.user.id === state.selectedId ? ' active' : '') + '" data-user-id="' + esc(c.user.id) + '">' +
        avatar(c.user, 40) +
        '<div class="convo-main">' +
          '<div class="convo-name"><span>' + esc(c.user.displayName || c.user.username) + '</span>' +
            (c.last ? '<span class="convo-time">' + timeAgo(c.last.createdAt) + '</span>' : '') +
          '</div>' +
          '<div class="convo-last' + (c.unread ? ' unread' : '') + '">' +
            (c.last
              ? (c.last.fromId === me ? '<span class="muted">You: </span>' : '') + esc(c.last.text.slice(0, 60) + (c.last.text.length > 60 ? '…' : ''))
              : 'No messages yet') +
          '</div>' +
        '</div>' +
        (c.unread ? '<span class="unread-dot">' + c.unread + '</span>' : '') +
      '</div>').join('');

    convoList.querySelectorAll('[data-user-id]').forEach((el) => {
      el.addEventListener('click', () => selectConversation(el.getAttribute('data-user-id')));
    });
  }

  // ---------- thread ----------
  async function selectConversation(userId) {
    state.selectedId = userId;
    state.lastThreadSig = '';
    state.threadBottom = true;
    // Only rewrite the hash when it actually differs, otherwise selecting the
    // same person would be a no-op route change (or, on a deep link, would
    // re-enter the router needlessly).
    const nextHash = '#/messages/' + encodeURIComponent(userId);
    if (window.location.hash !== nextHash) window.location.hash = nextHash;
    threadPane.classList.add('show');
    if (state.conversations.length) renderConvos();
    else convoList.innerHTML = spinner();
    threadInner.innerHTML = spinner();
    await refreshThread();
    loadInbox(true);
  }

  async function refreshThread() {
    if (!state.selectedId) return;
    let data;
    try {
      data = await api.get('/api/conversations/' + encodeURIComponent(state.selectedId));
    } catch (err) {
      threadInner.innerHTML = '<p class="muted" style="text-align:center;padding:40px">' + esc(err.message) + '</p>';
      return;
    }
    const sig = JSON.stringify(data.messages.map((m) => m.id + m.read));
    const changed = sig !== state.lastThreadSig;
    state.lastThreadSig = sig;
    if (!changed && threadInner.dataset.rendered) return;
    threadInner.dataset.rendered = '1';
    state.messages = data.messages;

    const wasNearBottom = state.threadBottom;
    const prevScroll = threadInner.querySelector('.thread-body');
    const prevTop = prevScroll ? prevScroll.scrollTop : 0;

    renderThread(data);

    // Keep focus near the bottom.
    const body = threadInner.querySelector('.thread-body');
    if (body) {
      const near = wasNearBottom || (body.scrollHeight - body.scrollTop - body.clientHeight < 120);
      if (near) body.scrollTop = body.scrollHeight;
      else body.scrollTop = prevTop;
    }

    // Mark as read.
    const hasUnread = data.messages.some((m) => m.fromId === state.selectedId && !m.read);
    if (hasUnread) {
      api.post('/api/conversations/' + encodeURIComponent(state.selectedId) + '/read').then(() => loadInbox(true)).catch(() => {});
    }
  }

  function renderThread(data) {
    const other = data.other;
    const head = '<div class="thread-head">' +
      '<button type="button" class="icon-btn back-btn" id="thread-back">' + icon('chevL', 20) + '</button>' +
      avatar(other, 34) +
      '<div><strong>' + esc(other.displayName || other.username) + '</strong>' +
        '<div><span>' + esc(roleLabel(other.role)) +
          (other.designation ? ' · ' + esc(other.designation) : '') +
          ' · @' + esc(other.username) + '</span></div>' +
      '</div>' +
    '</div>';

    const body = '<div class="thread-body" id="thread-scroll">' +
      (data.messages.length
        ? data.messages.map((m) => {
            const mine = m.fromId === me;
            return '<div class="msg-row' + (mine ? ' mine' : '') + '">' +
              '<div class="msg-bubble">' + esc(m.text) + '</div>' +
              '<div class="msg-time">' + fmtDateTime(m.createdAt) + '</div>' +
            '</div>';
          }).join('')
        : '<p class="muted" style="text-align:center;padding:30px">No messages yet — say hi!</p>') +
    '</div>';

    const input = '<div class="thread-input">' +
      '<textarea id="msg-input" rows="1" placeholder="Write a message…"></textarea>' +
      '<button type="button" class="btn btn-primary" id="msg-send">' + icon('send', 16) + '</button>' +
    '</div>';

    threadInner.innerHTML = head + body + input;
    const backBtn = threadInner.querySelector('#thread-back');
    if (backBtn) {
      backBtn.addEventListener('click', () => threadPane.classList.remove('show'));
    }
    bindThreadInput(other);
  }

  function bindThreadInput(other) {
    const input = document.getElementById('msg-input');
    const sendBtn = document.getElementById('msg-send');
    if (!input) return;

    const send = async () => {
      if (state.sending) return;
      const text = input.value.trim();
      if (!text) return;
      state.sending = true;
      input.value = '';
      input.style.height = 'auto';
      try {
        await api.post('/api/messages', { toId: other.id, text });
        state.lastThreadSig = '';
        state.threadBottom = true;
        await refreshThread();
        loadInbox(true);
      } catch (err) {
        toast(err.message || 'Could not send message.', 'error');
        input.value = text;
      } finally {
        state.sending = false;
        input.focus();
      }
    };

    sendBtn.addEventListener('click', send);
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });

    const scrollBody = threadInner.querySelector('.thread-body');
    if (scrollBody) {
      scrollBody.addEventListener('scroll', () => {
        state.threadBottom = scrollBody.scrollHeight - scrollBody.scrollTop - scrollBody.clientHeight < 120;
      });
    }
  }

  // Poll every 3 seconds (acceptable without external services).
  const inboxTimer = setInterval(() => loadInbox(true), 3000);
  const threadTimer = setInterval(() => {
    if (state.selectedId) refreshThread();
  }, 3000);

  // A deep link (#/messages/<id>) selects the conversation only after the inbox
  // has arrived, so the conversation list is never painted before its data.
  loadInbox(false).then(() => {
    if (state.selectedId) selectConversation(state.selectedId);
  });

  return {
    clean() {
      clearInterval(inboxTimer);
      clearInterval(threadTimer);
      document.title = PAGE_TITLE;
    },
  };
}