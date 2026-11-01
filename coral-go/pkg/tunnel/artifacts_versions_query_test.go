package tunnel

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11782 (#11700): the Hub asks for the artifact lists one row per file with versions=newest, on the cross-team list and the team's own. Only that exact word passes: the handler also
// takes "all", but the Hub has no need of it, and any other value, a second versions, or a repeat of the word is refused before the computer is asked.
func TestVersionsNewestPassesTheArtifactListsThroughTheConnector(t *testing.T) {
	routes := []string{"/api/team-artifacts", "/api/board/team-a/artifacts"}
	reached := 0
	hub := newHub(t, fastCfg())
	sess, _ := connect(t, hub, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"items":[]}`))
	}), func(l *LocalHandler) {
		l.MaxMode = func() Mode { return TierView }
		l.AllowPath = nil
		l.AllowRequest = AllowRequest(func() Mode { return TierView })
	})
	get := func(path, q string) error {
		req, _ := http.NewRequest("GET", "http://x"+path+"?"+q, nil)
		resp, err := sess.RoundTrip(req)
		if err == nil {
			resp.Body.Close()
		}
		return err
	}
	for _, p := range routes {
		for _, q := range []string{"versions=newest", "limit=50&versions=newest", "versions=newest&sort=newest&limit=5"} {
			before := reached
			require.NoError(t, get(p, q), p+"?"+q)
			assert.Equal(t, before+1, reached, "the computer answered "+p+"?"+q)
		}
		for _, q := range []string{
			"versions=all", "versions=", "versions=Newest", "versions=NEWEST", "versions=newest2", "versions=newest%00", "versions=newest%20", "versions=old",
			"versions=newest&versions=newest", "versions=newest&versions=all", "versions=all&versions=newest", "versions=newest,all", "versions[]=newest", "Versions=newest",
		} {
			before := reached
			err := get(p, q)
			require.Error(t, err, p+"?"+q)
			assert.Contains(t, err.Error(), "path_not_allowed", p+"?"+q)
			assert.Equal(t, before, reached, "the computer was never asked "+p+"?"+q)
		}
	}
	// no other list takes the word
	for _, p := range []string{"/api/artifacts", "/api/session-artifacts", "/api/saved", "/api/board/team-a/goals"} {
		err := get(p, "versions=newest")
		require.Error(t, err, p)
		assert.Contains(t, err.Error(), "path_not_allowed", p)
	}
}
