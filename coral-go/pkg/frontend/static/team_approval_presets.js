/* How much the Operator approves (#11657, from #11589's design): three names for combinations of the team's existing flags, never a new stored setting, so nothing can go out of step. Team settings shows the name the flags match
 * (Custom when they match none) and a choice sets the flags; the New team step offers the same three and a new team starts on "Operator approves goals". Planning approval only: it does not touch auto-accept, the Orchestrator's
 * access, cross-team switches, Guides or health, and a file tagged "for review" or a question to the Operator reaches Needs you whatever the choice. */

export const APPROVAL_PRESETS = [
    { id: 'tasks', label: 'Operator approves tasks', goals: true, tasks: true, requireGoal: true,
        help: 'Every goal and every task an agent adds waits for you in Needs you. The most control and the most to decide: each follow-up task is held too. A team with no Orchestrator waits for you on all of its own planning.' },
    { id: 'goals', label: 'Operator approves goals', goals: true, tasks: false, requireGoal: true,
        help: 'You approve the direction. Agents add tasks under approved goals freely, and every task needs a goal, so none can slip past the goals gate.' },
    { id: 'auto', label: 'Fully autonomous', goals: false, tasks: false, requireGoal: null,
        help: 'Agents plan freely. This is planning only: a file tagged for review and a question to you still reach Needs you, and nothing else about what agents may do changes.' },
];
const CUSTOM = { id: 'custom', label: 'Custom', help: 'The switches below do not match one of the three choices.' };
export const NEW_TEAM_APPROVAL = 'goals'; // what a new team starts on (the Operator's choice, #11589)

/** The preset the flags match: 'tasks', 'goals', 'auto', or 'custom'. Fully autonomous does not care about require_goal (it keeps whatever the team has). */
export function presetOf(v) {
    const g = !!(v && v.goals_need_approval), t = !!(v && v.tasks_need_approval), r = !!(v && v.require_goal);
    if (g && t && r) return 'tasks';
    if (g && !t && r) return 'goals';
    if (!g && !t) return 'auto';
    return 'custom';
}
/** The flags a preset sets: { goals_need_approval, tasks_need_approval } and require_goal only when the preset needs it (Fully autonomous leaves it as it is). null for Custom. */
export function presetFlags(id) {
    const p = APPROVAL_PRESETS.find(x => x.id === id);
    if (!p) return null;
    return { goals_need_approval: p.goals, tasks_need_approval: p.tasks, ...(p.requireGoal ? { require_goal: true } : {}) };
}
const helpOf = id => (APPROVAL_PRESETS.find(p => p.id === id) || CUSTOM).help;

/** The settings row: the three choices (and Custom where the flags can differ). */
export function approvalField({ custom = true, id } = {}) {
    return { key: 'planning_approval', type: 'select', label: 'Planning approval', ...(id ? { id } : {}), help: helpOf(NEW_TEAM_APPROVAL),
        options: [...APPROVAL_PRESETS.map(p => ({ value: p.id, label: p.label })), ...(custom ? [{ value: CUSTOM.id, label: 'Custom (set below)' }] : [])] };
}

/** Keeps the row and the flags in step on `view` (a settings view) inside `host`: a choice sets the flags it names, a flag changed by hand moves the row to the name it now matches, and the sentence under the row follows the
 * choice. `flagKeys` are the view's own switches (the New team step has no approval switches: only require_goal, which it holds on while a choice needs it, and `follow: false` because its flags come from the choice alone; `autoClearsRequireGoal`: a new team that picks Fully autonomous is not left with the goal rule the default set). */
export function wireApproval(view, host, { flagKeys = ['goals_need_approval', 'tasks_need_approval', 'require_goal'], follow = true, autoClearsRequireGoal = false } = {}) {
    const row = () => host.querySelector('.sv-row[data-key="planning_approval"]');
    const say = id => view.retext('planning_approval', { help: helpOf(id) });
    if (view.ready && view.ready.then) view.ready.then(() => say(view.values().planning_approval)).catch(() => {}); // the sentence under the row is the one for what the team has, from the first draw
    host.addEventListener('change', e => {
        const r = row(); if (!r) return;
        if (r.contains(e.target)) {
            const flags = presetFlags(view.values().planning_approval);
            if (flags) for (const [k, val] of Object.entries(flags)) if (flagKeys.includes(k)) view.set(k, val);
            if (autoClearsRequireGoal && view.values().planning_approval === 'auto' && flagKeys.includes('require_goal')) view.set('require_goal', false); // a new team that chooses Fully autonomous starts as teams did before
            say(view.values().planning_approval);
        } else if (follow && e.target.closest && flagKeys.some(k => e.target.closest(`.sv-row[data-key="${k}"]`))) {
            const next = presetOf(view.values());
            if (view.values().planning_approval !== next) view.set('planning_approval', next);
            say(next);
        }
    });
}
