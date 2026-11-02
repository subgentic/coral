package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Hermes is offered on macOS and Linux and not on a Windows server (#12038): the check says so with `supported: false` and one line, so New agent and New team hide it
// and give the reason, whichever computer the server is. Any other agent on Windows, and Hermes elsewhere, carries no such field.
func TestCLICheckHermesIsUnsupportedOnWindows(t *testing.T) {
	bin := t.TempDir() // a Hermes CLI that IS on PATH: a Windows server still does not offer it
	require.NoError(t, os.WriteFile(filepath.Join(bin, "hermes"), []byte("#!/bin/sh\necho 1.0\n"), 0o755))
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	h := newSystemHandlerForTest(t)
	ask := func(goos, typ string) map[string]any {
		t.Helper()
		old := cliGOOS
		cliGOOS = goos
		t.Cleanup(func() { cliGOOS = old })
		req := httptest.NewRequest(http.MethodGet, "/api/system/cli-check?type="+typ, nil)
		req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
		rec := httptest.NewRecorder()
		h.CLICheck(rec, req)
		require.Equal(t, 200, rec.Code, rec.Body.String())
		var out map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
		return out
	}
	win := ask("windows", "hermes")
	assert.Equal(t, false, win["supported"])
	assert.Equal(t, false, win["found"], "found is false even with the CLI on PATH")
	assert.Contains(t, win["message"], "Windows")
	for _, c := range [][2]string{{"darwin", "hermes"}, {"linux", "hermes"}, {"windows", "pi"}, {"windows", "claude"}} {
		_, has := ask(c[0], c[1])["supported"]
		assert.False(t, has, "%v must not carry supported", c)
	}
}
