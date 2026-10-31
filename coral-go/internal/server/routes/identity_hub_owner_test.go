package routes

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store/storetest"
	"github.com/subgentic/coral/pkg/hubowner"
)

const (
	stampRoute  = "/api/board/team/artifacts/abc123/review"
	stampSecret = "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"
)

type stampRig struct {
	o    *IdentityObserver
	dir  string
	h    http.Handler
	seen struct {
		human bool
		body  string
		kind  string
		ran   bool
	}
}

// newStampRig is the real identity observer in front of a handler that reports whether it saw a person. The API key is "valid" for any bearer; cookie says whether a dashboard session is signed in.
func newStampRig(t *testing.T, install bool) *stampRig {
	t.Helper()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "s.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	rig := &stampRig{dir: t.TempDir()}
	rig.o = NewIdentityObserver(db, nil, func(*http.Request) bool { return false })
	rig.o.SetVerifiers(func(*http.Request) bool { return true }, nil)
	rig.o.SetHubOwnerDir(rig.dir, time.Now().Add(-time.Hour))
	if install {
		require.NoError(t, hubowner.WriteFile(rig.dir, "ssh-box", stampSecret))
	}
	rig.h = rig.o.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		rig.seen.ran, rig.seen.human, rig.seen.body = true, humanInputCaller(r), string(b)
		rig.seen.kind, _ = r.Context().Value(callerKindKey{}).(string)
		w.WriteHeader(http.StatusOK)
	}))
	return rig
}

func (rig *stampRig) do(method, route, body string, mutate func(r *http.Request)) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://127.0.0.1:8450"+route, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer the-hubs-key-for-this-remote")
	r.Header.Set("Content-Type", "application/json")
	if mutate != nil {
		mutate(r)
	}
	rig.seen.ran, rig.seen.human, rig.seen.body, rig.seen.kind = false, false, "", ""
	w := httptest.NewRecorder()
	rig.h.ServeHTTP(w, r)
	return w
}

func stampFor(t *testing.T, method, route, body string, at time.Time) string {
	t.Helper()
	s, err := hubowner.Sign(stampSecret, "ssh-box", method, route, []byte(body), at)
	require.NoError(t, err)
	return s
}

func TestAGenuineStampMakesAnAPIKeyRequestAPerson(t *testing.T) {
	rig := newStampRig(t, true)
	body := `{"decision":"approve"}`

	w := rig.do("POST", stampRoute, body, nil)
	require.Equal(t, 200, w.Code)
	assert.False(t, rig.seen.human, "a bare API key is automation")

	w = rig.do("POST", stampRoute, body, func(r *http.Request) {
		r.Header.Set(hubowner.Header, stampFor(t, "POST", stampRoute, body, time.Now()))
	})
	require.Equal(t, 200, w.Code, w.Body.String())
	assert.True(t, rig.seen.human, "a genuine stamp is the hub's signed-in person")
	assert.Equal(t, callerHubOwner, rig.seen.kind)
	assert.Equal(t, body, rig.seen.body, "the body the handler reads is the one that was signed")
}

func TestAStampThatIsNotGenuineIsRefusedNeverIgnored(t *testing.T) {
	body := `{"decision":"approve"}`
	for name, c := range map[string]struct {
		install bool
		route   string
		body    string
		mutate  func(t *testing.T, r *http.Request)
	}{
		"no secret installed": {false, stampRoute, body, func(t *testing.T, r *http.Request) {
			r.Header.Set(hubowner.Header, stampFor(t, "POST", stampRoute, body, time.Now()))
		}},
		"another body": {true, stampRoute, `{"decision":"changes"}`, func(t *testing.T, r *http.Request) {
			r.Header.Set(hubowner.Header, stampFor(t, "POST", stampRoute, body, time.Now()))
		}},
		"another route": {true, "/api/board/team/artifacts/other/review", body, func(t *testing.T, r *http.Request) {
			r.Header.Set(hubowner.Header, stampFor(t, "POST", stampRoute, body, time.Now()))
		}},
		"a route off the list": {true, "/api/saved", body, func(t *testing.T, r *http.Request) {
			r.Header.Set(hubowner.Header, stampFor(t, "POST", "/api/saved", body, time.Now()))
		}},
		"a stale stamp": {true, stampRoute, body, func(t *testing.T, r *http.Request) {
			r.Header.Set(hubowner.Header, stampFor(t, "POST", stampRoute, body, time.Now().Add(-time.Minute)))
		}},
		"a future stamp": {true, stampRoute, body, func(t *testing.T, r *http.Request) {
			r.Header.Set(hubowner.Header, stampFor(t, "POST", stampRoute, body, time.Now().Add(time.Minute)))
		}},
		"from before the process started": {true, stampRoute, body, func(t *testing.T, r *http.Request) {
			r.Header.Set(hubowner.Header, stampFor(t, "POST", stampRoute, body, time.Now().Add(-2*time.Hour)))
		}},
		"junk": {true, stampRoute, body, func(t *testing.T, r *http.Request) { r.Header.Set(hubowner.Header, "yes please") }},
		"two stamps": {true, stampRoute, body, func(t *testing.T, r *http.Request) {
			s := stampFor(t, "POST", stampRoute, body, time.Now())
			r.Header.Add(hubowner.Header, s)
			r.Header.Add(hubowner.Header, s)
		}},
		"a second spelling": {true, stampRoute, body, func(t *testing.T, r *http.Request) {
			s := stampFor(t, "POST", stampRoute, body, time.Now())
			r.Header.Set(hubowner.Header, s)
			r.Header["x-coral-hub-owner"] = []string{s}
		}},
		"without the API key": {true, stampRoute, body, func(t *testing.T, r *http.Request) {
			r.Header.Del("Authorization")
			r.Header.Set(hubowner.Header, stampFor(t, "POST", stampRoute, body, time.Now()))
		}},
		"on a tunnelled request": {true, stampRoute, body, func(t *testing.T, r *http.Request) {
			r.Header.Set("X-Coral-Via-Tunnel", "1")
			r.Header.Set(hubowner.Header, stampFor(t, "POST", stampRoute, body, time.Now()))
		}},
		"a body too large": {true, stampRoute, strings.Repeat("x", hubowner.MaxBody+1), func(t *testing.T, r *http.Request) {
			r.Header.Set(hubowner.Header, stampFor(t, "POST", stampRoute, "x", time.Now()))
		}},
	} {
		rig := newStampRig(t, c.install)
		w := rig.do("POST", c.route, c.body, func(r *http.Request) { c.mutate(t, r) })
		assert.Equal(t, http.StatusForbidden, w.Code, "%s: %s", name, w.Body.String())
		assert.Contains(t, w.Body.String(), "hub_owner_stamp_refused", name)
		assert.False(t, rig.seen.ran, "%s: the handler ran for a refused stamp", name)
		assert.NotContains(t, w.Body.String(), "secret", name)
	}
}

func TestAStampCannotBeUsedTwice(t *testing.T) {
	rig := newStampRig(t, true)
	body := `{"decision":"approve"}`
	stamp := stampFor(t, "POST", stampRoute, body, time.Now())
	set := func(r *http.Request) { r.Header.Set(hubowner.Header, stamp) }
	require.Equal(t, 200, rig.do("POST", stampRoute, body, set).Code)
	w := rig.do("POST", stampRoute, body, set)
	assert.Equal(t, http.StatusForbidden, w.Code, "a replayed stamp")
	assert.False(t, rig.seen.ran)
}

func TestARotatedSecretKillsTheOldStampsAndASecondStampStillWorks(t *testing.T) {
	rig := newStampRig(t, true)
	body := "{}"
	old := stampFor(t, "POST", stampRoute, body, time.Now())
	require.NoError(t, hubowner.WriteFile(rig.dir, "ssh-box", strings.Repeat("ab", 32)))
	w := rig.do("POST", stampRoute, body, func(r *http.Request) { r.Header.Set(hubowner.Header, old) })
	assert.Equal(t, http.StatusForbidden, w.Code, "a stamp made with the old secret")
	fresh, err := hubowner.Sign(strings.Repeat("ab", 32), "ssh-box", "POST", stampRoute, []byte(body), time.Now())
	require.NoError(t, err)
	w = rig.do("POST", stampRoute, body, func(r *http.Request) { r.Header.Set(hubowner.Header, fresh) })
	assert.Equal(t, 200, w.Code, w.Body.String())
	assert.True(t, rig.seen.human)
}

func TestNoStampChangesNothing(t *testing.T) {
	rig := newStampRig(t, true)
	for _, route := range []string{stampRoute, "/api/saved", "/api/board/team/artifacts/abc/tags"} {
		w := rig.do("POST", route, `{}`, nil)
		assert.Equal(t, 200, w.Code, route)
		assert.False(t, rig.seen.human, route)
		assert.Equal(t, callerAPIKey, rig.seen.kind, route)
	}
	_ = context.Background
}

// A secret installed, replaced or removed is a person's act that must not pass silently: one warning line in the log each time, and the time in the health answer (Security's SHOULD 1b).
func TestTheSecretFileBeingInstalledReplacedOrRemovedIsLoggedEachTime(t *testing.T) {
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo})))
	t.Cleanup(func() { slog.SetDefault(old) })

	rig := newStampRig(t, false) // SetHubOwnerDir ran with no file: nothing to say yet
	assert.NotContains(t, buf.String(), "secret file", "a warning for a file that is not there")
	_, ok := rig.o.HubOwnerStampAt()
	assert.False(t, ok)

	require.NoError(t, hubowner.WriteFile(rig.dir, "ssh-box", stampSecret))
	at, ok := rig.o.HubOwnerStampAt()
	require.True(t, ok)
	assert.False(t, at.IsZero())
	assert.Equal(t, 1, strings.Count(buf.String(), "installed or replaced"), "installing was not logged once:\n"+buf.String())
	assert.Contains(t, buf.String(), "level=WARN")
	_, _ = rig.o.HubOwnerStampAt() // looking again says nothing more
	assert.Equal(t, 1, strings.Count(buf.String(), "installed or replaced"))

	// a replacement (a later time) is logged again, and so is the first stamp check after it
	require.NoError(t, hubowner.WriteFile(rig.dir, "ssh-box", strings.Repeat("ab", 32)))
	later := time.Now().Add(2 * time.Second)
	require.NoError(t, os.Chtimes(filepath.Join(rig.dir, hubowner.FileName), later, later))
	rig.do("POST", stampRoute, "{}", func(r *http.Request) { r.Header.Set(hubowner.Header, "junk") }) // a stamp check looks at the file
	assert.Equal(t, 2, strings.Count(buf.String(), "installed or replaced"), "a replacement was not logged:\n"+buf.String())

	// removal
	require.NoError(t, os.Remove(filepath.Join(rig.dir, hubowner.FileName)))
	_, ok = rig.o.HubOwnerStampAt()
	assert.False(t, ok)
	assert.Contains(t, buf.String(), "gone or not usable")
	assert.NotContains(t, buf.String(), stampSecret, "the secret is in the log")
	assert.NotContains(t, buf.String(), strings.Repeat("ab", 32))
}

func TestAStampRefusalAsksForTheClocksToBeChecked(t *testing.T) {
	rig := newStampRig(t, true)
	w := rig.do("POST", stampRoute, "{}", func(r *http.Request) {
		r.Header.Set(hubowner.Header, stampFor(t, "POST", stampRoute, "{}", time.Now().Add(-time.Minute)))
	})
	require.Equal(t, http.StatusForbidden, w.Code)
	assert.Contains(t, w.Body.String(), "Check that both computers' clocks are right")
}
