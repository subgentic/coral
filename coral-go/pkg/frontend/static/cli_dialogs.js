/* Moved out of modals.js as it was (#4684): The CLI checks of the Settings paths (verify one or all), the 'CLI not found' dialog of a launch, and the permission-prompt warning. No behaviour change. */
import { importOnce } from './import_once.js';
import { registerDialog } from './modal_chrome.js';
import { state } from './state.js';
import { escapeHtml, escapeAttr } from './utils.js';
import { normServer, LOCAL_SERVER, serverFetch } from './server_base.js';
import { serverLabel } from './launch_server.js';
const { _settingsFor } = await importOnce('./launch_models.js');
const { defaultPermissionMode, permissionDescription, _getPermissionFlagsForAgentMode, _hasPermFlag } = await importOnce('./permission_flags.js');
const { CLI_INSTALL_INSTRUCTIONS } = await importOnce('./cli_check.js');
const { cliVerifyWords } = await importOnce('./cli_verify_words.js');
const { showSettingsModal } = await importOnce('./settings_dialog.js');

/** Verify a CLI path by calling the backend check endpoint. The words (and what to do when a path is refused) are cli_verify_words.js's (#10083). */
async function _checkOneCLI(inputId, resultId) {
    const input = document.getElementById(inputId);
    const resultEl = document.getElementById(resultId);
    if (!input || !resultEl) return;

    const binary = input.value.trim() || input.placeholder;
    resultEl.textContent = 'Checking…'; // a word: this line is a live region, and a screen reader would say "dot dot dot" (#10693)
    resultEl.className = 'cli-verify-result';
    resultEl.title = '';
    const why = _whyLine(resultEl);
    why.textContent = '';
    why.hidden = true;

    let words;
    try {
        // The type lets the server accept a path to that CLI's binary (#3583).
        const type = inputId.replace('settings-cli-path-', '');
        const resp = await fetch(`/api/system/cli-check?binary=${encodeURIComponent(binary)}&type=${encodeURIComponent(type)}`);
        let data = null;
        try { data = await resp.json(); } catch { data = null; }
        words = cliVerifyWords({ ok: resp.ok, status: resp.status, data, typed: input.value, type: (CLI_INSTALL_INSTRUCTIONS[type] || {}).label || type });
    } catch {
        words = cliVerifyWords({ error: true });
    }
    resultEl.textContent = words.text;
    resultEl.classList.add(words.cls);
    if (words.hint) { resultEl.title = words.hint; why.textContent = words.hint; why.hidden = false; resultEl.setAttribute('aria-describedby', why.id); } else resultEl.removeAttribute('aria-describedby');
}

/** The line under a result that says why a path was refused and what to do (made once, text only). */
function _whyLine(resultEl) {
    const id = `${resultEl.id}-why`;
    let why = document.getElementById(id);
    if (!why) {
        why = document.createElement('small');
        why.id = id;
        why.className = 'cli-verify-why';
        why.setAttribute('role', 'status');
        why.hidden = true;
        resultEl.insertAdjacentElement('afterend', why);
    }
    return why;
}

window._verifyAllCLIs = async function() {
    const btn = document.getElementById('verify-all-btn');
    if (btn && btn.getAttribute('aria-disabled') === 'true') return; // checking already
    if (btn) { btn.setAttribute('aria-disabled', 'true'); btn.textContent = 'Checking…'; } // not disabled: a disabled button that has the keyboard drops it to the page (#10693)
    await Promise.all([
        _checkOneCLI('settings-cli-path-claude', 'cli-result-claude'),
        _checkOneCLI('settings-cli-path-codex', 'cli-result-codex'),
        _checkOneCLI('settings-cli-path-agy', 'cli-result-agy'),
        _checkOneCLI('settings-cli-path-pi', 'cli-result-pi'),
    ]);
    if (btn) { btn.removeAttribute('aria-disabled'); btn.textContent = 'Verify All'; }
};

function _showCLINotFoundModal(agentType, server = LOCAL_SERVER, { retry = null } = {}) {
    const info = CLI_INSTALL_INSTRUCTIONS[agentType] || { name: agentType, cmd: `Install ${agentType} CLI` };
    const name = escapeHtml(info.name); // an agent type the table does not know is shown as it came (#4853)
    const label = escapeHtml(info.label || info.name); // the product's name, not the command's (#7450)
    const remote = normServer(server) !== LOCAL_SERVER;
    const where = remote ? `on ${escapeHtml(serverLabel(server, state.servers))}` : 'on this computer';
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.display = 'flex';
    modal.innerHTML = `
        <div class="modal-content dlg-confirm cli-dialog">
            <h3>${label} is not installed</h3>
            <p class="cli-dialog-text">
                Coral starts ${label} for you, but it is not installed ${where}. Run this in a terminal, then press Check again.
            </p>
            <div class="cli-dialog-command">
                <code>${escapeHtml(info.cmd)}</code>
                <button class="btn btn-small" data-on-click="info-copy" data-cmd="${escapeAttr(info.cmd)}">Copy</button>
            </div>
            ${/^https:\/\/[^\s"'<>]+$/.test(info.url || '') ? `<p class="cli-dialog-alt">Or use the official install page:<br><a href="${escapeAttr(info.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(info.url.replace(/^https:\/\//, ''))}</a></p>` : ''}
            ${info.note ? `<p class="cli-dialog-note">${escapeHtml(info.note)}</p>` : ''}
            <p class="cli-recheck-status" role="status" aria-live="polite"></p>
            <div class="modal-actions cli-dialog-actions">
                ${remote ? '' : '<button class="btn" data-action="settings">It is installed somewhere else</button>'}
                <button class="btn" data-action="close">Got it</button>
                <button class="btn btn-primary" data-action="recheck">Check again</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    const close = registerDialog(modal);
    modal.addEventListener('click', (e) => {
        if (e.target.dataset?.action === 'close') close();
        if (e.target.dataset?.action === 'settings') { close(); showSettingsModal(); }
        if (e.target.dataset?.action === 'recheck') _recheckCLI(e.target, modal, agentType, server, close, retry);
    });
}

/** "Check again" in the Not Found dialog (#5835): ask the server to look again. When the CLI is there: with a retry (the caller's own launch) close the dialog and run it, as the person meant to;
 *  without one say "Found it. Press Launch again." and close nothing (a launch from the board has no form to repeat). When it is not: say so (a Coral that was started before the install may not see
 *  the new PATH until it is restarted). The status is a live region that is always displayed and only has its text set, so a screen reader hears each answer. */
async function _recheckCLI(button, modal, agentType, server, close, retry) {
    const status = modal.querySelector('.cli-recheck-status');
    status.textContent = '';
    button.disabled = true; button.textContent = 'Checking…';
    try {
        const resp = await serverFetch(server, `/api/system/cli-check?type=${encodeURIComponent(agentType)}&source=cli_recheck`, { cache: 'no-store' });
        const data = await resp.json();
        if (resp.ok && data && data.found) {
            if (typeof retry === 'function') { close(); retry(); return; }
            status.textContent = 'Found it. Press Launch again.';
        } else status.textContent = resp.ok ? 'Still not found. If you just installed it, restart Coral so it sees the new install, or say where it is installed.' : 'Could not check just now. Try again.';
    } catch { status.textContent = 'Could not check just now. Try again.'; }
    button.disabled = false; button.textContent = 'Check again';
    if (modal.isConnected && !modal.contains(document.activeElement)) button.focus(); // disabling the button while it looked dropped the keyboard's place
}

// picked: the mode the launch form's select says. Codex's Default already is the launch that never asks (workspace-write, #7527), the one its Auto is: there is no flag to offer, so no warning (#7620).
// Claude's Default asks before it acts, which is not the saved default's launch: that one keeps its question.
function _checkPermissionFlag(flagsStr, agentType, server = LOCAL_SERVER, picked = '') {
    if (picked === 'default' && agentType === 'codex') return Promise.resolve('skip');
    const mode = defaultPermissionMode(_settingsFor(server), agentType);
    const permFlag = _getPermissionFlagsForAgentMode(agentType, mode);
    if (!permFlag) return Promise.resolve('skip');
    const modeLine = permissionDescription(agentType, mode); // what that mode means for THIS CLI (Antigravity and Gemini skip every check, Pi has no prompts)
    const modeName = { plan: 'Plan', acceptEdits: 'Accept edits', auto: 'Auto', bypassPermissions: 'Bypass permissions', dontAsk: "Don't ask" }[mode] || 'Auto'; // the saved default's name, not its CLI flag (#10074)
    return new Promise((resolve) => {
        if (flagsStr && _hasPermFlag(flagsStr)) {
            resolve('skip');
            return;
        }
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.style.display = 'flex';
        modal.innerHTML = `
            <div class="modal-content dlg-confirm cli-dialog cli-dialog-narrow">
                <h3>Default mode waits for you</h3>
                <p class="cli-dialog-text cli-dialog-text-roomy">
                    Default mode stops and waits for you each time. Use ${escapeHtml(modeName)} so it keeps going?
                </p>
                <p class="cli-dialog-text">${escapeHtml(modeName)}: ${escapeHtml(modeLine)}</p>
                <div class="modal-actions cli-dialog-actions-tight">
                    <button class="btn" data-action="cancel">Cancel</button>
                    <button class="btn" data-action="skip">Keep Default</button>
                    <button class="btn btn-primary" data-action="enable">Use ${escapeHtml(modeName)}</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        const close = registerDialog(modal, { onClose: () => resolve(null) }); // Escape and the backdrop cancel: the launch must not wait on a dialog that is gone
        modal.addEventListener('click', (e) => {
            const action = e.target.dataset?.action;
            if (action) {
                resolve(action === 'cancel' ? null : action);
                close();
            }
        });
    });
}

export { _checkPermissionFlag, _showCLINotFoundModal };
