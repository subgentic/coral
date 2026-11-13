import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
installDom({ mode: 'local' });
const { state } = await importUi('state');
const pm = await importUi('pending_messages');
const { keepFirstPage } = await importUi('chat_kept_pages');
const { refreshLiveHistory, resetLiveHistory } = await importUi('live_history');
const box = document.getElementById('live-history-messages');
const failures = [];
for (const [id, content] of [['plain-user', 'Please focus on the release'], ['queued-command', 'Please prepare a local test build']]) {
    const now = Date.now();
    const session = { session_id: id, name: id, agent_type: 'claude', type: 'live', working: true };
    state.currentSession = session;
    state.liveSessions = [session];
    state.currentView = 'chat';
    resetLiveHistory();
    pm.addPendingMessage(id, content, now - 1000);
    // Both Claude wire shapes normalize to user messages. A kept page must
    // settle them exactly as a fresh history response does, even with no delta.
    const receipt = { type: 'user', content, timestamp: new Date(now).toISOString() };
    pm.addPendingMessage(id, 'A different message still waiting', now + 1);
    keepFirstPage(id, [receipt], 1, 0);
    globalThis.fetch = window.fetch = async () => Response.json({ messages: [], total: 1, start: 1, has_more: false });
    await refreshLiveHistory();
    pm.syncPendingBubbles(box, id);
    assert.ok(box.textContent.includes(content), id + ': kept transcript rendered');
    if (box.querySelectorAll('.chat-bubble.pending').length !== 1 || box.querySelector('.chat-bubble.pending')?.textContent.includes(content)) failures.push(id + ': delivered receipt in kept history leaves pending bubble');
    assert.ok(box.querySelector('.chat-bubble.pending')?.textContent.includes('A different message still waiting'), id + ': unrelated queued message stays pending');
    session.working = false;
    state.lastSendAt.delete(id);
    pm.syncWorkingIndicator(box, session);
}
assert.deepEqual(failures, []);
console.log('pending kept receipts ok');
