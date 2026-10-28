/* The preview pane, loaded on first use (#9753). The pane is opened by a click, so its code (preview_pane.js and what only it uses) is not part of the
 * first screen: these are the entry points the startup modules call. The first open loads it, gives it the agent the page
 * is showing; until then there are no tabs, so closing them or switching agent has nothing to do but remember the agent. */
import { importOnce } from './import_once.js';
// The helpers the pane shares with other lazy modules (the artifact viewer, a goal's and a team's artifacts) stay startup modules: a lazy module may only import startup modules statically (import_hygiene).
import './overlay_history.js';
import './cm_util.js';
import './agent_file_api.js';
import './artifact_paths.js';
import './artifact_download.js';
import './artifact_preview.js';
import './preview_content.js';

let pane = null;     // the loaded module
let pending = null;  // the load in flight
let session = null;  // the agent the page shows, for a pane that loads later

/** The loaded pane (loading it on the first call): for a caller that needs more than an open. It is the one instance, with the agent the page shows. */
export function previewPane() {
    if (!pending) {
        pending = importOnce('./preview_pane.js').then(m => {
            pane = m;
            m.setPreviewSession(session);
            return m;
        }, e => { pending = null; throw e; });
    }
    return pending;
}
const load = previewPane;

const open = name => (...args) => { if (pane) return pane[name](...args); return load().then(m => m[name](...args)); };

export const openPreviewTab = open('openPreviewTab');
export const openArtifactTab = open('openArtifactTab');
export const openChatImageTab = open('openChatImageTab');

/** The agent the page shows: a loaded pane switches its tabs, one not yet loaded just remembers it. */
export function setPreviewSession(key) {
    session = key || null;
    if (pane) pane.setPreviewSession(session);
}

/** Closes every tab: none exist before the pane loads, unless an open is loading it, which this one follows. */
export function closeAllTabs() { if (pane) return pane.closeAllTabs(); if (pending) return pending.then(m => m.closeAllTabs()); }
