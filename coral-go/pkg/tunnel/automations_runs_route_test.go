package tunnel

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/redact"
)

// Recent runs as pages through Coral Hub (#13183, QA Reviewer 2's MUST): GET /api/automations/runs is a View route like the two reads it replaced (/api/scheduled/runs/recent, /api/workflows/runs/recent), and a viewer's
// reply is redacted like theirs: the runs carry a job's prompt and what its steps wrote, where a token can sit. Before it was listed the Hub refused it and the page showed 'Try again' with no rows.
func TestTheRecentRunsPageIsAViewRouteAndItsRowsAreRedacted(t *testing.T) {
	const path = "/api/automations/runs"
	assert.Equal(t, TierView, Classify(http.MethodGet, path, ""))
	assert.Equal(t, TierView, Classify(http.MethodGet, path, "limit=50&cursor=abc&q=nightly&result=failed&unread=true"), "its own query words pass")
	assert.Equal(t, TierNever, Classify(http.MethodGet, path, "evil=1"), "a word it does not read is refused")
	for _, m := range []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete} {
		assert.Equal(t, TierNever, Classify(m, path, ""), "only GET: "+m)
	}
	assert.Equal(t, TierNever, Classify(http.MethodGet, path+"/more", ""))
	assert.Contains(t, RedactionClass(http.MethodGet, path), "redact", "a View route is redacted unless it is on the exempt list")
	assert.NotContains(t, RedactionClass(http.MethodGet, path), "exempt")

	tok := fake("ghp_", 36, alnum)
	local := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == path {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"runs":[{"kind":"job","id":1,"output":"export GITHUB_TOKEN=` + tok + `"}],"has_more":false,"total":1}`))
			return
		}
		http.NotFound(w, r)
	})
	hub := newHub(t, fastCfg())
	sess, _ := connect(t, hub, local, func(l *LocalHandler) {
		l.AllowRequest = AllowRequest(func() Mode { return TierView })
		l.MaxMode = func() Mode { return TierView }
		l.RedactTokens = func() bool { return true }
	})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(WithHubTier(ctx, "view"), http.MethodGet, "http://x"+path+"?limit=50", nil)
	resp, err := sess.RoundTrip(req)
	require.NoError(t, err, "a viewer's read of the page is allowed through the Hub")
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	assert.Equal(t, 200, resp.StatusCode)
	assert.NotContains(t, string(b), tok, "the run's text is redacted for a viewer")
	assert.True(t, strings.Contains(string(b), redact.Marker), "the redaction marker is in its place: "+string(b))
}
