// Local, human-driven Coral Live controls (#21030). Backend gate and caller guards
// are authoritative. No remote URL, automatic confirm, storage, or retry of writes.
import { importOnce } from './import_once.js';
import { loadStyles } from './lazy_styles.js';
const { answeredLocally } = await importOnce('./owner_refusal.js');
const { createLiveControlsShell } = await importOnce('./live_controls.js');
const { localLiveLinks } = await importOnce('./live_links.js');
const { renderLivePreview } = await importOnce('./live_public_preview.js');
await loadStyles('live_controls.css');
const API = '/api/live/links';
const WORDS = { bad_hash: 'The preview changed. Load and read a new preview before confirming.', chat_unavailable: 'Chat sharing is not available yet. Your previous selection is unchanged.', bad_period: 'This renewal period is not available.', not_found: 'This live link is no longer available.', live_closed: 'Coral Live is not enabled.' };

export { localLiveLinks };

export function mountLiveControls(host, { team, teamLabel, links }) {
    if (!answeredLocally(team) || !Array.isArray(links)) return null;
    const { root, field } = createLiveControlsShell({ teamLabel, hubLabel: '' });
    host.replaceChildren(root);
    const life = new AbortController();
    let link = links.find(item => item.team === teamLabel && item.state !== 'stopped') || null;
    let preview = null, read = false, busy = false, revision = 0, dirty = false, stopping = false, createExpiry = 'none', createDelay = 30;
    // The Hub gives the person this id; this computer never receives the URL/token.
    const hub = document.createElement('input');
    hub.type = 'text'; hub.maxLength = 36; hub.autocomplete = 'off'; hub.setAttribute('aria-label', 'Hub link id');
    hub.placeholder = 'Link id copied from the Hub page';
    field('hub').replaceWith(hub);
    const chatHost = field('chat').closest('label');
    const chatRows = document.createElement('div'); chatHost.replaceWith(chatRows);
    const alive = () => !life.signal.aborted && root.isConnected;
    const tell = text => { field('status-line').textContent = text; };
    const invalidate = () => {
        revision++; preview = null; read = false; field('confirm').checked = false;
        field('public').replaceChildren();
        field('changed').hidden = false;
    };
    const request = async (path = '', method = 'GET', body) => {
        const response = await fetch(API + path, { method, signal: life.signal, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
        const data = await response.json();
        if (!response.ok) {
            const error = new Error(WORDS[data.error] || 'Coral Live could not complete this action. Try again.');
            error.stale = response.status === 409 || data.error === 'bad_hash';
            throw error;
        }
        if (method !== 'GET') localLiveLinks(team);
        return data;
    };
    const path = suffix => `/${encodeURIComponent(link.id)}/${suffix}`;
    const run = async work => {
        if (busy || !alive()) return;
        const mine = revision;
        busy = true; tell(''); renderControls();
        try { await work(); } catch (e) { if (alive() && mine === revision && e.name !== 'AbortError') { if (e.stale) invalidate(); tell(e.message); } }
        finally { if (!stopping) busy = false; if (alive()) renderControls(); }
    };
    const stop = async () => {
        if (!link || !alive() || stopping) return;
        // Invalidates any in-flight preview or enabling reply before sending Stop.
        invalidate(); const mine = revision; const id = link.id;
        busy = true; stopping = true; renderControls();
        try { const stopped = await request(`/${encodeURIComponent(id)}/stop`, 'POST', {}); if (alive() && mine === revision) { link = stopped; dirty = false; tell('Sharing stopped.'); } }
        catch (e) { if (alive() && e.name !== 'AbortError') tell(e.message); }
        finally { stopping = false; busy = false; if (alive()) renderControls(); }
    };
    const edit = () => link?.draft || link || {};
    const writeViews = (chatKey, expiresIn = edit().expires_in, delay = edit().delay_s) => {
        invalidate();
        return run(async () => {
            const mine = revision;
            const next = await request(path('views'), 'PUT', { chat_key: chatKey, period_days: chatKey ? Math.min(edit().period_days || 7, 7) : 90, expires_in: expiresIn || 'none', delay_s: Number(delay || 30) });
            if (alive() && mine === revision) { link = next; dirty = true; }
        });
    };
    const button = (label, action, primary = false, disabled = false) => {
        const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
        if (primary) b.className = 'coral-live-primary'; b.disabled = disabled;
        b.onclick = action; field('actions').append(b);
    };
    const date = seconds => Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toLocaleString() : '';
    const selectedKey = () => link?.draft ? link.draft.chat_key || '' : link?.agents?.find(a => a.chat)?.key || '';
    const selectedRole = () => link?.agents?.find(a => a.key === selectedKey())?.role || '';
    function renderControls() {
        const live = link?.state === 'live', stopped = link?.state === 'stopped', paused = link?.state === 'paused';
        const canCreate = !link || stopped;
        field('state').textContent = link?.state || 'Not created';
        field('state').classList.toggle('coral-live-live', live);
        field('team').disabled = true;
        hub.disabled = !canCreate || busy; if (link && !canCreate) hub.value = link.hub || '';
        field('expiry').disabled = busy;
        field('delay').disabled = busy;
        field('expiry').value = canCreate ? createExpiry : edit().expires_in || 'none';
        field('delay').value = String(canCreate ? createDelay : edit().delay_s || 30);
        chatRows.replaceChildren();
        for (const agent of link?.agents || []) {
            const label = document.createElement('label'); label.className = 'coral-live-check';
            const input = document.createElement('input'); input.type = 'checkbox'; input.checked = agent.key === selectedKey();
            input.disabled = !agent.key || stopped || busy;
            input.dataset.agentKey = agent.key || '';
            const words = document.createElement('span');
            const name = document.createElement('strong'); name.textContent = `Share ${agent.role}'s chat`;
            const detail = document.createElement('small'); detail.textContent = `Public label: ${agent.role} · current session only`;
            words.append(name, detail);
            input.onchange = () => writeViews(input.checked ? agent.key : '');
            label.append(input, words); chatRows.append(label);
        }
        field('needs').hidden = !live;
        const due = link?.notice_at && Date.now() >= link.notice_at * 1000;
        field('needs-title').textContent = due ? 'Re-confirm your live link' : 'Coral Live is on';
        field('needs-copy').textContent = 'Chat: ' + (link?.agents?.find(a => a.chat && a.in_view !== false)?.role || 'off') + '.';
        const facts = link ? [`Created by ${link.created_by || 'you'}`, teamLabel, link.live_since ? `Live since ${date(link.live_since)}` : ''] : [];
        if (Number.isInteger(link?.last_viewed_age_s) && link.last_viewed_age_s >= 0 && link.last_viewed_age_s <= 31 * 86400) {
            facts.push(`Last viewed ${link.last_viewed_age_s < 60 ? 'less than a minute' : Math.floor(link.last_viewed_age_s / 60) + ' minutes'} ago (as the Hub reports)`);
        }
        field('needs-facts').textContent = facts.filter(Boolean).join(' · ');
        field('renew').hidden = !link?.reconfirm_due && !link?.chat_off_why;
        field('renew').textContent = (link?.chat_off_why ? 'Chat is off. Review the current agent before enabling it again. ' : '') + (link?.reconfirm_due ? `One re-confirm covers everything this link shows. Re-confirm by ${date(link.reconfirm_due)}. After grace, the whole link pauses${link.pause_at ? ' at ' + date(link.pause_at) : ''}.` : '');
        field('link').hidden = !link;
        field('load-preview').disabled = !link || stopped || busy;
        field('confirm-wrap').hidden = !preview;
        if (!preview && (paused || stopped)) field('public').textContent = paused ? 'Not live right now. This view is paused.' : 'Not live right now. This link has ended.';
        field('confirm').disabled = busy || !preview;
        field('confirm').checked = read;
        field('confirm-text').textContent = `${selectedKey() ? (selectedRole() + "'s chat includes my typed messages and the agent's replies, shown ") + (edit().delay_s || 30) + ' seconds late. ' : 'Chat is off. '}I read the preview. Anyone with the link can read it. This confirms everything the link shows.`;
        field('actions').replaceChildren();
        if (canCreate) button('Create preview link', () => run(async () => {
            const next = await request('', 'POST', { hub_link: hub.value.trim(), team: teamLabel });
            if (alive()) {
                link = next;
                if (createExpiry !== 'none' || createDelay !== 30) link = await request(path('views'), 'PUT', { chat_key: '', period_days: 90, expires_in: createExpiry, delay_s: createDelay });
                invalidate(); field('changed').hidden = true;
            }
        }), true, busy || !hub.value.trim());
        else {
            const changed = dirty || link.agents?.some(a => a.in_view === false) || link.draft && (selectedKey() !== (link.agents?.find(a => a.chat)?.key || '') || ['expires_in', 'delay_s', 'period_days'].some(key => link.draft[key] !== link[key]));
            const action = paused ? 'resume' : live && !changed ? 'reconfirm' : 'go-live';
            button(paused ? 'Resume sharing' : action === 'reconfirm' ? 'Re-confirm link' : 'Go live', () => run(async () => {
                if (!preview || !read) return;
                const mine = revision;
                const body = action === 'reconfirm' ? {} : action === 'resume' ? { hash: preview.hash } : { hash: preview.hash, read: true };
                const next = await request(path(action), 'POST', body);
                if (alive() && mine === revision) { link = next; dirty = false; read = false; renderLivePreview(field('public'), preview.frame, { teamLabel, live: true, delaySeconds: link.delay_s || 30 }); tell('Sharing confirmed at this computer.'); }
            }), true, busy || !preview || !read);
            if (live) button('Pause', () => run(async () => {
                invalidate(); const mine = revision;
                const next = await request(path('pause'), 'POST', {});
                if (alive() && mine === revision) { link = next; tell('Sharing paused.'); }
            }), false, busy);
            button('Stop sharing now', stop, false, stopping); // Stop stays available during another request.
        }
        root.querySelector('[data-stop]').disabled = !link || stopped || stopping;
        field('needs-open').disabled = busy;
    }
    hub.oninput = renderControls;
    field('confirm').onchange = e => { read = e.target.checked && !!preview; renderControls(); };
    field('expiry').onchange = e => { if (!link || link.state === 'stopped') { createExpiry = e.target.value; renderControls(); } else writeViews(selectedKey(), e.target.value, edit().delay_s); };
    field('delay').onchange = e => { if (!link || link.state === 'stopped') { createDelay = Number(e.target.value); renderControls(); } else writeViews(selectedKey(), edit().expires_in, e.target.value); };
    field('load-preview').onclick = () => run(async () => {
        const mine = revision;
        const next = await request(path('preview'));
        if (!alive() || mine !== revision) return;
        if (!next.hash || !next.frame) throw new Error('The public preview is not available yet.');
        preview = next; read = false; field('changed').hidden = true;
        renderLivePreview(field('public'), next.frame, { teamLabel, live: link.state === 'live', delaySeconds: edit().delay_s || 30 });
    });
    root.querySelector('[data-stop]').onclick = stop;
    field('needs-open').onclick = () => field('state').scrollIntoView({ block: 'center', behavior: 'smooth' });
    field('status-line').textContent = ''; renderControls();
    return { root, destroy() { life.abort(); revision++; preview = null; root.remove(); } };
}
