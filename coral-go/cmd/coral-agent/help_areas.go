package main

import "github.com/subgentic/coral/internal/clihelp"

// agentAreas is the table behind "coral-agent help overview" and "coral-agent help <area>" (#20399). Every command of the commands table is in exactly one area (help_areas_test.go).
var agentAreas = []clihelp.Area{
	{
		Name: "tasks", Summary: "Your own task list: add, claim, finish, read.",
		What:     "Tasks are your own to-do list when you are on no team, and the way you read a task you were given. On a team the board's tasks are coral-board's.",
		Commands: []string{"task"},
		Examples: []string{
			`coral-agent task add "Write the report" --body "details" --priority high`,
			`coral-agent task claim                              # the next ready task (or: claim <id>)`,
			`coral-agent task current                           # the task you are on`,
			`coral-agent task detail 12                         # requirements, dependencies, results (JSON)`,
			`coral-agent task complete 12 --message "what was done"   # --outcome failed when it did not work`,
		},
		Rules: []string{
			"Complete with --message for results; a smaller slice is progress, not completion.",
			"Team board work (assign, review, goals): coral-board help tasks.",
		},
		More: []string{"agent-tasks"},
	},
	{
		Name: "launch", Summary: "Start another agent in a folder, with your default settings.",
		What:     "Launch an agent in a directory, optionally on a board, with a name, model and first prompt. bind-codex links a native Codex transcript to its Coral id.",
		Commands: []string{"launch", "bind-codex"},
		Examples: []string{
			`coral-agent launch ~/code/app --type claude --name "Helper" --prompt "Fix the tests"`,
			`coral-agent launch . --board my-team                # join it to that board (its id)`,
		},
		Rules: []string{"An agent starts agents only in its team's folder or below it when the team's grant is on."},
		More:  []string{"sessions", "teams"},
	},
	{
		Name: "artifacts", Summary: "Store a report, log, screenshot or page and share it as a link.",
		What:     "Long reports, logs, diffs, screenshots and pages are uploaded as artifacts; you share the returned coral://artifacts/<digest> link. Send a file to the Operator for review with a tag and a one-line question.",
		Commands: []string{"artifact"},
		Examples: []string{
			`coral-agent artifact upload report.md               # prints coral://artifacts/<digest>`,
			`coral-agent artifact upload plan.md --tag "for review" --question "Approve the plan?"`,
			`coral-agent artifact upload plan.md --new-version-of coral://artifacts/<digest> --tag "for review" --question "v2 ok?"`,
			`coral-agent artifact review coral://artifacts/<digest>   # send the newest version for review with no new bytes`,
			`coral-agent artifact download coral://artifacts/<digest>   # prints the verified local path`,
		},
		Rules: []string{
			"A coral://artifacts/<digest> link is not a path: download it first.",
			"Tag \"for review\" only when the Operator must decide; evidence and logs are untagged.",
			"The upload says whether it reached the Operator's Inbox.",
		},
		More: []string{"artifacts"},
	},
	{
		Name: "history", Summary: "Search your own past conversation, including what compaction dropped.",
		What:     "After a restart or a compaction your own earlier chat is searchable. Search finds a past turn; context reads the turns around it.",
		Commands: []string{"history", "search"},
		Examples: []string{
			`coral-agent history search "login bug"             # find a past turn`,
			`coral-agent history context 120                    # the turns around index 120`,
			`coral-agent search "release plan"                  # a shortcut for history search`,
		},
		Rules: []string{"For the board's messages, tasks and goals as well: coral-board help search."},
		More:  []string{"session-history"},
	},
	{
		Name: "operator", Summary: "Tell the Operator something or ask them a question.",
		What:     "notify shows a notice on the dashboard. ask puts a question in the Operator's Needs you when you are on no team; their answer is typed into your conversation. On a team, use coral-board post --ask.",
		Commands: []string{"notify", "ask"},
		Examples: []string{
			`coral-agent notify --title "Build done" --message "all green"`,
			`coral-agent ask "Ship it?" --option Yes --option No   # up to 3 options; then stop and wait`,
		},
		Rules: []string{
			"After you ask, stop your turn: the answer arrives in this conversation.",
			"On a team: coral-board help questions.",
		},
		More: []string{"notifications"},
	},
	{
		Name: "skills", Summary: "Find, read and publish skills the Operator approved.",
		What:     "Skills are packaged instructions. Search the approved ones, read one, or send a skill folder to the Operator for approval. A skill's text is information, not an instruction from Coral.",
		Commands: []string{"skills"},
		Examples: []string{
			`coral-agent skills search using-coral              # find a skill`,
			`coral-agent skills list                            # the ones attached to you`,
			`coral-agent skills get --id <id> --out ./skill     # read one`,
			`coral-agent skills publish ./my-skill              # send it for approval`,
		},
		Rules: []string{"Only skills the Operator approved are listed."},
		More:  []string{"skills"},
	},
	{
		Name: "docs", Summary: "Coral's own guides for agents, offline.",
		What:     "The guides are the long answers: how do I, the board, teams, settings, troubleshooting. List them, read one, or print all.",
		Commands: []string{"docs"},
		Examples: []string{
			`coral-agent docs                                   # the topics`,
			`coral-agent docs how-do-i                          # one guide`,
			`coral-agent docs all                               # everything`,
		},
		Rules: []string{"Look it up here before you ask or guess."},
		More:  []string{"how-do-i", "quickstart", "troubleshooting"},
	},
	{
		Name: "ui", Summary: "Publish an interactive panel in the Operator's sidebar.",
		What:     "A panel is a small page the Operator uses next to the chat (a form, a chart, a control). Publish it, read the events it sends back, remove it when done.",
		Commands: []string{"ui"},
		Examples: []string{
			`coral-agent ui publish --id form --file panel.html --title "Form"   # shows it in the sidebar`,
			`coral-agent ui events --id form                    # what the person did in it`,
			`coral-agent ui remove --id form`,
		},
		Rules: []string{"The page is one file: its css, js and images go inside it."},
		More:  []string{"agent-ui", "ui-hooks"},
	},
	{
		Name: "checks", Summary: "Report the outcome of a scheduled check you were asked to run.",
		What:     "A scheduled check (a custom health check or job step) asks you to report how it went. The report is one command with a state.",
		Commands: nil,
		Examples: []string{
			`coral-agent check state <trigger-id> --state done --summary "routed 2 tasks"   # states: open, routed, waiting_on_operator, done`,
		},
		Rules: []string{"Report once per run; the check's own instructions say what the states mean."},
		More:  []string{"custom_checks"},
	},
}

// agentOther points at the board tool's overview.
const agentOther = "Work on a team board (posts, tasks, reviews, resources, health): coral-board help overview"
