/* The Analytics view "Resource queue" (#13671, the Operator's ask): how much the queue that shares the Mac and the mini between agents is used, and whether it improves coordination. It reads
 * GET /api/analytics/resource-queue (numbers only, the Operator's alone, on this computer: a Hub guest or an agent is refused and the page says so in one line). The before side of the
 * before/after is the board's HEAVY RUN posts (an estimate, said so on the page); the since side is the queue's own record. Everything is built with the DOM and textContent: agent names are written by agents. */
import { importOnce } from './import_once.js';
const V = await importOnce('./analytics_viz.js');
const D = await importOnce('./analytics_tabs_data.js');
const { el } = V;

export const QUEUE_GUEST_LINE = 'The resource queue’s numbers are for the person at this computer only: they come from this computer’s queue and board.';

/** "45 s", "3 min", "1 h 5 min": a length of time said the way a person says it. */
export function durWords(seconds) {
    const s = Math.round(Number(seconds) || 0);
    if (s < 60) return `${s} s`;
    if (s < 3600) return `${Math.round(s / 60)} min`;
    const h = Math.floor(s / 3600), m = Math.round((s - h * 3600) / 60);
    return m ? `${h} h ${m} min` : `${h} h`;
}
const minWords = (m) => (m < 0 ? 'no samples' : durWords(m * 60));
const perDay = (n, unit) => `${String(Math.round(n * 10) / 10).replace(/\.0$/, '')} ${unit} a day`;
const pctWords = (p) => `${String(Math.round(p * 10) / 10).replace(/\.0$/, '')}%`;
const say = (text, status = false) => { const p = el('p', 'atab-say', text); if (status) p.setAttribute('role', 'status'); return p; }; // role=status only on the lines that appear when something is empty or went wrong: the explanations stay quiet when the period changes

/** What the read becomes for the page: the before/after rows, the days (the go-live day marked) and the resource rows. */
export function queueModel(data) {
    const ba = data.before_after || {}, before = ba.before || {}, since = ba.since || {};
    const cutDay = String(data.go_live || '').slice(0, 10), cutTime = String(data.go_live || '').slice(11, 16);
    const days = (data.per_day || []).map(d => ({ ...d, label: D.dayLabel(d.day) + (d.day === cutDay ? ' · queue live' : '') }));
    const live = since.days > 0;
    const rows = [
        ['Heavy runs overlapping on one computer', perDay(before.overlap_min_per_day || 0, 'min'), live ? perDay(since.overlap_min_per_day || 0, 'min') : 'Not yet'],
        ['Slot-request posts on the board', perDay(before.slot_posts_per_day || 0, 'posts'), live ? perDay(since.slot_posts_per_day || 0, 'posts') : 'Not yet'],
        ['Median wait for a slot', before.wait_samples ? `about ${minWords(before.wait_median_min)}` : 'no samples', live ? (since.wait_samples ? minWords(since.wait_median_min) : 'no samples') : 'Not yet'],
        ['Heavy runs started (from the posts)', String(before.runs || 0), live ? String(since.runs || 0) : 'Not yet'],
    ];
    return { before, since, live, days, rows, cutDay, cutWhen: `${cutDay} ${cutTime}`, resources: data.resources || [], agents: data.by_agent || [], patterns: data.by_pattern || [], hasHistory: !!data.history, hasQueue: data.queue !== false };
}

function pending(text) { const n = el('p', 'atab-pending'); n.append(el('b', null, 'Collecting. '), document.createTextNode(text)); return n; }

/** The page's content for one read: an array of nodes. */
export function drawQueue(data, phone) {
    const q = queueModel(data), out = [];
    const less = (cur, prev) => (q.live && prev > 0 ? V.changeWords(cur, prev).replace(/^same as before$/, 'same as before').replace(/(\d+% (more|less))$/, '$1 than before') : '');
    out.push(V.kpiStrip([
        { label: 'Overlapping heavy runs, before', value: perDay(q.before.overlap_min_per_day || 0, 'min'), note: `${q.before.days || 0} days of the board’s HEAVY RUN posts` },
        { label: 'Overlapping heavy runs, since the queue', value: q.live ? perDay(q.since.overlap_min_per_day || 0, 'min') : 'Not yet', delta: less(q.since.overlap_min_per_day, q.before.overlap_min_per_day), good: q.since.overlap_min_per_day <= q.before.overlap_min_per_day ? true : false, note: q.live ? `${q.since.days} days since the queue went live` : `the queue went live ${q.cutWhen}Z` },
        { label: 'Slot-request posts, since', value: q.live ? perDay(q.since.slot_posts_per_day || 0, 'posts') : 'Not yet', delta: less(q.since.slot_posts_per_day, q.before.slot_posts_per_day), good: q.since.slot_posts_per_day <= q.before.slot_posts_per_day ? true : false, note: `before: ${perDay(q.before.slot_posts_per_day || 0, 'posts')}` },
        { label: 'Median wait for a slot, since', value: q.live && q.since.wait_samples ? minWords(q.since.wait_median_min) : 'No samples', note: q.before.wait_samples ? `before: about ${minWords(q.before.wait_median_min)} (an estimate)` : 'before: no samples' },
    ]));
    out.push(V.panel('Before and after the queue', `the queue went live ${q.cutWhen} UTC`,
        V.plainTable(['Measure', `Before (${q.before.days || 0} days)`, q.live ? `Since (${q.since.days} days)` : 'Since'], q.rows, { right: [1, 2], label: 'Before and after the resource queue' }),
        say('Before the queue the numbers are read from the team’s own HEAVY RUN START and END posts and from posts asking for a slot, so they are estimates. Since the queue the wait is the queue’s own record.')));
    const overlap = [{ key: 'overlap_mac_min', name: 'Mac' }, { key: 'overlap_mini_min', name: 'mini' }];
    out.push(V.panel('Heavy runs overlapping', 'minutes a day with two or more on one computer: lower is better',
        V.stackedBars(q.days.map(d => ({ day: d.day, label: d.label, values: { overlap_mac_min: d.overlap_mac_min, overlap_mini_min: d.overlap_mini_min } })), overlap, { fmt: D.fmtCount, phone, label: 'Minutes of overlapping heavy runs per day' }), V.legend(overlap)));
    const posts = [{ key: 'slot_posts', name: 'Slot-request posts' }];
    out.push(V.panel('Slot-request posts', 'a day, the posts the queue is meant to make unnecessary',
        V.stackedBars(q.days.map(d => ({ day: d.day, label: d.label, values: { slot_posts: d.slot_posts } })), posts, { fmt: D.fmtCount, phone, label: 'Slot-request posts per day' }), V.legend(posts)));
    if (!q.hasQueue) { out.push(pending('The resource queue is off on this computer, so only the board’s posts are counted.')); return out; }
    if (!q.hasHistory) { out.push(pending('The queue’s own record could not be opened on this computer, so its usage is not kept.')); return out; }
    out.push(V.panel('Use of each resource', 'busy is the share of the time a slot was held', q.resources.length
        ? V.plainTable(['Resource', 'Claims', 'Busy', 'Wait: median / slowest 1 in 10', 'Granted at once', 'By the hook / by hand', 'Refused / kicked / lease ran out'],
            q.resources.map(r => [r.resource, D.fmtCount(r.claims), pctWords(r.busy_pct), `${durWords(r.wait_median_s)} / ${durWords(r.wait_p90_s)}`, pctWords(r.at_once_pct), `${D.fmtCount(r.auto)} / ${D.fmtCount(r.hand)}`, `${D.fmtCount(r.refused)} / ${D.fmtCount(r.kicked)} / ${D.fmtCount(r.expired)}`]),
            { right: [1, 2, 3, 4, 5, 6], label: 'Use of each resource' })
        : pending('Nothing has been claimed in this period. The queue’s own numbers appear as agents claim.')));
    const byAgent = q.agents.slice(0, 8).map((a, i) => ({ name: a.agent, value: a.holds, i, text: `${D.fmtCount(a.holds)} ${a.holds === 1 ? 'hold' : 'holds'} · ${a.hours} h` }));
    const byPattern = q.patterns.slice(0, 8).map((p, i) => ({ name: p.pattern, value: p.holds, i, text: `${D.fmtCount(p.holds)} ${p.holds === 1 ? 'hold' : 'holds'}` }));
    const agents = V.panel('Holds by agent', 'who held a computer', byAgent.length ? V.rankedBars(byAgent) : say('No agent has held a computer in this period.', true));
    const pats = V.panel('Holds by command', 'the hook’s matched pattern, never the command itself', byPattern.length ? V.rankedBars(byPattern) : say('The hook has claimed nothing in this period.', true));
    const both = el('div', 'atab-row2'); both.append(agents, pats);
    out.push(phone ? agents : both);
    if (phone) out.push(pats);
    if (data.dropped > 0) out.push(say(`${D.fmtCount(data.dropped)} ${data.dropped === 1 ? 'change was' : 'changes were'} not recorded (the record was busy or full).`, true));
    return out;
}
