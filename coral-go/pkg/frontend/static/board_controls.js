/* The board's pause, sleep, per-message delete and copy-link controls (moved out of message_board.js, #8399; no behaviour change). */
import { build, keyRoute } from './routes.js';
import { showToast } from './utils.js';
import { boardFetch, pathId, teamFetch } from './server_base.js';
import { paintPauseButton } from './board_pause_button.js';
import { bs } from './board_state.js';
import { renderMessages } from './board_window.js';

let isSleeping = false;

/** Copy link: the message's own address (the team page's Board tab with the message's number). */
export async function copyMessageLink(id) {
    if (!bs.currentProject) return;
    const url = `${location.origin}${build(keyRoute('team', bs.currentProject, 'messages', Number(id)))}`;
    try { await navigator.clipboard.writeText(url); showToast('Link copied'); } catch { showToast('Could not copy the link', true); }
}

export async function loadPausedState(project) {
    try {
        const resp = await boardFetch(project, `/paused`);
        const data = await resp.json();
        bs.isPaused = !!data.paused;
        updatePauseButton();
    } catch (e) {
        bs.isPaused = false;
        updatePauseButton();
    }
}

function updatePauseButton() {
    // the page's own item is text; the team panel's button is an icon that one function paints (#5491)
    paintPauseButton(document.getElementById('board-chat-pause-btn'), bs.isPaused);
    const btn = document.getElementById('mb-pause-btn');
    if (!btn) return;
    btn.textContent = bs.isPaused ? 'Resume Board' : 'Pause Board';
    const note = document.getElementById('mb-pause-note'); if (note) note.textContent = bs.isPaused ? 'Agents get messages again when you resume.' : 'Agents stop receiving new messages until you resume.'; // what it does (#10008)
    btn.classList.toggle('mb-action-danger', bs.isPaused);
}

export async function toggleBoardPause() {
    if (!bs.currentProject) return;
    const action = bs.isPaused ? 'resume' : 'pause';
    try {
        const resp = await boardFetch(bs.currentProject, `/${action}`, {
            method: 'POST',
        });
        const data = await resp.json();
        bs.isPaused = !!data.paused;
        updatePauseButton();
    } catch (e) {
        console.error('Failed to toggle pause:', e);
    }
}

// The × on a message asks first: a deleted message is gone for every reader. The wording names the
// sender and the start of the text, so a mis-click on the wrong row is easy to spot (#3696).
 export function confirmDeleteBoardMessage(messageId) {
    const m = bs._allMessages.find(x => x.id === messageId);
    const text = m ? String(m.content || '').replace(/\s+/g, ' ').trim() : '';
    const what = m ? `the message from ${m.job_title || 'Unknown'}${text ? ` ("${text.length > 60 ? text.slice(0, 60) + '\u2026' : text}")` : ''}` : `message #${messageId}`;
    window.showConfirmModal('Delete message', `Delete ${what}? This cannot be undone.`, () => deleteBoardMessage(messageId), undefined, { label: 'Delete message', danger: true });
}

async function deleteBoardMessage(messageId) {
    if (!bs.currentProject) return;
    try {
        const resp = await boardFetch(bs.currentProject, `/messages/${pathId(messageId)}`, {
            method: 'DELETE',
        });
        if (!resp.ok) {
            console.error('Delete message failed:', resp.status);
            return;
        }
        // Remove locally and re-render
        bs._allMessages = bs._allMessages.filter(m => m.id !== messageId);
        bs._totalMessages = Math.max(0, bs._totalMessages - 1);
        bs._countedTotal = Math.max(0, bs._countedTotal - 1);
        renderMessages(bs._allMessages);
    } catch (e) {
        console.error('Failed to delete message:', e);
    }
}

export async function loadSleepState(project) {
    try {
        const resp = await teamFetch(project, n => `/api/sessions/live/team/${encodeURIComponent(n)}/sleep-status`);
        const data = await resp.json();
        isSleeping = !!data.sleeping;
        updateSleepUI();
    } catch (e) {
        isSleeping = false;
        updateSleepUI();
    }
}

function updateSleepUI() {
    const btn = document.getElementById('mb-sleep-btn');
    if (btn) {
        btn.textContent = isSleeping ? 'Wake Team' : 'Sleep Team';
        btn.classList.toggle('btn-warning', isSleeping);
    }
    const banner = document.getElementById('mb-sleep-banner');
    if (banner) {
        banner.style.display = isSleeping ? '' : 'none';
    }
    const input = document.getElementById('mb-post-input');
    const sendBtn = document.querySelector('#mb-board .btn-primary');
    if (input) {
        input.disabled = isSleeping;
        input.placeholder = isSleeping ? 'Team is sleeping...' : 'Message the team...';
    }
    if (sendBtn) {
        sendBtn.disabled = isSleeping;
        sendBtn.style.opacity = isSleeping ? '0.4' : '';
    }
}
