/* A new folder typed at step 1 of New agent (#16351). The server makes one new folder inside one that exists (create_new_folder, #12833: createChosenFolder), and the team dialog already checks for it at its step 1
 * (_checkNewTeamFolder); this is the same check for the agent dialog, which sent create_dir for its own suggestion only and so answered a typed new folder with "directory not found" at Launch. */
import { serverFetch, LOCAL_SERVER } from './server_base.js';
import { usesSuggestion, fitsCoralFolder, offerCreateFolder } from './folder_suggestion.js';

const NEW_FOLDER_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;

/** Checks the folder in `input` on `server` before the dialog moves on. Resolves true when the launch may go on (the folder exists, is the suggestion, or is a new one inside an existing folder: input.dataset.createNew
 *  is then the path and `line` says Coral makes it), false when it may not (with `validate`, the words are said under the field through `invalid(input, words)`). A folder on another computer is left to the launch, as before. */
export async function checkNewAgentFolder({ input, line, server, validate = false, invalid }) {
    if (!input) return false;
    const dir = input.value.trim();
    const clear = () => { delete input.dataset.createNew; if (line && !line.hidden) line.hidden = true; };
    if (!dir) { clear(); return false; }
    if (usesSuggestion(input) || server !== LOCAL_SERVER || input.dataset.dirServer) { clear(); return true; } // the server makes its own suggestion; another computer's folders are checked there
    const still = () => input.value.trim() === dir;
    const refuse = words => { if (!still()) return false; clear(); if (validate && invalid) invalid(input, words); return false; };
    const m = /^(.*[\\/])([^\\/]+)[\\/]*$/.exec(dir);
    const canCreate = !!m && NEW_FOLDER_NAME.test(m[2]) && !/(^|[\\/])\.\.([\\/]|$)/.test(dir);
    const parent = m && (m[1].length > 1 ? m[1].replace(/[\\/]+$/, '') : m[1]);
    try {
        const response = await serverFetch(server, `/api/filesystem/list?path=${encodeURIComponent(dir)}`);
        if (!still()) return false;
        if (response.ok) { const data = await response.json(); if (!still()) return false; if (data.error) return refuse('The folder cannot be read. Choose an accessible folder.'); clear(); return true; }
        if (![403, 404].includes(response.status)) { clear(); return true; } // could not be checked here: the launch checks it, as it always did
        if (!canCreate) return refuse('Folder not found. Pick one with Browse, or type a new folder inside one that exists.');
        const parentResponse = await serverFetch(server, `/api/filesystem/list?path=${encodeURIComponent(parent)}`);
        if (!still()) return false;
        if (!parentResponse.ok) { // <home>/Coral/<name> with no Coral folder yet: the one shape the server makes whole (create_dir), so the same Create this folder offer as after a failed launch
            const offered = refuse('Folder not found, and neither is the folder it would be made in. Pick one with Browse.');
            if (validate && fitsCoralFolder(input.dataset.coralRoot, dir)) { const err = document.getElementById(`${input.id}-error`); if (err) err.textContent = 'Folder not found.'; offerCreateFolder(input); }
            return offered;
        }
        const parentData = await parentResponse.json();
        if (!still()) return false;
        if (parentData.error || !Array.isArray(parentData.entries)) return refuse('The folder it would be made in cannot be read. Pick another with Browse.');
        if (parentData.entries.includes(m[2])) return refuse('This folder exists but cannot be read. Choose an accessible folder.');
    } catch { clear(); return true; } // a check that could not run does not stop a launch the server can still judge
    input.dataset.createNew = dir;
    if (line) { line.textContent = `${m[2]} does not exist yet. Coral creates it inside ${parent} when you launch.`; line.hidden = false; }
    return true;
}
