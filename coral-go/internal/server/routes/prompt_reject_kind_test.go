package routes

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/opencode"
)

// #11407 (Security's INFO 5 on #11399): the only_reject refusal is decided from an option's parsed KIND where it has one, and from its label only where it has none.

func TestAnOptionThatAllowsIsNotARejectWhateverItsWordsBeginWith(t *testing.T) {
	for _, o := range []promptOption{
		{Label: "No, allow it", Kind: "allow_once"},
		{Label: "No problem: always", Kind: "allow_always"},
		{Label: "Cancel the wait and run it", Kind: "allow_once"},
		{Label: "Deny nothing", Kind: "allow_always"},
	} {
		assert.False(t, optionIsReject(o), "kind %s with the label %q allows: it is no reject", o.Kind, o.Label)
	}
	assert.True(t, optionIsReject(promptOption{Label: "Allow", Kind: "reject"}), "an option the parser knows refuses, whatever its words say")
}

func TestAnOptionWithNoKindIsJudgedByItsLabel(t *testing.T) {
	for _, label := range []string{"No", "no", "No, and tell Codex what to do differently (esc)", "Reject", "Deny", "Cancel", "Not now", "Decline", "Don't allow", "  No  "} {
		assert.True(t, optionIsReject(promptOption{Label: label}), label)
	}
	for _, label := range []string{"None", "Nothing", "Nope", "Notify me", "Yes", "Yes, and don't ask again", "Allow once", ""} {
		assert.False(t, optionIsReject(promptOption{Label: label}), "%q is not a reject", label)
	}
}

// The approval table gives the approve-once option its kind, so a recognised approval's allow cannot be mistaken for a reject by its words.
func TestTheApprovalTableMarksTheApproveOnceOption(t *testing.T) {
	s, ok := parsePromptScreen(screenPermission)
	require.True(t, ok)
	markApprovalKinds(at.Claude, screenPermission, &s)
	kinds := map[int]string{}
	for _, o := range s.Options {
		kinds[o.N] = o.Kind
	}
	assert.Equal(t, "allow_once", kinds[1], "the approve-once option")
	// the other rows carry their kinds too (#11399): the Yes rows that last past this answer, and the refusal, so the card does not rest on their words
	assert.Equal(t, "allow_always", kinds[2])
	assert.Equal(t, "allow_always", kinds[3])
	assert.Equal(t, "reject", kinds[4])
	for _, o := range s.Options {
		if o.Kind == "allow_once" {
			o.Label = "No, go ahead" // words that look like a refusal on an option the table knows allows
			assert.False(t, optionIsReject(o))
		}
	}
	// a screen that is not an approval is left alone
	plain, ok := parsePromptScreen(screenQuestion)
	if ok {
		markApprovalKinds(at.Claude, screenQuestion, &plain)
		for _, o := range plain.Options {
			assert.Empty(t, o.Kind, "a question's options have no kind")
		}
	}
}

// The opencode card's own answers carry their kind: Allow once, Allow always and Reject, and a request that cannot be allowed has Reject alone.
func TestAnOpencodeCardsAnswersCarryTheirKind(t *testing.T) {
	allowed := opencode.PermissionRequest{Permission: "bash", Patterns: []string{"go test"}, Always: []string{"go test"}}
	if !allowed.Allowed() {
		t.Skip("the fixture request is not one that can be allowed")
	}
	var kinds []string
	for _, o := range opencodeCardOptions(allowed) {
		kinds = append(kinds, opencodeKind(o.Reply))
	}
	assert.Equal(t, []string{"allow_once", "allow_always", "reject"}, kinds)
	assert.Empty(t, opencodeKind("something else"))
	for _, k := range kinds[:2] {
		assert.False(t, optionIsReject(promptOption{Label: "No, do it", Kind: k}), "an allowing answer is no reject whatever its label says")
	}
}
