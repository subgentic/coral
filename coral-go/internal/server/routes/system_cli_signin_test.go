package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #16714: the sign-in route starts the CLI's login on this computer. It refuses through the Hub, for non-human callers and for unsupported agent types, and is rate-limited.

func signIn(t *testing.T, h *SystemHandler, query string, tunneled bool, human bool) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/system/cli-signin?"+query, nil)
	if human {
		req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
	}
	if tunneled {
		req.Header.Set(tunnel.ViaHeader, "1")
	}
	rec := httptest.NewRecorder()
	h.CLISignIn(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func TestCLISignInRefusesThroughTheHub(t *testing.T) {
	h := newSystemHandlerForTest(t)
	code, out := signIn(t, h, "type=claude", true, true)
	assert.Equal(t, http.StatusForbidden, code, "the Hub cannot start a login on this computer")
	assert.Equal(t, "local_only", out["code"])
}

func TestCLISignInRefusesAnAgentToken(t *testing.T) {
	h := newSystemHandlerForTest(t)
	code, _ := signIn(t, h, "type=claude", false, false)
	assert.Equal(t, http.StatusForbidden, code, "an agent token cannot start a login")
}

func TestCLISignInRefusesAnUnsupportedType(t *testing.T) {
	h := newSystemHandlerForTest(t)
	code, out := signIn(t, h, "type=pi", false, true)
	assert.Equal(t, http.StatusOK, code)
	assert.Equal(t, false, out["started"])
	assert.Equal(t, "not_supported", out["reason"])
}

func TestCLISignInRefusesMissingType(t *testing.T) {
	h := newSystemHandlerForTest(t)
	code, _ := signIn(t, h, "", false, true)
	assert.Equal(t, http.StatusBadRequest, code)
}

func TestCLISignInRateLimitsRepeatedStarts(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell-script fake binary")
	}
	bin := filepath.Join(t.TempDir(), "claude")
	require.NoError(t, os.WriteFile(bin, []byte("#!/bin/sh\nexit 0\n"), 0o755))
	t.Setenv("PATH", filepath.Dir(bin)+string(os.PathListSeparator)+"/usr/bin")

	h := newSystemHandlerForTest(t)

	frozen := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	signinStartMu.Lock()
	orig := signinStartNow
	signinStartNow = func() time.Time { return frozen }
	signinStartAt = map[string]time.Time{}
	signinStartMu.Unlock()
	t.Cleanup(func() {
		signinStartMu.Lock()
		signinStartNow = orig
		signinStartAt = map[string]time.Time{}
		signinStartMu.Unlock()
	})

	_, out := signIn(t, h, "type=claude", false, true)
	assert.Equal(t, true, out["started"], "the first start succeeds")

	_, out = signIn(t, h, "type=claude", false, true)
	assert.Equal(t, false, out["started"], "the second start within the gap is refused")
	assert.Equal(t, "too_soon", out["reason"])
}

func TestCLISignInStartsWhenTheCLIIsFound(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell-script fake binary")
	}
	bin := filepath.Join(t.TempDir(), "claude")
	require.NoError(t, os.WriteFile(bin, []byte("#!/bin/sh\nexit 0\n"), 0o755))
	t.Setenv("PATH", filepath.Dir(bin)+string(os.PathListSeparator)+"/usr/bin")

	h := newSystemHandlerForTest(t)

	// Reset rate limit.
	signinStartMu.Lock()
	signinStartAt = map[string]time.Time{}
	signinStartMu.Unlock()

	code, out := signIn(t, h, "type=claude", false, true)
	assert.Equal(t, http.StatusOK, code)
	assert.Equal(t, true, out["started"])
}

func TestCLISignInSaysWhenTheCLIIsNotFound(t *testing.T) {
	t.Setenv("PATH", "/nonexistent-dir-no-cli-here")
	h := newSystemHandlerForTest(t)

	// Reset rate limit.
	signinStartMu.Lock()
	signinStartAt = map[string]time.Time{}
	signinStartMu.Unlock()

	code, out := signIn(t, h, "type=claude", false, true)
	assert.Equal(t, http.StatusOK, code)
	assert.Equal(t, false, out["started"])
	assert.Equal(t, "cli_not_found", out["reason"])
}

func TestCLISignInRespectsConfiguredCLIPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell-script fake binary")
	}
	bin := filepath.Join(t.TempDir(), "my-claude")
	require.NoError(t, os.WriteFile(bin, []byte("#!/bin/sh\nexit 0\n"), 0o755))
	h := newSystemHandlerForTest(t)
	require.NoError(t, store.NewSessionStore(h.db).SetSetting(context.Background(), agent.CLIPathSettingKey("claude"), bin))

	signinStartMu.Lock()
	signinStartAt = map[string]time.Time{}
	signinStartMu.Unlock()

	code, out := signIn(t, h, "type=claude", false, true)
	assert.Equal(t, http.StatusOK, code)
	assert.Equal(t, true, out["started"])
}
