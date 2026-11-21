package tunnel

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #20255 (coral-hub's #256214): the diff thread's read through the Hub is ONE owner-read row, GET /api/artifacts/{diff}/comments. It matches the key diff:<team>:<session>:<16 hex> and nothing else (never a goal: key
// or a digest), takes board and state and no series, is the owner's alone, and carries no write.
func TestTheDiffThreadReadIsOneOwnerRowForThatKeyAlone(t *testing.T) {
	const key = "diff:team-a:agent-12345:0123456789abcdef"
	read := "/api/artifacts/" + key + "/comments"
	assert.Equal(t, TierView, Classify("GET", read, ""))
	assert.Equal(t, TierView, Classify("GET", read, "state=all&board=team-a"))
	pattern, mode := OwnerRoute("GET", read)
	assert.Equal(t, "/api/artifacts/{diff}/comments", pattern)
	assert.Equal(t, OwnerRefuse, mode, "the owner's alone: the machine refuses anyone else")

	for _, q := range []string{"series=1", "state=all&series=1", "extra=1"} {
		assert.Equal(t, TierNever, Classify("GET", read, q), "?"+q)
	}

	digest := strings.Repeat("a", 64)
	for _, p := range []string{
		"/api/artifacts/diff:team-a:12/comments", "/api/artifacts/diff:team-a:agent-12345/comments",
		"/api/artifacts/diff:team-a:agent-12345:0123456789abcde/comments", "/api/artifacts/diff:team-a:agent-12345:0123456789abcdeg/comments", "/api/artifacts/diff:team-a:agent-12345:0123456789ABCDEF/comments",
		"/api/artifacts/diff:team-a:agent-12345:0123456789abcdef0/comments", "/api/artifacts/diff:team-a:agent:0123456789abcdef/comments", "/api/artifacts/diff:../x:agent-12345:0123456789abcdef/comments",
		"/api/artifacts/diff::agent-12345:0123456789abcdef/comments", "/api/artifacts/DIFF:team-a:agent-12345:0123456789abcdef/comments", "/api/artifacts/diff:team-a:agent-12345:0123456789abcdef:x/comments",
		"/api/artifacts/diff:" + digest + ":a.go/comments",
		read + "/1", "/api/artifacts/" + key, "/api/artifacts/" + key + "/meta", "/api/artifacts/" + key + "/versions",
	} {
		assert.Equal(t, TierNever, Classify("GET", p, ""), p)
		if _, m := OwnerRoute("GET", p); m != OwnerNone {
			t.Errorf("%s has an owner row (%v)", p, m)
		}
	}
	// A goal key keeps the goal row, never this one.
	gp, _ := OwnerRoute("GET", "/api/artifacts/goal:team-a:12/comments")
	assert.Equal(t, "/api/artifacts/{goal}/comments", gp)
	// The digest and goal rows keep their own queries.
	assert.Equal(t, TierView, Classify("GET", "/api/artifacts/"+digest+"/comments", "series=1&state=all"))
	assert.Equal(t, TierNever, Classify("GET", "/api/artifacts/goal:team-a:12/comments", "series=1"))

	for _, m := range []string{"POST", "PUT", "PATCH", "DELETE"} {
		for _, p := range []string{read, read + "/lock", "/api/artifacts/" + key + "/comments/1", "/api/artifacts/" + key + "/comments/1/resolve", "/api/artifacts/" + key + "/comments/1/send"} {
			assert.Equal(t, TierNever, Classify(m, p, ""), m+" "+p)
		}
	}
}
