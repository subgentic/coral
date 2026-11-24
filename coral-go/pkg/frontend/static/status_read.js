/* One uncached status read answers the panels that ask in the same moment (#21126). */
import { boardFetch } from './server_base.js';
const reads = new Map();
export const statusRead = team => reads.get(team) || reads.set(team, boardFetch(team, '/status', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).finally(() => reads.delete(team))).get(team);
