package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/store"
)

// #20750, pictures on an agent's saved instructions: images {"instructions": [hex]} on the PUT; present replaces, [] clears, omitted leaves, instructions saved empty take them away; the Operator's alone;
// the agent starts with the words and then one coral://artifacts line per picture.
func TestAnAgentsInstructionsCarryPicturesUntilReplaced(t *testing.T) {
	_, h, _, ss := setupSessionsTestServer(t)
	_, bh := setupBoardTestServer(t)
	bh.SetTaskArtifactWriter(t.TempDir(), nil)
	h.SetBoardHandler(bh)
	const sid = "sess-instr-1"
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "agent", WorkingDir: t.TempDir(), CreatedAt: time.Now().UTC().Format(time.RFC3339)}))

	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if req.Header.Get("X-Test-Caller") != "agent" {
				req = withActor(req, Actor{Kind: ActorOperator, Name: "Operator"})
				req = asCaller(callerDashCookie)(req)
			}
			next.ServeHTTP(w, req)
		})
	})
	r.Post("/api/field-images", bh.UploadPersonFieldImage)
	r.Put("/api/sessions/live/{name}/instructions", h.SetInstructions)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)

	upload := func(draft string, shade uint8) string {
		req, err := http.NewRequest("POST", srv.URL+"/api/field-images?scope=instruction&draft="+draft, bytes.NewReader(shadePNG(t, shade)))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "image/png")
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		require.Equal(t, http.StatusCreated, resp.StatusCode, "%v", out)
		return out["hex"].(string)
	}
	put := func(caller string, body map[string]any) (int, map[string]any) {
		body["session_id"] = sid
		return sendJSONHeader(t, "PUT", srv.URL+"/api/sessions/live/agent/instructions", body, map[string]string{"X-Test-Caller": caller})
	}
	a, b := upload("i1", 130), upload("i1", 131)

	code, out := put("dash", map[string]any{"instructions": "be careful", "images_draft": "i1", "images": map[string]any{"instructions": []string{a}}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, []string{a}, imagesOf(out, "instructions"))
	assert.Equal(t, "be careful\ncoral://artifacts/"+a, h.withInstructionPictures(context.Background(), sid, "be careful"), "the agent starts with the words and a line per picture")

	code, out = put("dash", map[string]any{"instructions": "be very careful"}) // omitted: left
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, []string{a}, imagesOf(out, "instructions"))
	code, out = put("dash", map[string]any{"instructions": "be very careful", "images_draft": "i1", "images": map[string]any{"instructions": []string{b, a}}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, []string{b, a}, imagesOf(out, "instructions"))

	// Not the Operator's, not this field, not an upload of this draft: nothing changes.
	code, out = put("agent", map[string]any{"instructions": "x", "images": map[string]any{"instructions": []string{a}}})
	assert.GreaterOrEqual(t, code, 400, "%v", out)
	code, out = put("dash", map[string]any{"instructions": "x", "images_draft": "i1", "images": map[string]any{"name": []string{a}}})
	assert.Equal(t, "picture_field_unknown", out["code"], "%d", code)
	code, out = put("dash", map[string]any{"instructions": "x", "images_draft": "elsewhere", "images": map[string]any{"instructions": []string{string(bytes.Repeat([]byte("e"), 64))}}})
	assert.Equal(t, "picture_not_yours", out["code"], "%d", code)
	assert.Len(t, h.instructionImages(context.Background(), sid)["instructions"], 2, "a refused write left the pictures")

	// A failed save is said plainly; instructions saved empty take their pictures away.
	bh.setFieldImages = func(context.Context, string, string, string, map[string][]board.GoalImage) error {
		return fmt.Errorf("disk full")
	}
	code, out = put("dash", map[string]any{"instructions": "y", "images_draft": "i1", "images": map[string]any{"instructions": []string{a}}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, true, out["pictures_not_saved"])
	bh.setFieldImages = nil
	code, out = put("dash", map[string]any{"instructions": ""})
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Empty(t, h.instructionImages(context.Background(), sid)["instructions"], "instructions replaced by nothing take their pictures with them")
	assert.Equal(t, "", h.withInstructionPictures(context.Background(), sid, ""))
}

// A wake of an agent whose conversation is not resumed starts it with its saved instructions and then the lines of their pictures.
func TestAWakeStartsAnAgentWithItsInstructionPictures(t *testing.T) {
	r := newSleepRig(t)
	truePath, lerr := exec.LookPath("true")
	if lerr != nil {
		t.Skip("no true(1) to stand in for the Codex CLI")
	}
	require.NoError(t, r.ss.SetSetting(r.ctx, "cli_path_codex", truePath))
	_, bh := setupBoardTestServer(t)
	r.h.SetBoardHandler(bh)
	cx, team, words := uuid.NewString(), "autosleep", "mind the table"
	require.NoError(t, r.ss.RegisterLiveSession(r.ctx, &store.LiveSession{SessionID: cx, AgentName: "cx", AgentType: "codex", BoardName: &team, WorkingDir: t.TempDir(), Prompt: &words}))
	hexID := strings.Repeat("f", 64)
	require.NoError(t, bh.bs.SetFieldImages(r.ctx, "", board.FieldImagesSession, cx, "instructions", []board.GoalImage{{Hex: hexID, Name: "shot.png", ContentType: "image/png"}}))
	ls, err := r.ss.GetLiveSession(r.ctx, cx)
	require.NoError(t, err)
	plan, err := r.h.prepareWake(r.ctx, ls, true)
	require.NoError(t, err)
	assert.Contains(t, plan.params.Prompt, "mind the table\ncoral://artifacts/"+hexID)
}
