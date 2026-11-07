import { copyText, showToast } from './utils.js';

/** The agent-readable link names this immutable version, independent of its computer. */
export async function copyArtifactId(hex) {
    hex = String(hex || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hex)) { showToast('Artifact ID is unavailable', true); return false; }
    const copied = await copyText(`coral://artifacts/${hex}`);
    showToast(copied ? 'Artifact ID copied' : 'Could not copy artifact ID', !copied);
    return copied;
}
