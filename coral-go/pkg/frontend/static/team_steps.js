/* The Launch Agent Team dialog's three steps (#6397, #7407): 1 Name and where it launches, 2 Members, 3 Start and team settings. Pure DOM: `data-stage` on the step says which page shows (css), and the buttons and the line under the title follow it. */
export const TEAM_STEPS = ['team', 'members', 'start'];
const STEP_NAMES = { team: 'Your team', members: 'Members', start: 'Start and team settings' };

export function currentTeamStep() {
    return document.getElementById('launch-step-team')?.dataset.stage || 'team';
}

/** The folder in the step line, as the end of its path ("…/Coral/first-team"): a whole path wrapped over four lines on a phone. A tap shows all of it and another shortens it (#11401). Text only: a path is the person's. */
function folderButton(dir) {
    const short = dir.length <= 34 ? dir : '…/' + dir.split(/[\\/]+/).filter(Boolean).slice(-2).join('/');
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'team-sub-path'; b.textContent = short; b.setAttribute('aria-expanded', 'false'); b.setAttribute('aria-label', `Folder ${dir}`);
    if (short === dir) { b.disabled = true; return b; }
    b.addEventListener('click', () => { const open = b.getAttribute('aria-expanded') !== 'true'; b.setAttribute('aria-expanded', String(open)); b.textContent = open ? dir : short; });
    return b;
}

export function showTeamStep(step, { focus = false } = {}) {
    const i = TEAM_STEPS.indexOf(step);
    if (i < 0) return;
    const root = document.getElementById('launch-step-team');
    if (!root) return;
    root.dataset.stage = step;
    document.getElementById('launch-modal')?.setAttribute('data-team-stage', step); // the Machine row above belongs to step 1 only (css)
    for (const name of TEAM_STEPS) {
        const panel = document.getElementById(`team-panel-${name}`);
        if (panel) panel.hidden = name !== step;
    }
    const back = document.getElementById('launch-team-back');
    const next = document.getElementById('launch-team-next');
    const go = document.getElementById('launch-team-go');
    if (back) back.hidden = i === 0;
    if (next) next.hidden = i === TEAM_STEPS.length - 1;
    if (go) go.hidden = i !== TEAM_STEPS.length - 1;
    const name = (document.getElementById('team-board-name')?.value || '').trim(), dir = (document.getElementById('launch-team-dir')?.value || '').trim();
    const sub = document.getElementById('team-stage-sub');
    if (sub) {
        sub.textContent = '';
        sub.append(`Step ${i + 1} of ${TEAM_STEPS.length}: ${STEP_NAMES[step]}`);
        if (step !== 'team' && (name || dir)) { // the recap line of the title: the team and where (text only: a name and a path are the person's)
            sub.append('. ');
            if (name) { const b = document.createElement('b'); b.textContent = name; sub.append(b); }
            if (name && dir) sub.append(' in ');
            if (dir) sub.append(folderButton(dir));
        }
    }
    const live = document.getElementById('team-step-live');
    if (live) live.textContent = `Step ${i + 1} of ${TEAM_STEPS.length}: ${STEP_NAMES[step]}`;
    document.dispatchEvent(new CustomEvent('team-step-shown', { detail: { step } }));
    if (focus) {
        const first = { team: '#team-board-name', members: '#team-template-select', start: '#team-goal' }[step];
        (step === 'start' ? document.getElementById('team-goal') || document.querySelector('#launch-step-team .settings-tab[aria-selected="true"]') : document.querySelector(first))?.focus(); // step 3 opens in its first field, the task: the keyboard that typed it was on the menu's "Start" tab and the text went nowhere (#10410)
    }
}
