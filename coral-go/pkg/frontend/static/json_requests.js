/* JSON request encoding and reply decoding load when called; ordinary status,
 * body and network-error contracts stay the same. */
import { importOnce } from './import_once.js';

export async function sendJson(method, url, body) {
    const resp = await fetch(url, { method, headers: method === 'DELETE' ? {} : { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: method === 'DELETE' ? undefined : JSON.stringify(body || {}) });
    let data = {};
    try { data = await resp.json(); } catch { /* an empty or non-JSON body */ }
    return { ok: resp.ok, status: resp.status, data: data || {}, retryAfter: resp.headers.get('Retry-After') };
}


export async function requestJson(method, url, body) {
    const init = { method };
    if (body !== undefined) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(body); }
    const resp = await fetch(url, init);
    const text = await resp.text().catch(() => '');
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (e) { if (resp.ok) throw e; }
    if (!resp.ok) {
        if (resp.status === 409) {
            const server = /^\/api\/remote\/([^/]+)\//.exec(String(url))?.[1];
            if (server) {
                const { computerUpdateError } = await importOnce('./computer_update_error.js');
                const update = computerUpdateError(decodeURIComponent(server), resp.status, data);
                if (update) throw update;
            }
        }
        const error = new Error((data && typeof data.error === 'string' && data.error) || `HTTP ${resp.status}`);
        error.status = resp.status;
        error.data = data || {};
        throw error;
    }
    return data;
}
