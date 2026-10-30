// The first agent and the first team need a folder, and a person who has used none has nothing to pick from (#11258 item 3): the Folder field starts as
// <home>/Coral/<name>, which Coral makes when the launch is confirmed (create_dir). A person with a recent folder or a Settings default is not offered one, and
// a folder they type or Browse to is never made for them.
import { getRecentDirs } from './browser.js';
import { LOCAL_SERVER } from './server_base.js';

const SAFE = /[^A-Za-z0-9._-]+/g;

/** <root>/Coral/<name> with the root's own separator, or '' when there is no root. */
export function suggestedFolder(root, name) {
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

/** Fill `input` with the suggestion and show `line`, when the field is empty (or still the earlier suggestion), the server is this one and no recent folder exists. */
export function offerSuggestion(input, line, name) {
    if (!input || input.dataset.dirServer) return;
    const now = input.value.trim();
    if (now && !usesSuggestion(input)) { showLine(input, line, false); return; }
    if (getRecentDirs(LOCAL_SERVER).length) { if (usesSuggestion(input)) { input.value = ''; delete input.dataset.suggested; } showLine(input, line, false); return; }
    const dir = suggestedFolder(input.dataset.coralRoot, name);
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
