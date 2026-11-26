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

// CodexFullAccessConfirmOnScreen reports whether Codex's "Enable full access?" confirmation is open (Codex 0.172, #21677): the second dialog a person meets after choosing Full Access in Codex's own /permissions picker ("Enable full access? When
// Codex runs with full access, it can edit any file on your computer and run commands with network, without your approval ... 1. Yes, continue anyway 2. Cancel"). No event says so, and Coral's send is held behind it: the screen is what
// tells. It never answers: widening what an agent may do is the person's choice, and a message is never typed into it as if it were an answer. Found by its stable words and its two numbered rows, not the version.
func CodexFullAccessConfirmOnScreen(screen string) bool {
	// Not PromptOnScreen: Codex draws this dialog indented, with its composer still drawn under it and the footer "enter select · esc back", none of which the generic menu read takes for a prompt. The cursor on
	// one of its two rows is what says it is open, and not a reply that quotes the words.
	lines := tailLines(screenText(screen), 25)
	text := strings.ToLower(strings.Join(strings.Fields(strings.Join(lines, " ")), " "))
	if !strings.Contains(text, "enable full access?") || !strings.Contains(text, "1. yes, continue anyway") || !strings.Contains(text, "2. cancel") {
		return false
	}
	for _, l := range lines {
		t := strings.TrimSpace(l)
		if strings.HasPrefix(t, "› 1.") || strings.HasPrefix(t, "› 2.") || strings.HasPrefix(t, "> 1.") || strings.HasPrefix(t, "> 2.") {
			return true
		}
	}
	return false
}
