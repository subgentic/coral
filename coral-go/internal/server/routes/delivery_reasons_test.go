package routes

import (
	"os"
	"regexp"
	"sort"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The reasons a comment's delivery (and the one-call Request changes answer built on it) can give, pinned (#13976, for coral-hub's closed list): a new reason fails this test until coral-hub is told. The words are
// read out of the source that makes them, so the list cannot drift from the code unnoticed.
//
// On a 200 of the one-call answer the field "reason" is one of the seven below; "failed" and "redaction_unavailable" never reach it (they undo the decision and answer 5xx agent_not_told), and "not_for_review" named in
// a comment of autoDelivery is no reason anything gives.
var deliveryReasonsOn200 = []string{"already_sent", "ambiguous_uploader", "asleep_or_gone", "board_paused", "no_uploader", "not_owner", "rate_limited"}

// deliveryReasonsThatUndo are the reasons a delivery can give that the one-call answer turns into a 5xx and a rollback.
var deliveryReasonsThatUndo = []string{"failed", "redaction_unavailable"}

// changeAnswerErrorCodes are the codes of the one-call answer's refusals, 4xx and 5xx (changeWordsError codes, the review route's own, and the 409 of a delivery in progress).
var changeAnswerErrorCodes = []string{"agent_not_told", "already_in_progress", "comments_forbidden", "images_not_in_this_slice", "owner_identity_unavailable", "owner_only", "redaction_unavailable", "sign_in_link", "text_only_for_changes", "text_too_long", "too_many_comments", "words_unavailable"}

func sourceWords(t *testing.T, file string, res ...*regexp.Regexp) []string {
	t.Helper()
	b, err := os.ReadFile(file)
	require.NoError(t, err)
	seen := map[string]bool{}
	for _, re := range res {
		for _, m := range re.FindAllStringSubmatch(string(b), -1) {
			seen[m[1]] = true
		}
	}
	var out []string
	for w := range seen {
		out = append(out, w)
	}
	sort.Strings(out)
	return out
}

func TestTheDeliveryReasonsAreTheClosedListCoralHubIsTold(t *testing.T) {
	made := regexp.MustCompile(`autoDelivery\{Reason: "([a-z_]+)"\}`)
	first := regexp.MustCompile(`firstReason\([a-z]+, "([a-z_]+)"\)`)
	plain := regexp.MustCompile(`return false, "([a-z_]+)"`)
	var all []string
	for _, f := range []string{"artifact_comment_auto.go", "no_team_notice.go", "team_artifact_changes.go"} {
		all = append(all, sourceWords(t, f, made, first, plain)...)
	}
	set := map[string]bool{}
	for _, w := range all {
		set[w] = true
	}
	var got []string
	for w := range set {
		got = append(got, w)
	}
	sort.Strings(got)
	want := append(append([]string{}, deliveryReasonsOn200...), deliveryReasonsThatUndo...)
	sort.Strings(want)
	assert.Equal(t, want, got, "a delivery reason was added or removed: tell coral-hub, then update this list (deliveryReasonsOn200, deliveryReasonsThatUndo)")
}

func TestTheOneCallAnswersRefusalCodesAreTheClosedList(t *testing.T) {
	code := regexp.MustCompile(`&changeWordsError\{http\.Status[A-Za-z]+, "([a-z_]+)"`)
	review := regexp.MustCompile(`commentRefuse\(w, http\.Status[A-Za-z]+, "(images_not_in_this_slice|text_only_for_changes)"`)
	got := sourceWords(t, "team_artifact_changes.go", code)
	got = append(got, sourceWords(t, "team_artifact_review.go", review)...)
	set := map[string]bool{}
	for _, w := range got {
		set[w] = true
	}
	var uniq []string
	for w := range set {
		uniq = append(uniq, w)
	}
	sort.Strings(uniq)
	assert.Equal(t, changeAnswerErrorCodes, uniq, "a refusal code of the one-call answer was added or removed: tell coral-hub, then update changeAnswerErrorCodes")
}
