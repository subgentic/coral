package agent

import "strings"

// What Coral pre-approves for every Claude agent whatever its mode (#14105). An agent another agent starts is ask-first on purpose (#11713), and under ask-first every Bash call prompts, coral-board
// post included: a team that was just approved stalled on its first message to the board. The fix loosens no mode and no file or shell access: Coral writes a short list of allow rules for the
// board's own talk, one per subcommand, into the settings of the agent's own session (never ~/.claude). Security's rules for it (#14105):
//   - never the whole CLI: `coral-board heavy run -- <command>` runs any command, so Bash(coral-board *) would be an ask-first agent running arbitrary shell with no prompt;
//   - a subcommand is listed only after it was read: none of these executes anything (only heavy does), and each is bounded by the agent's own token;
//   - a new subcommand in coral-board's switch fails TestEveryCoralBoardSubcommandHasADecision until it is decided here.
//
// Claude Code matches an allow rule per command after splitting && || ; | & and newlines (every part must be allowed), and an allow rule does not match past a leading assignment of an environment variable
// it does not know. Whether an allow rule covers a command substitution inside an allowed command's arguments is not in its documentation, so ask rules for $( and ` and <( and >( go with them: an ask
// rule is checked against the nested commands too, and it outranks an allow.
var coralBoardPreApproved = map[string]string{
	"post":   "writes a message to a board; the agent's own token, the board's own rules",
	"read":   "reads a board's messages",
	"task":   "the task queue's own commands (claim, submit, post on a task): the server decides what a token may do",
	"goal":   "the goal commands: the server decides what a token may do",
	"wait":   "the worker prompt tells agents to wait on the board: one server call (poll or cancel), no command run and no file or path read (Security, #14105)",
	"status": "one GET of the board's health, printed: no command run and no file or path read (Security, #14105)",
}

// coralBoardNotPreApproved is every other subcommand and why it still prompts. The reasons are the reviewer's words, not a promise about what each does.
var coralBoardNotPreApproved = map[string]string{
	"join":         "Security (#14105): not pre-approved; joining a board is a prompt",
	"heavy":        "runs ANY command on a machine, under a queue slot: never pre-approved",
	"resource":     "claims a machine slot: a prompt is fine",
	"send":         "types into another agent's terminal",
	"wake":         "wakes another agent",
	"sleep":        "puts another agent to sleep",
	"delete":       "deletes a board",
	"leave":        "leaves a board",
	"export":       "reads and writes a file path",
	"workflow":     "reads a workflow file; workflows run commands server-side",
	"settings":     "changes settings",
	"link":         "links boards across teams",
	"unlink":       "unlinks boards",
	"links":        "not decided: reads cross-team links; ask-first until a reviewer reads it",
	"search":       "not decided: ask-first until a reviewer reads it",
	"check":        "not decided: ask-first until a reviewer reads it",
	"projects":     "not decided: ask-first until a reviewer reads it",
	"subscribers":  "not decided: ask-first until a reviewer reads it",
	"working-mode": "changes a team's working mode",
	"reviewer":     "changes who reviews",
	"seats":        "not decided: ask-first until a reviewer reads it",
	"peek":         "reads another agent's screen",
	"waiting":      "not decided: ask-first until a reviewer reads it",
	"ask":          "asks the Operator: not decided, ask-first until a reviewer reads it",
	"health":       "not decided: ask-first until a reviewer reads it",
	"queue":        "not decided: ask-first until a reviewer reads it",
	"targets":      "not decided: ask-first until a reviewer reads it",
}

// coralBoardBaselineRules are the allow rules (one per pre-approved subcommand, with and without arguments) and the ask rules that keep a substitution out of them.
func coralBoardBaselineRules() (allow, ask []string) {
	subs := make([]string, 0, len(coralBoardPreApproved))
	for s := range coralBoardPreApproved {
		subs = append(subs, s)
	}
	sortStrings(subs)
	for _, s := range subs {
		allow = append(allow, "Bash(coral-board "+s+")", "Bash(coral-board "+s+" *)")
	}
	ask = []string{"Bash(coral-board *$(*)", "Bash(coral-board *`*)", "Bash(coral-board *<(*)", "Bash(coral-board *>(*)"}
	return allow, ask
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && strings.Compare(s[j-1], s[j]) > 0; j-- {
			s[j-1], s[j] = s[j], s[j-1]
		}
	}
}

// mergeRules adds rules to list, once each.
func mergeRules(list, add []string) []string {
	seen := map[string]bool{}
	for _, r := range list {
		seen[r] = true
	}
	for _, r := range add {
		if !seen[r] {
			list = append(list, r)
			seen[r] = true
		}
	}
	return list
}
