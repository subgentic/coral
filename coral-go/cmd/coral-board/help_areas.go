package main

import "github.com/subgentic/coral/internal/clihelp"

// boardAreas is the table behind "coral-board help overview" and "coral-board help <area>" (#20399). Every command of the commands table is in exactly one area (help_areas_test.go).
var boardAreas = []clihelp.Area{
	{
		Name: "talking", Summary: "Post to the team, read what was said, answer questions.",
		What:     "The board is the team's chat. A post must tell someone: @mention a member, use --to, or answer a task with --task. Read what is new, and answer a question by its number.",
		Commands: []string{"join", "post", "read", "check", "projects", "subscribers", "leave", "status"},
		Examples: []string{
			`coral-board read                                   # new messages for you (--all, --last N, --id N)`,
			`coral-board post "@Backend Dev the API is ready"    # a short post that names someone`,
			`coral-board post --reply-to 42 "Done, see the task"  # answers message 42 (closes a question asked of you)`,
			`coral-board post - <<'EOF'                         # several lines or backticks: a quoted heredoc, EOF on its own line`,
			`coral-board subscribers                            # who is on the board`,
			`coral-board status                                 # JSON: who is available and the open work`,
		},
		Rules: []string{
			"A post that notifies nobody is refused: @Name, --to, or --task N.",
			"Start every post with a one-line summary; put long text in an artifact (coral-agent help artifacts) and link it.",
			"Never put backticks or $(...) inside a double-quoted post: use the quoted heredoc.",
		},
		More: []string{"board", "quickstart"},
	},
	{
		Name: "questions", Summary: "Ask a teammate or the Operator a question and wait for the answer.",
		What:     "A question is a post that stays open until each person it names answers. A question to the Operator lands in their Needs you. Do not block on it: keep doing work you can do.",
		Commands: []string{"ask"},
		Examples: []string{
			`coral-board post --ask "@Operator Ship v2 today?" --yes-no   # Approve / Deny buttons`,
			`coral-board post --ask "@Reviewer is this ready?"           # a question to a teammate`,
			`coral-board ask withdraw 57                                 # take back your open question 57`,
			`coral-board wait --operator "Which logo?"                   # park until the Operator answers, then stop your turn`,
		},
		Rules: []string{
			"Ask the Operator with --ask and name @Operator; a plain post does not reach their Needs you.",
			"Asking the same question again while it is open posts nothing: it says 'Already asked as #N'.",
			"A file the Operator must decide on is uploaded with --tag \"for review\" --question \"...\" (coral-agent help artifacts).",
		},
		More: []string{"board", "coordination-reporting"},
	},
	{
		Name: "tasks", Summary: "Tasks and goals: assign work, claim it, finish it, track what it serves.",
		What:     "Work to produce (code, tests, docs, a review) is a task. Goals say what the team is working toward; a task can serve one. Tasks notify their assignee, so no separate post is needed.",
		Commands: []string{"task", "goal", "workflow"},
		Examples: []string{
			`coral-board task add "Fix the login bug" --assignee "Backend Dev" --priority high --body "details"`,
			`coral-board task claim                              # the next task assigned to you`,
			`coral-board task complete 12 --message "what was done"`,
			`coral-board task submit-review 12 --branch my-branch --reason "why" --message "last test line"   # code goes to review, not complete`,
			`coral-board goal list                              # the team's goals (goal show N, goal add)`,
		},
		Rules: []string{
			"Complete with --message for results and --outcome failed for unsuccessful work.",
			"A smaller slice is progress, not completion: report success only after checking the assigned requirements.",
			"Commits go through submit-review; the orchestrator completes the task.",
		},
		More: []string{"agent-tasks", "task-workflows", "completion-review"},
	},
	{
		Name: "reviews", Summary: "Reviews, reviewers and the merge queue (approved work not yet landed).",
		What:     "Authors submit work for review; reviewers approve or reject a named commit. Approved tasks wait in the merge queue until their patches land.",
		Commands: []string{"queue", "reviewer"},
		Examples: []string{
			`coral-board task approve 31                         # as a reviewer, on the task you were given`,
			`coral-board task reject 31 --note "why"             # sends it back to the author`,
			`coral-board queue                                  # approved tasks whose patches have not landed`,
			`coral-board reviewer set "QA Engineer" --reviews-only --areas ui,go   # Operator only`,
		},
		Rules: []string{
			"A review is a verdict on the named commit, never a rewrite of it.",
			"Name only tests you ran from the commit's own diff, and cite only reviews that are posted.",
		},
		More: []string{"completion-review", "merge-queue"},
	},
	{
		Name: "agents", Summary: "See, wake, sleep, stop, restart and message other agents.",
		What:     "The orchestrator and the Operator can look at what an agent is doing and change its state. Every agent can wait for a teammate, a task or a commit and be woken when it happens.",
		Commands: []string{"peek", "waiting", "wake", "sleep", "stop", "interrupt", "restart", "wait", "send", "targets"},
		Examples: []string{
			`coral-board peek "Frontend Dev"                     # the agent's terminal (orchestrator only)`,
			`coral-board waiting "Frontend Dev"                  # what waits for it: unread messages, a send not typed`,
			`coral-board wake "Frontend Dev"                      # start an asleep agent (also: sleep, restart, stop, interrupt)`,
			`coral-board wait --task 12                          # park until task 12 changes, then STOP your turn`,
			`coral-board send --board other-team "message"       # another team's Orchestrator (Orchestrators and the Operator)`,
		},
		Rules: []string{
			"When you wait, run coral-board wait and STOP your turn: never sleep or poll in a loop. Coral wakes you.",
			"Sleep and Archive are different: a slept agent can be started again.",
		},
		More: []string{"sessions", "notifications"},
	},
	{
		Name: "resources", Summary: "Claim a slot of a shared computer or tool before a heavy run.",
		What:     "Heavy runs (full test suites, builds) share a few machines. A resource has slots; claim one, run the work in the same command, and the slot goes back when it ends.",
		Commands: []string{"resource", "heavy"},
		Examples: []string{
			`coral-board resource list                           # every resource, who holds it, the line`,
			`coral-board resource claim epoch-go --wait --run -- go test ./...   # wait for a slot, run, give it back`,
			`coral-board resource renew epoch-go                 # a long run: renew the lease`,
			`coral-board resource release epoch-go              # give it back early`,
		},
		Rules: []string{
			"Claim and run in the same command: the slot goes back when that command ends.",
			"A lease runs out: renew a run of ten minutes or more every few minutes.",
		},
		More: []string{"resource-queue"},
	},
	{
		Name: "health", Summary: "The team's health check: what it watches and how to tune it.",
		What:     "The health check nudges stuck work: unclaimed tasks, long waits, stale reviews, a landing that waits, goals that are ready. The orchestrator or the Operator tunes each rule; every rule has settings keys.",
		Commands: []string{"health"},
		Examples: []string{
			`coral-board health settings show                    # every key, its value, default and range (live)`,
			`coral-board health settings set landing.wait_min 20  # tune one key`,
			`coral-board health settings reset landing.wait_min   # back to the default`,
			`coral-board health ack 7                            # mark an item handled (the item ends with [ack 7])`,
		},
		Rules: append(healthRuleLines(),
			"'health settings show' lists every key of each group live, with its default and range: the table the server itself uses.",
			"Only the orchestrator or the Operator changes a setting, on this computer."),
		More: []string{"custom_checks", "coordination-reporting"},
	},
	{
		Name: "search", Summary: "Find a message, task, goal or past chat; and what is in a release.",
		What:     "One search over the board's messages, tasks, goals and your past chats. Narrow it by source, state, goal, person or time. Look it up before you ask or guess.",
		Commands: []string{"search"},
		Examples: []string{
			`coral-board search "login bug"                      # every word, any order`,
			`coral-board search "release" --source tasks --state done --since 2d`,
			`coral-board search "decision" --source goals --json`,
		},
		Rules: []string{
			"Do not grep logs or transcripts: search finds posts, tasks, goals and past chats.",
			"Your own past chat: coral-agent history search <query>.",
		},
		More: []string{"session-history"},
	},
	{
		Name: "artifacts", Summary: "Share a file (report, log, screenshot, page) as a Coral artifact.",
		What:     "Long text, logs, diffs, screenshots and pages go in an artifact; a post links it as coral://artifacts/<digest>. The commands are coral-agent's, not coral-board's.",
		Commands: nil,
		Examples: []string{
			`coral-agent artifact upload report.md               # prints coral://artifacts/<digest>`,
			`coral-agent artifact upload plan.md --tag "for review" --question "Approve the plan?"   # the Operator decides`,
			`coral-agent artifact download coral://artifacts/<digest>   # prints the local path`,
		},
		Rules: []string{
			"Tag a file \"for review\" only when the Operator must decide: evidence and logs are untagged.",
			"A new version of a file uses --new-version-of and the review tag again, or it skips the Inbox.",
		},
		More: []string{"artifacts"},
	},
	{
		Name: "cross-team", Summary: "Message other teams on this Coral or other Corals (link, send, Hub).",
		What:     "Teams can be linked so their orchestrators message each other. Linking is the Operator's; sending is the orchestrators'. Teams on other Corals are reached through Coral Hub.",
		Commands: []string{"link", "unlink", "links", "seats"},
		Examples: []string{
			`coral-board targets                                 # teams you may message`,
			`coral-board send --board other-team "message"       # to its Orchestrator`,
			`coral-board links                                  # Operator: who a team's links allow`,
			`coral-board link team-a team-b                      # Operator: let two teams message each other`,
		},
		Rules: []string{
			"link, unlink, links and seats are the Operator's; an agent's terminal is refused.",
			"Both boards must allow cross-team messaging.",
		},
		More: []string{"cross-team", "hub"},
	},
	{
		Name: "reminders", Summary: "Remind an agent of something at a time, once or on a schedule.",
		What:     "A reminder tells an agent something at a time and stays open until the agent runs 'remind done'. Scheduled jobs and workflows are the other way to run something later.",
		Commands: []string{"remind"},
		Examples: []string{
			`coral-board remind add --help                      # the forms: once or on a schedule`,
			`coral-board remind list                            # open reminders`,
			`coral-board remind done 4                          # you did it`,
		},
		Rules: []string{"A reminder stays open until the agent says done."},
		More:  []string{"reminders", "scheduled-jobs", "workflows"},
	},
	{
		Name: "settings", Summary: "Team rules, Coral settings, export and delete (mostly the Operator's).",
		What:     "Working mode is the rules every agent is told. Coral settings are the Operator's. You can read and export; changing most of it is refused for an agent.",
		Commands: []string{"working-mode", "settings", "export", "delete"},
		Examples: []string{
			`coral-board working-mode                            # read the team's rules`,
			`coral-board export --output chat.md                 # export the chat (json, markdown or html)`,
			`coral-board settings set <key> <value>              # Operator only`,
		},
		Rules: []string{"settings, delete and working-mode changes are the Operator's."},
		More:  []string{"settings-system", "team-config"},
	},
}

// boardOther points at the other tool's overview.
const boardOther = "Your own tasks, launching agents, files, history, notify and skills: coral-agent help overview"

// healthRules are the rules of the health check by the first part of their settings keys (help_areas_test.go fails for a group of board.HealthKeys that no line names, so a new rule is added here).
var healthRules = []struct{ groups, watches string }{
	{"interval_min, heartbeat_min, recipient", "how often the check runs and posts, and who gets its items (the Orchestrator by default)"},
	{"claim_nudge", "a task assigned to someone who has not claimed it"},
	{"status_nudge, busy_no_task, held_notice", "a task in progress with no update; an agent busy with no task; work held too long"},
	{"mention_renudge, ask_reminder", "an @mention or a question nobody has answered"},
	{"unowned_tasks, goals_ready, goal_size", "tasks with no owner; a goal whose tasks are done; a goal with too many open tasks"},
	{"landing, release", "approved work that has not landed; a release that waits"},
	{"action_list", "stuck waits, overloaded agents, stale reviews and mentions in the Operator's list"},
	{"compact_context, dialog_timeout, auto_recommend", "agents with too much context; a dialog waiting too long; recommending an answer after a grace"},
	{"off_books, post_no_task, upload_no_task, deviations", "work done with no task; a post or upload that names none; deviations from the plan"},
	{"pool_review, wait_escalate, default_reviewers, reviewer_pool", "review picking from a pool; waits that escalate; who reviews by default"},
	{"assign_limit, park_limit, stale_sweep_hours, auto_delegate, all_clear, on", "limits on assigned and parked work, the stale-task sweep, and on/off switches"},
}

func healthRuleLines() []string {
	out := make([]string, 0, len(healthRules))
	for _, r := range healthRules {
		out = append(out, r.groups+": "+r.watches)
	}
	return out
}
