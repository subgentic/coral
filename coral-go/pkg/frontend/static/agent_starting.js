/* A new agent's first seconds (#6382): the live list says it, `starting` on the row (true while the CLI has not emitted its first event, #6381). The composer says "Starting <agent>" in its box and Send says why a message may wait: the server holds a first
 * message until the CLI's input box is up and refuses it, before typing anything, after ReadyWait (10 s: agent_not_ready), so the words say a few seconds and that nothing is sent (#9948). Read from the row's own status only; nothing here counts time. */

/** True while the live list says the agent has not started yet. */
export function agentIsStarting(row) {
    return !!row && row.starting === true && row.agent_type !== "terminal" && !row.sleeping;
}

const SEND_STARTING_TITLE = "This agent is still starting: a message waits a few seconds for it, and if it is not ready nothing is sent";
const STARTING_HINT = "A message sent now waits a few seconds for it. If it is not ready, nothing is sent and your text stays here.";
const SEND_BUTTONS = '.btn-send, .mobile-send-btn[data-on-click="cmd-send"]';

let sendStarting = false; // the last answer, kept because the toolbar's buttons are rebuilt (controls.js) after it is given

/** Send's words while the agent starts (and back to its own when it has). */
export function syncSendStarting(starting = sendStarting) {
    sendStarting = !!starting;
    const hint = document.getElementById("composer-starting-hint"); // the same words as a quiet line above the box (#8242): a phone never shows Send's title
    if (hint) {
        if (starting) { // shown first and worded a frame later: a polite live region that appears with its words says nothing (the live-region census)
            if (hint.hidden) hint.hidden = false;
            requestAnimationFrame(() => { if (!hint.hidden && hint.textContent !== STARTING_HINT) hint.textContent = STARTING_HINT; }); // written once: a toolbar rebuild calls this again, and a rewritten text is read again by some screen readers (#8298)
        } else { if (!hint.hidden) hint.hidden = true; if (hint.textContent) hint.textContent = ""; }
    }
    document.querySelectorAll(SEND_BUTTONS).forEach(b => {
        if (starting) {
            if (b.dataset.startingWas === undefined) b.dataset.startingWas = JSON.stringify([b.getAttribute("title"), b.getAttribute("data-tooltip"), b.getAttribute("aria-label")]);
            b.setAttribute("title", SEND_STARTING_TITLE);
            if (b.hasAttribute("data-tooltip")) b.setAttribute("data-tooltip", SEND_STARTING_TITLE);
            b.setAttribute("aria-label", "Send: " + SEND_STARTING_TITLE);
        } else if (b.dataset.startingWas !== undefined) {
            const [title, tip, label] = JSON.parse(b.dataset.startingWas);
            delete b.dataset.startingWas;
            [["title", title], ["data-tooltip", tip], ["aria-label", label]].forEach(([k, v]) => { if (v === null) b.removeAttribute(k); else b.setAttribute(k, v); });
        }
    });
}
