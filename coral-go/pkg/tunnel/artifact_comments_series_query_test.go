package tunnel

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13502: the dashboard's shell reads a file's comments with series=1 (artifact_comments_api.js: the earlier versions' comments, marked) and the handler reads it, but the table did not list it, so through Coral Hub every
// click on a file in the Inbox ended in "path_not_allowed". The shell's exact query passes; the same names with another value, a repeat or a stray parameter still do not.
func TestTheCommentsReadWithSeriesPassesTheConnector(t *testing.T) {
	const path = "/api/artifacts/" + "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" + "/comments"
	reached := 0
	hub := newHub(t, fastCfg())
	sess, _ := connect(t, hub, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"comments":[]}`))
	}), func(l *LocalHandler) {
		l.MaxMode = func() Mode { return TierView }
		l.AllowPath = nil
		l.AllowRequest = AllowRequest(func() Mode { return TierView })
	})
	get := func(q string) error {
		req, _ := http.NewRequest("GET", "http://x"+path+"?"+q, nil)
		resp, err := sess.RoundTrip(req)
		if err == nil {
			resp.Body.Close()
		}
		return err
	}
	for _, q := range []string{"state=all", "state=all&board=team-a", "state=all&series=1", "state=all&board=team-a&series=1"} { // what listComments sends, with and without a team and the series flag
		before := reached
		require.NoError(t, get(q), q)
		assert.Equal(t, before+1, reached, "the computer answered ?"+q)
	}
	for _, q := range []string{"state=all&series=2", "state=all&series=", "state=all&series=1&series=1", "state=all&Series=1", "state=all&series=1&extra=1"} {
		before := reached
		err := get(q)
		if err == nil {
			assert.Equal(t, before, reached, "the computer was never asked ?"+q)
			continue
		}
		assert.Contains(t, err.Error(), "path_not_allowed", q)
		assert.Equal(t, before, reached, "the computer was never asked ?"+q)
	}
}
