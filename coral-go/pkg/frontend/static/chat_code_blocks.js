// Code controls load with the first code block; their behavior is unchanged.
import { copyText, showToast } from './utils.js';

// Swap a copy button's icon to a check for a moment after copying.
export function flashCopied(btn) {
    const icon = btn.querySelector(".material-icons");
    icon.textContent = "check";
    btn.classList.add("copied");
    clearTimeout(btn._copiedTimer);
    btn._copiedTimer = setTimeout(() => {
        icon.textContent = "content_copy";
        btn.classList.remove("copied");
    }, 1500);
}

export function addCodeCopyButtons(root) {
    for (const pre of root.querySelectorAll(".message-text pre")) {
        if (pre.parentElement.classList.contains("code-block")) continue;
        const wrap = document.createElement("div");
        wrap.className = "code-block";
        pre.replaceWith(wrap);
        wrap.appendChild(pre);
        wrap.insertAdjacentHTML("beforeend", `<span class="code-scroll-hint" hidden>Scrolls sideways</span><button type="button" class="code-wrap-btn" title="Wrap long lines" aria-label="Wrap lines" aria-pressed="false">Wrap</button><button type="button" class="code-copy-btn" title="Copy code" aria-label="Copy code"><span class="material-icons" aria-hidden="true">content_copy</span></button>`);
        wireCodeBlocks();
        requestAnimationFrame(() => syncCodeScroll(wrap)); // the hint is drawn once the block has its width (#10533)
    }
}

/** A block whose line is cut says so, until its lines are wrapped (#10533, the Desktop tester: a long line scrolled with nothing to say so). */
function syncCodeScroll(block) {
    const pre = block.querySelector("pre"), hint = block.querySelector(".code-scroll-hint");
    if (!pre || !hint) return;
    const inner = pre.querySelector("code") || pre; // the highlighted code element is the one that scrolls
    hint.hidden = block.classList.contains("code-wrapped") || !(Math.max(pre.scrollWidth - pre.clientWidth, inner.scrollWidth - inner.clientWidth) > 1);
}
// The page-wide listeners of code blocks (Wrap lines, the scroll hint's resize, Copy) are registered when the first code block is drawn, not at startup (#11032: nothing on the start screen has one).
let codeListenersOn = false;
function wireCodeBlocks() {
    if (codeListenersOn) return;
    codeListenersOn = true;
    window.addEventListener("resize", () => { for (const b of document.querySelectorAll(".code-block")) syncCodeScroll(b); });
    document.addEventListener("click", (e) => {
        const btn = e.target.closest && e.target.closest(".code-wrap-btn");
        if (!btn) return;
        const block = btn.parentElement, on = block.classList.toggle("code-wrapped");
        btn.setAttribute("aria-pressed", String(on));
        btn.title = on ? "Stop wrapping long lines" : "Wrap long lines";
        syncCodeScroll(block);
    });
    document.addEventListener("click", async (e) => {
        const btn = e.target.closest && e.target.closest(".code-copy-btn");
        if (!btn) return;
        const code = btn.parentElement.querySelector("pre");
        if (!(await copyText(code ? code.textContent.replace(/\n$/, "") : ""))) {
            showToast("Could not copy", true);
            return;
        }
        flashCopied(btn);
    });
}

