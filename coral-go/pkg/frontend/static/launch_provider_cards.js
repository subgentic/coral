/* The provider cards of New Agent's Agent step (#11235, the Operator's pick, Option B of UI/UX's mockups). Each provider this computer has is a radio card saying "Installed · default <model>"; the open one holds its own Model
 * (with its refresh) and Thinking rows, the levels that provider has or a sentence that it has none; a provider that is not installed sits under "Not installed" with a link to install it and no radio, so it cannot look
 * selectable. The form's own agent select stays the one value (everything that reads it is unchanged: the missing-CLI line, the model list, the permission mode, Launch), and the two Model and Thinking rows are the form's
 * own rows, moved into the open card. Restart keeps launch_agent_pick.js's group. The answers of the CLI checks arrive up to PROBE_MS after the cards are drawn: until then all four are cards, and the missing ones move
 * to "Not installed" and an installed one is selected when nothing was chosen and Claude is missing: none of it while a person is on the group or has chosen (the order and the selection never move under them, #8024). */
import { serverFetch, normServer, LOCAL_SERVER } from './server_base.js';
import { importOnce } from './import_once.js';
import { modelName } from './model_labels.js';
const { _getDefaultModels } = await importOnce('./launch_models.js');
const { CLI_INSTALL_INSTRUCTIONS } = await importOnce('./cli_check.js');

const TYPES = [['claude', 'Claude'], ['codex', 'Codex'], ['agy', 'Antigravity'], ['pi', 'Pi']];
const ALIAS = { gemini: 'agy', antigravity: 'agy' };
const MARKS = { claude: 'C', codex: 'X', agy: 'A', pi: 'P' }; // the badge letters of the mockup: Codex is X, Antigravity A, so no two badges are the same
const PROBE_MS = 1500;

/** What the server says of that agent's CLI: { found: true|false|null (could not say), url }. */
async function probe(server, type) {
    try {
        const r = await serverFetch(server, `/api/system/cli-check?type=${encodeURIComponent(type)}`);
        if (!r.ok) return { found: null };
        const d = await r.json();
        return { found: typeof d.found === 'boolean' ? d.found : null, url: d.install_url || '' };
    } catch { return { found: null }; }
}

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

export async function buildProviderCards({ group, form, server, implicitDefault }) {
    const select = form && form.querySelector('.acf-agent-type');
    if (!group || !select) return;
    const gen = (group._pickToken = (group._pickToken || 0) + 1);
    delete group.dataset.probed;
    group.classList.add('provider-cards'); group.classList.remove('launch-agent-pick');
    const modelRow = form.querySelector('.sv-row[data-key="model"]'), thinkingRow = form.querySelector('.sv-row[data-key="thinking"]');
    const hold = el('div', 'provider-hold'); hold.hidden = true; // the rows wait here when no card is open
    const thinkingWrap = () => form.querySelector('.acf-thinking-wrap');
    const note = group.id === 'launch-agent-pick' ? document.getElementById('launch-codex-note') : null; // New Agent's own group: Codex stops on Coral's hooks question the first time (hooks_review.js, #6409): said once
    const describeBy = n => { // the group and each radio are described by the note while it shows (a hidden note would still be read); a radio is also described by its own status line
        const on = !n.hidden;
        if (on) group.setAttribute('aria-describedby', n.id); else group.removeAttribute('aria-describedby');
        for (const r of group.querySelectorAll('input[type="radio"]')) r.setAttribute('aria-describedby', [`${group.id}-st-${r.value}`, on ? n.id : ''].filter(Boolean).join(' '));
    };
    const typeNow = () => ALIAS[select.value] || select.value;
    let chosen = false; // a person picked a provider here, or the select moved some other way: the answers of the checks leave the selection alone
    const start = select.value;
    const state = new Map(TYPES.map(([t]) => [t, { found: null, url: '' }])); // found: null until the check answers
    let defaults = {};
    const cards = new Map();

    const statusOf = type => { const s = state.get(type); if (s.found === null) return ''; const d = defaults[type]; return `Installed · default ${d ? modelName(type, d, server) : 'model'}`; };
    const noThinking = (card, label) => { const p = card.querySelector('.provider-no-thinking'); if (!p) return; const wrap = thinkingWrap(), known = Array.isArray(form._thinkingLevels); p.hidden = !(card.classList.contains('is-open') && known && wrap && wrap.hidden); p.textContent = `${label} has no thinking levels, so there is nothing to set.`; };

    function place() { // the open card holds the Model and Thinking rows; with none open they wait in the hold
        const open = cards.get(typeNow());
        const into = open && !open.classList.contains('is-missing') ? open.querySelector('.provider-card-body') : hold;
        for (const row of [modelRow, thinkingRow]) if (row && row.parentNode !== into) into.append(row);
        // the thinking sentence sits after the rows: the row hides itself when the provider has no levels
        if (open && into !== hold) noThinking(open, TYPES.find(([t]) => t === typeNow())?.[1] || '');
    }
    function sync() {
        const v = typeNow();
        for (const [type, card] of cards) {
            const on = type === v && !card.classList.contains('is-missing');
            card.classList.toggle('is-open', on);
            const body = card.querySelector('.provider-card-body'); if (body) body.hidden = !on;
            const r = card.querySelector('input'); if (r) r.checked = on;
        }
        place();
        if (note) { note.hidden = !(v === 'codex' && normServer(server) === LOCAL_SERVER); describeBy(note); }
    }

    function draw() {
        for (const row of [modelRow, thinkingRow]) if (row) hold.append(row); // out of the cards before they are replaced
        group.replaceChildren(hold);
        cards.clear();
        const installed = TYPES.filter(([t]) => state.get(t).found !== false), missing = TYPES.filter(([t]) => state.get(t).found === false);
        for (const [type, label] of installed) {
            const card = el('div', 'provider-card'); card.dataset.type = type;
            const head = el('label', 'provider-card-head');
            const input = el('input'); input.type = 'radio'; input.name = `${group.id}-radios`; input.value = type;
            input.addEventListener('change', () => { if (!input.checked) return; chosen = true; select.value = type; select.dispatchEvent(new Event('change', { bubbles: true })); });
            input.setAttribute('aria-label', label); // the name is the provider's; its status is the description
            const mark = el('span', 'provider-mark', MARKS[type] || label[0]); mark.setAttribute('aria-hidden', 'true');
            const st = el('span', 'provider-status', statusOf(type)); st.id = `${group.id}-st-${type}`;
            head.append(input, mark, el('span', 'provider-name', label), st);
            const body = el('div', 'provider-card-body'); body.hidden = true;
            const none = el('p', 'provider-no-thinking sv-hint'); none.hidden = true; none.setAttribute('role', 'status');
            card.append(head, body); body.append(none);
            group.append(card); cards.set(type, card);
        }
        if (missing.length) {
            const sec = el('div', 'provider-missing'); sec.setAttribute('role', 'group');
            const h = el('h5', 'group-head provider-missing-title', 'Not installed'); h.id = `${group.id}-missing`; sec.setAttribute('aria-labelledby', h.id);
            sec.append(h);
            for (const [type, label] of missing) {
                const row = el('div', 'provider-card provider-missing-entry is-missing'); row.dataset.type = type;
                const mark = el('span', 'provider-mark', MARKS[type] || label[0]); mark.setAttribute('aria-hidden', 'true');
                const info = CLI_INSTALL_INSTRUCTIONS[type] || {};
                const a = el('a', 'provider-install', `Install ${label}`); a.href = state.get(type).url || info.url || '#'; a.target = '_blank'; a.rel = 'noopener noreferrer';
                row.append(mark, el('span', 'provider-name', label), a);
                sec.append(row); cards.set(type, row);
            }
            group.append(sec);
        }
        sync();
    }

    select.addEventListener('change', () => { if (select.value !== start) chosen = true; sync(); });
    form.addEventListener('acf-synced', () => { const open = cards.get(typeNow()); if (open && !open.classList.contains('is-missing')) noThinking(open, TYPES.find(([t]) => t === typeNow())?.[1] || ''); });
    draw();
    group.hidden = false;
    form.classList.add('has-agent-pick'); // the group is the one place that names the provider: the form's own select stays (hidden by css) and follows it (#6407)
    _getDefaultModels(server).then(d => { if (group._pickToken !== gen) return; defaults = d || {}; for (const [type, card] of cards) { const s = card.querySelector('.provider-status'); if (s) s.textContent = statusOf(type); } }).catch(() => {});
    const found = await Promise.all(TYPES.map(([t]) => Promise.race([probe(server, t), new Promise(r => setTimeout(() => r({ found: null }), PROBE_MS))])));
    if (group._pickToken !== gen || !group.isConnected) return; // another New Agent opened meanwhile
    TYPES.forEach(([t], i) => state.set(t, found[i]));
    // nothing was ever chosen and the built-in default is not here: start on the first provider that is
    if (!chosen && implicitDefault && typeNow() === 'claude' && found[0].found === false) {
        const first = TYPES.findIndex((_, i) => found[i].found === true);
        if (first >= 0) { select.value = TYPES[first][0]; select.dispatchEvent(new Event('change', { bubbles: true })); chosen = false; }
    }
    if (!group.contains(document.activeElement) || !chosen) draw(); // moving a card would drop the keyboard from it: only when nobody is on the group
    else for (const [type, card] of cards) { const s = card.querySelector('.provider-status'); if (s) s.textContent = statusOf(type); }
    group.dataset.probed = '1';
    // a later check of a CLI (Check again, or after Set path and Save) draws its card again from the fresh answer (#10161)
    const onChecked = e => {
        if (!group.isConnected) { document.removeEventListener('cli-checked', onChecked); return; }
        const type = ALIAS[e.detail.type] || e.detail.type; if (!state.has(type)) return;
        state.set(type, { found: !!e.detail.found, url: state.get(type).url });
        if (!group.contains(document.activeElement)) draw();
    };
    document.addEventListener('cli-checked', onChecked);
}
