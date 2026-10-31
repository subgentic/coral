// The first agent and the first team need a folder, and a person who has used none has nothing to pick from (#11258 item 3): the Folder field starts as
// <home>/Coral/<name>, which Coral makes when the launch is confirmed (create_dir). A person with a recent folder or a Settings default is not offered one, and
// a folder they type or Browse to is never made for them.
import { getRecentDirs } from './browser.js';
import { LOCAL_SERVER } from './server_base.js';

const SAFE = /[^A-Za-z0-9._-]+/g;

/** <root>/Coral/<name> with the root's own separator, or '' when there is no root. */
function suggestedFolder(root, name) {
    const r = String(root || '').replace(/[\\/]+$/, '');
    if (!r) return '';
    const sep = r.includes('\\') && !r.includes('/') ? '\\' : '/';
    const n = String(name || '').trim().replace(SAFE, '-').replace(/^[-.]+|-+$/g, '').slice(0, 64) || 'first-agent';
    return `${r}${sep}Coral${sep}${n}`;
}

/** True when the field still holds the folder this module suggested: only then is create_dir sent. */
export function usesSuggestion(input) {
    return !!(input && input.dataset.suggested && input.value.trim() === input.dataset.suggested);
}

/** True when every recent folder is one Coral made under <root>/Coral/ (a person who has only used the suggestions has chosen no folder of their own, #11336). */
export function onlyCoralMadeRecents(root, recents) {
    const r = String(root || '').replace(/[\\/]+$/, '');
    return !!r && recents.length > 0 && recents.every(d => { const x = String(d || '').replace(/\\/g, '/'); return x.startsWith(`${r.replace(/\\/g, '/')}/Coral/`); });
}

/** A name under <root>/Coral/ that no recent folder uses: first-team, first-team-2, ... */
function freshFolder(root, name, recents) {
    const taken = new Set(recents.map(d => String(d || '').replace(/[\\/]+$/, '')));
    for (let n = 1; n < 100; n++) { const f = suggestedFolder(root, n === 1 ? name : `${name}-${n}`); if (f && !taken.has(f)) return f; }
    return suggestedFolder(root, name);
}

/** Fill `input` with the suggestion and show `line`, when the field is empty (or still the earlier suggestion), the server is this one and no recent folder exists. With `afterCoralMade` the recent
 *  folders being only ones Coral itself made (the first agent's) is no reason to leave the field empty: a team is offered its own new folder beside them (#11336). */
export function offerSuggestion(input, line, name, { afterCoralMade = false } = {}) {
    if (!input || input.dataset.dirServer) return;
    const now = input.value.trim();
    if (now && !usesSuggestion(input)) { showLine(input, line, false); return; }
    const recents = getRecentDirs(LOCAL_SERVER), mayOffer = !recents.length || (afterCoralMade && onlyCoralMadeRecents(input.dataset.coralRoot, recents));
    if (!mayOffer) { if (usesSuggestion(input)) { input.value = ''; delete input.dataset.suggested; } showLine(input, line, false); return; }
    const dir = recents.length ? freshFolder(input.dataset.coralRoot, name, recents) : suggestedFolder(input.dataset.coralRoot, name);
    if (!dir) return;
    input.value = dir; input.dataset.suggested = dir;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    showLine(input, line, true);
}

/** Keep the line true as the person edits: it goes as soon as the field is anything but the suggestion. */
export function syncSuggestionLine(input, line) { showLine(input, line, usesSuggestion(input)); }

function showLine(input, line, on) {
    if (!line) return;
    if (line.hidden === on) line.hidden = !on;
    const ids = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter(x => x && x !== line.id);
    if (on) ids.push(line.id);
    if (ids.length) input.setAttribute('aria-describedby', ids.join(' ')); else input.removeAttribute('aria-describedby');
}

/** True when `value` is <root>/Coral/<name>, the one shape the server makes (create_dir, launch_create_dir.go): a path outside it only gets the error and Browse. */
export function fitsCoralFolder(root, value) {
    const r = String(root || '').replace(/\\/g, '/').replace(/\/+$/, ''), v = String(value || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
    return !!r && v.startsWith(`${r}/Coral/`) && v.length > r.length + 7 && !v.slice(r.length + 7).includes('/');
}

/** After the server said the folder does not exist (the error line is up): a "Create this folder" button inside that line when the path is one Coral may make. It marks the value as
 *  the suggestion, so create_dir goes with the next launch, and takes the error away. Returns true when the button was added. */
export function offerCreateFolder(input) {
    const err = input && document.getElementById(`${input.id}-error`);
    if (!err || input.dataset.dirServer || !fitsCoralFolder(input.dataset.coralRoot, input.value)) return false;
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn field-error-action'; b.textContent = 'Create this folder';
    b.addEventListener('click', () => {
        input.dataset.suggested = input.value.trim();
        input.dispatchEvent(new Event('input', { bubbles: true })); // the error goes, the suggestion line says Coral makes it at Launch
        input.focus();
    });
    err.append(' ', b);
    return true;
}
