package tunnel

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11782 (#11700, #14719): ordinary Hub artifact lists use versions=newest. The review decision may expand a legacy row with versions=all, but only through the owner-only cross-team route; team lists and other values remain refused.
func TestVersionsNewestAndLegacyAllPassOnlyOnCrossTeamList(t *testing.T) {
	teamRoute := "/api/team-artifacts"
	boardRoute := "/api/board/team-a/artifacts"
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
	for _, p := range []string{teamRoute, boardRoute} {
		for _, q := range []string{"versions=newest", "limit=50&versions=newest", "versions=newest&sort=newest&limit=5"} {
			before := reached
			require.NoError(t, get(p, q), p+"?"+q)
			assert.Equal(t, before+1, reached, "the computer answered "+p+"?"+q)
		}
		if p == teamRoute {
			for _, q := range []string{"versions=all", "team=team-a&tag=for+review&q=Plan.md&by=Writer&versions=all&limit=50"} {
				before := reached
				require.NoError(t, get(p, q), p+"?"+q)
				assert.Equal(t, before+1, reached, "the scoped legacy lookup reached the computer: "+p+"?"+q)
			}
		}
		for _, q := range []string{
			"versions=", "versions=Newest", "versions=NEWEST", "versions=newest2", "versions=newest%00", "versions=newest%20", "versions=old",
			"versions=newest&versions=newest", "versions=newest&versions=all", "versions=all&versions=newest", "versions=newest,all", "versions[]=newest", "Versions=newest",
		} {
			before := reached
			err := get(p, q)
			require.Error(t, err, p+"?"+q)
			assert.Contains(t, err.Error(), "path_not_allowed", p+"?"+q)
			assert.Equal(t, before, reached, "the computer was never asked "+p+"?"+q)
		}
		if p == boardRoute {
			before := reached
			err := get(p, "versions=all")
			require.Error(t, err, p+"?versions=all")
			assert.Contains(t, err.Error(), "path_not_allowed", p+"?versions=all")
			assert.Equal(t, before, reached, "team artifact all-versions reads remain refused")
		}
	}
	// no other list takes the word
	for _, p := range []string{"/api/artifacts", "/api/session-artifacts", "/api/saved", "/api/board/team-a/goals"} {
		err := get(p, "versions=newest")
		require.Error(t, err, p)
		assert.Contains(t, err.Error(), "path_not_allowed", p)
	}
}
