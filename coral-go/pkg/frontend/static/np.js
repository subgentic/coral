/* One themed not-found view for every bad address (#15295): a team, a goal, a task, a file or an agent that is not there says so by name and links back to the right list, instead of showing the list or the start page with no
 * word. Lazy: loaded when an address misses. The page is inside the dashboard, so it has the theme and the sidebar; the words are set with textContent. */
import { importOnce } from './import_once.js';
import { onViewShown, showView } from './view_switch.js';
import { go } from './nav.js';
const { loadStyles } = await importOnce('./lazy_styles.js');

const KINDS = { team: 'team', goals: 'goal', tasks: 'task', artifacts: 'file', agent: 'agent', agents: 'agent', messages: 'message', board: 'message' };
const LISTS = { goal: 'Goals', task: 'Tasks', file: 'Artifacts', message: 'Board', team: 'Agents', agent: 'Agents', page: 'Agents' };

/** Show it. what: 'goal' | 'task' | 'file' | 'agent' | 'team' | 'message' | 'page'; id: what the address named (shown as text, never as markup); back: the route of the list to go back to. */
export async function showNotFound({ what = 'page', id = '', back = { view: 'agents' }, backLabel = '' }) {
    await loadStyles('not_found.css');
    let view = document.getElementById('not-found-view');
    if (!view) {
        view = document.createElement('section'); view.id = 'not-found-view'; view.className = 'not-found'; view.setAttribute('aria-labelledby', 'not-found-title');
        const title = document.createElement('h2'); title.id = 'not-found-title'; title.className = 'not-found-title';
        const detail = document.createElement('p'); detail.className = 'not-found-detail'; detail.setAttribute('role', 'status');
        const button = document.createElement('button'); button.type = 'button'; button.className = 'btn not-found-back';
        view.append(title, detail, button);
        (document.getElementById('team-page-view') || document.querySelector('.layout')).parentNode.append(view);
        onViewShown(() => { view.hidden = true; });
    }
    const n = String(id || '').slice(0, 60), label = what === 'page' ? 'That page' : `That ${what}`;
    view.querySelector('.not-found-title').textContent = n && what !== 'page' ? `${label} was not found: ${n}` : `${label} was not found`;
    view.querySelector('.not-found-detail').textContent = 'The address may be mistyped, or it was removed. Nothing was opened.';
    const button = view.querySelector('.not-found-back'), text = backLabel || `Back to ${LISTS[what] || 'Agents'}`;
    button.textContent = text;
    button.onclick = () => { view.hidden = true; go(back); };
    showView('');
    view.hidden = false; button.focus();
}

/** What the address named, as text: percent-decoded, or as written when it is not valid (a lone % must not stop the view, Security's SHOULD on #15295). */
const decoded = t => { if (!t) return ''; try { return decodeURIComponent(t).slice(0, 60); } catch { return t.slice(0, 60); } };

/** The not-found view for an address that did not parse: what it named comes from its path words (/team/<id>/artifacts/zzz is a file of that team), and the way back is that team's list when there is one. */
export function lost(pathname) {
    const parts = String(pathname || '').split('/').filter(Boolean), head = parts[0] === 'board' ? 'team' : parts[0];
    const tab = parts[2] || '', what = head === 'team' ? (parts.length > 2 ? KINDS[tab] || 'page' : 'team') : KINDS[head] || 'page';
    const back = head === 'team' && parts[1] && /^[\w.@-]+$/.test(parts[1]) && ['goals', 'tasks', 'artifacts'].includes(tab) ? { view: 'team', id: parts[1], sub: tab } : { view: 'agents' };
    return showNotFound({ what, id: decoded(parts[head === 'team' ? 3 : 1]), back, backLabel: back.view === 'team' ? `Back to ${LISTS[what] || 'the team'}` : '' });
}
