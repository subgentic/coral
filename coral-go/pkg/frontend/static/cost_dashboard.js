import { openTask } from './task_navigation.js';
/* Token Usage Dashboard — token usage and cost UI */

import { showView, escapeHtml, escapeAttr } from './utils.js';
import { state } from './state.js';
import { emptyState } from './dom_write.js';
import { pollEvery } from './overload.js';
import { keyLabel } from './server_base.js';
import { formatTokens, formatDuration, formatCost } from './format.js';
import { importOnce } from './import_once.js';
import { isPhoneLayout } from './phone_layout.js';
const { dataTable, tableState, link: dtLink, chip, tag, avatar } = await importOnce('./data_table.js'); // the shared table (#7743)
const { showViews, syncRangeLine, phoneOneLine } = await importOnce('./analytics_views.js'); // the sidebar's list of views and the page's title (#7473)
const agentDetail = await importOnce('./analytics_agent.js'); // one agent over the range, opened from By agent (#7930)
const series = await importOnce('./analytics_series.js'); // the lines over time above By provider, By model, By team and By agent (#7857)
const { syncEfficiency } = await importOnce('./analytics_efficiency.js'); // the Group by switch and the comparison of Tokens per commit and Task time (Goal #77)
const { showSpend } = await importOnce('./analytics_spend.js'); // a lazy module loads the others it needs through importOnce, so a failed load is retried

// What an empty table says: where the numbers come from and what to try (#6975), not just that there are none.
const NO_DATA = 'No data in this range yet. It appears once an agent has used tokens; try a longer range.';

function _formatTime(isoStr) {
    if (!isoStr) return '\u2014';
    try {
        const d = new Date(isoStr);
        return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
            + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch { return isoStr; }
}

function _formatDuration(startStr, endStr) {
    if (!startStr) return '\u2014';
    try {
        const start = new Date(startStr);
        const end = endStr ? new Date(endStr) : new Date();
        const diffMs = end - start;
        if (diffMs < 0) return '\u2014';
        return formatDuration(diffMs);
    } catch { return '\u2014'; }
}

function _findSession(sessionId) {
    if (!sessionId || !state.liveSessions) return null;
    return state.liveSessions.find(s => s.session_id === sessionId) || null;
}

let _costRefreshTimer = null;

// ── Sort & Filter State ─────────────────────────────────────

// Per-column dropdown filters: { "table:field": Set of selected values }
// Empty set = show all (no filter active)
const _colFilters = {};

// Raw data caches — populated on fetch, re-rendered on sort/filter
const _rawData = {
    provider: [], model: [], thinking: [], agent: [], team: [], branch: [], task: [],
};

// Currently open dropdown (only one at a time)
let _openDropdown = null;

function _rerender(table) {
    switch (table) {
        case 'provider': _renderProviderTable(_rawData.provider); break;
        case 'model':   _renderModelTable(_rawData.model); break;
        case 'thinking': _renderThinkingTable(_rawData.thinking); break;
        case 'agent':   _renderAgentTable(_rawData.agent); break;
        case 'team':    _renderTeamTable(_rawData.team); break;
        case 'branch':  _renderBranchTable(_rawData.branch); break;
        case 'task':    _renderTaskTable(_rawData.task); break;
    }
}

// Apply all active column filters for a table
function _applyColFilters(rows, table, fieldExtractors) {
    let result = rows;
    for (const [field, extractor] of Object.entries(fieldExtractors)) {
        const key = `${table}:${field}`;
        const selected = _colFilters[key];
        if (selected && selected.size > 0) {
            result = result.filter(r => selected.has(extractor(r)));
        }
    }
    return result;
}

function _hasActiveFilter(table, field) {
    const key = `${table}:${field}`;
    const s = _colFilters[key];
    return s && s.size > 0;
}

// What each table is called, as its section's heading says (#6432): a sort or filter button is named for its column and its table, so "Cost" is not six buttons that read the same.
const TABLE_TITLES = { provider: 'By Provider', model: 'By Model', thinking: 'By Thinking Level', agent: 'By Agent', team: 'By Team', branch: 'By Branch', task: 'By Task' };

// Open/close the column filter dropdown
function _openFilter(table, field, anchorEl) {
    _closeDropdown();

    const key = `${table}:${field}`;
    const data = _rawData[table] || [];
    const extractor = _getFilterExtractor(table, field);

    // Collect unique values
    const uniqueVals = [...new Set(data.map(r => extractor(r)))].filter(v => v).sort();
    if (uniqueVals.length === 0) return;

    const selected = _colFilters[key] || new Set();

    // Create dropdown
    const dropdown = document.createElement('div');
    dropdown.className = 'cost-filter-dropdown';
    dropdown.onclick = (e) => e.stopPropagation();

    // Search input
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'cost-filter-search';
    search.placeholder = 'Search...';
    search.autocomplete = 'off';
    dropdown.appendChild(search);

    // Actions row
    const actions = document.createElement('div');
    actions.className = 'cost-filter-actions';
    actions.innerHTML = `<button class="cost-filter-action-btn" data-action="all">Select All</button><button class="cost-filter-action-btn" data-action="none">Clear</button>`;
    dropdown.appendChild(actions);

    // Items container
    const itemsContainer = document.createElement('div');
    itemsContainer.className = 'cost-filter-items';
    dropdown.appendChild(itemsContainer);

    function renderItems(query) {
        const q = (query || '').toLowerCase();
        const filtered = q ? uniqueVals.filter(v => v.toLowerCase().includes(q)) : uniqueVals;
        itemsContainer.innerHTML = filtered.map(val => {
            const checked = selected.size === 0 || selected.has(val) ? 'checked' : '';
            return `<label class="cost-filter-item"><input type="checkbox" ${checked} data-val="${escapeHtml(val)}"><span>${escapeHtml(val)}</span></label>`;
        }).join('');
    }

    renderItems('');

    search.addEventListener('input', () => renderItems(search.value));

    // Handle checkbox changes
    itemsContainer.addEventListener('change', (e) => {
        const cb = e.target;
        if (!cb.dataset.val) return;
        if (cb.checked) {
            // If all are now checked, clear filter (show all)
            const allChecked = itemsContainer.querySelectorAll('input[type=checkbox]');
            const checkedCount = [...allChecked].filter(c => c.checked).length;
            if (checkedCount === uniqueVals.length) {
                _colFilters[key] = new Set();
            } else {
                if (!_colFilters[key]) _colFilters[key] = new Set();
                _colFilters[key].add(cb.dataset.val);
            }
        } else {
            // If unchecking and no filter exists yet, create one with all except this
            if (!_colFilters[key] || _colFilters[key].size === 0) {
                _colFilters[key] = new Set(uniqueVals.filter(v => v !== cb.dataset.val));
            } else {
                _colFilters[key].delete(cb.dataset.val);
            }
        }
        _rerender(table);
    });

    // Select All / Clear
    actions.addEventListener('click', (e) => {
        const action = e.target.dataset.action;
        if (action === 'all') {
            _colFilters[key] = new Set();
            renderItems(search.value);
            _rerender(table);
        } else if (action === 'none') {
            _colFilters[key] = new Set(['__none__']); // impossible value to match nothing
            itemsContainer.querySelectorAll('input[type=checkbox]').forEach(c => c.checked = false);
            _rerender(table);
        }
    });

    // Position relative to anchor
    const rect = anchorEl.getBoundingClientRect();
    dropdown.style.position = 'fixed';
    dropdown.style.top = (rect.bottom + 4) + 'px';
    dropdown.style.left = Math.min(rect.left, window.innerWidth - 220) + 'px';
    document.body.appendChild(dropdown);

    _openDropdown = dropdown;

    // Close on outside click
    setTimeout(() => {
        document.addEventListener('click', _closeDropdown, { once: true });
    }, 0);
}

function _closeDropdown() {
    if (_openDropdown) {
        _openDropdown.remove();
        _openDropdown = null;
    }
}

function _getFilterExtractor(table, field) {
    const extractors = {
        'provider:agent_type': r => r.agent_type || '',
        'model:model': r => r.model || '',
        'model:agent_type': r => r.agent_type || '',
        'thinking:agent_type': r => r.agent_type || '',
        'thinking:model': r => r.model || '',
        'thinking:level': r => r.level || '',
        'agent:agent_name': r => r.display_name || r.agent_name || '',
        'agent:board_name': r => r.board_name || '',
        'agent:folder': r => r.folder || '',
        'team:board_name': r => r.board_name || '(no team)',
        'branch:branch': r => (r.repo_name && r.branch ? `${r.repo_name} : ${r.branch}` : r.branch) || '(unknown)',
        'branch:board_name': r => r.board_name || '(no team)',
        'task:assigned_to': r => r.assigned_to || '',
        'task:priority': r => r.priority || 'medium',
    };
    return extractors[`${table}:${field}`] || (() => '');
}

export async function showCostDashboard() {
    showView('cost-dashboard-view');
    showViews();
    await _refreshCostDashboard();
    stopCostDashboard(); // clear any existing timer
    _costRefreshTimer = pollEvery(_refreshCostDashboard, 15000);
}

/** Coral's own routes (the dashboard's calls to its server: an api or proxy row no agent made) are noise: the table is the person's work, so they are left out, and with nothing else it says nothing, not a list of /api paths (#6382, first-run report #6370 item 11; also beside real calls, #7719). */
export function shownCallMetrics(rows) {
    const own = r => (r.call_type === 'api' || r.call_type === 'proxy') && !r.agent_name;
    return rows.filter(r => !own(r)); // never listed, even beside real calls: they grew with every refresh of this page (#7719)
}

async function _refreshCallMetrics(period, hours) {
    const el = document.getElementById('call-metrics-summary');
    if (!el) return;
    const label = (document.querySelector(`#cost-time-range option[value="${period}"]`)?.textContent || 'Last 24 hours').toLowerCase();
    try {
        const response = await fetch(`/api/call-metrics/summary?hours=${hours}`, { cache: 'no-store' });
        if (!response.ok) throw new Error('metrics unavailable');
        const data = await response.json();
        const rows = shownCallMetrics(data.rows || []);
        // Metrics past the raw-row cap are not stored (#5359): say so, so a gap after a burst is not read as quiet (#5368).
        const dropped = data.cap_dropped > 0 ? `<p class="cost-empty">${Number(data.cap_dropped)} calls were not recorded since Coral started: the call metrics table was full.</p>` : '';
        // The server keeps calls for a limited time (#3261) and answers with the window it used: a longer range says so.
        const kept = data.hours > 0 && data.hours < hours ? `<p class="cost-empty">Calls are kept for ${Math.round(data.hours / 24)} days, so this shows the last ${Math.round(data.hours / 24)} days.</p>` : '';
        if (!rows.length) { emptyState(el, `No tool calls in the ${label} yet. They appear once an agent has used a tool.`, 'cost-empty'); if (kept + dropped) el.insertAdjacentHTML('beforeend', kept + dropped); return; }
        el.innerHTML = kept + dropped;
        const st = _tables.calls || (_tables.calls = tableState());
        if (!st.sort) st.sort = { key: 'calls', dir: 'desc' };
        const dash = v => v || '—';
        el.append(dataTable({ label: 'Tool and API calls', fold: 'labeled', scroll: true, state: st, rows, rowKey: r => `${r.operation}|${r.call_type}|${r.agent_name}|${r.board_name}`, ...phoneOneLine([
            { key: 'operation', label: 'Operation', sort: true, tone: 'primary', field: 'operation' },
            { key: 'call_type', label: 'Type', sort: true, field: 'call_type' },
            { key: 'agent', label: 'Agent', sort: true, sortValue: r => r.agent_name || '', cell: r => dash(r.agent_name) },
            { key: 'team', label: 'Team', sort: true, sortValue: r => r.board_name || '', cell: r => dash(r.board_name) },
            _numCol('calls', 'Calls', r => r.calls || 0, String, { foldFirst: true }),
            _numCol('errors', 'Errors', r => r.errors || 0, String, { foldFirst: true }),
            _numCol('avg_ms', 'Avg ms', r => Math.round(r.avg_duration_ms || 0), String, { foldFirst: true }),
        ], ['calls']) }).el);
    } catch { emptyState(el, 'Call metrics unavailable', 'cost-empty'); }
}

export function stopCostDashboard() {
    if (_costRefreshTimer) {
        clearInterval(_costRefreshTimer);
        _costRefreshTimer = null;
    }
}

// Each table is named by its section's heading, whenever the table is drawn again (a sort, a filter, a refresh) (#6432).
let _tableNamer = null;
function _nameCostTables() {
    let n = 0;
    for (const sec of document.querySelectorAll('#cost-dashboard-view .cost-section')) {
        const h = sec.querySelector('.cost-section-title'), t = sec.querySelector('table');
        n++;
        if (!h || !t) continue;
        if (!h.id) h.id = `cost-title-${n}`;
        if (t.getAttribute('aria-labelledby') !== h.id) t.setAttribute('aria-labelledby', h.id);
    }
}
function _watchCostTables() {
    const view = document.getElementById('cost-dashboard-view');
    if (_tableNamer || !view) return;
    _tableNamer = new MutationObserver(_nameCostTables);
    _tableNamer.observe(view, { childList: true, subtree: true });
    _nameCostTables();
}

export async function _refreshCostDashboard() {
    _watchCostTables();
    const { costRange, providerRows, modelRows, thinkingRows, agentRows } = await importOnce('./cost_data.js'); // the range and the rows, pure (#8359); loaded when the page first refreshes, as the page's other lazy parts are
    const period = document.getElementById('cost-time-range')?.value || 'day';
    const { hoursAgo, since, sinceParam, interval, tsParams } = costRange(period, Date.now());

    // Flash live indicator
    _flashLiveIndicator();
    _refreshSeries(); // the chart above the open breakdown view (#7857)
    _refreshOverview(); // the change against the period before, and cost by team (#7930)
    _refreshCallMetrics(period, hoursAgo); // the calls view follows the range too, with the page's own refresh (#7719)
    syncEfficiency(period);
    showSpend(document.getElementById('cost-spend'), period, document.getElementById('cost-task-time')); // tokens per commit and task time, one team (#7526, #7530): its own read, its own errors

    try {
        const [summaryResp, taskResp, tsResp, teamResp, branchResp] = await Promise.all([
            fetch(`/api/token-usage/summary${sinceParam}`).catch(() => null),
            fetch('/api/board/tasks' + COST_TASK_QUERY).catch(() => null), // only what the By task table draws: the tasks with a cost, a few columns (#9100: the whole rows of 100 tasks were 147 K, every 15 s)
            fetch(`/api/token-usage/timeseries${tsParams}`).catch(() => null),
            fetch(`/api/token-usage/by-team${sinceParam}`).catch(() => null),
            fetch(`/api/token-usage/by-branch${sinceParam}`).catch(() => null),
        ]);

        if (summaryResp && summaryResp.ok) {
            const data = await summaryResp.json();
            const t = data.totals || {};
            _setText('cost-input-tokens', formatTokens(t.input_tokens || 0));
            _setText('cost-output-tokens', formatTokens(t.output_tokens || 0));
            _setText('cost-cache-read', formatTokens(t.cache_read_tokens || 0));
            _setText('cost-cache-write', formatTokens(t.cache_write_tokens || 0));
            _setText('cost-total-requests', String(t.num_requests || 0)); // the calls recorded: the figure By agent's Requests column adds up to
            _setText('cost-total-cost', formatCost(t.cost_usd || 0, { zeroAsTwo: true }));

            // By provider (#5120): the agent types' totals, from by_agent_type: the one source for them (by_model and by_thinking split them).
            _renderProviderTable(providerRows(data.by_agent_type));

            // One row per model id and agent type (#4589); a session that switched models is in each model's row.
            _renderModelTable(modelRows(data.by_model));

            // By thinking level (#4969, #5120): per provider and model, the levels the transcripts recorded, and the rest of each model's usage as "Not reported".
            _renderThinkingTable(thinkingRows(data.by_thinking));

            // Render per-agent (session) breakdown
            _renderAgentTable(agentRows(data.by_agent));
        }

        // Render time-series chart and sparklines
        if (tsResp && tsResp.ok) {
            const data = await tsResp.json();
            const buckets = data.buckets || [];
            _renderSpendChart(buckets);
            _renderSparklines(buckets);
            _renderBurnRate(buckets, hoursAgo);
        }

        // Render team breakdown
        if (teamResp && teamResp.ok) {
            const data = await teamResp.json();
            _renderTeamTable(data.teams || []);
        }

        // Render branch breakdown
        if (branchResp && branchResp.ok) {
            const data = await branchResp.json();
            _renderBranchTable(data.branches || []);
        }

        if (taskResp && taskResp.ok) {
            const data = await taskResp.json();
            _renderTaskTable(data.tasks || []);
        }
    } catch (e) {
        console.error('[cost-dashboard] refresh error:', e);
    }
}

export function _costTimeRangeChanged() {
    syncRangeLine();
    _refreshCostDashboard();
}

function _setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

// ── The tables are data_table (#7743) ────────────────────────────────────
// A table here is its columns and its rows: the component draws it, folds it under 40 rem (name first, then "label value" lines) and sorts it. What stays on this page: the rows' own filters (the header's
// filter button opens the choice list below), and each table's sort, kept across the refresh.
const _tables = {};
const _numCol = (key, label, get, show, extra) => ({ key, label, numeric: true, sort: 'number', firstDir: 'desc', sortValue: get, cell: r => show(get(r)), ...extra });
const _tokCol = (key, label, extra) => _numCol(key, label, r => r[key] || 0, formatTokens, extra);
const _cacheCols = () => [_tokCol('cache_read_tokens', 'Cache read', { narrowHide: true }), _tokCol('cache_write_tokens', 'Cache write', { narrowHide: true })]; // the two that wait when the table's box is narrow
const _costCol = () => _numCol('cost_usd', 'Cost', r => r.cost_usd || 0, c => formatCost(c, { zeroAsTwo: true }), { foldFirst: true }); // the figure the page is opened for: on a phone it follows the name (#5056)
const _shareCol = () => _numCol('cost_pct', 'Share', r => r.cost_pct || 0, v => `${Math.round(v * 100)}%`, { foldFirst: true });
// Team's and branch's Share: the share of the whole table (not of the filtered rows), drawn as a bar with its figure.
const _shareBarCol = total => _numCol('cost_pct', 'Share', r => r.cost_usd || 0, () => '', { foldFirst: true, cell: r => {
    const pct = (((r.cost_usd || 0) / total) * 100).toFixed(1), wrap = document.createElement('div'), bar = document.createElement('div'), label = document.createElement('span');
    wrap.className = 'cost-share-bar-wrapper'; bar.className = 'cost-share-bar'; bar.style.width = `${Math.max(2, ((r.cost_usd || 0) / total) * 100)}%`; label.className = 'cost-share-label'; label.textContent = `${pct}%`;
    wrap.append(bar, label); return wrap;
} });
const _textCol = (table, key, label, get, extra) => ({ key, label, sort: true, sortValue: get, cell: get, tone: 'primary', filter: { label: `Filter ${label}, ${TABLE_TITLES[table]}`, active: () => _hasActiveFilter(table, key), open: btn => _openFilter(table, key, btn) }, ...extra });
// ── The breakdown views over time (#7857) ────────────────────────────────
// By provider, By model, By team and By agent each have a line per table row above the table. The table is the legend: a swatch before the first column's name (a button: it brings the line forward), a click on the
// row does the same, and under the table a line says whether the rows add up to where the chart ends. The chart reads /api/token-usage/timeseries?group_by=...
const SERIES_VIEWS = {
    provider: { group: 'provider', key: r => r.agent_type || 'unknown', rowKey: r => r.agent_type || 'unknown', name: r => r.agent_type || 'unknown' },
    model: { group: 'model', key: r => r.model_id || 'unknown', rowKey: r => `${r.model_id || 'unknown'}|${r.agent_type || ''}`, name: r => r.model || 'unknown' },
    team: { group: 'team', key: r => r.board_name || '(no team)', rowKey: r => r.board_name || '(no team)', name: r => (r.board_name ? keyLabel(r.board_name) : '(no team)') },
    agent: { group: 'agent', key: r => r.agent_name || '(unknown)', rowKey: r => r.session_id || `${r.agent_name}:${r.launched_at || r.first_seen}`, name: r => r.display_name || r.agent_name || 'Agent' },
};
const _currentView = () => document.getElementById('cost-dashboard-view')?.dataset.view || '';
const _periodHours = () => ({ hour: 1, day: 24, week: 168, month: 720 })[document.getElementById('cost-time-range')?.value || 'day'] || 24;
const _periodInterval = () => ({ hour: '5m', day: '1h', week: '1h', month: '1d' })[document.getElementById('cost-time-range')?.value || 'day'] || '1h';

/** The sum of a figure over a view's rows (the unfiltered ones; only those with a key in `keys` when it is given), or null when its rows do not have it (By team has no Requests). */
function _rowsTotal(view, field, keys) {
    const v = SERIES_VIEWS[view], want = keys ? new Set(keys) : null;
    const rows = (_rawData[view] || []).filter(r => !want || want.has(v.key(r)));
    if (!rows.length || rows.some(r => r[field] == null)) return null;
    return rows.reduce((a, r) => a + (Number(r[field]) || 0), 0);
}

function _drawSeries(view) {
    const host = document.getElementById(`cost-series-${view}`);
    if (!host) return;
    series.drawPanel(host, view, { tableTotal: (f, keys) => _rowsTotal(view, f, keys), redraw: () => _refreshSwatches(view), phone: isPhoneLayout() });
}

async function _refreshSeries(view = _currentView()) {
    const v = SERIES_VIEWS[view];
    if (!v) return;
    const host = document.getElementById(`cost-series-${view}`);
    if (!host) return;
    const untilMs = Date.now(), sinceMs = untilMs - _periodHours() * 3600000, interval = _periodInterval();
    try {
        const resp = await fetch(`/api/token-usage/timeseries?since=${encodeURIComponent(new Date(sinceMs).toISOString())}&interval=${interval}&group_by=${v.group}`, { cache: 'no-store' });
        if (!resp.ok) throw new Error('unavailable');
        const data = await resp.json();
        series.setData(view, { buckets: data.buckets || [], interval, sinceMs, untilMs });
    } catch { series.setData(view, null, 'The chart is unavailable. The table below is complete.'); }
    _drawSeries(view);
    _rerender(view); // the swatches
}

/** Paints a row's switch for its view's current lines: filled in its line's colour (pressed), filled grey when it is part of Other (not pressed), an empty ring when rows are chosen and this one is not. */
function _paintSwatch(btn, view, r) {
    const v = SERIES_VIEWS[view], color = series.swatchColor(view, v.key(r)), sw = btn.firstChild;
    sw.classList.toggle('cost-swatch-off', color === 'off'); sw.style.background = color === 'off' ? '' : color;
    btn.setAttribute('aria-pressed', String(series.hasLine(view, v.key(r))));
    btn.classList.toggle('cost-toggle-front', series.highlighted(view) === series.lineKeyOf(view, v.key(r)) && !!series.highlighted(view));
}
/** The switches of a view's table painted again, in place: a click does not rebuild the table, so the keyboard stays where it was. */
function _refreshSwatches(view) {
    const v = SERIES_VIEWS[view], box = document.getElementById(`cost-by-${view}`);
    if (!box) return;
    const byKey = new Map((_rawData[view] || []).map(r => [String(v.rowKey(r)), r]));
    for (const tr of box.querySelectorAll('tr.dt-row')) { const sw = tr.querySelector('.cost-toggle'), r = byKey.get(tr.dataset.key); if (sw && r) _paintSwatch(sw, view, r); }
}
const _highlight = (view, r) => { series.setHighlight(view, series.lineKeyOf(view, SERIES_VIEWS[view].key(r))); _drawSeries(view); _refreshSwatches(view); };
const _toggle = (view, r) => { series.toggleLine(view, SERIES_VIEWS[view].key(r)); _drawSeries(view); _refreshSwatches(view); };

/** A row's switch in the table's first column: its line's swatch, a button (aria-pressed): pressed and filled when the row has a line, a ring when it is left out. It is the only control of the row's line; a click on the
 *  row itself brings the line forward. */
function _swatched(view, cell) {
    return r => {
        const inner = cell(r);
        if (!series.swatchColor(view, SERIES_VIEWS[view].key(r))) return inner;
        const wrap = document.createElement('span'); wrap.className = 'cost-lead';
        const b = document.createElement('button'); b.type = 'button'; b.className = 'cost-toggle'; b.setAttribute('aria-label', `Show ${SERIES_VIEWS[view].name(r)}'s line`);
        b.append(document.createElement('i')); b.firstChild.className = 'cost-swatch'; b.firstChild.setAttribute('aria-hidden', 'true');
        b.addEventListener('click', () => _toggle(view, r));
        _paintSwatch(b, view, r);
        wrap.append(b, inner instanceof Node ? inner : document.createTextNode(String(inner == null ? '' : inner)));
        return wrap;
    };
}
const _seriesOpts = view => ({ open: r => _highlight(view, r), rowName: r => SERIES_VIEWS[view].name(r), rowKey: SERIES_VIEWS[view].rowKey });

// ── The Overview over time (#7930): the change against the period before, and cost by team stacked ──
const _CHANGE_CARDS = { input_tokens: 'input', output_tokens: 'output', cache_read_tokens: 'cache-read', cache_write_tokens: 'cache-write', num_requests: 'requests', cost_usd: 'cost' };

async function _refreshOverview() {
    if (_currentView() !== 'overview') return;
    const host = document.getElementById('cost-series-overview');
    if (!host) return;
    const hours = _periodHours(), untilMs = Date.now(), sinceMs = untilMs - hours * 3600000, interval = _periodInterval(), iso = ms => encodeURIComponent(new Date(ms).toISOString());
    const read = async url => { const resp = await fetch(url, { cache: 'no-store' }); if (!resp.ok) throw new Error('unavailable'); return (await resp.json()).buckets || []; };
    try {
        const [now, byTeam, prior] = await Promise.all([
            read(`/api/token-usage/timeseries?since=${iso(sinceMs)}&interval=1d`),
            read(`/api/token-usage/timeseries?since=${iso(sinceMs)}&interval=${interval}&group_by=team`),
            read(`/api/token-usage/timeseries?since=${iso(sinceMs - hours * 3600000)}&until=${iso(sinceMs)}&interval=1d`),
        ]);
        const word = series.priorWord(document.getElementById('cost-time-range')?.value || 'day'), cur = series.bucketTotals(now), before = series.bucketTotals(prior);
        let compared = false;
        for (const [field, id] of Object.entries(_CHANGE_CARDS)) { const e = document.getElementById(`cost-change-${id}`), t = series.changeText(cur[field], before[field]); if (e) e.textContent = t; if (t) compared = true; }
        _setText('cost-compare-text', compared ? ` \u00b7 Change against ${word}` : ''); // said once here, not on each tile
        series.setData('overview', { buckets: byTeam, interval, sinceMs, untilMs });
    } catch {
        for (const id of Object.values(_CHANGE_CARDS)) { const e = document.getElementById(`cost-change-${id}`); if (e) e.textContent = ''; }
        _setText('cost-compare-text', '');
        series.setData('overview', null, 'The chart is unavailable. The figures above are complete.');
    }
    series.drawOverviewPanel(host, { phone: isPhoneLayout() });
}

document.addEventListener('cost-view-change', e => {
    if (e.detail !== 'overview') _setText('cost-compare-text', ''); // the comparison is the Overview's: no other view says it
    if (SERIES_VIEWS[e.detail]) _refreshSeries(e.detail); else if (e.detail === 'overview') _refreshOverview();
});
let _resizeTimer = null;
window.addEventListener('resize', () => { clearTimeout(_resizeTimer); _resizeTimer = setTimeout(() => { const v = _currentView(); if (SERIES_VIEWS[v] && document.getElementById(`cost-series-${v}`)?.firstChild) _drawSeries(v); }, 150); });

const PHONE_LEAD = { model: 'model', thinking: 'level' }; // the column By model and By thinking are about, kept on a phone beside Cost: the Provider column before it is only a filter (#8982)
function _drawTable(container, table, columns, rows, empty, extra) {
    const st = _tables[table] || (_tables[table] = tableState());
    if (!st.sort) st.sort = { key: 'cost_usd', dir: 'desc' };
    if (!rows.length) { emptyState(container, empty || NO_DATA, 'cost-empty'); return; }
    const t = dataTable({ label: TABLE_TITLES[table], rowKey: r => rows.indexOf(r), state: st, fold: 'labeled', scroll: true, ...phoneOneLine(columns, ['cost_usd'], PHONE_LEAD[table]), rows, ...extra }); // a phone: one line a row, the name and Cost (#8982)
    container.replaceChildren(t.el);
    if (SERIES_VIEWS[table]) _drawSeries(table); // the line under the chart compares its total with these rows
}

function _renderProviderTable(rows) {
    const total = rows.reduce((n, r) => n + (r.cost_usd || 0), 0);
    rows.forEach(r => { r.cost_pct = total > 0 ? (r.cost_usd || 0) / total : 0; });
    _rawData.provider = rows;
    const container = document.getElementById('cost-by-provider');
    if (!container) return;
    const filtered = _applyColFilters(rows, 'provider', { agent_type: r => r.agent_type || '' });
    _drawTable(container, 'provider', [
        _textCol('provider', 'agent_type', 'Provider', r => r.agent_type || '', { cell: _swatched('provider', r => r.agent_type || '') }),
        _numCol('requests', 'Requests', r => r.requests || 0, String),
        _tokCol('input_tokens', 'Input'), _tokCol('output_tokens', 'Output'), ..._cacheCols(),
        _costCol(), _shareCol(),
    ], filtered, null, _seriesOpts('provider'));
}

function _renderModelTable(rows) {
    const modelTotal = rows.reduce((n, r) => n + (r.cost_usd || 0), 0);
    rows.forEach(r => { r.cost_pct = modelTotal > 0 ? (r.cost_usd || 0) / modelTotal : 0; });
    _rawData.model = rows;
    const container = document.getElementById('cost-by-model');
    if (!container) return;
    const filtered = _applyColFilters(rows, 'model', { model: r => r.model || '', agent_type: r => r.agent_type || '' });
    _drawTable(container, 'model', [
        _textCol('model', 'agent_type', 'Provider', r => r.agent_type || '', { cell: _swatched('model', r => r.agent_type || '') }),
        _textCol('model', 'model', 'Model', r => r.model || '', { title: r => r.model_id || '' }),
        _numCol('requests', 'Requests', r => r.requests || 0, String),
        _tokCol('input_tokens', 'Input'), _tokCol('output_tokens', 'Output'), ..._cacheCols(),
        _costCol(), _shareCol(),
    ], filtered, null, _seriesOpts('model'));
}


/** Usage by thinking level (#4969). "Not reported" is the usage whose turn recorded no level (a CLI that writes none, or from before it was tracked):
 *  never the level an agent was launched with. "Thinking" is the tokens the CLI reported for thinking, shown apart: it is not added to any total. */
function _renderThinkingTable(rows) {
    const total = rows.reduce((n, r) => n + (r.cost_usd || 0), 0);
    rows.forEach(r => { r.cost_pct = total > 0 ? (r.cost_usd || 0) / total : 0; });
    _rawData.thinking = rows;
    const container = document.getElementById('cost-by-thinking');
    if (!container) return;
    const filtered = _applyColFilters(rows, 'thinking', { agent_type: r => r.agent_type || '', model: r => r.model || '', level: r => r.level || '' }); // the three filter buttons of the headings (#5042: they opened nothing)
    _drawTable(container, 'thinking', [
        _textCol('thinking', 'agent_type', 'Provider', r => r.agent_type || ''),
        _textCol('thinking', 'model', 'Model', r => r.model || '', { sortValue: r => (r.model_id ? r.model : 'zzzz Not reported'), title: r => r.model_id || '' }), // after the named models when ascending
        _textCol('thinking', 'level', 'Thinking level', r => r.level || '', { sortValue: r => (r.level_key ? r.level : 'zzzz Not reported') }), // after the named levels when ascending (localeCompare puts '~' first)
        _numCol('requests', 'Calls', r => r.requests || 0, v => (v ? String(v) : '–')),
        _tokCol('input_tokens', 'Input'), _tokCol('output_tokens', 'Output'), ..._cacheCols(),
        _numCol('thinking_tokens', 'Thinking', r => r.thinking_tokens, v => (v === null ? '–' : formatTokens(v)), { sortValue: r => r.thinking_tokens || 0 }),
        _costCol(), _shareCol(),
    ], filtered, null, { quiet: r => !r.level_key }); // the usage with no thinking level recorded (#4969) is not a level: quieter than the rows that are
}

function _renderAgentTable(rows) {
    _rawData.agent = rows;
    const container = document.getElementById('cost-by-agent');
    if (!container) return;
    const nameOf = r => r.display_name || r.agent_name || '';
    const filtered = _applyColFilters(rows, 'agent', { agent_name: nameOf, board_name: r => r.board_name || '', folder: r => r.folder || '' });
    const start = r => r.launched_at || r.first_seen, end = r => r.stopped_at || r.last_seen;
    const span = r => { const a = Date.parse(start(r)), b = end(r) ? Date.parse(end(r)) : Date.now(); return Number.isFinite(a) && Number.isFinite(b) ? b - a : -1; };
    // a name opens the live agent, or the ended one's history (the mouse over a row draws its cost over its turns)
    const nameCell = r => {
        const session = _findSession(r.session_id);
        const name = r.display_name || (session && session.display_name) || r.agent_name || r.session_id || '—';
        if (session) return dtLink(name, () => { window.switchNavTab('agents'); window.selectLiveSession(session.name, session.agent_type, session.session_id); });
        if (!r.session_id) return name;
        const wrap = document.createElement('span');
        wrap.append(dtLink(name, () => { window.switchNavTab('history'); window.selectHistorySession(r.session_id); }));
        if (r.is_live === false) wrap.append(document.createTextNode(' (ended)'));
        return wrap;
    };
    _drawTable(container, 'agent', [
        _textCol('agent', 'agent_name', 'Agent', nameOf, { cell: _swatched('agent', nameCell) }),
        _costCol(), // right after the name: eleven columns do not all fit a desktop page, and Cost is the figure the page is opened for (#7719)
        _textCol('agent', 'board_name', 'Team', r => r.board_name || '', { cell: r => (r.board_name ? keyLabel(r.board_name) : '—'), tone: 'secondary' }), // the key's label (#3536)
        _textCol('agent', 'folder', 'Folder', r => r.folder || '', { cell: r => r.folder || '—', title: r => r.working_dir || r.folder || '', tone: 'secondary' }),
        { key: 'first_seen', label: 'Launched', sort: true, sortValue: r => start(r) || '', cell: r => _formatTime(start(r)), tone: 'secondary' },
        _numCol('duration', 'Duration', span, () => '', { cell: r => _formatDuration(start(r), end(r)) }),
        _numCol('requests', 'Requests', r => r.requests || 0, String),
        _tokCol('input_tokens', 'Input'), _tokCol('output_tokens', 'Output'), ..._cacheCols(),
        { key: 'details', label: 'Details', tone: 'secondary', cell: r => { const b = dtLink('Charts', () => agentDetail.openAgent(r, document.getElementById('cost-time-range')?.value || 'day')); b.setAttribute('aria-label', `Charts for ${r.display_name || r.agent_name || 'agent'}`); return b; } }, // one agent over the range (#7930)
    ], filtered, NO_DATA, _seriesOpts('agent'));
}

const COST_TASK_FIELDS = 'id,board_id,title,status,priority,assigned_to,claimed_at,completed_at,cost_usd,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens';
const COST_TASK_QUERY = `?has_cost=true&limit=100&fields=${COST_TASK_FIELDS}`; // the tasks with a cost and the columns the table draws, not the whole rows of 100 tasks every 15 s (147 K, #9100)

// Cached tasks for click-to-detail
let _costTaskCache = [];

function _showCostTaskDetail(taskId) {
    const task = _costTaskCache.find(t => t.id === taskId);
    const board = task && task.board_id || state.selectedTeam;
    if (board) openTask(board, taskId); // the task's own page on its team's page (#7644)
}

function _renderTaskTable(tasks) {
    const container = document.getElementById('cost-by-task');
    if (!container) return;

    // Only show tasks with cost data
    const costTasks = tasks.filter(t => t.cost_usd > 0);
    _rawData.task = costTasks;

    const filtered = _applyColFilters(costTasks, 'task', {
        assigned_to: t => t.assigned_to || '',
        priority: t => t.priority || 'medium',
    });
    _costTaskCache = filtered;
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    const STATUS = { completed: 'Done', in_progress: 'In progress', skipped: 'Skipped' };
    const span = t => { const a = Date.parse(t.claimed_at); if (!Number.isFinite(a)) return -1; const b = t.completed_at ? Date.parse(t.completed_at) : Date.now(); return b - a; };
    _drawTable(container, 'task', [
        { key: 'status', label: 'Status', cell: t => chip(STATUS[t.status] || 'Waiting', `status-${String(t.status || 'pending').replace('_', '-')}`), tone: 'secondary' },
        { key: 'id', label: 'ID', cell: t => `#${t.id}`, tone: 'tertiary' },
        { key: 'title', label: 'Task', primary: true, sort: true, sortValue: t => t.title || '', cell: t => t.title || '', width: 'grow' },
        _textCol('task', 'assigned_to', 'Agent', t => t.assigned_to || '', { cell: t => avatar(t.assigned_to, t.assigned_to || '—'), tone: 'secondary' }),
        _textCol('task', 'priority', 'Priority', t => t.priority || 'medium', { sortValue: t => priorityOrder[t.priority] ?? 2, cell: t => tag(t.priority || 'medium'), tone: 'secondary', firstDir: 'asc' }),
        { key: 'claimed_at', label: 'Start time', sort: true, sortValue: t => t.claimed_at || '', cell: t => (t.claimed_at ? _formatTime(t.claimed_at) : '—'), tone: 'secondary' },
        _numCol('duration', 'Duration', span, () => '', { cell: t => _formatDuration(t.claimed_at, t.completed_at) }),
        _tokCol('input_tokens', 'Input'), _tokCol('output_tokens', 'Output'), ..._cacheCols(),
        _costCol(),
    ], filtered, 'No task costs in this range yet. They appear once an agent has worked on a board task.', { rowKey: t => t.id, open: t => _showCostTaskDetail(t.id), rowName: t => t.title || '' });
}

// ── Live Indicator ───────────────────────────────────────────

function _flashLiveIndicator() {
    const el = document.getElementById('cost-live-indicator');
    if (!el) return;
    el.classList.add('cost-live-flash');
    setTimeout(() => el.classList.remove('cost-live-flash'), 1000);
}

// ── Cumulative Spend Chart ───────────────────────────────────

let _spendBuckets = [], _spendDrawnW = 0, _spendWatch = null;

/** The chart is drawn at the card's inside width, and again when that changes (the window, the sidebar): an svg drawn at a width measured once sat centred in a wider card, with an empty band beside it (#7712). */
function _watchSpendChart(container) {
    if (_spendWatch || typeof ResizeObserver !== 'function') return;
    _spendWatch = new ResizeObserver(() => { if (_spendBuckets.length >= 2 && _spendInnerWidth(container) !== _spendDrawnW) _renderSpendChart(_spendBuckets); });
    _spendWatch.observe(container);
}
function _spendInnerWidth(container) {
    const cs = getComputedStyle(container);
    return Math.max(0, Math.round(container.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0))); // 0 while the view is hidden (the padding alone is not a width)
}

function _renderSpendChart(buckets) {
    const container = document.getElementById('cost-spend-chart');
    if (!container) return;
    _spendBuckets = buckets;
    _watchSpendChart(container);

    if (buckets.length < 2) {
        emptyState(container, 'Not enough data', 'cost-empty');
        return;
    }

    _spendDrawnW = _spendInnerWidth(container);
    const W = _spendDrawnW || 600; // hidden: a fallback, drawn again when the card has a width
    const H = 180;
    const PAD = { top: 24, right: 16, bottom: 32, left: 56 };
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;

    const maxCost = buckets[buckets.length - 1].cumulative_cost || 1;
    const n = buckets.length;

    // Build polyline for cumulative cost
    const points = buckets.map((b, i) => {
        const x = PAD.left + (i / (n - 1)) * plotW;
        const y = PAD.top + plotH - (b.cumulative_cost / maxCost) * plotH;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    });

    // Area fill
    const areaPoints = [
        `${PAD.left.toFixed(1)},${(PAD.top + plotH).toFixed(1)}`,
        ...points,
        `${(PAD.left + plotW).toFixed(1)},${(PAD.top + plotH).toFixed(1)}`
    ];

    // Y-axis labels
    const midCost = maxCost / 2;

    // X-axis labels (first, middle, last): a multi-day chart must distinguish dates, not repeat the same time.
    const multiDay = Date.parse(buckets[n - 1].bucket) - Date.parse(buckets[0].bucket) > 86400000;
    const formatBucketLabel = (b) => {
        try {
            const d = new Date(b);
            return multiDay ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        } catch { return ''; }
    };

    // The chart's text alternative: what it shows and where it ends (the tables below carry the detail) (#6432).
    const chartLabel = `Cumulative spend: ${formatCost(buckets[buckets.length - 1].cumulative_cost || 0, { zeroAsTwo: true })} over ${n} intervals`;
    const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="spend-chart-svg" role="img" aria-label="${escapeAttr(chartLabel)}">
        <!-- Grid lines -->
        <line class="cost-chart-grid" x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left + plotW}" y2="${PAD.top}" />
        <line class="cost-chart-grid" x1="${PAD.left}" y1="${PAD.top + plotH / 2}" x2="${PAD.left + plotW}" y2="${PAD.top + plotH / 2}" stroke-dasharray="4,4" />
        <line class="cost-chart-grid" x1="${PAD.left}" y1="${PAD.top + plotH}" x2="${PAD.left + plotW}" y2="${PAD.top + plotH}" />
        <!-- Area + Line -->
        <polygon class="spend-area" points="${areaPoints.join(' ')}" />
        <polyline class="spend-line" points="${points.join(' ')}" />
        <!-- Dot on last point -->
        <circle class="spend-dot" cx="${points[points.length - 1].split(',')[0]}" cy="${points[points.length - 1].split(',')[1]}" r="3" />
        <!-- Y labels -->
        <text class="spend-label" x="${PAD.left - 8}" y="${PAD.top + 4}" text-anchor="end">${formatCost(maxCost, { zeroAsTwo: true })}</text>
        <text class="spend-label" x="${PAD.left - 8}" y="${PAD.top + plotH / 2 + 4}" text-anchor="end">${formatCost(midCost, { zeroAsTwo: true })}</text>
        <text class="spend-label" x="${PAD.left - 8}" y="${PAD.top + plotH + 4}" text-anchor="end">$0</text>
        <!-- X labels -->
        <text class="spend-label" x="${PAD.left}" y="${H - 4}" text-anchor="start">${formatBucketLabel(buckets[0].bucket)}</text>
        <text class="spend-label" x="${PAD.left + plotW / 2}" y="${H - 4}" text-anchor="middle">${formatBucketLabel(buckets[Math.floor(n / 2)].bucket)}</text>
        <text class="spend-label" x="${PAD.left + plotW}" y="${H - 4}" text-anchor="end">${formatBucketLabel(buckets[n - 1].bucket)}</text>
    </svg>`;

    container.innerHTML = svg;
}

// ── Sparklines in Summary Cards ──────────────────────────────

function _renderMiniSparkline(containerId, values, color) {
    const container = document.getElementById(containerId);
    if (!container || values.length < 2) {
        if (container) container.innerHTML = '';
        return;
    }

    const W = 80, H = 24;
    const max = Math.max(...values) || 1;
    const n = values.length;

    const points = values.map((v, i) => {
        const x = (i / (n - 1)) * W;
        const y = H - (v / max) * (H - 2) - 1;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    });

    container.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
        <polyline fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" points="${points.join(' ')}" />
    </svg>`;
}

function _cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function _renderSparklines(buckets) {
    if (buckets.length < 2) return;
    // each tile's line is its metric's colour in the charts (the same tokens: input blue, output orange, cache read aqua, cache write yellow)
    const c = field => _cssVar(`--viz-${(series.METRIC_SLOT[field] ?? 0) + 1}`);
    _renderMiniSparkline('cost-spark-input', buckets.map(b => b.input_tokens), c('input_tokens'));
    _renderMiniSparkline('cost-spark-output', buckets.map(b => b.output_tokens), c('output_tokens'));
    _renderMiniSparkline('cost-spark-cache-read', buckets.map(b => b.cache_read_tokens), c('cache_read_tokens'));
    _renderMiniSparkline('cost-spark-cache-write', buckets.map(b => b.cache_write_tokens), c('cache_write_tokens'));
    _renderMiniSparkline('cost-spark-requests', buckets.map(b => b.num_requests), c('num_requests'));
    _renderMiniSparkline('cost-spark-cost', buckets.map(b => b.cumulative_cost), c('cost_usd'));
}

// ── Burn Rate ────────────────────────────────────────────────

function _renderBurnRate(buckets, periodHours) {
    const el = document.getElementById('cost-burn-rate');
    if (!el || buckets.length === 0) return;

    const totalCost = buckets[buckets.length - 1].cumulative_cost || 0;

    if (totalCost === 0 || periodHours === 0) {
        el.textContent = '$0.00/hr';
        return;
    }

    // Calculate actual time span from data
    const firstTime = new Date(buckets[0].bucket).getTime();
    const lastTime = new Date(buckets[buckets.length - 1].bucket).getTime();
    const spanHours = Math.max((lastTime - firstTime) / 3600000, 1);

    const rate = totalCost / spanHours;
    el.textContent = formatCost(rate, { zeroAsTwo: true }) + '/hr';
}

// ── Team Table ───────────────────────────────────────────────

function _renderTeamTable(teams) {
    _rawData.team = teams;
    const container = document.getElementById('cost-by-team');
    if (!container) return;
    const filtered = _applyColFilters(teams, 'team', { board_name: t => t.board_name || '(no team)' });
    const total = teams.reduce((n, t) => n + (t.cost_usd || 0), 0) || 1;
    _drawTable(container, 'team', [
        _textCol('team', 'board_name', 'Team', t => t.board_name || '', { cell: _swatched('team', t => (t.board_name ? keyLabel(t.board_name) : '(no team)')) }),
        _numCol('num_agents', 'Agents', t => t.num_agents || 0, String),
        _tokCol('input_tokens', 'Input'), _tokCol('output_tokens', 'Output'), ..._cacheCols(),
        _costCol(), _shareBarCol(total),
    ], filtered, null, _seriesOpts('team'));
}

// ── Branch Table ────────────────────────────────────────────

/** A pull request's number, linked to it when the repository's address is known. */
function _prCell(prNumber, remoteURL) {
    if (!prNumber) return '—';
    if (!remoteURL) return `#${prNumber}`;
    let base = remoteURL.replace(/\.git$/, '');
    if (base.startsWith('git@')) {
        const parts = base.split(':');
        if (parts.length === 2) base = 'https://' + parts[0].slice(4) + '/' + parts[1];
    }
    const a = document.createElement('a'); a.href = `${base}/pull/${prNumber}`; a.target = '_blank'; a.rel = 'noopener'; a.textContent = `#${prNumber}`;
    return a;
}

function _renderBranchTable(branches) {
    _rawData.branch = branches;
    const container = document.getElementById('cost-by-branch');
    if (!container) return;
    const branchName = b => (b.repo_name && b.branch ? `${b.repo_name} : ${b.branch}` : b.branch) || '';
    const filtered = _applyColFilters(branches, 'branch', {
        branch: b => branchName(b) || '(unknown)',
        board_name: b => b.board_name || '(no team)',
    });
    const total = branches.reduce((n, b) => n + (b.cost_usd || 0), 0) || 1;
    _drawTable(container, 'branch', [
        _textCol('branch', 'branch', 'Branch', branchName, { cell: b => branchName(b) || '(unknown)' }),
        _textCol('branch', 'board_name', 'Team', b => b.board_name || '', { cell: b => (b.board_name ? keyLabel(b.board_name) : '—'), tone: 'secondary' }),
        _numCol('pr_number', 'PR', b => b.pr_number || 0, () => '', { cell: b => _prCell(b.pr_number, b.remote_url) }),
        _numCol('num_agents', 'Agents', b => b.num_agents || 0, String),
        _tokCol('input_tokens', 'Input'), _tokCol('output_tokens', 'Output'), ..._cacheCols(),
        _costCol(), _shareBarCol(total),
    ], filtered);
}
