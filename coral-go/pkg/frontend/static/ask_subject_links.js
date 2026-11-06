/* Row subjects open the team's item, independently of the question row. The
 * computer is renderer metadata; unknown/offline remote sources stay words. */
import { el } from './dom_el.js';
import { build, keyRoute } from './routes.js';
import { boardTeamKey, isLocalServer, isCloud, keyLabel, normServer } from './server_base.js';
import { state } from './state.js';
export function askSubjectLinks(ask, subjects, server, open) {
    if (!subjects.length) return null;
    const team = boardTeamKey(server, ask.board);
    const available = isLocalServer(server) || ((isCloud() || state.hub) && (state.servers || []).some(s => normServer(s.id) === normServer(server) && (s.online === true || s.status === 'online')));
    const root = el('span', 'inbox-review-earlier inbox-ask-subject-links');
    root.title = subjects.map(x => `${x.kind === 'goal' ? 'Goal' : 'Task'} #${x.id}${x.title ? `: ${x.title}` : ''}`).join('\n') + `\n(named by ${ask.asker})`;
    subjects.forEach((x, i) => {
        if (i) root.append(' · ');
        const word = `${x.kind === 'goal' ? 'Goal' : 'Task'} #${x.id}`;
        if (!available || !Number.isSafeInteger(x.id) || x.id < 1) { root.append(el('strong', '', word)); return; }
        const route = keyRoute('team', team, x.kind === 'goal' ? 'goals' : 'tasks', x.id);
        const a = el('a', 'inbox-ask-subject-link', word); a.href = build(route); a.dataset.subjectKind = x.kind;
        a.setAttribute('aria-label', `Open ${word}${x.title ? `: ${x.title}` : ''} on ${keyLabel(team)}`);
        a.addEventListener('pointerdown', e => e.stopPropagation()); // a subject long press never selects the row
        a.addEventListener('click', e => { e.stopPropagation(); if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); open(route); });
        root.append(a);
    });
    return root;
}
