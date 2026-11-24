// Persistent local Needs-you cards (#21030). Refresh uses the list route, which
// applies the backend's clock. No timer and no dismiss/reconfirm from a feed.
import { importOnce } from './import_once.js';
const { answeredLocally } = await importOnce('./owner_refusal.js');
import { loadStyles } from './lazy_styles.js';
const { attentionLinks, localLiveLinks, onLiveLinks, liveRenewalCopy } = await importOnce('./live_links.js');
let host = null, team = ''; 
export const liveAttentionCount = () => attentionLinks().length;
export function watchLiveAttention(fn) { return onLiveLinks(() => { paint(); fn(); }); }
export async function refreshLiveAttention() {
    if (!answeredLocally('')) return;
    const links = await localLiveLinks('');
    if (links !== null) { await loadStyles('live_controls.css'); paint(); }
}
export function mountLiveAttention(target, teamName = '') {
    if (!answeredLocally('')) return;
    host = target; team = teamName;
    paint();
}
function paint() {
    if (!host?.isConnected) return;
    host.querySelector(':scope > .coral-live')?.remove();
    const links = attentionLinks().filter(l => !team || l.team === team);
    const empty = host.querySelector('.empty-state');
    if (empty) empty.hidden = links.length > 0;
    if (!links.length) return;
    const root = document.createElement('section'); root.className = 'coral-live'; root.setAttribute('aria-label', 'Live links');
    for (const link of links) {
        const card = document.createElement('section'); card.className = 'coral-live-card coral-live-needs';
        const title = document.createElement('h2');
        const due = link.state === 'paused' || link.notice_at && Date.now() >= Date.parse(link.notice_at);
        title.textContent = due ? 'Re-confirm your live link' : 'Coral Live is on';
        const copy = document.createElement('p');
        copy.textContent = link.state === 'paused' ? 'Re-confirm missed. The whole link is paused. Review and confirm at this computer to resume.' : `${link.team} · Created by ${link.created_by || 'you'}${link.live_since ? ' · Live since ' + new Date(Date.parse(link.live_since)).toLocaleString() : ''}`;
        const chat = document.createElement('p');
        chat.textContent = due && link.state === 'live' ? liveRenewalCopy(link) : 'Chat: ' + (link.agents?.find(a => a.chat && a.in_view !== false)?.role || 'off') + '.';
        const viewed = document.createElement('small');
        if (Number.isInteger(link.last_viewed_age_s) && link.last_viewed_age_s >= 0 && link.last_viewed_age_s <= 31 * 86400) viewed.textContent = `Last viewed ${Math.floor(link.last_viewed_age_s / 60)} minutes ago (as the Hub reports)`;
        const note = document.createElement('p'); note.className = 'coral-live-muted'; note.textContent = 'Stopping ends new sharing. What a viewer already copied cannot be recalled.';
        const actions = document.createElement('div'); actions.className = 'coral-live-actions';
        const open = document.createElement('button'); open.type = 'button'; open.textContent = due ? 'Review and re-confirm' : 'Review live link';
        open.onclick = () => importOnce('./team_settings_modal.js').then(m => m.openTeamSettings(link.team, { section: 'live' }));
        const stop = document.createElement('button'); stop.type = 'button'; stop.className = 'coral-live-danger'; stop.textContent = 'Stop sharing now';
        const feedback = document.createElement('p'); feedback.setAttribute('role', 'status');
        stop.onclick = async () => {
            if (!answeredLocally('')) return;
            stop.disabled = true;
            try {
                const r = await fetch(`/api/live/links/${encodeURIComponent(link.id)}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
                if (!r.ok) throw new Error();
                await refreshLiveAttention();
            } catch { feedback.textContent = 'Sharing could not be stopped. Try again.'; stop.disabled = false; }
        };
        actions.append(open, stop); card.append(title, copy, chat, viewed, note, actions, feedback); root.append(card);
    }
    host.prepend(root);
}
