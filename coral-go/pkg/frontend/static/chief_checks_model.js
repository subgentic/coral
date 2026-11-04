/* Pure presentation rules for the local Chief configurator. */
export const INTERVALS = [[5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, 'Hour']];
export const NOTIFY_MODES = [['only_if_found', 'Only if something is found'], ['every_time', 'Every time'], ['daily_brief', 'In the daily brief']];
export function scheduleWords(c) {
    if (c.schedule_kind === 'interval') return `Every ${c.every_minutes === 60 ? 'hour' : `${c.every_minutes} minutes`}`;
    return `${c.schedule_kind === 'weekdays' ? 'Weekdays' : 'Daily'} at ${c.at} · ${c.timezone}`;
}
export function triggerWords(t) {
    if (t.state === 'done') return 'Done';
    if (t.delivery === 'failed') return 'Delivery failed';
    if (t.delivery === 'held') return 'Delivery held';
    if (t.delivery !== 'delivered' && t.state !== 'done') return 'Waiting for delivery';
    if (t.state === 'routed') return 'Routed to a task';
    if (t.state === 'waiting_on_operator') return 'Waiting on you';
    if (t.notify_mode === 'daily_brief' && t.summary && !t.brief_id) return 'Awaiting brief';
    return 'Open';
}
export function newCheck(target = {}, timezone = 'UTC') {
    return { name: '', instruction: '', target_board: target.team || '', target_session: target.session_id || '', notify_mode: 'only_if_found', enabled: true, wake_if_asleep: false, source_key: '', schedule_kind: 'interval', every_minutes: 15, at: '09:00', timezone, revision: 0 };
}
export function sourceRows(inventory, checks) {
    if (inventory?.supported !== true || !Array.isArray(inventory.servers)) return null;
    return inventory.servers.map(s => {
        const key = `${String(s.scope || '')}:${String(s.name || '')}:${String(s.transport || '')}`;
        return { key, name: String(s.name || 'Unnamed source'), transport: String(s.transport || ''), scope: String(s.scope || ''), check: checks.find(c => c.source_key === key) || null, usable: key.length <= 120 };
    });
}
/** All outcomes are retained: one failure must not hide a later successful request. */
export async function runCheckQueue(checks, run, keyFor) {
    const results = [];
    for (const check of checks) {
        try { results.push({ id: check.id, ok: true, trigger: await run(check.id, keyFor(check.id)) }); }
        catch (error) { results.push({ id: check.id, ok: false, error: String(error?.message || 'The check could not be scheduled.') }); }
    }
    return results;
}
