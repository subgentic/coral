/* The phone's ONE navigation model (#11236, approved by the operator; #11239): every view the dashboard can show declares a screen TYPE here, and the type decides what chrome it gets, so a screen cannot drift
 * from the rules (tests/frontend/phone_screens_census.test.mjs checks that every view in view_switch.js is declared).
 *
 *   top-level  a ☰, the title in the bar, at most one icon or ⋯, tabs (view_list.js's strip) under it, the floating bottom nav, a + for what the page creates (Home, Inbox, Automations, Analytics, Docs)
 *   drill-down a ← (always the arrow in the bar, never a link in the content), the title with a context line, ⋯; no ☰ and no bottom nav; the primary action is a composer or one sticky-footer button
 *   form       a ←, the title with the step or the parent, a sticky footer with the one action (New agent, New goal, New task, Settings and its sections)
 *
 * `slice` is the build slice (#11239 A to D) that brings the screen to the model: a screen whose slice is not built yet keeps today's chrome (its nav and bar as before); BUILT lists the slices that are. `nav` is the bottom-nav
 * slot that is lit on a top-level screen (the nav's four: Home, Inbox, Tasks, More). */
export const SCREEN_TYPES = {
    'top-level': { back: false, menu: true, bottomNav: true },
    'drill-down': { back: true, menu: false, bottomNav: false },
    form: { back: true, menu: false, bottomNav: false },
};

export const BUILT = new Set(['A']);

export const PHONE_SCREENS = {
    'mobile-agent-list': { type: 'top-level', nav: 'nav-agents', fab: 'agents', slice: 'A' }, // Home: the agent list (its + makes an agent or a team)
    'inbox-view': { type: 'top-level', nav: 'nav-inbox', slice: 'A' },               // Inbox (its folders are the tab strip)
    'group-table-view': { type: 'top-level', nav: tab => (tab === 'hub-inbox' ? 'nav-inbox' : 'nav-more'), fab: tab => (tab === 'automations' ? 'automations' : null), slice: 'A' }, // a folder page: the Inbox's (lit Inbox) or Automations' (More); the tab that is open says which
    'scheduler-view': { type: 'top-level', nav: 'nav-more', fab: 'automations', slice: 'A' }, // Automations > Jobs (its + makes a job or a workflow)
    'workflows-view': { type: 'top-level', nav: 'nav-more', fab: 'automations', slice: 'A' }, // Automations > Workflows
    'cost-dashboard-view': { type: 'top-level', nav: 'nav-more', slice: 'C' },       // Analytics
    'docs-view': { type: 'top-level', nav: 'nav-more', slice: 'C' },                 // Docs
    'live-session-view': { type: 'drill-down', slice: 'B' },                         // the agent chat and terminal
    'team-page-view': { type: 'drill-down', slice: 'B' },                            // a team and its tabs
    'messageboard-view': { type: 'drill-down', slice: 'B' },
    'history-session-view': { type: 'drill-down', slice: 'B' },                      // a past chat
    'servers-view': { type: 'top-level', nav: 'nav-more', slice: 'C' },              // Computers
    'artifacts-view': { type: 'top-level', nav: 'nav-more', slice: 'D' },            // the Hub's Artifacts
    'welcome-screen': { type: 'top-level', slice: 'D' },                             // a wide window's first page: a phone never shows it (#4497)
    'chats-empty-view': { type: 'top-level', slice: 'D' },
    'timeline-view': { type: 'drill-down', slice: 'D' },
    'kanban-view': { type: 'drill-down', slice: 'D' },
};

/** The declared screen of a view, once its slice is built: { type, nav } or null while the view keeps today's chrome. `nav` is the lit slot's name, from a function of the open nav tab where one page serves two tabs. */
export function builtScreen(viewId, navTab = '') {
    const s = PHONE_SCREENS[viewId];
    return s && BUILT.has(s.slice) ? { ...s, nav: typeof s.nav === 'function' ? s.nav(navTab) : s.nav, fab: typeof s.fab === 'function' ? s.fab(navTab) : s.fab } : null;
}
