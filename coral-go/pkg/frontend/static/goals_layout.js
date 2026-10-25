/* The page around the Goals face (#7404, UI/UX's #7401): Goals uses the width. While the board's Goals face is on screen the agent list is the 56 px rail and the right panel is out of the way (a Members button in
 * the board's header brings it back); each choice is remembered for Goals alone, one click away, and the person's own layout (the rail's key, the right panel's open state) is not written while Goals is on:
 * leaving Goals puts it back as it was. A phone has its own layout and is left alone. The rail is the sidebar's own (.layout.sidebar-collapsed); the panel is hidden by the style sheet. */

import { browserLocal } from './safe_storage.js';
import { state } from './state.js';
import { isPhoneLayout } from './phone_layout.js';
import { onDockPage } from './dock_page.js';

const AGENTS_KEY = 'coral.goals.agents';   // 'wide' when the person opened the agent list in Goals; anything else is the rail
const MEMBERS_KEY = 'coral.goals.members'; // 'open' when the person opened the right panel in Goals
const OWN_RAIL_KEY = 'coral-sidebar-collapsed-rail'; // the person's own choice (sidebar.js): read here, never written while Goals is on

let on = false;
let panelWas = null; // the right panel was shut and Members opened it: put back when it closes or Goals is left

export const goalsLayoutOn = () => on;

/** An empty agent list never opens wide: it is a blank third of the window. */
const agentsWide = () => browserLocal.get(AGENTS_KEY) === 'wide' && (state.liveSessions || []).length > 0;
const membersOpen = () => on && browserLocal.get(MEMBERS_KEY) === 'open';

function applyAgents() {
    const collapsed = on ? !agentsWide() : browserLocal.get(OWN_RAIL_KEY) === '1';
    document.querySelector('.layout')?.classList.toggle('sidebar-collapsed', collapsed);
}

function applyMembers() {
    const open = membersOpen();
    document.body.toggleAttribute('data-goals-members', open);
    const b = document.getElementById('mb-members-btn');
    if (b) { b.setAttribute('aria-expanded', String(open)); b.classList.toggle('active', open); }
    const dock = document.getElementById('agentic-state');
    if (open && dock?.classList.contains('collapsed')) { // the panel is shut by the person's own choice: open it for Members and put it back after
        panelWas = 'shut';
        window.toggleAgenticPanel?.(true);
    }
    if (open) window.switchAgenticTab?.('subscribers', 'top');
    if (!open && panelWas) { panelWas = null; window.toggleAgenticPanel?.(false); }
}

/** The Goals face is on screen (true) or not (false): called as the board draws its face. */
export function setGoalsLayout(next) {
    next = !!next && !isPhoneLayout();
    if (next === on) { if (on) applyAgents(); return; }
    on = next;
    document.body.toggleAttribute('data-goals-layout', on);
    applyAgents();
    applyMembers();
}

export function toggleGoalsAgents() {
    if (!(state.liveSessions || []).length) return; // nothing to show: the rail stays
    browserLocal.set(AGENTS_KEY, agentsWide() ? 'rail' : 'wide'); applyAgents();
}
export function toggleGoalsMembers() { browserLocal.set(MEMBERS_KEY, membersOpen() ? 'closed' : 'open'); applyMembers(); }

onDockPage(kind => { if (kind !== 'board') setGoalsLayout(false); }); // another page: the person's own layout is back
