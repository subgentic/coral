package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/pkg/tunnel"
)

// #16032: a send, keys or answer-prompt through Coral Hub is typed only when the server the hub routed it to is this one.
func TestHubTargetGuardRefusesARequestRoutedToAnotherComputer(t *testing.T) {
	reached := 0
	h := HubTargetGuard(func(context.Context) (string, error) { return "srv-own", nil })(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached++ }))
	do := func(via bool, names ...string) int {
		req := httptest.NewRequest("POST", "/api/sessions/live/worktree1/send", nil)
		if via {
			req.Header.Set(tunnel.ViaHeader, "1")
		}
		for _, n := range names {
			req.Header.Add(tunnel.HubServerHeader, n)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		return w.Code
	}
	assert.Equal(t, 409, do(true, "srv-other"), "another computer's id")
	assert.Equal(t, 409, do(true, ""), "an empty id")
	assert.Equal(t, 409, do(true, "srv-own", "srv-own"), "a repeated header is not read as either")
	assert.Equal(t, 0, reached, "something was typed for a request routed elsewhere")
	assert.Equal(t, 200, do(true, "srv-own"))
	assert.Equal(t, 200, do(true, " SRV-own "), "the id is compared the way the link list compares it")
	assert.Equal(t, 200, do(true), "a hub that does not name the server yet is not broken")
	assert.Equal(t, 200, do(false, "srv-other"), "a request that did not come through the hub is not read for the header")
	assert.Equal(t, 4, reached)

	// a computer that does not know its own id cannot confirm the one named
	h2 := HubTargetGuard(func(context.Context) (string, error) { return "", nil })(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached++ }))
	req := httptest.NewRequest("POST", "/api/sessions/live/worktree1/send", nil)
	req.Header.Set(tunnel.ViaHeader, "1")
	req.Header.Set(tunnel.HubServerHeader, "srv-own")
	w := httptest.NewRecorder()
	h2.ServeHTTP(w, req)
	assert.Equal(t, 409, w.Code)
	assert.Equal(t, 4, reached)
}
