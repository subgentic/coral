package routes

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14730 (design v3, Security's conditions): the owner trusts ONE exact version (its digest) of an HTML file so the viewer runs its scripts; only a person (never an agent's token); per digest; undoable at
// once; only HTML; and a read is never an error for a file that cannot run scripts (the page treats every answer but a clean "trusted" as "no scripts").
func TestTrustPreviewRoute(t *testing.T) {
	rig := newPruneRig(t)
	html1, _, err := storeArtifact(rig.coralDir, "s1", "page.html", "text/html", []byte("<script>1</script>"))
	require.NoError(t, err)
	html2, _, err := storeArtifact(rig.coralDir, "s1", "page.html", "text/html", []byte("<script>2</script>")) // a newer version: another digest
	require.NoError(t, err)
	text, _, err := storeArtifact(rig.coralDir, "s1", "notes.txt", "text/plain", []byte("hello"))
	require.NoError(t, err)
	require.NotEqual(t, html1, html2)

	call := func(method, id string, hdr map[string]string) (int, map[string]any) {
		req, err := http.NewRequest(method, rig.srv.URL+"/api/artifacts/"+id+"/trust-preview", nil)
		require.NoError(t, err)
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		var out map[string]any
		_ = json.Unmarshal(raw, &out)
		return resp.StatusCode, out
	}
	dash := map[string]string{testDashboardHeader: "1"}
	agent := map[string]string{testAgentHeader: "s1"}

	// an agent's token never reads, trusts or undoes: scripts are the person's decision
	for _, m := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
		code, _ := call(m, html1, agent)
		assert.Equal(t, http.StatusForbidden, code, "an agent's %s is refused", m)
	}
	code, out := call(http.MethodGet, html1, dash)
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, false, out["trusted"], "nothing is trusted by default, and the agent's refused PUT trusted nothing")

	// ids that are not a whole digest, and files that do not exist
	code, _ = call(http.MethodPut, "abc", dash)
	assert.Equal(t, http.StatusBadRequest, code)
	code, _ = call(http.MethodPut, strings.ToUpper(html1), dash)
	assert.Equal(t, http.StatusBadRequest, code, "only the lower-case digest")
	code, _ = call(http.MethodPut, strings.Repeat("0", 64), dash)
	assert.Equal(t, http.StatusNotFound, code)

	// the owner trusts one version; it reads back; the other version stays untrusted (per exact bytes)
	code, out = call(http.MethodPut, html1, dash)
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, true, out["trusted"])
	_, out = call(http.MethodGet, html1, dash)
	assert.Equal(t, true, out["trusted"], "the trusted version reads trusted")
	_, out = call(http.MethodGet, html2, dash)
	assert.Equal(t, false, out["trusted"], "a newer version has another digest and is untrusted")
	code, _ = call(http.MethodPut, html1, dash)
	assert.Equal(t, http.StatusOK, code, "trusting twice is harmless")

	// undo: at once, the record is gone
	code, out = call(http.MethodDelete, html1, dash)
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, false, out["trusted"])
	_, out = call(http.MethodGet, html1, dash)
	assert.Equal(t, false, out["trusted"], "Turn off takes effect at once")

	// only HTML can be trusted; reading a file that cannot run scripts is simply "not trusted"
	code, out = call(http.MethodPut, text, dash)
	assert.Equal(t, http.StatusUnsupportedMediaType, code)
	assert.Equal(t, "not_html", out["code"])
	code, out = call(http.MethodGet, text, dash)
	assert.Equal(t, http.StatusOK, code)
	assert.Equal(t, false, out["trusted"])
}

func TestTrustableMediaTypeIsHTMLOnly(t *testing.T) {
	for mt, want := range map[string]bool{"text/html": true, "text/html; charset=utf-8": true, "TEXT/HTML": true, "application/xhtml+xml": true,
		"image/svg+xml": false, "application/pdf": false, "text/javascript": false, "text/plain": false, "": false, "application/octet-stream": false} {
		assert.Equal(t, want, trustableMediaType(mt), mt)
	}
}
