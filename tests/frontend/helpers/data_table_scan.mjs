// What the data_table census (data_table_census.test.mjs) counts, as functions its own test (data_table_scan.test.mjs) can run on fixtures: the CSS rules that style a table, a row, a cell or a header, and the
// JavaScript that builds table markup, in every spelling the surfaces use (a template string, createElement, el(), and the h() builder of cloud_servers.js).

// a selector that names a table part (an element: table, thead, tbody, tfoot, tr, td, th), or a class of a table the surfaces built for themselves: the class is matched whole, so `.goals-table-page` (the Goals
// page's layout class) and `.group-table-link` (a button in a group page) are not tables
const TABLE_CLASS = '(?:team-table|group-table|group-table-stack|group-table-aligned|servers-table|cost-table|goals-table|board-task-item|team-row|sched-table|sched-runs-table|wf-table|wf-runs-table|wf-steps-table|cs-table)';
export const CSS_SELECTOR = new RegExp(`(^|[\\s,>+~(])(table|thead|tbody|tfoot|tr|td|th)\\b|\\.${TABLE_CLASS}(?![\\w-])`);
export const DT_CLASS = /\.dt-[a-z]/;

/** The selector text of every rule (before a "{"), comments and at-rule preludes left out. */
export function cssRules(src) {
    const text = src.replace(/\/\*[\s\S]*?\*\//g, '');
    const out = [];
    let depth = 0, buf = '';
    for (const ch of text) {
        if (ch === '{') { if (buf.trim() && !buf.trim().startsWith('@')) out.push(buf.trim()); buf = ''; depth++; }
        else if (ch === '}') { depth--; buf = ''; }
        else buf += ch;
    }
    return out;
}

/** The rules of a stylesheet that style a table part (a rule of the component's own dt-* class is reported apart; a rule whose selector matches one of `exempt` is counted in `exempted`, not in `n`). */
export function cssCount(src, exempt = []) {
    let n = 0, exempted = 0; const own = [];
    for (const sel of cssRules(src)) {
        if (DT_CLASS.test(sel)) own.push(sel.slice(0, 80));
        else if (CSS_SELECTOR.test(sel)) { if (exempt.some(re => re.test(sel))) exempted++; else n++; }
    }
    return { n, own, exempted };
}

// <table>, <tr>, <td>, <th> in a template string; createElement('td'); el('td'); and h('td') (the builder of cloud_servers.js, which makes real table nodes)
export const JS_BUILDER = /createElement\(\s*['"](?:table|tr|td|th)['"]\s*\)|<table[\s>]|<tr[\s>]|<td[\s>]|<th[\s>]|\b(?:el|h)\(\s*['"](?:table|tr|td|th)['"]/g;
export const jsCount = (src) => (src.match(JS_BUILDER) || []).length;

// What is not a list the dashboard draws, each with its reason (#7905); the census fails when an entry stops matching anything, and the scan's own test holds that every entry has a reason.
export const EXEMPT = {
    css: { 'content_table.css': 'tables an author wrote in Markdown (a subagent\'s details, a chat bubble, .md, Docs, the preview): content, not a list the dashboard draws, with one shared style and tokens' },
    js: {},
};
// rules in a stylesheet that has real tables too, exempt by selector with a reason (none now: the session tooltip is a .facts list, facts.js)
export const EXEMPT_SELECTORS = [];
