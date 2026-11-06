package server

import (
	"net/url"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/hubowner"
)

// #13761 end to end: the chat box's model switch reaches this computer through the self-hosted Hub as an API-key request. The key alone is no person (403 operator_only); the same request with a genuine stamp over
// its method, path, query and body passes the person gate; a stamp for another body is refused.
func TestTheModelSwitchThroughAStampedProxyPassesThePersonGateAndTheKeyAloneDoesNot(t *testing.T) {
	r := newE2ERemote(t, "model-hub", nil)
	setHome(t, r.dir)
	h := r.srv.Router()
	sid := r.launchDirectTerminal(t, r.work)
	name := r.sessionNameFor(sid)
	secret, err := hubowner.NewSecret()
	require.NoError(t, err)
	require.NoError(t, hubowner.WriteFile(r.cfg.CoralDir(), "model-hub", secret))
	target := "/api/sessions/live/" + name + "/model"
	body := `{"session_id":"` + sid + `","agent_type":"claude","model":"opus"}`
	stamp := func(b string) map[string]string {
		u, perr := url.Parse(target)
		require.NoError(t, perr)
		s, serr := hubowner.Sign(secret, "model-hub", "POST", hubowner.Target(u), []byte(b), time.Now())
		require.NoError(t, serr)
		return map[string]string{"Authorization": "Bearer " + r.key(), hubowner.Header: s, "Content-Type": "application/json"}
	}
	rec := bare(h, "POST", target, body, map[string]string{"Authorization": "Bearer " + r.key(), "Content-Type": "application/json"})
	assert.Equal(t, 403, rec.Code, "the key alone: %s", rec.Body.String())
	assert.Contains(t, rec.Body.String(), "operator_only")
	rec = bare(h, "POST", target, body, stamp("another body"))
	assert.Equal(t, 403, rec.Code, "a stamp for other bytes: %s", rec.Body.String())
	rec = bare(h, "POST", target, body, stamp(body))
	assert.NotContains(t, rec.Body.String(), "operator_only", "the stamped switch passes the person gate (status %d): %s", rec.Code, rec.Body.String())
}
