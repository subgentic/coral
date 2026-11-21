/* The Hub's explicit version refusal. A plain 409, a guessed version, or an
 * extended/unusable body does not prove that updating this computer fixes it. */
import { state } from './state.js';

export function requiredCoralVersion(status, data) {
    return status === 409 && data && typeof data === 'object' && !Array.isArray(data)
        && data.error === 'coral_too_old' && typeof data.min === 'string'
        && data.min.length <= 20 && /^\d+\.\d+\.\d+$/.test(data.min)
        && data.min === data.min.trim() && Object.keys(data).length === 2 ? data.min : '';
}

export function computerUpdateError(server, status, data) {
    const min = requiredCoralVersion(status, data);
    if (!min) return null;
    return Object.assign(new Error(computerUpdateMessage(server, min)),
        { status, code: 'coral_too_old', min, server, data });
}

export function computerUpdateMessage(server, min) {
    const computer = (state.servers || []).find(s => s.id === server);
    const label = String(computer?.label || computer?.name || server || 'this computer');
    return `Update Coral on ${label} to ${min} to see this`;
}

/** Clone only a version refusal: the caller still owns the original Response body. */
export async function responseUpdateError(response, server) {
    if (response.status !== 409) return null;
    return computerUpdateError(server, response.status, await response.clone().json().catch(() => null));
}

export async function httpError(resp, server) {
    if (resp.status === 409 && server) {
        const update = await responseUpdateError(resp, server);
        if (update) { update.body = await resp.text().catch(() => ''); return update; }
    }
    const text = await resp.text().catch(() => '');
    let reason = '';
    try { const body = JSON.parse(text); if (body && typeof body.error === 'string') reason = body.error; } catch { /* not JSON */ }
    const error = new Error(reason || `${resp.status}: ${text || resp.statusText}`);
    error.status = resp.status;
    error.body = text;
    return error;
}
