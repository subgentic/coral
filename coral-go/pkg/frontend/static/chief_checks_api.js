/* Local person-only API. No credential or connector configuration is accepted. */
import { serverFetch, pathId } from './server_base.js';
async function request(path, options = {}) {
    const response = await serverFetch('local', path, { credentials: 'same-origin', cache: 'no-store', ...options });
    let data;
    try { data = await response.json(); } catch { throw new Error('Coral returned an unreadable reply. Try again.'); }
    if (!response.ok) throw new Error(data.error || `The request failed (HTTP ${response.status}).`);
    return data;
}
const json = body => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
export const loadChecks = () => request('/api/chief/checks');
export const loadTriggers = before => request('/api/chief/triggers' + (before ? `?before=${pathId(before)}` : ''));
export const loadChief = () => request('/api/chief');
export const loadAgents = () => request('/api/sessions/live');
export const loadSources = agent => request(`/api/sessions/live/${encodeURIComponent(agent.name)}/mcp-servers?session_id=${encodeURIComponent(agent.session_id)}`);
export const saveCheck = check => request('/api/chief/checks' + (check.id ? `/${pathId(check.id)}` : ''), { method: check.id ? 'PUT' : 'POST', ...json(check) });
export const deleteCheck = check => request(`/api/chief/checks/${pathId(check.id)}`, { method: 'DELETE', ...json({ revision: check.revision }) });
export const runCheck = async (id, key) => (await request(`/api/chief/checks/${pathId(id)}/run`, { method: 'POST', headers: { 'Idempotency-Key': key } })).trigger;
export const setTriggerState = (trigger, state) => request(`/api/chief/triggers/${pathId(trigger.id)}/state`, { method: 'POST', ...json({ state }) });
