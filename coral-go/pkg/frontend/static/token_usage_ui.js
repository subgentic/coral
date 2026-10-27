/* Token usage in the header and the team's token usage view, and the team's knowledge button (moved out of render.js, #4996; no behaviour change). */
import { historyFetch } from './history_source.js';
import { serverFetch, serverForSession, teamFetch, keyLabel } from './server_base.js';
import { formatTokens } from './format.js';
import { formatCost } from './format.js';
import { compactDuration } from './format.js';
import { importOnce } from './import_once.js';

const formatDuration = sec => (sec > 0 ? compactDuration(sec) : ''); // execution time: nothing for none or zero

export async function updateTokenUsage(sessionId) {
    const el = document.getElementById('session-token-usage');
    if (!el) return;
    if (!sessionId) { el.style.display = 'none'; return; }

    try {
        const resp = await serverFetch(serverForSession(null, sessionId), `/api/token-usage?session_id=${encodeURIComponent(sessionId)}`);
        if (!resp.ok) { el.style.display = 'none'; return; }
        const data = await resp.json();
        if (!data.totals.total_tokens || data.totals.total_tokens === 0) { el.style.display = 'none'; return; }

        const parts = [formatTokens(data.totals.total_tokens) + ' tokens'];
        if (data.totals.cost_usd > 0) parts.push(formatCost(data.totals.cost_usd));
        el.textContent = parts.join(' · ');
        el.style.display = '';
    } catch {
        el.style.display = 'none';
    }
}

export async function updateHistoryTokenUsage(sessionId) {
    const container = document.getElementById('history-token-usage');
    if (!container) return;
    if (!sessionId) { container.style.display = 'none'; return; }

    try {
        const resp = await historyFetch(`/api/token-usage?session_id=${encodeURIComponent(sessionId)}`);
        if (!resp.ok) { container.style.display = 'none'; return; }
        const data = await resp.json();
        const t = data.totals;
        if (!t || !t.total_tokens || t.total_tokens === 0) { container.style.display = 'none'; return; }

        document.getElementById('htu-input').textContent = formatTokens(t.input_tokens || 0);
        document.getElementById('htu-output').textContent = formatTokens(t.output_tokens || 0);
        const cache = (t.cache_read_tokens || 0) + (t.cache_write_tokens || 0);
        document.getElementById('htu-cache').textContent = cache > 0 ? formatTokens(cache) : '—';
        document.getElementById('htu-requests').textContent = String(t.num_sessions || '—');
        document.getElementById('htu-cost').textContent = t.cost_usd > 0 ? formatCost(t.cost_usd) : '—';
        container.style.display = '';
    } catch (error) {
        if (error.name === 'AbortError') return;
        container.style.display = 'none';
    }
}

export async function getTeamTokenUsage(boardName) {
    try {
        const resp = await teamFetch(boardName, n => `/api/token-usage?board_name=${encodeURIComponent(n)}`);
        if (!resp.ok) return null;
        const data = await resp.json();
        if (!data.totals.total_tokens || data.totals.total_tokens === 0) return null;
        const parts = [formatTokens(data.totals.total_tokens) + ' tokens'];
        if (data.totals.cost_usd > 0) parts.push(formatCost(data.totals.cost_usd));
        if (data.totals.execution_time_sec > 0) parts.push(formatDuration(data.totals.execution_time_sec));
        return parts.join(' · ');
    } catch {
        return null;
    }
}

export async function showTeamTokenUsage(boardName) {
    const modal = document.getElementById('task-detail-modal');
    const titleEl = document.getElementById('task-detail-modal-title');
    const content = document.getElementById('task-detail-content');
    if (!modal || !content) return;

    titleEl.textContent = `Token Usage — ${keyLabel(boardName)}`;
    content.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-muted)">Loading...</div>';
    modal.style.display = '';
    modal.onclick = (e) => { if (e.target === modal) { modal.style.display = 'none'; } };

    // Token usage is read from Coral's unified usage API.
    const usageData = await teamFetch(boardName, n => `/api/token-usage?board_name=${encodeURIComponent(n)}`)
        .then(resp => resp.ok ? resp.json() : null)
        .catch(() => null);
    // The unified usage API answers { records, totals }: one record per session (and source), so the members are the records grouped by agent name (one agent that ran in several sessions is one row).
    const members = new Map();
    for (const r of usageData?.records || []) {
        const name = r.agent_name || r.session_id || 'Unknown agent', m = members.get(name) || { name, total_input_tokens: 0, total_output_tokens: 0, total_cache_read_tokens: 0, total_cache_write_tokens: 0, total_cost_usd: 0, total_requests: 0 };
        m.total_input_tokens += r.input_tokens || 0; m.total_output_tokens += r.output_tokens || 0; m.total_cache_read_tokens += r.cache_read_tokens || 0; m.total_cache_write_tokens += r.cache_write_tokens || 0;
        m.total_cost_usd += r.cost_usd || 0; m.total_requests += r.num_turns || 0;
        members.set(name, m);
    }
    const agents = [...members.values()].filter(a => a.total_requests > 0 || a.total_cost_usd > 0);

    // Compute totals
    let totalIn = 0, totalOut = 0, totalCacheR = 0, totalCacheW = 0, totalCost = 0, totalReqs = 0;
    for (const a of agents) {
        totalIn += a.total_input_tokens || 0;
        totalOut += a.total_output_tokens || 0;
        totalCacheR += a.total_cache_read_tokens || 0;
        totalCacheW += a.total_cache_write_tokens || 0;
        totalCost += a.total_cost_usd || 0;
        totalReqs += a.total_requests || 0;
    }

    if (agents.length === 0) {
        content.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-muted)">No token usage recorded for this team</div>';
        return;
    }

    // Render summary + agent table
    const executionTimeRow = usageData?.totals?.execution_time_sec > 0
        ? `<div><span class="info-token-label">Execution Time</span><span class="info-token-value">${formatDuration(usageData.totals.execution_time_sec)}</span></div>`
        : '';
    let html = `<div class="info-token-grid" style="margin-bottom:16px">
        <div><span class="info-token-label">Input</span><span class="info-token-value">${formatTokens(totalIn)}</span></div>
        <div><span class="info-token-label">Output</span><span class="info-token-value">${formatTokens(totalOut)}</span></div>
        <div><span class="info-token-label">Cache Read</span><span class="info-token-value">${formatTokens(totalCacheR)}</span></div>
        <div><span class="info-token-label">Cache Write</span><span class="info-token-value">${formatTokens(totalCacheW)}</span></div>
        <div><span class="info-token-label">Requests</span><span class="info-token-value">${totalReqs}</span></div>
        <div><span class="info-token-label">Cost</span><span class="info-token-value">${formatCost(totalCost)}</span></div>
        ${executionTimeRow}
    </div>`;

    const { dataTable, tableState } = await importOnce('./data_table.js'); // the shared table (#7743), loaded when this dialog is opened
    // The members' table is data_table, with By agent's column order (Agent, Cost, then the tokens) and its K/M/B figures; the dearest member first.
    content.innerHTML = html;
    const num = (key, label, extra) => ({ key, label, numeric: true, sort: 'number', firstDir: 'desc', sortValue: r => r[key] || 0, cell: r => formatTokens(r[key] || 0), ...extra });
    const state = tableState(); state.sort = { key: 'total_cost_usd', dir: 'desc' };
    content.append(dataTable({ label: 'Token usage by member', fold: 'labeled', scroll: true, state, rows: agents, rowKey: r => r.name, columns: [
        { key: 'name', label: 'Agent', tone: 'primary', sort: true, sortValue: r => r.name || '', cell: r => r.name || '' },
        num('total_cost_usd', 'Cost', { cell: r => formatCost(r.total_cost_usd || 0), foldFirst: true }),
        num('total_input_tokens', 'Input'), num('total_output_tokens', 'Output'), num('total_cache_read_tokens', 'Cache read'), num('total_cache_write_tokens', 'Cache write'),
    ] }).el);
}

export async function distillTeamKnowledge(boardName) {
    if (window.openTeamPage) await window.openTeamPage(boardName, { tab: 'knowledge' });
    // Starts a run, or joins the one already running (#3325); the team page's Knowledge tab shows the progress and the result follows from knowledge_distill.js.
    const { startDistill } = await importOnce('./knowledge_distill.js');
    try { await startDistill(boardName); } catch (err) { const { showToast } = await importOnce('./notifications.js'); showToast(`Could not start: ${err && err.message ? err.message : 'no answer'}`, true); }
}
