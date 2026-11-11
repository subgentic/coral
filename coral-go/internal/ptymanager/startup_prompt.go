package ptymanager

import "strings"

// A just-launched agent can wait on a prompt its CLI draws before any hook runs (#4543): Codex's directory
// trust and hook review and its update offer, Claude Code's folder trust and custom API key questions. No
// event says so, so the session looked ready while the agent was blocked; the screen is what tells.
const (
	StartupTrust  = "startup_trust"  // a folder, directory or hooks trust question
	StartupUpdate = "cli_update"     // the CLI offers an update before it starts
	StartupPrompt = "startup_prompt" // another question at launch (Claude's custom API key)
)

// StartupPromptOnScreen is the reason a prompt open on screen holds an agent that has sent no event yet,
// or "" when no prompt holds it.
func StartupPromptOnScreen(screen string) string {
	open, why := PromptOnScreen(screen)
	if !open || !isPromptHold(why) || isDialogHold(why) {
		return ""
	}
	text := strings.ToLower(strings.Join(tailLines(screenText(screen), 25), "\n"))
	switch {
	case strings.Contains(text, "update available"):
		return StartupUpdate
	case strings.Contains(text, "trust"):
		return StartupTrust
	}
	return StartupPrompt
}

// CodexHooksReviewOnScreen reports whether Codex's hooks-review dialog is open ("Hooks need review: N hooks are new or changed ... 1. Review
// hooks / 2. Trust all and continue / 3. Continue without trusting"). Codex draws it when Coral gives it its hooks on the command line, and until
// the person answers it the hooks do not run. It is a question about running code outside Codex's sandbox: a message is never typed into it as
// if it were an answer, and only the person answers it. The stable words are matched, not the version or the count of hooks.
func CodexHooksReviewOnScreen(screen string) bool {
	if open, _ := PromptOnScreen(screen); !open {
		return false
	}
	text := strings.ToLower(strings.Join(strings.Fields(strings.Join(tailLines(screenText(screen), 25), " ")), " "))
	return strings.Contains(text, "new or changed") && strings.Contains(text, "hook") &&
		(strings.Contains(text, "trust all and continue") || strings.Contains(text, "review hooks") || strings.Contains(text, "hooks need review"))
}

// CodexRateLimitNoticeOnScreen reports whether Codex's "Approaching rate limits" notice is open ("Switch to <model> for lower credit usage? 1. Switch to <model> 2. Keep current model 3. Keep current model
// (never show again)", #15485). Codex draws it after its hooks have started, on an idle agent, so no event says so and Coral's send is held behind it: the screen is what tells. Found by its stable words and its
// three numbered rows, as the answer path does (routes.rateLimitNotice): any other menu is not it. It never answers: the choice is the person's (a switch changes the model, the third stops the reminder for good).
func CodexRateLimitNoticeOnScreen(screen string) bool {
	if open, _ := PromptOnScreen(screen); !open {
		return false
	}
	text := strings.ToLower(strings.Join(strings.Fields(strings.Join(tailLines(screenText(screen), 25), " ")), " "))
	return strings.Contains(text, "approaching rate limits") && strings.Contains(text, "1. switch to ") && strings.Contains(text, "2. keep current model") && strings.Contains(text, "3. keep current model (never show again)")
}
