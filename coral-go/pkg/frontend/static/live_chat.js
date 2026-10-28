/* Live chat public entry and message actions. History loading/rendering and view mode live in their own modules. */

// Preserve the original dependency evaluation order and listener registration order (#4996, #8353).
import './hooks_review.js';
import { state } from './state.js';
import { importOnce } from './import_once.js';
import { escapeHtml, showToast, copyText } from './utils.js';
import './actions.js';
import './platform/detect.js';
import './xterm_renderer.js';
import './vendor_loader.js';
import './agent_view.js';
import './render.js';
import { chatAgentAdapter } from './chat_agents.js';
import './server_base.js';
import './server_status.js';
import './terminal_gone.js';
import './overload.js';
import './local_store.js';
import { htmlToElement } from './chat_content.js';
import { flashCopied } from './chat_bubbles.js';
import './saved_marks.js';
import './pasted_content.js';
import './chat_page.js';
import { ownPromptCard } from './needs_input_card.js';
import './pending_messages.js';
import './safe_storage.js';
import './chat_thumbs.js';
import { renderToolCard } from './chat_tool_cards.js';
import { bubbleSource } from './chat_messages.js';
import './chat_kept_pages.js';
import './chat_jump_latest.js';
import { sendPromptAnswer } from './chat_prompt_empty.js';
import './command_autosize.js';
import './chat_announce.js';
import { wireMessageActions } from './message_actions.js';
import { historyGeneration } from './live_history.js';
import { fetchChatMessage } from './live_history_fetch.js';
import { prefetchTerminal } from './live_view_mode.js';
export { clearKeptChatPages } from './chat_kept_pages.js';
export { renderTranscript } from './chat_messages.js';
export { initCommandInputAutosize } from './command_autosize.js';
export { addPendingMessage, confirmPendingMessage, loadPendingFromStorage, removePendingMessage } from './pending_messages.js';
export { linkifyRefs } from './chat_bubbles.js';
export { refreshLiveHistory, chatHasOlder, loadMoreHistory, jumpToLiveMessage, stopLiveHistoryPoll, resetLiveHistory } from './live_history.js';
export { getLiveViewMode, clearViewOverride, effectiveLiveViewMode, applyLiveViewMode, terminalPrefetch, setLiveViewMode, showTerminalView, showChatView } from './live_view_mode.js';
export { stitchPages } from './live_history_render.js';

// Opening a card whose tool or output was shortened loads its message in full and shows that in
// the card. Checked by tool_use_id, so a transcript that changed underneath shows nothing wrong:
// the card then says its text was shortened.
async function loadTrimmedCard(card) {
    const session = state.currentSession;
    if (!session || card.dataset.trimLoading) return;
    card.dataset.trimLoading = "1";
    const generation = historyGeneration;
    try {
        const toolUseId = card.dataset.toolUseId || "";
        if (card.dataset.trimUse !== undefined) {
            const msg = await fetchChatMessage(session, Number(card.dataset.trimUse));
            if (generation !== historyGeneration) return;
            const tool = (msg && Array.isArray(msg.tool_uses) ? msg.tool_uses : []).find(t => (t.tool_use_id || "") === toolUseId);
            if (!tool || tool.trimmed) throw new Error("the message changed");
            const fresh = htmlToElement(renderToolCard(tool, chatAgentAdapter(session.agent_type)));
            const body = card.querySelector(":scope > .tool-call-body");
            const outputs = [...body.querySelectorAll(":scope > .tool-card-output")];
            body.replaceChildren(...fresh.querySelector(".tool-call-body").childNodes, ...outputs);
            delete card.dataset.trimUse;
        }
        if (card.dataset.trimResult !== undefined) {
            const msg = await fetchChatMessage(session, Number(card.dataset.trimResult));
            if (generation !== historyGeneration) return;
            if (!msg || msg.type !== "tool_result" || (msg.tool_use_id || "") !== (card.dataset.trimResultId || "") || msg.trimmed) {
                throw new Error("the message changed");
            }
            const pre = card.querySelector(".tool-card-output > pre");
            if (pre) pre.textContent = msg.content || "";
            delete card.dataset.trimResult;
            delete card.dataset.trimResultId;
        }
    } catch (e) {
        if (generation !== historyGeneration) return;
        const body = card.querySelector(":scope > .tool-call-body");
        if (body && !body.querySelector(":scope > .tool-card-trim-note")) {
            body.insertAdjacentHTML("beforeend", `<div class="tool-card-trim-note">Shortened; the full text couldn't be loaded (${escapeHtml(e.message || "error")}).</div>`);
        }
    } finally {
        delete card.dataset.trimLoading;
    }
}

// toggle doesn't bubble: caught on the way down.
document.addEventListener("toggle", (e) => {
    const card = e.target;
    if (!card || !card.open || !card.classList || !card.classList.contains("tool-call")) return;
    if (card.dataset.trimUse !== undefined || card.dataset.trimResult !== undefined) loadTrimmedCard(card);
}, true);


wireMessageActions(document.getElementById("live-history-messages")); // the chat container is in the page from the start

document.addEventListener("click", (e) => {
    const btn = e.target.closest && e.target.closest(".chat-msg-menu-btn");
    if (btn) importOnce('./message_menu.js').then(m => m.openMessageMenu(btn)).catch(() => {}); // Copy and Save for later on a message (#10159)
});

document.addEventListener("click", async (e) => {
    const btn = e.target.closest && e.target.closest(".chat-copy-btn");
    if (!btn) return;
    const bubble = btn.closest(".chat-bubble");
    const text = bubbleSource.get(bubble) ?? bubble.querySelector(".message-text")?.innerText ?? "";
    if (!(await copyText(text))) {
        showToast("Could not copy", true);
        return;
    }
    flashCopied(btn);
});


// The intent: pointer over, touch or keyboard focus on the Terminal button (it exists in the page from the start).
for (const type of ["pointerover", "touchstart", "focusin"]) {
    document.addEventListener(type, (e) => {
        if (e.target instanceof Element && e.target.closest("#live-view-btn-terminal, [data-on-click='terminal-view-open']")) prefetchTerminal();
    }, { capture: true, passive: true });
}


document.addEventListener("click", (e) => {
    const btn = e.target.closest && e.target.closest("#live-history-messages .cni-answer");
    if (!btn || btn.disabled || btn.nodeName !== "BUTTON") return;
    const card = ownPromptCard(btn);
    if (!card) return;
    btn.classList.add("sending");
    sendPromptAnswer(card, Number(btn.dataset.n), btn.dataset.label, btn.dataset.action).then(ok => {
        if (!ok) btn.classList.remove("sending");
    });
});

document.addEventListener("submit", (e) => {
    const form = e.target.closest && e.target.closest("#live-history-messages .cni-text-form");
    if (!form) return;
    e.preventDefault();
    if (!ownPromptCard(form)) return;
    const input = form.querySelector("input");
    const text = input.value.trim();
    if (!text) {
        input.focus();
        return;
    }
    sendPromptAnswer(ownPromptCard(form), Number(form.dataset.n), form.dataset.label, "text", text);
});
