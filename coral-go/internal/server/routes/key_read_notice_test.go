package routes

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/hubowner"
)

// captureLog collects what slog says for the length of a test.
func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelWarn})))
	t.Cleanup(func() { slog.SetDefault(old) })
	keyReadLogged.Lock()
	keyReadLogged.at = map[string]time.Time{}
	keyReadLogged.Unlock()
	return &buf
}

// #21285: a private read with the server's API key and no stamp is served, with the notice header and one log line a day per kind; a person, an owner-stamped Hub and Coral Hub's tunnel get neither.
func TestAKeyOnlyPrivateReadIsServedWithANoticeAndAPersonOrAStampedHubGetsNone(t *testing.T) {
	buf := captureLog(t)
	as := func(kind string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", "/api/saved", nil)
		r = r.WithContext(context.WithValue(r.Context(), callerKindKey{}, kind))
		w := httptest.NewRecorder()
		noteKeyOnlyRead(w, r, "saved")
		return w
	}
	for _, person := range []string{callerDashCookie, callerHubOwner} {
		assert.Empty(t, as(person).Header().Get(hubowner.KeyReadNoticeHeader), person)
	}
	assert.Empty(t, as(callerOpen).Header().Get(hubowner.KeyReadNoticeHeader), "no credential at all")
	assert.Empty(t, buf.String(), "no log for a person or a stamp")

	assert.Equal(t, "saved", as(callerAPIKey).Header().Get(hubowner.KeyReadNoticeHeader), "the key alone")
	assert.Equal(t, 1, strings.Count(buf.String(), "no owner stamp"), "one line")
	as(callerAPIKey)
	assert.Equal(t, 1, strings.Count(buf.String(), "no owner stamp"), "once a day per kind, not per read")
}

// #21285: the saved reads and the skills reads carry the notice for the key alone, and a person's read does not; the answer is the same either way (a warning now, a refusal in a later release).
func TestTheSavedAndSkillsReadsWarnAKeyAndStillAnswerIt(t *testing.T) {
	captureLog(t)
	g := newSavedRig(t)
	get := func(path string, h map[string]string) *http.Response {
		req, _ := http.NewRequest("GET", g.srv.URL+path, nil)
		for k, v := range h {
			req.Header.Set(k, v)
		}
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		resp.Body.Close()
		return resp
	}
	viaKey := map[string]string{"Authorization": "Bearer the-servers-key"}
	resp := get("/api/saved", viaKey)
	assert.Equal(t, http.StatusOK, resp.StatusCode, "the key still reads the saved list")
	assert.Equal(t, "saved", resp.Header.Get(hubowner.KeyReadNoticeHeader))
	resp = get("/api/saved/999/message", viaKey)
	assert.Equal(t, "saved", resp.Header.Get(hubowner.KeyReadNoticeHeader), "the whole message too, even when it is not found")
	resp = get("/api/saved", map[string]string{testDashboardHeader: "1"})
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Empty(t, resp.Header.Get(hubowner.KeyReadNoticeHeader), "a person's read has no notice")
}

// #21285: the skills list and the approval view carry the notice for the key alone; the answer is unchanged.
func TestTheSkillsReadsWarnAKeyAndStillAnswerIt(t *testing.T) {
	captureLog(t)
	e := newSkillsEnv(t)
	row, _ := e.publish(map[string]string{"SKILL.md": "---\nname: tidy\ndescription: Tidy things\n---\nTidy."}, "operator")
	read := func(path, kind string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", path, nil)
		req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, kind))
		rec := httptest.NewRecorder()
		e.router.ServeHTTP(rec, req)
		return rec
	}
	for _, path := range []string{"/api/skills", "/api/skills/" + row.ID} {
		rec := read(path, callerAPIKey)
		assert.Equal(t, http.StatusOK, rec.Code, "the key still reads "+path)
		assert.Equal(t, "skills", rec.Header().Get(hubowner.KeyReadNoticeHeader), path)
		rec = read(path, callerDashCookie)
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Empty(t, rec.Header().Get(hubowner.KeyReadNoticeHeader), "a person's read: "+path)
	}
}
