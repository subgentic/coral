package routes

import (
	"net/http"
	"regexp"
	"strings"

	"github.com/subgentic/coral/internal/cloud"
)

// An agent at a permission prompt is a Needs you item with Yes and No (#21256, coral-hub #273334: the Operator, signed in through the Hub on a phone, was never offered the answer to a Codex agent's
// `git rebase` prompt). The item carries only the prompt's ONE-TIME choices, with their real numbers, and only when there is at least one Yes and one No; a lasting grant ("Yes, and don't ask again for
// commands that start with ...", "allow all edits", "always") is never one of them. What is pressed is answered by the existing answer-prompt route, which re-reads the screen and, for a press from Needs you,
// refuses a digit whose label changed or is not one-time by THIS list (Security Reviewer's conditions on #21256). inbox_answer.js's ONE_TIME is the same list for display only: this one decides.

// oneTimeForm is a permission choice that lasts for this one answer: Yes, Allow or Approve, optionally "once", "this once", "proceed", "continue" or Antigravity's "run command"; No, Deny or Reject,
// optionally "cancel" or Codex's "and tell <CLI> what to do differently". The WHOLE label must be one of these (a trailing key hint and final punctuation dropped), so any added words fail.
var oneTimeForm = regexp.MustCompile(`(?i)^(?:(?:yes|allow|approve)(?:,? (?:once|this once|proceed|continue|run command))?|(?:no|deny|reject)(?:,? (?:cancel|and tell \w+ what to do differently))?)$`)

// keyHint is a key in brackets at the end of a label ("(y)", "(esc)"): only a key is a hint, so "(always)" or "(all projects)" stays in the label and the whole-label match fails.
var keyHint = regexp.MustCompile(`(?i)\s*\((?:[a-z]|esc|enter|tab|shift\+tab|ctrl\+[a-z])\)$`)

var (
	yesWord = regexp.MustCompile(`(?i)^(?:yes|allow|approve)\b`)
	noWord  = regexp.MustCompile(`(?i)^(?:no|deny|reject)\b`)
)

// wholeLabel is a label as the one-time match reads it: one line, the key hint and final punctuation dropped.
func wholeLabel(label string) string {
	s := strings.Join(strings.Fields(label), " ")
	s = keyHint.ReplaceAllString(s, "")
	return strings.TrimRight(s, ".! ")
}

// oneTimeChoice reports whether a permission prompt's option lasts for this one answer only.
func oneTimeChoice(label string) bool { return oneTimeForm.MatchString(wholeLabel(label)) }

// asksPermission reports whether a menu is a permission prompt: one of its options is a Yes, Allow or Approve.
func asksPermission(opts []NeedsYouOption) bool {
	for _, o := range opts {
		if yesWord.MatchString(strings.TrimSpace(o.Label)) {
			return true
		}
	}
	return false
}

// permissionOptions is what a Needs you item offers of a permission prompt's menu: its one-time options with their own numbers, or none unless that leaves at least one Yes and one No.
func permissionOptions(opts []NeedsYouOption) []NeedsYouOption {
	var out []NeedsYouOption
	yes, no := false, false
	for _, o := range opts {
		if o.N < 1 || o.N > 9 || !oneTimeChoice(o.Label) {
			continue
		}
		l := strings.TrimSpace(o.Label)
		yes = yes || yesWord.MatchString(l)
		no = no || noWord.MatchString(l)
		out = append(out, o)
	}
	if !yes || !no {
		return nil
	}
	return out
}

// needsYouPress is the press-time check of an answer sent from a Needs you item (body "from": "needs_you"), after the screen was re-read and the label matched: only the person (the dashboard, or the
// owner through a Hub with a genuine stamp) may press, and only a one-time choice. It returns the status and words of a refusal, or 0: nothing is typed on a refusal.
func needsYouPress(r *http.Request, label string) (int, string, string) {
	if !humanInputCaller(r) {
		return http.StatusForbidden, "not_the_person", "Only the person can answer this from Needs you. Open the agent to answer it."
	}
	if !oneTimeChoice(label) {
		return http.StatusConflict, "lasting_choice", "That choice lasts beyond this one answer. Answer it in the agent's own chat."
	}
	return 0, "", ""
}

// hubAutomationAtPermission: a request that came through Coral Hub WITHOUT the owner's genuine stamp (the Hub's own automation at the Interact tier) may not answer a permission prompt (Security's condition 1
// on #21256). The person through the Hub (a stamped request) and this computer's own dashboard are not affected.
func hubAutomationAtPermission(r *http.Request, screen promptScreen) bool {
	if humanInputCaller(r) {
		return false
	}
	kind, _ := r.Context().Value(callerKindKey{}).(string)
	if !cloud.Tunneled(r) && kind != callerHub && kind != callerHubOwner {
		return false
	}
	for _, o := range screen.Options {
		if yesWord.MatchString(strings.TrimSpace(o.Label)) {
			return true
		}
	}
	return false
}
