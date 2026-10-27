/* The operator's per-member review settings. The subscriber route is the authority,
 * not the availability snapshot; through the Hub this first version is read-only. */
import { importOnce } from './import_once.js';
import { boardFetch } from './server_base.js';
const { answeredLocally } = await importOnce('./owner_refusal.js');
const { reviewAreas, reviewAreasError } = await importOnce('./review_pool.js');
const { mountSettingsView } = await importOnce('./settings_view.js');

export function mountAgentReviewSettings(host, team, subscriber) {
    const section = document.createElement('section');
    section.setAttribute('aria-label', 'Review settings');
    const title = document.createElement('h3'); title.textContent = 'Review settings';
    const form = document.createElement('div'); section.append(title, form); host.append(section);
    const local = answeredLocally(team);
    let loaded = false;
    const view = mountSettingsView(form, {
        mode: 'settings',
        readOnly: () => !local ? 'Change review settings on the team’s computer.' : !loaded ? 'Loading review settings…' : false,
        fields: [
            { key: 'reviews_only', type: 'toggle', label: 'Reviews only', default: false, help: 'Claim reviews instead of build tasks.' },
            { key: 'review_areas', type: 'text', label: 'Areas', default: '', placeholder: 'ui, go, security', help: 'Comma-separated areas, up to 8. Leave empty for all areas.', validate: reviewAreasError },
        ],
        load: async () => {
            const r = await boardFetch(team, '/subscribers');
            if (!r.ok) throw new Error('Review settings could not be read.');
            const data = await r.json();
            const member = (Array.isArray(data) ? data : data.subscribers || []).find(s => s.subscriber_id === subscriber);
            if (!member) throw new Error('This agent is no longer a member of the team.');
            loaded = true;
            return { reviews_only: member.reviews_only === true, review_areas: (member.review_areas || []).join(', ') };
        },
        save: async changes => {
            if (!local) throw new Error('Change review settings on the team’s computer.');
            const body = { ...changes };
            if (Object.hasOwn(body, 'review_areas')) body.review_areas = reviewAreas(body.review_areas);
            const r = await boardFetch(team, `/subscribers/${encodeURIComponent(subscriber)}/review-settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (!r.ok) {
                if (r.status === 403) throw new Error('Only the Operator can change review settings.');
                if (r.status === 404) throw new Error('This agent is no longer a member of the team.');
                throw new Error('Review settings could not be saved. Try again.');
            }
            const saved = await r.json();
            if (Object.hasOwn(changes, 'review_areas')) view.set('review_areas', (saved.review_areas || body.review_areas).join(', '));
            return { note: 'Review settings saved.' };
        },
    });
    const error = document.createElement('p'); error.className = 'goals-failed'; error.setAttribute('role', 'alert');
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn'; retry.textContent = 'Try again';
    retry.hidden = true; section.append(error, retry);
    const failed = e => { if (!section.isConnected) return; error.textContent = e.message || 'Review settings could not be read.'; retry.hidden = false; };
    retry.addEventListener('click', () => { error.textContent = ''; retry.hidden = true; view.reload().catch(failed); });
    view.ready.catch(failed);
    return view;
}
