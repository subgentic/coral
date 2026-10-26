/** Request a same-origin JSON route and return its answer, or throw. The error is the server's own reason ({"error": "..."}) or "HTTP <status>", with .status and .data
 *  on it, so a caller that treats one status specially (a 409) reads e.status. A body, when there is one, is sent as JSON; an empty answer is {}. Unlike sendJson it throws
 *  for a refusal, and unlike apiFetch it names the status the way the settings dialogs always did. */
export async function requestJson(method, url, body) {
    const init = { method };
    if (body !== undefined) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(body); }
    const resp = await fetch(url, init);
    const text = await resp.text().catch(() => '');
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (e) { if (resp.ok) throw e; }
    if (!resp.ok) {
        const error = new Error((data && typeof data.error === 'string' && data.error) || `HTTP ${resp.status}`);
        error.status = resp.status;
        error.data = data || {};
        throw error;
    }
    return data;
}

