/* Live history requests: session parameters, trimmed messages and prefetched first pages. Moved from live_chat.js (#8353). */

import { serverFetch, sessionServer, isCloud } from './server_base.js';
import { takeChatPrefetch } from './chat_page.js';

// The query every chat request starts from: which session, and where it is.
export function chatParams(session) {
    const params = new URLSearchParams();
    params.set("session_id", session.session_id);
    if (session.agent_type) {
        params.set("agent_type", session.agent_type);
    }
    // Through the hub the machine resolves the directory from session_id (its own stored record), and the hub's route
    // table refuses an absolute path in a file-ref parameter: sending it would turn the chat into a 404.
    if (session.working_directory && !(isCloud() && sessionServer(session) !== 'local')) {
        params.set("working_directory", session.working_directory);
    }
    return params;
}

// One message, whole: the page of one that ends after it, without trim.
export async function fetchChatMessage(session, index) {
    const params = chatParams(session);
    params.set("after", "0");
    params.set("limit", "1");
    params.set("before", String(index + 1));
    const resp = await serverFetch(sessionServer(session), `/api/sessions/live/${encodeURIComponent(session.name)}/chat?${params}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return (data && Array.isArray(data.messages) && data.messages[0]) || null;
}

/** The reply to the request: the first page of a deep-linked chat asked for at page load if it is the same request, else a new one. */
export async function _fetchHistoryPage(session, params, server, abortCtrl, initialLoadDone) {
    // The first page of a deep-linked chat was asked for when the page loaded, before the list named the agent (chat_page.js): when it is the request
    // this would make, take it over; if it failed or was refused, make the request as usual. Its abort is this load's: a switch cancels it too.
    let resp = null;
    const early = initialLoadDone ? null : takeChatPrefetch(session, params, { local: server === 'local', cloud: isCloud() });
    if (early) {
        abortCtrl.signal.addEventListener('abort', early.abort, { once: true });
        try { resp = await early.promise; } catch { resp = null; }
        if (resp && !resp.ok) resp = null; // a refusal (a 401 above all) is the real request's to meet, with the page's own handling
    }
    if (!resp) resp = await serverFetch(sessionServer(session), `/api/sessions/live/${encodeURIComponent(session.name)}/chat?${params}`, {
        signal: abortCtrl.signal,
    });
    return resp;
}
