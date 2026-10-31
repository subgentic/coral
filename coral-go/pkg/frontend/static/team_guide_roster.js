// The team's Guides group of Team settings (#11457, the guide role's roster): the name agents see on each guide's messages. A guide is a person the owner gave a guide grant on this board in Coral Hub; this page only
// names them (and cannot grant or cut anyone's access: that is Coral Hub's). The values are GET and PUT /api/board/{project}/guide-roster, `{"roster": {"hub-user-<8 hex>": "Name"}}`, at most 20 guides and 40 characters
// a name; owner only, so a page that may not read it has no group (the server decides who may write; this page draws what it is told and says what the server refused). Labels are the only thing the Hub sends: no email.
import { importOnce } from './import_once.js';
import { boardFetch } from './server_base.js';
const { refusalOf, answeredLocally } = await importOnce('./owner_refusal.js');
export const GR_KEYS = ['gr_roster'];
export const MAX_GUIDES = 20, MAX_NAME = 40;
const LABEL = /^hub-user-[0-9a-f]{8}$/;

/** Makes the group for one team. */
export function createGuideRoster(team) {
    let rows = [];       // [label, name], in the order shown
    let slot = null, listEl = null, addInput = null, say = null;
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    /** What the page compares for "changed": the named guides only, sorted. */
    const canon = () => JSON.stringify(rows.filter(([, n]) => n.trim()).map(([l, n]) => [l, n.trim()]).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
    const changed = () => slot && slot.dispatchEvent(new Event('input', { bubbles: true }));
    const draw = () => {
        if (!listEl) return;
        listEl.replaceChildren();
        for (const row of rows) {
            const li = el('div', 'gr-guide');
            const code = el('code', 'gr-label', `Guide ${row[0]}`);
            const input = el('input', 'field field-dense gr-name'); input.type = 'text'; input.maxLength = MAX_NAME; input.value = row[1]; input.placeholder = 'Name agents see (not named yet)';
            input.setAttribute('aria-label', `Name for guide ${row[0]}`);
            input.addEventListener('input', () => { row[1] = input.value; });
            const drop = el('button', 'btn btn-quiet gr-remove', 'Remove name'); drop.type = 'button'; drop.setAttribute('aria-label', `Remove the name of guide ${row[0]}`);
            drop.addEventListener('click', () => { rows = rows.filter(r => r !== row); draw(); changed(); });
            li.append(code, input, drop);
            listEl.append(li);
        }
        if (!rows.length) listEl.append(el('p', 'sv-help', 'No guide is named yet.'));
    };
    const add = () => {
        const label = (addInput.value || '').trim().toLowerCase();
        if (!LABEL.test(label)) { say.textContent = 'A guide\'s label looks like hub-user- and eight letters or digits (0 to 9, a to f).'; return; }
        if (rows.some(r => r[0] === label)) { say.textContent = 'That guide is already in the list.'; return; }
        if (rows.length >= MAX_GUIDES) { say.textContent = `A team names at most ${MAX_GUIDES} guides.`; return; }
        say.textContent = ''; rows.push([label, '']); addInput.value = ''; draw(); changed();
        listEl.querySelector('.gr-guide:last-child .gr-name')?.focus();
    };
    const render = s => {
        slot = s;
        listEl = el('div', 'gr-list');
        const addRow = el('div', 'gr-add');
        addInput = el('input', 'field field-dense'); addInput.type = 'text'; addInput.placeholder = 'hub-user-xxxxxxxx'; addInput.setAttribute('aria-label', 'A guide\'s Coral Hub label'); addInput.spellcheck = false; addInput.autocapitalize = 'none';
        addInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
        const btn = el('button', 'btn', 'Add a guide'); btn.type = 'button'; btn.addEventListener('click', add);
        addRow.append(addInput, btn);
        say = el('p', 'sv-help gr-say'); say.setAttribute('role', 'status');
        s.append(listEl, addRow, say, el('p', 'sv-help', 'To stop a guide\'s access, remove them in Coral Hub.'));
        draw();
        return { get: canon, set: () => {} }; // the rows are the screen's own: what is saved comes back through load and save
    };
    return {
        fields: () => [{ key: 'gr_roster', type: 'custom', label: 'Guide names', wide: true, help: 'The name agents see on a guide\'s messages. Until you name them, a guide shows as their Coral Hub label.', render }],
        /** Reads the roster. Resolves to the values, or `values: null` with the reason when the server does not give it to this page (the group is then removed). */
        async load() {
            const r = await boardFetch(team, '/guide-roster').catch(() => null);
            if (!r || !r.ok) return { refusal: r ? await refusalOf(r, answeredLocally(team)) : 'Unavailable', values: null };
            const j = await r.json().catch(() => ({}));
            rows = Object.entries(j.roster || {}).map(([l, n]) => [l, String(n)]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
            draw();
            return { values: { gr_roster: canon() } };
        },
        /** Saves the roster whole (the route takes it whole) and shows what the server kept. */
        async save() {
            const roster = Object.fromEntries(rows.filter(([, n]) => n.trim()).map(([l, n]) => [l, n.trim()]));
            const r = await boardFetch(team, '/guide-roster', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roster }) });
            if (!r.ok) {
                const j = await r.json().catch(() => ({}));
                throw new Error(typeof j.error === 'string' && j.error ? j.error : await refusalOf(r, answeredLocally(team)));
            }
            const j = await r.json().catch(() => ({ roster }));
            rows = Object.entries(j.roster || roster).map(([l, n]) => [l, String(n)]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
            draw();
            return canon();
        },
    };
}
