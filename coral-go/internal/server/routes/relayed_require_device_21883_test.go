package routes

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/devicekey"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #21883: with "Require a trusted device for Hub actions" on, the guard refuses a request on any listed route that carries no signature, 403 device_required, before any handler. These call the guard directly, so each
// refusal fails a test when only it is removed.

type emptyStore struct{ devicekey.Store }

func (emptyStore) ActiveDeviceKey(context.Context, string, time.Time) (store.DeviceKey, error) {
	return store.DeviceKey{}, errors.New("no such key")
}

func concreteTarget(r devicekey.Route, k devicekey.Kind) string {
	t := strings.NewReplacer("{project}", "team1", "{name}", "agent1", "{id}", "id1").Replace(r.Pattern)
	switch k {
	case devicekey.HubAutoAccept:
		t += "?allow=true"
	case devicekey.AllowLink, devicekey.MakeLinkKey:
		t += "?box_pk=" + rlBox
	}
	return t
}

func guardRunFor(on bool, method, target string, headers map[string]string) (rec *httptest.ResponseRecorder, reached bool) {
	g := RelayedGuard(func() *devicekey.Verifier { return &devicekey.Verifier{Store: emptyStore{}} }, func(context.Context) (string, error) { return rlOwner, nil }, func(context.Context) bool { return on })
	r := httptest.NewRequest(method, target, strings.NewReader("{}"))
	stamp(r)
	r = r.WithContext(cloud.WithVia(r.Context(), cloud.Via{LinkID: rlLink, HubUser: rlOwner}))
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	rec = httptest.NewRecorder()
	g(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached = true })).ServeHTTP(rec, r)
	return rec, reached
}

func TestWithTheSwitchOnEveryListedKindUnsignedIsRefusedDeviceRequired(t *testing.T) {
	n := 0
	for _, k := range devicekey.RelayedKinds {
		for _, rt := range devicekey.KindRoutes[k] {
			n++
			rec, reached := guardRunFor(true, rt.Method, concreteTarget(rt, k), nil)
			assert.False(t, reached, "%s %s must not reach the handler", rt.Method, rt.Pattern)
			want, status := "device_required", http.StatusForbidden
			if relayedRequired[k] {
				want, status = "bad_form", http.StatusBadRequest // the kinds that were always required keep their own refusal
			}
			assert.Equal(t, status, rec.Code, "%s %s", rt.Method, rt.Pattern)
			assert.Contains(t, rec.Body.String(), want, "%s %s", rt.Method, rt.Pattern)
		}
	}
	require.Greater(t, n, 15, "the table was read")
}

func TestWithTheSwitchOffAnUnsignedListedRequestIsUntouched(t *testing.T) {
	for _, k := range devicekey.RelayedKinds {
		if relayedRequired[k] {
			continue
		}
		for _, rt := range devicekey.KindRoutes[k] {
			_, reached := guardRunFor(false, rt.Method, concreteTarget(rt, k), nil)
			assert.True(t, reached, "%s %s", rt.Method, rt.Pattern)
		}
	}
}

func TestTheSwitchLeavesAReadAndAnUnlistedRouteAlone(t *testing.T) {
	_, reached := guardRunFor(true, "GET", "/api/sessions/live/agent1/send", nil)
	assert.True(t, reached, "a read of a listed path")
	_, reached = guardRunFor(true, "POST", "/api/not/a/listed/route", nil)
	assert.False(t, reached, "an unlisted write is the generic hub-write kind: unsigned it is refused")
}

func TestWithTheSwitchOnAHalfSetOfHeadersIsStillBadForm(t *testing.T) {
	rec, reached := guardRunFor(true, "POST", "/api/sessions/live/agent1/send", map[string]string{tunnel.DeviceKeyHeader: "x"})
	assert.False(t, reached)
	assert.Contains(t, rec.Body.String(), "bad_form")
}
