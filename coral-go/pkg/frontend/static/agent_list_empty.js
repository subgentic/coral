/* Existing empty-agent-list cards, loaded only when that list is empty. */
import { LAUNCH_CARDS, goalDesc } from './launch_cards.js';
import { escapeHtml } from './utils.js';

export function emptyListHtml(unfilteredCount) {
    if (!unfilteredCount) return 'No live sessions';
    const words = (document.getElementById('agent-search-input')?.value || '').trim();
    if (words) return `No agents match ${escapeHtml(words.length > 40 ? words.slice(0, 40) + '\u2026' : words)}. <button type="button" class="btn btn-quiet btn-small" data-on-click="agent-search-clear">Clear search</button>`;
    return 'No agents match these filters. <button type="button" class="btn btn-quiet btn-small" data-on-click="agent-filters-clear">Clear filters</button>';
}

const PHONE_CARD_ACTION = {
    agent: 'data-on-click="m-show-launch-modal-then-select-launch-type" data-arg="agent"',
    team: 'data-on-click="m-show-launch-modal-then-select-launch-type" data-arg="team"',
    goal: 'data-on-click="m-new-goal-from-home"',
};
const phoneCard = c => `<button type="button" class="empty-launch" ${PHONE_CARD_ACTION[c.key]}><span class="empty-launch-icon material-icons" aria-hidden="true">${c.icon}</span><span class="empty-launch-copy"><strong>${c.label}</strong><span${c.key === 'goal' ? ' data-goal-desc' : ''}>${c.key === 'goal' ? goalDesc() : c.desc}</span></span><span class="material-icons empty-launch-arrow" aria-hidden="true">arrow_forward</span></button>`;
export const phoneWelcome = () => `<li class="empty-state empty-welcome"><h2>What do you want to work on?</h2><p>Start one agent in a folder, or a team that works together.</p>
<div class="empty-launch-list">
${LAUNCH_CARDS.map(phoneCard).join('\n')}
</div></li>`;
