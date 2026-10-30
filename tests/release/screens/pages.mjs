// The pages the release screenshots photograph: ONE list, and census.test.mjs fails when the dashboard has a route, a nav tab, a Settings section or a dialog that is not in it (or in the two
// short lists of what is deliberately not photographed, with the reason), so a new page cannot be skipped.
//
// An entry: { id, world, path | open, wait?, notes? }
//   id     the file name's page part: <id>__<width>.png (lower case, digits, dashes)
//   world  'seeded' (the server seed.mjs filled) or 'fresh' (a server with nothing in it and no password yet: the first-run screens)
//   path   the address, with {names} that seed.json fills: {team} {agentWorking} {agentWaiting} {agentIdle} {agentAsleep} {goal} {task} {workflow} {run} {job} {chat}
//   open   the name of a function in openers.mjs that gets the page to the screen when an address is not enough (a dialog, a Settings section)
//   widths  only these widths, when the page does not exist at the others (the reason is in notes)
//   stub   an API answer the page is given because the isolated server cannot be in that state (named in stubs.mjs); the entry says so on its card

export const WIDTHS = [
    { name: '1440', width: 1440, height: 900, mobile: false },   // full
    { name: '900', width: 900, height: 900, mobile: false },     // middle
    { name: '390', width: 390, height: 844, mobile: true },      // phone: the mobile user agent and touch
];
export const THEMES = ['dark', 'light'];
export const DEFAULT_THEMES = ['dark'];

const agent = (id, state, sub) => ({ id: `agent-${id}${sub ? '-' + sub : ''}`, world: 'seeded', path: `/agents/{agent${state}}${sub ? '/' + sub : ''}` });

export const PAGES = [
    // Home and the agents
    { id: 'home', world: 'seeded', path: '/agents' },
    { id: 'agent-chat-working', world: 'seeded', path: '/agents/{agentWorking}', notes: 'a working agent: the chat, the Stop button, the queued line' },
    { id: 'agent-terminal-working', world: 'seeded', path: '/agents/{agentWorking}?view=terminal' },
    { id: 'agent-chat-waiting', world: 'seeded', path: '/agents/{agentWaiting}', notes: 'an agent waiting for the person: the permission question' },
    { id: 'agent-chat-idle', world: 'seeded', path: '/agents/{agentIdle}', notes: 'an idle agent that has answered' },
    { id: 'agent-asleep', world: 'seeded', path: '/agents/{agentAsleep}', notes: 'a sleeping agent' },
    ...['board', 'tasks', 'notes', 'files', 'browse', 'artifacts', 'activity', 'agent-ui'].map(sub => agent('tab', 'Working', sub)),
    // A team and its tabs (the path word of the Board tab is "board")
    { id: 'team-goals', world: 'seeded', path: '/team/{team}' },
    { id: 'team-agents', world: 'seeded', path: '/team/{team}/agents' },
    { id: 'team-tasks', world: 'seeded', path: '/team/{team}/tasks' },
    { id: 'team-artifacts', world: 'seeded', path: '/team/{team}/artifacts' },
    { id: 'team-knowledge', world: 'seeded', path: '/team/{team}/knowledge' },
    { id: 'team-board', world: 'seeded', path: '/team/{team}/board' },
    { id: 'team-goal-page', world: 'seeded', path: '/team/{team}/goals/{goal}' },
    { id: 'team-task-page', world: 'seeded', path: '/team/{team}/tasks/{task}' },
    { id: 'team-settings', world: 'seeded', open: 'teamSettings', widths: ['1440', '900'], notes: 'the popout of the team page\'s Settings button; a phone reaches it through the page\'s More menu, which this run does not open' },
    // The Inbox and its folders
    { id: 'inbox-needs', world: 'seeded', path: '/inbox/needs' },
    { id: 'inbox-saved', world: 'seeded', path: '/inbox/saved' },
    { id: 'inbox-artifacts', world: 'seeded', path: '/inbox/artifacts' },
    { id: 'inbox-chats', world: 'seeded', path: '/inbox/chats' },
    { id: 'inbox-chat-page', world: 'seeded', path: '/inbox/chats/all/{chat}' },
    { id: 'inbox-goals', world: 'seeded', path: '/inbox/goals' },
    { id: 'inbox-tasks', world: 'seeded', path: '/inbox/tasks' },
    { id: 'inbox-boards', world: 'seeded', path: '/inbox/boards' },
    // Automations
    ...['running', 'failed', 'recent', 'jobs', 'workflows'].map(f => ({ id: `automations-${f}`, world: 'seeded', path: `/automations/${f}` })),
    { id: 'automations-job-page', world: 'seeded', path: '/automations/jobs/{job}' },
    { id: 'automations-workflow-page', world: 'seeded', path: '/automations/workflows/{workflow}' },
    { id: 'automations-run-page', world: 'seeded', path: '/automations/workflows/{workflow}/runs/{run}' },
    // Analytics, the docs
    { id: 'analytics', world: 'seeded', path: '/analytics' },
    ...['provider', 'model', 'thinking', 'team', 'agent', 'branch', 'task', 'calls', 'per-commit', 'task-time'].map(p => ({ id: `analytics-${p}`, world: 'seeded', path: `/analytics/${p}` })),
    { id: 'docs', world: 'seeded', path: '/docs' },
    { id: 'docs-page', world: 'seeded', path: '/docs/agent-tasks' },
    // Settings: one entry for each section of the dialog
    ...['general', 'agents', 'terminal', 'notifications', 'files', 'cleanup', 'network', 'security', 'updates'].map(g => ({ id: `settings-${g}`, world: 'seeded', open: 'settings', group: g })),
    // Dialogs
    { id: 'dialog-new-agent', world: 'seeded', open: 'newAgent' },
    { id: 'dialog-new-team', world: 'seeded', open: 'newTeam' },
    { id: 'dialog-open-folder', world: 'seeded', open: 'openFolder' },
    { id: 'dialog-update-ready', world: 'seeded', open: 'updateDialog', stub: 'updateStaged', notes: 'a verified update is ready: the isolated server cannot be in that state, so its status answer is stubbed' },
    { id: 'dialog-themes', world: 'seeded', open: 'themes' },
    { id: 'dialog-jump', world: 'seeded', open: 'jump', widths: ['1440', '900'], notes: 'the keyboard jump dialog (Ctrl or Cmd+K): a phone has no keyboard shortcut' },
    { id: 'dialog-new-job', world: 'seeded', open: 'newJob' },
    { id: 'dialog-new-task', world: 'seeded', open: 'newTask' },
    { id: 'dialog-mobile-connect', world: 'seeded', open: 'mobileConnect', widths: ['1440', '900'], notes: 'opened from the home page\'s card, which a phone with agents does not show' },
    // The first run: a server with nothing in it and no password
    { id: 'first-run-home', world: 'fresh', path: '/agents', notes: 'a fresh Coral: the set-a-password prompt over the empty home' },
    { id: 'first-run-welcome', world: 'fresh', open: 'welcome', notes: 'the first-launch screen: the ways to run Coral' },
];

// A route the router sends to another page: the shot of that page is the shot of this route. Keyed by the view name in app_routes.js.
export const ALIASES = {
    board: '/board/{team} opens the team page on its Board tab (team-board)',
    workflows: '/workflows is the Workflows folder of Automations (automations-workflows)',
    jobs: '/jobs is the Jobs folder of Automations (automations-jobs)',
    chats: '/chats is the Inbox\'s All chats (inbox-chats)',
    servers: 'the Servers tab is the Hub\'s: a Coral that is not a Hub goes home (home)',
};

// The routes' pieces that have no page of their own and the reason: the census reads this before it fails.
export const NOT_PHOTOGRAPHED = {
    modals: {
        'prompt-modal': 'a generic question the code asks with its own text; each is seen in the page that asks it',
        'alert-modal': 'a generic message the code shows with its own text',
        'confirm-modal': 'a generic confirmation the code asks with its own text',
        'info-modal': 'a generic help card the code fills with its own text',
        'restart-modal': 'the update dialog (dialog-update-ready) is this dialog',
        'resume-modal': 'opened from a History chat that has ended: needs an ended session',
        'mb-export-modal': 'a download dialog of the Board tab, one button',
        'save-template-modal': 'opened from New team after a launch; the New team dialog covers its form',
        'default-prompts-modal': 'opened from Settings > Agents; settings-agents covers the section it opens from',
        'custom-view-modal': 'a developer feature behind Settings',
        'macro-modal': 'a keyboard feature behind Settings',
        'task-detail-modal': 'the task page (team-task-page) is this view',
        'jump-status': 'a status line inside the jump dialog (dialog-jump)',
        'team-wizard-modal': null, // covered: dialog-new-team
        'launch-modal': null,
        'open-folder-modal': null,
        'settings-modal': null,
        'theme-configurator-modal': null,
        'job-modal': null,
        'mobile-connect-modal': null,
        'create-task-modal': null,
        'jump-modal': null,
    },
};

export const MODAL_PAGE = {
    'launch-modal': 'dialog-new-agent', 'team-wizard-modal': 'dialog-new-team', 'open-folder-modal': 'dialog-open-folder', 'settings-modal': 'settings-general', 'theme-configurator-modal': 'dialog-themes',
    'job-modal': 'dialog-new-job', 'mobile-connect-modal': 'dialog-mobile-connect', 'create-task-modal': 'dialog-new-task', 'jump-modal': 'dialog-jump',
};
export const NAV_TAB_PAGE = {
    agents: 'home', 'hub-inbox': 'inbox-needs', history: 'inbox-chats', automations: 'automations-jobs', tokens: 'analytics', servers: 'home', docs: 'docs', artifacts: 'inbox-artifacts', board: 'team-board',
};
