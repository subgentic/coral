/* ONE read of GET /api/account for the page's life (#11106, the Hub's ask): the account menu (cloud.js, its `nav`), the Artifacts tab (artifacts_tab.js, artifacts_frame) and the team-link flag (team_link_flag.js, team_link_dialog)
 * all take their answer from this promise, so the Hub is asked once on load, not three times. It resolves to the parsed object, or null when there is no answer (a failed read, a refusal, a body that is not an object): a failed read
 * changes nothing, every reader falls back to what it drew before. */
let _read = null;

export function readAccount() {
    if (!_read) {
        _read = fetch('/api/account', { headers: { Accept: 'application/json' } })
            .then(r => (r.ok ? r.json() : null))
            .then(d => (d && typeof d === 'object' && !Array.isArray(d) ? d : null))
            .catch(() => null);
    }
    return _read;
}

/** The Hub's pages the account menu links to, BY KEY, from Coral's own table (#11106, the Hub's ask): the label and the same-origin path are fixed here and never taken from GET /api/account, whose `nav` names only the keys, in the order to show, of what
 *  this account may use. A key that is not in the table is ignored (not drawn, not an error). */
export const ACCOUNT_NAV = { account: ['Account', '/account'], billing: ['Billing', '/account/billing'], team: ['Team', '/account/team'], 'team-links': ['Team links', '/team-links'], usage: ['Usage', '/usage'], goals: ['Goals', '/goals'], machines: ['Machines', '/machines'], saved: ['Saved for later', '/saved'] };

/** The entries `nav` names that Coral knows, each once, in the Hub's order: [[label, path], ...]; null when `nav` is not an array (an older Hub: today's links stay). */
export function accountNavEntries(nav) {
    if (!Array.isArray(nav)) return null;
    const seen = new Set(), out = [];
    for (const e of nav) {
        const key = e && typeof e === 'object' && typeof e.key === 'string' ? e.key : '';
        if (!Object.prototype.hasOwnProperty.call(ACCOUNT_NAV, key) || seen.has(key)) continue;
        seen.add(key); out.push(ACCOUNT_NAV[key]);
    }
    return out;
}
