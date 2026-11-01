package tunnel

import (
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11845 (#11836): the viewer's Open in new tab links the artifact with open=1 so a file on another computer opens as a readable tab instead of downloading. Through the connector the content route takes
// exactly that, next to the link form v=2 and alone: any other value, a repeat, another case or another route is refused before the computer is asked.
func TestOpenOnePassesTheArtifactContentThroughTheConnector(t *testing.T) {
	hex := strings.Repeat("ab", 32)
	content := "/api/artifacts/" + hex
	reached := 0
	hub := newHub(t, fastCfg())
	sess, _ := connect(t, hub, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached++
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("hello"))
	}), func(l *LocalHandler) {
		l.MaxMode = func() Mode { return TierView }
		l.AllowPath = nil
		l.AllowRequest = AllowRequest(func() Mode { return TierView })
	})
	get := func(path, q string) error {
		u := "http://x" + path
		if q != "" {
			u += "?" + q
		}
		req, _ := http.NewRequest("GET", u, nil)
		resp, err := sess.RoundTrip(req)
		if err == nil {
			resp.Body.Close()
		}
		return err
	}
	for _, q := range []string{"v=2&open=1", "open=1&v=2", "open=1", "v=2"} {
		before := reached
		require.NoError(t, get(content, q), q)
		assert.Equal(t, before+1, reached, "the computer answered ?"+q)
	}
	for _, q := range []string{
		"open=0", "open=2", "open=", "open=true", "open=1%00", "open=1%20", "open=01", "open=1&open=1", "open=1&open=0", "Open=1", "open[]=1", "v=2&open=1&x=1", "v=3&open=1", "open=1&v=2&v=2",
	} {
		before := reached
		err := get(content, q)
		require.Error(t, err, q)
		assert.Contains(t, err.Error(), "path_not_allowed", q)
		assert.Equal(t, before, reached, "the computer was never asked ?"+q)
	}
	// no other route takes the word
	for _, p := range []string{content + "/meta", content + "/comments", "/api/artifacts", "/api/session-artifacts"} {
		err := get(p, "open=1")
		require.Error(t, err, p)
		assert.Contains(t, err.Error(), "path_not_allowed", p)
	}
}
