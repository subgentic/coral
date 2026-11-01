/* Settings > Chief (#11796, the Coral dot's front door, section 1 of coral://artifacts/ea4bd6d1425d7712e921d92520225692206af05e7608e92c3635675061b57364): one screen where the Operator makes the one agent they talk to a
 * named, recognisable one: a name, an avatar (one of eight colours and a letter), which live agent it is, which team it fronts, and whether the /chief page is on. It replaces setting chief_page, chief_team and
 * chief_session by hand (coral-board settings set). Saving writes the settings only (the machine's own rule that an agent cannot): the name and avatar show at once on /chief and in its chat. The agent's model is shown, with
 * the way to change it where every agent's is changed (its own page); a launch is not made here. Every name that comes from an agent or a team is set as text, never as HTML. Machine-only: nothing of it exists through Coral Hub. */
import { importOnce } from './import_once.js';
import { showToast } from './utils.js';
const { mountSettingsView } = await importOnce('./settings_view.js');
const { COLORS, avatarNode, lookOf } = await importOnce('./chief_look.js');

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const NAME_MAX = 40;
const KEYS = ['chief_actions', 'chief_page', 'chief_name', 'chief_avatar', 'chief_avatar_letter', 'chief_fronts', 'chief_session', 'chief_team'];

async function json(url) { const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store' }); return r.ok ? r.json() : null; }
const yes = v => /^(1|true|yes|on)$/i.test(String(v || '').trim());

/** The agents Chief can be: every live agent, named as the Operator knows it, on its team. */
export const agentChoices = rows => (Array.isArray(rows) ? rows : []).filter(r => r && r.session_id && r.board_project).map(r => ({ value: r.session_id, label: `${r.display_name || r.name || r.session_id} · ${r.board_label || r.board_project}`, team: r.board_project, model: String(r.model || '') }));

/** What the three settings that record Chief's agent become: the session and the team it is on (both, or neither when none is picked). */
export const agentSettings = (sessionId, choices) => { const c = choices.find(x => x.value === sessionId); return c ? { chief_session: c.value, chief_team: c.team } : { chief_session: '', chief_team: '' }; };

export async function mountChiefSetup(host) {
    host.replaceChildren();
    const [stored, live, projects] = await Promise.all([json('/api/settings'), json('/api/sessions/live'), json('/api/board/projects')]);
    const settings = stored && typeof stored.settings === 'object' && stored.settings ? stored.settings : {}; // GET /api/settings answers { settings: { key: value } }
    const choices = agentChoices(Array.isArray(live) ? live : live && live.sessions);
    const teams = (Array.isArray(projects) ? projects : []).filter(p => p && p.board_id).map(p => ({ value: String(p.label || p.board_id), label: String(p.label || p.board_id) }));
    const section = el('section', 'chief-setup'); section.setAttribute('aria-label', 'Chief');
    const intro = el('p', 'chief-setup-intro', 'Chief is the one agent you talk to, from your phone too. Give it a name and a face, say which team it works with, and turn its page on.');
    const preview = el('div', 'chief-preview'); preview.setAttribute('role', 'img');
    const form = el('div', 'chief-setup-form'); section.append(intro, preview, form); host.append(section);
    const modelRow = el('p', 'chief-model');

    let view = null;
    const lookNow = () => { const v = view ? view.values() : {}; return lookOf({ name: v.chief_name, avatar: v.chief_avatar, avatar_letter: v.chief_avatar_letter, fronts: v.chief_fronts }); };
    const drawPreview = () => {
        const look = lookNow(), name = look.name || 'Chief';
        preview.replaceChildren(avatarNode(look, name), el('span', 'chief-preview-name', name), el('span', 'chief-preview-fronts', look.fronts ? `fronts ${look.fronts}` : 'no team chosen'));
        preview.setAttribute('aria-label', `Chief looks like this: ${name}${look.fronts ? `, fronting ${look.fronts}` : ''}`);
    };
    const drawModel = () => {
        const id = view ? view.values().chief_agent : '', c = choices.find(x => x.value === id);
        modelRow.replaceChildren();
        if (!c) { modelRow.textContent = 'Pick the agent to see its model.'; return; }
        modelRow.append(`Model: ${c.model || 'not known yet'}. `);
        const a = el('a', null, 'Change it on the agent’s own page'); a.href = `/agent/${encodeURIComponent(c.value)}`; a.target = '_blank'; a.rel = 'noopener';
        modelRow.append(a, '.');
    };
    const swatches = (slot) => {
        const group = el('div', 'chief-swatches'); group.setAttribute('role', 'radiogroup'); group.setAttribute('aria-label', 'Avatar colour');
        let value = '1'; const fns = [];
        const buttons = COLORS.map(([n, word]) => {
            const b = el('button', 'chief-swatch'); b.type = 'button'; b.setAttribute('role', 'radio'); b.setAttribute('aria-label', word); b.dataset.color = n; b.title = word;
            b.addEventListener('click', () => { api.set(n); fns.forEach(f => f()); group.dispatchEvent(new Event('change', { bubbles: true })); }); // the preview listens for it
            return b;
        });
        group.append(...buttons); slot.append(group);
        const api = {
            get: () => value,
            set: v => { value = COLORS.some(c => c[0] === String(v)) ? String(v) : '1'; for (const b of buttons) { const on = b.dataset.color === value; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; } },
            onChange: fn => fns.push(fn),
        };
        api.set('1');
        return api;
    };
    view = mountSettingsView(form, {
        mode: 'settings',
        saveBar: { save: 'Save Chief', cancel: 'Cancel' },
        words: { saved: 'Saved. /chief shows it now.' },
        fields: [
            { key: 'chief_name', type: 'text', label: 'Name', default: '', placeholder: 'Chief', help: `What /chief and its chat call it (at most ${NAME_MAX} characters). Empty keeps the agent’s own name.`, validate: v => ([...String(v || '')].length > NAME_MAX ? `At most ${NAME_MAX} characters.` : '') },
            { key: 'chief_avatar', type: 'custom', label: 'Avatar colour', help: 'One of eight colours.', render: swatches },
            { key: 'chief_avatar_letter', type: 'text', label: 'Avatar letter', default: '', placeholder: 'The name’s first letter', help: 'One letter or digit on the avatar.', validate: v => ([...String(v || '').trim()].length > 1 ? 'One letter or digit.' : '') },
            { key: 'chief_agent', type: 'select', label: 'Which agent', default: '', options: [{ value: '', label: choices.length ? 'No agent picked' : 'No agent is running' }, ...choices.map(c => ({ value: c.value, label: c.label }))], help: 'The running agent that is Chief. Start it on its own team first (a team of one).' },
            { key: 'chief_model', type: 'custom', label: 'Its model', render: slot => { slot.append(modelRow); drawModel(); } },
            // Chief's two levels (#11798): the mode it restarts in; Ask first is Default, Act is Accept edits (a shell command still asks).
            { key: 'chief_actions', type: 'select', label: "Chief's actions", default: 'ask_first', options: [{ value: 'ask_first', label: 'Ask first' }, { value: 'act', label: 'Act' }], help: 'Ask first: Chief asks before each action. Act: Chief edits without asking, and a shell command still asks. Applies when Chief restarts.' },
            { key: 'chief_fronts', type: 'select', label: 'Team it fronts', default: '', options: [{ value: '', label: 'No team chosen' }, ...teams], help: 'The team whose agents Chief takes your requests to.' },
            { key: 'chief_page', type: 'toggle', label: 'Serve the Chief page', default: false, help: 'Turns on /chief, the page for your phone.' },
        ],
        load: async () => {
            const again = await json('/api/settings'), st = again && again.settings ? again.settings : settings;
            const agent = choices.find(c => c.value === String(st.chief_session || '') && c.team === String(st.chief_team || ''));
            return { chief_name: String(st.chief_name || ''), chief_avatar: String(st.chief_avatar || '1'), chief_avatar_letter: String(st.chief_avatar_letter || ''), chief_agent: agent ? agent.value : '', chief_fronts: String(st.chief_fronts || ''), chief_actions: st.chief_actions === 'act' ? 'act' : 'ask_first', chief_page: yes(st.chief_page) };
        },
        save: async (changes, { values }) => {
            const body = {};
            for (const [k, v] of Object.entries(changes)) { if (k === 'chief_agent') Object.assign(body, agentSettings(v, choices)); else if (k !== 'chief_model' && KEYS.includes(k)) body[k] = typeof v === 'boolean' ? String(v) : String(v == null ? '' : v).trim(); }
            if (!Object.keys(body).length) return {};
            const r = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (!r.ok) { let m = ''; try { m = (await r.json()).error || ''; } catch { /* no reason given */ } throw new Error(m || `Chief could not be saved (HTTP ${r.status}).`); }
            if (Object.hasOwn(body, 'chief_name') || Object.hasOwn(body, 'chief_avatar') || Object.hasOwn(body, 'chief_avatar_letter')) showToast('Chief’s look is saved.', false, 3000);
            return {};
        },
    });
    const redraw = () => { drawPreview(); drawModel(); };
    form.addEventListener('input', redraw); form.addEventListener('change', redraw); form.addEventListener('sv-saved', redraw);
    host.dataset.ready = '';
    view.ready.then(() => { redraw(); host.dataset.ready = '1'; }, () => { redraw(); host.dataset.ready = '1'; });
    return view;
}
