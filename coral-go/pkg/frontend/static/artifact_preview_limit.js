/* Shared artifact preview budget, stored with UI settings. */
import { state } from './state.js';
export function artifactPreviewBytes() {
    const mb = Number(state.settings?.artifact_preview_max_mb);
    return ([2, 16, 32, 64].includes(mb) ? mb : 16) * 1024 * 1024;
}
export function artifactPreviewLimitText() {
    return `Preview is limited to ${artifactPreviewBytes() / (1024 * 1024)} MB (Settings > Files and Git > Largest artifact to preview).`;
}
