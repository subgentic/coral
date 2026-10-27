/* The health check's limits and defaults (#4230, the operator; Backend's #4175 step 2 API; the fields are team_health_fields.js): a team's health check on or off and its interval,
 * who receives it, the all-clear line, the default reviewers, and each automatic rule on or off with its numbers. The values are the "health"
 * object of GET and PUT /api/board/{project}/settings (PUT replaces the whole object, Operator only, and the server clamps every value and
 * refuses a recipient who is not a member of the team). Through Coral Hub the server leaves "health" out of the GET, and then there is no tab.
 *
 * The inputs' limits are the server's clamps (HEALTH_LIMITS mirrors internal/board/health_settings.go); the form saves on its own, not with the
 * main Save bar, and a field the form does not know (a rule the server added) is sent back as it was read. Since PUT replaces the whole
 * object, Save reads it again first and changes only what the person changed (#4423): a rule another client changed while the tab was
 * open keeps that change. */

export const HEALTH_LIMITS = { minutes: [5, 1440], nudges: [1, 5], reviewers: 8, goalTasks: [5, 500], landingWait: [15, 10080], checkWait: [5, 10080] }; // landingWait: the landing alert's wait, in minutes (#8947)

// The server's defaults (DefaultHealthSettings); held_notice is the Lead's #4225 field, filled in only when the server returns it.
export const HEALTH_DEFAULTS = {
    on: false, interval_min: 10, recipient: '', all_clear: true, default_reviewers: [], // the check is off until a team turns it on (#4962)
    auto_delegate: { on: true },
    claim_nudge: { on: true, after_min: 10, nudges: 2 },
    status_nudge: { on: true, after_min: 20, escalate_after_min: 10 },
    mention_renudge: { on: true, after_min: 10 },
    held_notice: { on: true, after_min: 10 },
    busy_no_task: { on: true, after_min: 10 }, post_no_task: { on: true }, upload_no_task: { on: true }, // work done off the books (#7793)
    goal_size: { on: true, limit: 15 }, // a goal with too many tasks (#7808)
    goals_ready: { on: true, wait_min: 30, nudge: '' }, unowned_tasks: { on: true, wait_min: 15, nudge: '' }, // two more lines of the check (Goal #80, #8975): on unless a team turns them off
    landing: { on: false, branch: 'main', wait_min: 120, nudge: '' }, // done work that has not landed on the branch (Goal #80, #8947): off until a team turns it on
    ask_reminder: { on: true, after_min: 15 }, // a question (post --ask) the member it asks has not answered (#7794): reminded whether or not the check is on
};
