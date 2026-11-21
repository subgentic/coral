/* Transcript reads and their errors load with a chat, away from startup. */
import { historyFetch, historyServer } from './history_source.js';
import { importOnce } from './import_once.js';

export async function loadHistoryMessages(sessionId, options = {}) {
    try {
        const params = new URLSearchParams();
        if (options.limit != null) params.set('limit', String(options.limit));
        if (options.offset != null) params.set('offset', String(options.offset));
        const qs = params.toString() ? `?${params}` : '';
        const source = historyServer();
        const response = await historyFetch(`/api/sessions/history/${encodeURIComponent(sessionId)}${qs}`);
        if (!response.ok) throw await (await importOnce('./computer_update_error.js')).httpError(response);
        const data = await response.json();
        return source === historyServer() ? data : null;
    } catch (e) {
        if (e.name === 'AbortError') return;
        if (options.throwOnError) throw e;
        console.error("Failed to load history messages:", e);
        return null;
    }
}
