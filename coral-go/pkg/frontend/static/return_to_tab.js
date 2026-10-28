/* Coming back to the page (the tab, or an installed app brought up from the background) refreshes what it shows at once and says so (#10068, desktop #10063 and mobile #10089):
 * a page that was in the background has a stale chat (its poll skips hidden windows) and often a feed socket the system closed, so the Working line a person sees is minutes old.
 * On return the feed reconnects now (not at the next backoff tick) and the open agent's chat and terminal are read again, with "Reconnecting…" (the feed is down) or "Loading chat…"
 * above the chat until that is done: never a blank view, never an old Working time with no word about it. The chat already on screen stays where it is.
 * Read when a return happens (app_wiring.js listens for visibilitychange, pageshow from the back-forward cache and the network coming back), not at start: the start weight is guarded. */
import { state } from './state.js';
import { connectCoralWs } from './websocket.js';
import { refreshCapture } from './capture.js';
import { refreshLiveHistory } from './live_chat.js';

const SHOW_AFTER_MS = 250; // a refresh that is quicker than this is not worth a flash
const GIVE_UP_MS = 10000;  // the note never outlives a refresh that hangs

/** True when the live feed socket is not open. */
function feedIsDown() { const ws = state.coralWs; return !ws || ws.readyState !== 1; }

function noteElement() {
    let el = document.getElementById('chat-return-note');
    if (el) return el;
    const chat = document.getElementById('live-history-messages');
    if (!chat || !chat.parentElement) return null;
    el = document.createElement('div');
    el.id = 'chat-return-note';
    el.className = 'loading-indicator';
    el.style.padding = '6px 16px'; // a slim line above the chat (a rule in the stylesheet would add to the guarded start weight)
    el.setAttribute('role', 'status');
    el.hidden = true;
    chat.parentElement.insertBefore(el, chat);
    return el;
}

let running = null;

/** Reconnect the feed if it is down and read the open agent again, saying which while it takes a moment. Runs once at a time. */
export function refreshOnReturn() {
    if (document.hidden) return Promise.resolve();
    if (running) return running;
    const down = feedIsDown();
    if (down) connectCoralWs();
    const live = state.currentSession && state.currentSession.type === 'live';
    if (!live) return Promise.resolve();
    const note = noteElement();
    const timers = [];
    if (note) timers.push(setTimeout(() => { note.textContent = down ? 'Reconnecting…' : 'Loading chat…'; note.hidden = false; }, SHOW_AFTER_MS));
    const done = () => { for (const t of timers) clearTimeout(t); if (note) { note.hidden = true; note.textContent = ''; } running = null; };
    if (note) timers.push(setTimeout(done, GIVE_UP_MS));
    running = Promise.allSettled([refreshCapture(), refreshLiveHistory()]).then(done);
    return running;
}
