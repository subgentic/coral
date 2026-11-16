/* Where an artifact's bytes come from, and what its Download saves (moved out of artifact_preview.js, #17351; not artifact_source.js, which is the viewer's capture of a source): the preview pane needs these at once, to open a tab and draw its toolbar, while the renderer
 * (artifact_preview.js, with its report, download and sandbox helpers) loads when the first artifact is drawn, so the start's bytes do not carry it. */
import { state } from './state.js';
import { splitKey, serverUrl, contextServer, artifactPath } from './server_base.js';
import { inlineArtifactPath } from './artifact_paths.js';

export const CORAL_ARTIFACT_URI_RE = /^coral:\/\/artifacts\/([a-f0-9]{64})$/i;

/** What a Download should save for an artifact that is a manifest (#9925): the manifest is a JSON list of files, so its Download saved a .json where the person wanted the file. One entry: that file, by its own name.
 *  Several: none (each row has its own Download, and the toolbar's Download JSON is the manifest itself), so null. */
export function manifestDownload(entries, server = contextServer()) {
    if (!Array.isArray(entries) || entries.length !== 1) return null;
    const m = CORAL_ARTIFACT_URI_RE.exec(entries[0].uri || '');
    return m ? { url: serverUrl(artifactPath(m[1]), server), name: entries[0].name } : null;
}

/** Resolve where an artifact's bytes come from; null when the source is unusable. */
export function resolveArtifactSource(uri, options = {}) {
    const match = CORAL_ARTIFACT_URI_RE.exec(uri);
    const board = options.board || (state.selectedTeam ? splitKey(state.selectedTeam).name : (state.currentSession?.board_project || '')); // options.board: a screen that names its own team (the Inbox's goal, #8914)
    const inlineURL = inlineArtifactPath(options.contentURL, board); // exactly the shape this route has, for this board (a registered server's value must name no other route)
    let externalURL = null;
    try {
        const parsed = new URL(options.externalURL);
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') externalURL = parsed.href;
    } catch { /* Only explicit HTTP(S) links can be embedded. */ }
    if (!match && !inlineURL && !externalURL) return null;
    // A board post's artifact lives on the board's server (#3540), which the caller names.
    return { url: externalURL || inlineURL || artifactPath(match[1]), externalURL, server: options.server || contextServer() };
}
