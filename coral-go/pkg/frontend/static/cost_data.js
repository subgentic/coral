/* The Analytics page's reads turned into rows, with no page in them (#8359, from #8340's census): the range a period names and the rows each table draws from the summary.
 * Moved out of cost_dashboard.js's _refreshCostDashboard as it was; the page still fetches and draws. Pure functions, so a node test can pin them (cost_data.test.mjs). */
import { modelDisplayName } from './model_names.js';

const THINKING_NAMES = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
function thinkingLevelName(level) { return level ? (THINKING_NAMES[level] || level) : 'Not reported'; }

/** What a period (hour, day, week, month) asks for: its hours, the `since` stamp from `nowMs`, the query strings for the summary and the time series, and the series' interval. */
export function costRange(period, nowMs) {
    // Map period to a 'since' timestamp for the unified token-usage API
    const sinceMap = { 'hour': 1, 'day': 24, 'week': 168, 'month': 720 };
    const hoursAgo = sinceMap[period] || 24;
    const since = hoursAgo > 0 ? new Date(nowMs - hoursAgo * 3600000).toISOString() : '';
    const sinceParam = since ? `?since=${encodeURIComponent(since)}` : '';

    // Choose time-series interval based on period
    const intervalMap = { 'hour': '5m', 'day': '1h', 'week': '1h', 'month': '1d' };
    const interval = intervalMap[period] || '1h';
    const tsParams = since
        ? `?since=${encodeURIComponent(since)}&interval=${interval}`
        : `?interval=${interval}`;
    return { hoursAgo, since, sinceParam, interval, tsParams };
}

/** By provider (#5120): the agent types' totals, from by_agent_type: the one source for them (by_model and by_thinking split them). */
export const providerRows = (rows) => (rows || []).map(a => ({
    agent_type: a.agent_type || 'unknown',
    requests: a.num_requests || 0,
    input_tokens: a.input_tokens || 0,
    output_tokens: a.output_tokens || 0,
    cache_read_tokens: a.cache_read_tokens || 0,
    cache_write_tokens: a.cache_write_tokens || 0,
    cost_usd: a.cost_usd || 0,
    cost_pct: 0,
}));

/** One row per model id and agent type (#4589); a session that switched models is in each model's row. */
export const modelRows = (rows) => (rows || []).map(a => ({
    model: modelDisplayName(a.model, a.model_display) || 'unknown',
    model_id: typeof a.model === 'string' ? a.model : '',
    agent_type: a.agent_type || 'unknown',
    requests: a.num_requests || 0,
    input_tokens: a.input_tokens || 0,
    output_tokens: a.output_tokens || 0,
    cache_read_tokens: a.cache_read_tokens || 0,
    cache_write_tokens: a.cache_write_tokens || 0,
    cost_usd: a.cost_usd || 0,
}));

/** By thinking level (#4969, #5120): per provider and model, the levels the transcripts recorded, and the rest of each model's usage as "Not reported". */
export const thinkingRows = (rows) => (rows || []).map(a => ({
    agent_type: a.agent_type || 'unknown',
    model: a.model ? modelDisplayName(a.model, a.model_display) : 'Not reported',
    model_id: typeof a.model === 'string' ? a.model : '',
    requests: a.num_calls || 0,
    level: thinkingLevelName(a.thinking),
    level_key: a.thinking || '',
    input_tokens: a.input_tokens || 0,
    output_tokens: a.output_tokens || 0,
    cache_read_tokens: a.cache_read_tokens || 0,
    cache_write_tokens: a.cache_write_tokens || 0,
    thinking_tokens: a.thinking ? (a.thinking_tokens || 0) : null,
    cost_usd: a.cost_usd || 0,
    cost_pct: 0,
}));

/** Per-agent (session) breakdown. */
export const agentRows = (rows) => (rows || []).map(a => ({
    session_id: a.session_id,
    agent_name: a.agent_name,
    display_name: a.agent_name || 'Agent',
    board_name: a.board_name || '',
    folder: a.folder || '',
    working_dir: a.working_dir || '',
    requests: a.requests || 0,
    input_tokens: a.input_tokens || 0,
    output_tokens: a.output_tokens || 0,
    cache_read_tokens: a.cache_read_tokens || 0,
    cache_write_tokens: a.cache_write_tokens || 0,
    cost_usd: a.cost_usd || 0,
    first_seen: a.first_seen || '',
    last_seen: a.last_seen || '',
    launched_at: a.launched_at || '',
    stopped_at: a.stopped_at || '',
}));

