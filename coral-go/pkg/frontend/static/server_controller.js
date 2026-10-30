/* The Servers list's one fetch/refresh lifecycle. Source adapters preserve each API's shape and error words. */
import { pollEvery } from './overload.js';
import { describeServerError } from './server_status.js';

export const serverSources = {
    registered: {
        rows: data => Array.isArray(data) ? data : [],
        refused: async response => describeServerError(response.status, await response.json().catch(() => ({}))),
        unreachable: 'Could not load the computer list. Is this Coral still running?',
    },
    cloud: {
        init: { headers: { Accept: 'application/json' } },
        rows: data => Array.isArray(data?.servers) ? data.servers : [],
        refused: async () => 'Could not load your computers.',
        unreachable: 'Could not reach the hub.',
    },
};

export function createServerController(source, view, { fetcher = (...args) => fetch(...args), poll = pollEvery, clear = clearInterval } = {}) {
    let timer = null, generation = 0;
    const load = async () => {
        const current = generation;
        try {
            const response = await fetcher('/api/servers', source.init);
            if (!response.ok) {
                const error = await source.refused(response);
                if (current !== generation) return;
                view.fail(error);
            } else {
                const data = await response.json();
                if (current !== generation) return;
                view.accept(source.rows(data));
            }
        } catch {
            if (current !== generation) return;
            view.fail(source.unreachable);
        }
        view.render();
    };
    const stop = () => { generation++; if (timer !== null) clear(timer); timer = null; };
    const start = async () => {
        stop();
        const current = generation;
        await load();
        if (current === generation) timer = poll(() => { if (view.canRefresh()) load(); }, 5000);
    };
    return { load, start, stop };
}
