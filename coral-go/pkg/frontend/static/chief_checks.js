/* Chief's local configurator: sources describe inventory, checks deliver text. */
import { el } from './dom_el.js';
import { importOnce } from './import_once.js';
import { pollEvery } from './overload.js';
import { isCloud } from './server_base.js';
import { build } from './routes.js';
const { newCheck, sourceRows, scheduleWords, triggerWords, runCheckQueue } = await importOnce('./chief_checks_model.js');
const api = await importOnce('./chief_checks_api.js');
const { loadStyles } = await importOnce('./lazy_styles.js');
await loadStyles('chief-checks.css');
let opened = null;
const button = (text, fn, cls = 'btn') => { const b = el('button', cls, text); b.type = 'button'; b.addEventListener('click', fn); return b; };
// randomUUID requires a secure context; getRandomValues also works on a
// plain-http LAN dashboard, as in agent_ui.js.
function newRequestID() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function showChiefChecks() {
    if (isCloud()) return;
    if (opened?.open) { opened.focus(); return; }
    const dialog = el('dialog', 'modal-content dlg-flow chief-checks'); opened = dialog;
    dialog.setAttribute('aria-labelledby', 'chief-checks-title');
    const head = el('header', 'chief-checks-head'), title = el('h2', '', 'Chief checks'); title.id = 'chief-checks-title';
    const intro = el('p', 'chief-check-hint', 'What your agent watches, and when it checks.');
    const awake = el('span', 'chief-check-hint', 'Agent status unavailable');
    const runAll = button('Run all checks now', () => run(checks)); runAll.disabled = true;
    const close = button('Close', () => dialog.close());
    head.append(title, awake, runAll, close);
    const notice = el('p', 'notice notice-info chief-checks-notice', 'Coral never holds your logins. It only sends your instruction to the chosen agent, which uses its own connectors.');
    const status = el('p', 'chief-check-hint', 'Loading checks…'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const tools = el('div', 'chief-check-actions');
    const add = button('New check', () => editor(newCheck(chief, timezone)), 'btn btn-primary'); add.disabled = true;
    const refresh = button('Refresh', () => load()); tools.append(add, refresh);
    const layout = el('div', 'chief-checks-layout'), main = el('div', 'chief-checks-main');
    const sources = el('section', 'chief-checks-sources'), list = el('section', 'chief-checks-list'), recent = el('section', 'chief-checks-recent');
    main.append(sources, list); layout.append(main, recent); dialog.append(head, intro, notice, status, tools, layout);
    let checks = [], agents = [], chief = {}, inventory = null, inventoryError = '', inventoryLoading = false, busy = false, closed = false, triggers = [], earliestExhausted = false;
    const keys = new Map();
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const say = (text, error = false) => { if (closed) return; status.textContent = text; status.className = error ? 'chief-check-error' : 'chief-check-hint'; };
    async function editor(c) {
        try {
            const { editCheck } = await importOnce('./chief_check_editor.js');
            if (closed) return;
            editCheck(c, agents, async saved => { checks = checks.some(x => x.id === saved.id) ? checks.map(x => x.id === saved.id ? saved : x) : [...checks, saved]; drawChecks(); drawSources(); runAll.disabled = !checks.length; say('Check saved.'); });
        } catch (e) { say(`The editor could not be opened. ${e.message || 'Try again.'}`, true); }
    }
    async function run(rows) {
        if (busy || !rows.length) return;
        busy = true; dialog.setAttribute('aria-busy', 'true'); runAll.disabled = true;
        say(`Scheduling ${rows.length} check${rows.length === 1 ? '' : 's'}…`);
        const results = await runCheckQueue(rows, api.runCheck, id => { if (!keys.has(id)) keys.set(id, newRequestID()); return keys.get(id); });
        for (const r of results) if (r.ok) keys.delete(r.id);
        busy = false;
        if (closed) return;
        dialog.removeAttribute('aria-busy'); runAll.disabled = !checks.length;
        const failed = results.filter(r => !r.ok);
        say(failed.length ? `${results.length - failed.length} scheduled; ${failed.length} could not be scheduled. ${failed.map(r => r.error).join(' ')} Retry uses the same request key.` : 'Checks scheduled. Recent triggers show whether delivery succeeded.', !!failed.length);
        await readTriggers();
    }
    async function toggle(c) {
        try { const saved = await api.saveCheck({ ...c, enabled: !c.enabled }); checks = checks.map(x => x.id === c.id ? saved : x); drawChecks(); drawSources(); say(saved.enabled ? 'Schedule enabled.' : 'Schedule paused. Run now is still available.'); }
        catch (e) { say(e.message, true); }
    }
    function drawChecks() {
        list.replaceChildren(el('h3', '', 'Checks'));
        if (!checks.length) list.append(el('p', 'chief-check-hint', 'No checks yet. Add an instruction to start.'));
        for (const c of checks) {
            const card = el('section', 'chief-check-card'); card.append(el('h4', '', c.name));
            const a = agents.find(x => x.session_id === c.target_session);
            card.append(el('p', 'chief-check-hint', `${scheduleWords(c)} · ${a?.display_name || a?.name || 'Original agent unavailable'}`));
            card.append(el('p', 'chief-check-instruction', c.instruction));
            if (c.paused_reason) card.append(el('p', 'chief-check-error', c.paused_reason));
            const acts = el('div', 'chief-check-actions');
            const on = button(c.enabled ? 'On' : 'Off', async () => { on.disabled = true; await toggle(c); if (on.isConnected) on.disabled = false; }); on.setAttribute('role', 'switch'); on.setAttribute('aria-checked', String(c.enabled)); on.setAttribute('aria-label', `Schedule ${c.name}`);
            const now = button('Run now', () => run([c]));
            const remove = button('Delete', async () => {
                if (remove.dataset.confirm !== 'yes') { remove.dataset.confirm = 'yes'; remove.textContent = 'Confirm delete'; return; }
                remove.disabled = true;
                try { await api.deleteCheck(c); checks = checks.filter(x => x.id !== c.id); drawChecks(); drawSources(); runAll.disabled = !checks.length; say('Check deleted. Its trigger history is retained.'); }
                catch (e) { say(e.message, true); remove.disabled = false; }
            });
            acts.append(on, now, button('Edit', () => editor(c)), remove); card.append(acts); list.append(card);
        }
    }
    function drawSources() {
        sources.replaceChildren(el('h3', '', 'Sources'), el('p', 'chief-check-hint', 'Read from Chief’s MCP inventory. Listed sources may still need sign-in on the agent; Coral does not test their connection.'));
        if (chief.session_id) { const link = el('a', '', 'Open Chief’s agent to set up connectors'); link.href = build({ view: 'agents', id: chief.session_id }); link.addEventListener('click', () => dialog.close()); sources.append(link); }
        if (inventoryLoading) { sources.append(el('p', 'chief-check-hint', 'Reading source inventory…')); return; }
        if (inventoryError) { sources.append(el('p', 'chief-check-error', inventoryError)); return; }
        const rows = sourceRows(inventory, checks.filter(c => c.target_session === chief.session_id));
        if (rows === null) { sources.append(el('p', 'chief-check-hint', 'Source inventory is unavailable for this agent. Set up connectors on the agent itself; you can still add a custom check.')); return; }
        if (!rows.length) sources.append(el('p', 'chief-check-hint', 'No sources configured. Add an MCP connector on the agent, then refresh.'));
        if (inventory.truncated) sources.append(el('p', 'chief-check-hint', 'Only part of the source inventory is shown. Use the agent’s setup to see all sources.'));
        const grid = el('div', 'chief-check-source-grid'); sources.append(grid);
        for (const s of rows) {
            const card = el('section', 'chief-check-card'); card.append(el('h4', '', s.name), el('p', 'chief-check-hint', `Configured · ${s.transport} · ${s.scope}`));
            const watch = button(s.check?.enabled ? 'Watching' : 'Watch source', () => s.check ? toggle(s.check) : editor({ ...newCheck(chief, timezone), name: `Check ${s.name}`.slice(0, 120), instruction: `Use ${s.name} to check for `, source_key: s.key }));
            watch.setAttribute('role', 'switch'); watch.setAttribute('aria-checked', String(!!s.check?.enabled)); watch.setAttribute('aria-label', `Watch ${s.name}`); watch.disabled = !s.usable;
            card.append(watch);
            if (s.check) card.append(el('p', 'chief-check-hint', scheduleWords(s.check)), button('Edit instruction and interval', () => editor(s.check)));
            if (!s.usable) card.append(el('p', 'chief-check-hint', 'This source identifier is too long. Add a custom check instead.'));
            grid.append(card);
        }
    }
    function reference(card, label, t, sub, id) {
        if (!Number.isSafeInteger(id) || id < 1) return;
        const link = el('a', '', label); link.href = build({ view: 'team', id: t.target_board, sub, item: String(id) }); link.addEventListener('click', () => dialog.close()); card.append(link);
    }
    function drawTriggers() {
        recent.replaceChildren(el('h3', '', 'Recent triggers'), el('p', 'chief-check-hint', 'Agent summaries are the agent’s words, kept on this computer. Delivery is not proof that the connector was checked.'));
        if (!triggers.length) recent.append(el('p', 'chief-check-hint', 'No triggers yet.'));
        for (const t of triggers) {
            const card = el('section', 'chief-check-card'); card.dataset.triggerId = String(t.id);
            card.append(el('h4', '', t.check_name), el('p', 'chief-check-state', triggerWords(t)), el('p', 'chief-check-hint', new Date(t.created_at * 1000).toLocaleString()));
            if (t.delivery_error) card.append(el('p', 'chief-check-error', `Delivery: ${String(t.delivery_error).replaceAll('_', ' ')}`));
            if (t.reminder_error) card.append(el('p', 'chief-check-error', `Reminder: ${String(t.reminder_error).replaceAll('_', ' ')}`));
            if (t.summary) card.append(el('p', 'chief-check-summary', t.summary));
            reference(card, `Task #${t.task_id}`, t, 'tasks', t.task_id); reference(card, 'Open question', t, 'messages', t.ask_id); reference(card, 'Open brief', t, 'messages', t.brief_id);
            const state = t.state === 'done' ? 'open' : 'done';
            const resolve = button(state === 'done' ? 'Mark done' : 'Reopen', async () => { resolve.disabled = true; try { const saved = await api.setTriggerState(t, state); triggers = triggers.map(x => x.id === saved.id ? saved : x); drawTriggers(); await readTriggers(); say(state === 'done' ? 'Trigger marked done.' : 'Trigger reopened.'); } catch (e) { say(e.message, true); resolve.disabled = false; } });
            card.append(resolve); recent.append(card);
        }
        if (triggers.length >= 100 && !earliestExhausted) recent.append(button('Load earlier triggers', async event => {
            const earlier = event.currentTarget; earlier.disabled = true;
            try { const more = await api.loadTriggers(triggers.at(-1).id); if (closed) return; triggers.push(...more.triggers); earliestExhausted = more.triggers.length < 100; drawTriggers(); if (!more.triggers.length) say('No earlier triggers.'); }
            catch (e) { say(e.message, true); earlier.disabled = false; }
        }));
    }
    async function readTriggers() {
        try { const data = await api.loadTriggers(); if (!closed) { const fresh = data.triggers || []; const last = fresh.at(-1)?.id; triggers = [...fresh, ...triggers.filter(t => last && t.id < last)]; drawTriggers(); } }
        catch (e) { if (!closed) { recent.replaceChildren(el('h3', '', 'Recent triggers'), el('p', 'chief-check-error', `Could not refresh triggers. ${e.message}`)); } }
    }
    async function load() {
        refresh.disabled = true; add.disabled = true;
        try {
            const [data, live, who] = await Promise.all([api.loadChecks(), api.loadAgents(), api.loadChief()]);
            if (closed) return;
            checks = data.checks || []; chief = who || {}; agents = (Array.isArray(live) ? live : live.sessions || []).filter(a => a.session_id && a.board_project);
            drawChecks(); runAll.disabled = !checks.length; add.disabled = !agents.length; inventory = null; inventoryError = '';
            const agent = agents.find(a => a.session_id === chief.session_id); inventoryLoading = !!agent;
            awake.textContent = !agent ? 'Chief is unavailable' : agent.sleeping === true ? 'Chief is asleep' : agent.sleeping === false ? 'Chief is awake' : 'Agent status unavailable';
            drawSources(); say(agents.length ? 'Checks are up to date.' : 'No receiving agents are available.');
            if (agent) { try { const data = await api.loadSources(agent); if (closed) return; inventory = data; } catch (e) { inventoryError = `Could not read sources. ${e.message}`; } }
            inventoryLoading = false; if (!closed) { drawSources(); await readTriggers(); }
        } catch (e) { say(`Could not load checks. ${e.message}`, true); }
        finally { if (!closed) refresh.disabled = false; }
    }
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener('close', () => { closed = true; clearInterval(timer); dialog.remove(); if (opened === dialog) opened = null; });
    document.body.append(dialog); dialog.showModal(); close.focus();
    const timer = pollEvery(() => { if (!closed) readTriggers(); }, 10000);
    await load();
}
