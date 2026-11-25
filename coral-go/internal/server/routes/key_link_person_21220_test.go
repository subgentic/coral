package routes

import (
	"context"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/pkg/tunnel"
)

// Security's round 1 MUST on #21220: a key link's request carries the connector's own stamp (the tunnel's rules apply to it), and it is still never the person.
func TestAKeyLinkCallerIsNeverThePerson(t *testing.T) {
	r := httptest.NewRequest("POST", "/api/sessions/live/a/answer-prompt", nil)
	r.Header.Set(tunnel.ViaHeader, cloud.ViaSecret())
	hub := r.WithContext(context.WithValue(r.Context(), callerKindKey{}, callerHub))
	key := r.WithContext(context.WithValue(r.Context(), callerKindKey{}, callerKeyLink))
	assert.True(t, humanInputCaller(hub), "a hosted Hub's own stamp is the person, as before")
	assert.False(t, humanInputCaller(key), "a key link's never is")
	rec := httptest.NewRecorder()
	assert.True(t, refuseUnlessPerson(rec, key, "answer"))
	assert.Equal(t, 403, rec.Code)

	o := &IdentityObserver{}
	o.SetHostedLinks(func(_ context.Context, id string) bool { return id == "lnk-0000aaaa" })
	tun := func(link string) string {
		q := httptest.NewRequest("GET", "/api/sessions/live", nil)
		q.Header.Set(tunnel.ViaHeader, cloud.ViaSecret())
		if link != "" {
			q.Header.Set(tunnel.LinkHeader, link)
		}
		return o.classify(q)
	}
	assert.Equal(t, callerHub, tun("lnk-0000aaaa"))
	assert.Equal(t, callerKeyLink, tun("lnk-0000bbbb"), "a key link's id")
	assert.Equal(t, callerKeyLink, tun(""), "fails closed: no link is not a hosted one")
}
