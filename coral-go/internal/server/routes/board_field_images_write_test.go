package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #20731 slice 2a: the writes that name field pictures. images is {field: [hex]}: a field that is present replaces its set, [] clears it, an omitted field is left; a picture is one uploaded for this team, scope and
// draft in the last 24 h, or already on the record; the Operator's alone.
type fieldWriteEnv struct {
	h    *BoardHandler
	srv  *httptest.Server
	anon *httptest.Server // the same routes with no person on the request (an agent)
}

func newFieldWriteEnv(t *testing.T) *fieldWriteEnv {
	t.Helper()
	_, h, _ := teamArtifactServer(t)
	old := uploaderLookup
	uploaderLookup = func(_ context.Context, sessionID string) (string, string, string) { return "alpha", "Alice", "worker" }
	t.Cleanup(func() { uploaderLookup = old })
	subscribeSession(t, h, "alpha", "Alice", sessAlice)
	routes := func(person bool) *httptest.Server {
		r := chi.NewRouter()
		wrap := func(fn http.HandlerFunc) http.HandlerFunc {
			return func(w http.ResponseWriter, req *http.Request) {
				if person {
					req = withActor(req, Actor{Kind: ActorOperator, Name: "Operator"})
					req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
				}
				fn(w, req)
			}
		}
		r.Post("/api/board/{project}/field-images", wrap(h.UploadFieldImage))
		r.Post("/api/board/{project}/tasks", wrap(h.CreateTask))
		r.Patch("/api/board/{project}/tasks/{taskID}/amend", wrap(h.AmendTask))
		r.Post("/api/board/{project}/tasks/{taskID}/reply", wrap(h.ReplyToTask))
		r.Post("/api/board/{project}/tasks/{taskID}/complete", wrap(h.CompleteTaskByID))
		r.Get("/api/board/{project}/tasks/{taskID}", wrap(h.GetTask))
		s := httptest.NewServer(r)
		t.Cleanup(s.Close)
		return s
	}
	return &fieldWriteEnv{h: h, srv: routes(true), anon: routes(false)}
}

func (e *fieldWriteEnv) send(t *testing.T, s *httptest.Server, method, path, contentType string, body []byte) (int, map[string]any) {
	t.Helper()
	req, err := http.NewRequest(method, s.URL+path, bytes.NewReader(body))
	require.NoError(t, err)
	req.Header.Set("Content-Type", contentType)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func (e *fieldWriteEnv) json(t *testing.T, method, path string, body any) (int, map[string]any) {
	t.Helper()
	raw, err := json.Marshal(body)
	require.NoError(t, err)
	return e.send(t, e.srv, method, path, "application/json", raw)
}

// upload puts one picture up for scope and draft through the real route and answers its hash.
func (e *fieldWriteEnv) upload(t *testing.T, scope, draft string, shade uint8) string {
	t.Helper()
	path := "/api/board/alpha/field-images?scope=" + scope
	if draft != "" {
		path += "&draft=" + draft
	}
	code, out := e.send(t, e.srv, "POST", path, "image/png", shadePNG(t, shade))
	require.Equal(t, http.StatusCreated, code, "%v", out)
	return out["hex"].(string)
}

func imagesOf(out map[string]any, field string) []string {
	var hexes []string
	if m, ok := out["images"].(map[string]any); ok {
		if list, ok := m[field].([]any); ok {
			for _, x := range list {
				hexes = append(hexes, x.(map[string]any)["hex"].(string))
			}
		}
	}
	return hexes
}

func TestPicturesGoWithTheFieldsOfATask(t *testing.T) {
	e := newFieldWriteEnv(t)
	a, b := e.upload(t, "task", "d1", 40), e.upload(t, "task", "d1", 41)

	// A new task keeps the pictures of the fields they were named for, and the read of the task returns them.
	code, out := e.json(t, "POST", "/api/board/alpha/tasks", map[string]any{"title": "Plan", "body": "see the picture", "created_by": "Operator", "subscriber_id": "Operator", "images_draft": "d1", "images": map[string][]string{"description": {a}, "instructions": {b}}})
	require.Equal(t, http.StatusCreated, code, "%v", out)
	id := out["id"].(float64)
	assert.Equal(t, []string{a}, imagesOf(out, "description"))
	assert.Equal(t, []string{b}, imagesOf(out, "instructions"))
	path := "/api/board/alpha/tasks/" + numStr(id)
	code, got := e.json(t, "GET", path, nil)
	require.Equal(t, http.StatusOK, code, "%v", got)
	assert.Equal(t, []string{a}, imagesOf(got, "description"), "the read returns what was kept")

	// An amendment: a field that is present replaces its set, an omitted one is left, [] clears; a picture already on the record can be named again with no upload.
	c := e.upload(t, "task", "d2", 42)
	code, out = e.json(t, "PATCH", path+"/amend", map[string]any{"subscriber_id": "Operator", "base_revision": 1, "reason": "new picture", "changes": map[string]any{"body": "changed"}, "images_draft": "d2", "images": map[string][]string{"description": {a, c}}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, []string{a, c}, imagesOf(out, "description"), "kept in the order sent, the old one named again")
	assert.Equal(t, []string{b}, imagesOf(out, "instructions"), "an omitted field is unchanged")
	code, out = e.json(t, "PATCH", path+"/amend", map[string]any{"subscriber_id": "Operator", "base_revision": 2, "reason": "drop it", "changes": map[string]any{"body": "again"}, "images": map[string][]string{"instructions": {}, "reason": {}}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Empty(t, imagesOf(out, "instructions"), "[] clears the field")
	assert.Equal(t, []string{a, c}, imagesOf(out, "description"))

	// Completion: the completion message's pictures.
	d := e.upload(t, "task", "", 43)
	code, out = e.json(t, "POST", path+"/complete", map[string]any{"subscriber_id": "Operator", "message": "done", "expected_revision": out["revision"], "images": map[string][]string{"completion_message": {d}}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, []string{d}, imagesOf(out, "completion_message"))
}

func TestARefusedPictureWritesNothing(t *testing.T) {
	e := newFieldWriteEnv(t)
	good := e.upload(t, "task", "d1", 50)
	other := e.upload(t, "chat", "d1", 51)
	make := func(images any, draft string) (int, map[string]any) {
		return e.json(t, "POST", "/api/board/alpha/tasks", map[string]any{"title": "T-" + draft + time.Now().String(), "created_by": "Operator", "subscriber_id": "Operator", "images_draft": draft, "images": images})
	}
	for name, tc := range map[string]struct {
		images any
		draft  string
		code   string
	}{
		"another draft":       {map[string][]string{"description": {good}}, "d2", "picture_not_yours"},
		"no draft at all":     {map[string][]string{"description": {good}}, "", "picture_not_yours"},
		"another scope":       {map[string][]string{"description": {other}}, "d1", "picture_not_yours"},
		"a hash from nowhere": {map[string][]string{"description": {strings.Repeat("a", 64)}}, "d1", "picture_not_yours"},
		"not a hash":          {map[string][]string{"description": {"../x"}}, "d1", "picture_not_yours"},
		"a field it has not":  {map[string][]string{"title": {good}}, "d1", "picture_field_unknown"},
		"five pictures":       {map[string][]string{"description": {good, good, good, good, good}}, "d1", "too_many_pictures"},
		"a bad draft id":      {map[string][]string{"description": {good}}, "Bad Draft!", ""},
	} {
		code, out := make(tc.images, tc.draft)
		assert.Equal(t, http.StatusBadRequest, code, "%s: %v", name, out)
		if tc.code != "" {
			assert.Equal(t, tc.code, out["code"], name)
		}
	}
	tasks, err := e.h.bs.ListTasks(context.Background(), "alpha")
	require.NoError(t, err)
	assert.Empty(t, tasks, "a refused write made no task")

	// A repeated hash is one picture named twice: refused too.
	code, out := make(map[string][]string{"description": {good, good}}, "d1")
	assert.Equal(t, http.StatusBadRequest, code, "%v", out)

	// An agent (no person on the request) is refused, with or without the picture being the team's own.
	raw, _ := json.Marshal(map[string]any{"title": "from an agent", "created_by": "Operator", "subscriber_id": "Operator", "images_draft": "d1", "images": map[string][]string{"description": {good}}})
	status, _ := e.send(t, e.anon, "POST", "/api/board/alpha/tasks", "application/json", raw)
	assert.Equal(t, http.StatusForbidden, status)
}

func TestAReplyCarriesItsPicturesAsLinesAndKeepsThemOnTheMessage(t *testing.T) {
	e := newFieldWriteEnv(t)
	task, err := e.h.bs.CreateTask(context.Background(), "alpha", "Plan", "", "medium", "Operator")
	require.NoError(t, err)
	a := e.upload(t, "task", "r1", 60)
	code, out := e.json(t, "POST", "/api/board/alpha/tasks/"+numStr(float64(task.ID))+"/reply", map[string]any{"content": "look at this", "images_draft": "r1", "images": map[string][]string{"content": {a}}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	msgs, err := e.h.bs.ListMessages(context.Background(), "alpha", 100, 0, 0)
	require.NoError(t, err)
	var found bool
	for _, m := range msgs {
		if strings.Contains(m.Content, "look at this") {
			found = true
			assert.Contains(t, m.Content, "coral://artifacts/"+a, "an agent reads the picture as a link")
		}
	}
	assert.True(t, found)
	kept, err := e.h.bs.FieldImages(context.Background(), "alpha", board.FieldImagesMessage, numStr(out["message_id"].(float64)))
	require.NoError(t, err)
	require.Len(t, kept["content"], 1)
	assert.Equal(t, a, kept["content"][0].Hex)
}

func TestAnUploadIsNamedForTwentyFourHoursNotThirtyMinutes(t *testing.T) {
	e := newFieldWriteEnv(t)
	a := e.upload(t, "task", "d1", 70)
	scope := fieldImageScope("alpha", "task", "d1")
	assert.True(t, recentFieldImage(scope, a, time.Now().Add(23*time.Hour)), "still nameable after 23 h")
	assert.False(t, recentFieldImage(scope, a, time.Now().Add(25*time.Hour)), "not after 25 h")
	assert.True(t, recentFieldImage(scope, a, time.Now().Add(2*commentImageTTL)), "the comment pictures' 30 minutes do not apply")
}

func TestTheUploadRateLimitIsCountedForTheTeamAndFieldNotTheDraft(t *testing.T) {
	e := newFieldWriteEnv(t)
	old := commentImageLimitPerMinute
	commentImageLimitPerMinute = 3
	commentImageLimit.mu.Lock()
	commentImageLimit.seen = nil // other tests' uploads for this team and field are not this test's count
	commentImageLimit.mu.Unlock()
	t.Cleanup(func() { commentImageLimitPerMinute = old })
	for i := 0; i < 3; i++ {
		code, out := e.send(t, e.srv, "POST", "/api/board/alpha/field-images?scope=task&draft=draft-"+numStr(float64(i)), "image/png", shadePNG(t, uint8(80+i)))
		require.Equal(t, http.StatusCreated, code, "%v", out)
	}
	code, _ := e.send(t, e.srv, "POST", "/api/board/alpha/field-images?scope=task&draft=draft-new", "image/png", shadePNG(t, 90))
	assert.Equal(t, http.StatusTooManyRequests, code, "a new draft id is no new allowance")
	code, _ = e.send(t, e.srv, "POST", "/api/board/alpha/field-images?scope=chat", "image/png", shadePNG(t, 91))
	assert.Equal(t, http.StatusCreated, code, "another field has its own count")
}

func numStr(f float64) string { return strconv.FormatInt(int64(f), 10) }

// A file's review decision carries its pictures in the field the decision has: note for Approve, text for Request changes, reason for Deny. They go to the agent as coral://artifacts lines and stay on the decision.
func TestADecisionCarriesItsPicturesInItsOwnField(t *testing.T) {
	old := uploaderLookup
	t.Cleanup(func() { uploaderLookup = old })
	for _, tc := range []struct{ decision, field, words string }{
		{"approve", "note", `"note":"good"`},
		{"deny", "reason", `"reason":"no"`},
		{"changes", "text", `"text":"fix the table"`},
	} {
		c := newChangesEnv(t)
		uploaderLookup = func(_ context.Context, sessionID string) (string, string, string) { return "alpha", "Alice", "worker" }
		up := chi.NewRouter()
		up.Post("/api/board/{project}/field-images", func(w http.ResponseWriter, req *http.Request) {
			req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
			c.h.UploadFieldImage(w, req)
		})
		us := httptest.NewServer(up)
		t.Cleanup(us.Close)
		fe := &fieldWriteEnv{h: c.h, srv: us}
		hexID := fe.upload(t, "task", "dec", 100)

		code, out := c.changes(t, `{"decision":"`+tc.decision+`",`+tc.words+`,"images_draft":"dec","images":{"`+tc.field+`":["`+hexID+`"]}}`)
		require.Equal(t, http.StatusOK, code, "%s: %v", tc.decision, out)
		kept, err := c.h.bs.FieldImages(context.Background(), "alpha", board.FieldImagesDecision, c.id)
		require.NoError(t, err)
		require.Len(t, kept[tc.field], 1, tc.decision)
		assert.Equal(t, hexID, kept[tc.field][0].Hex)
		seen := false
		for _, m := range c.messages(t) {
			seen = seen || strings.Contains(m, "coral://artifacts/"+hexID)
		}
		for _, cm := range c.comments(t) {
			seen = seen || strings.Contains(cm.Body, "coral://artifacts/"+hexID)
		}
		assert.True(t, seen, tc.decision+": the agent is given the picture as a link")
	}
}

func TestADecisionRefusesAPictureThatIsNotItsOwn(t *testing.T) {
	c := newChangesEnv(t)
	other := strings.Repeat("b", 64)
	for _, body := range []string{
		`{"decision":"approve","note":"x","images":{"reason":["` + other + `"]}}`, // the wrong field for Approve
		`{"decision":"approve","note":"x","images":{"note":["` + other + `"]}}`,   // never uploaded
		`{"decision":"ignore","images":{"note":[]}}`,                              // not a decision with words
		`{"decision":"save","images":{}}`,
	} {
		code, out := c.changes(t, body)
		assert.Equal(t, http.StatusBadRequest, code, "%s: %v", body, out)
	}
	assert.Empty(t, c.comments(t))
	assert.Empty(t, c.messages(t))
	assert.NotContains(t, c.state(t), "approved")
}
