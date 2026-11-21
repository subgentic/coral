package tunnel

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #20061 (coral-hub's #253742): the goal thread's read through the Hub is ONE owner-read row, GET /api/artifacts/{goal}/comments. It matches the key goal:<team>:<n> and nothing else, takes board and state and no
// series, is the owner's alone, and carries no diff row and no write.
func TestTheGoalThreadReadIsOneOwnerRowForThatKeyAlone(t *testing.T) {
	const key = "goal:team-a:12"
	read := "/api/artifacts/" + key + "/comments"
	assert.Equal(t, TierView, Classify("GET", read, ""))
	assert.Equal(t, TierView, Classify("GET", read, "state=all&board=team-a"))
	assert.Equal(t, TierView, Classify("GET", read, "state=open"))
	pattern, mode := OwnerRoute("GET", read)
	assert.Equal(t, "/api/artifacts/{goal}/comments", pattern)
	assert.Equal(t, OwnerRefuse, mode, "the owner's alone: the machine refuses anyone else")

	// board and state only: no series (a goal has no versions), nothing else.
	for _, q := range []string{"series=1", "state=all&series=1", "extra=1"} {
		assert.Equal(t, TierNever, Classify("GET", read, q), "?"+q)
	}

	// Not a diff thread, not a digest, not a malformed key: the shape is that one key.
	digest := strings.Repeat("a", 64)
	for _, p := range []string{
		"/api/artifacts/diff:team-a:12/comments", "/api/artifacts/diff:" + digest + ":a.go/comments",
		"/api/artifacts/goal:team-a:0/comments", "/api/artifacts/goal:team-a:012/comments", "/api/artifacts/goal:team-a:1:2/comments", "/api/artifacts/goal::1/comments",
		"/api/artifacts/goal:../x:1/comments", "/api/artifacts/goal:team-a:12x/comments", "/api/artifacts/goal:team-a:12345678901/comments", "/api/artifacts/GOAL:team-a:12/comments",
		"/api/artifacts/goal:team-a:12/comments/1", "/api/artifacts/goal:team-a:12", "/api/artifacts/goal:team-a:12/meta", "/api/artifacts/goal:team-a:12/versions",
	} {
		assert.Equal(t, TierNever, Classify("GET", p, ""), p)
		if _, m := OwnerRoute("GET", p); m != OwnerNone {
			t.Errorf("%s has an owner row (%v)", p, m)
		}
	}
	// A digest keeps its own row and its own query (series is still the artifact read's).
	assert.Equal(t, TierView, Classify("GET", "/api/artifacts/"+digest+"/comments", "series=1&state=all"))

	// No write on the goal key, through any method and any of the thread's routes.
	for _, m := range []string{"POST", "PUT", "PATCH", "DELETE"} {
		for _, p := range []string{read, read + "/lock", "/api/artifacts/" + key + "/comments/1", "/api/artifacts/" + key + "/comments/1/resolve", "/api/artifacts/" + key + "/comments/1/send"} {
			assert.Equal(t, TierNever, Classify(m, p, ""), m+" "+p)
		}
	}
}
