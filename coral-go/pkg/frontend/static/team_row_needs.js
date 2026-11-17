/* A team row in the sidebar says when something in the team needs the Operator (#17781, walk 64): a board question to the Operator (a plan to approve), an agent waiting, a proposal, a finished goal.
 * The count is the one the team page's Needs you tab carries (teamNeedsCount), so the two agree, and it is drawn on the row itself, so a collapsed team still shows it. Loaded the first time the list
 * draws a team (group_cards.js), so the first paint carries none of these bytes; the list is drawn again once the count is known and whenever it changes. */
import { importOnce } from './import_once.js';
import { redrawLiveList } from './list_hooks.js';
import { escapeAttr } from './utils.js';
import { registerActions, textOf } from './actions.js';
import { loadStyles } from './lazy_styles.js';
import { onOperatorAsksChanged, refreshOperatorAsks } from './operator_asks.js';

// The chip opens the team on its Needs you tab: the rest of the row opens the team's page on Goals (#19429). It is registered here, not in render.js, so the start path does not carry it.
registerActions({ 'team-needs-open': (el, event) => { event.stopPropagation(); const b = textOf(el.dataset.board); if (b) window.openTeamPage(b, { tab: 'needs' }); } });
await loadStyles('team_row_needs.css'); // the chip's rules are not in the start CSS
let count = null, shown = null; // null: nothing drawn with a count yet, so the first count always draws the list again (the first draw ran before this file was loaded, and knows no team)
const teams = new Set(); // the teams the list has drawn: the chip's counts are compared on these
const sum = () => (count ? [...teams].map(t => `${t}=${count(t).value}`).join('|') : '');
const changed = () => { const now = sum(); if (now !== shown) { shown = now; setTimeout(redrawLiveList); } }; // a tick later: the list asks loadedModule for this file, which knows it only once it has finished loading
importOnce('./inbox_sidebar.js').then(m => { count = m.teamNeedsCount; changed(); }).catch(() => {});
onOperatorAsksChanged(changed);
document.addEventListener('coral:team-needs-count', changed);
refreshOperatorAsks();

/** The chip for a team row: "N need you" (a number beside the name, or in its place when the row is narrow), "" when nothing waits or the count is not known yet. */
export function chip(team) {
    teams.add(team);
    const n = count ? count(team).value : 0;
    if (!(n > 0)) return '';
    const words = `${n} need${n === 1 ? 's' : ''} you`;
    return ` <span class="team-row-needs" data-on-click="team-needs-open" data-board="${escapeAttr(team)}" title="${escapeAttr(words)}" aria-label="${escapeAttr(words)}">${Number(n)} <span class="team-row-needs-word">need${n === 1 ? 's' : ''} input</span></span>`;
}
