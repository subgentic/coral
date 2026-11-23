package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
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
		r.Post("/api/board/{project}/messages", wrap(h.PostMessage))
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

// Slice 2b: a board post carries its pictures in its one field, content.
func TestABoardPostCarriesItsPicturesAsLinesAndKeepsThemOnTheMessage(t *testing.T) {
	e := newFieldWriteEnv(t)
	a := e.upload(t, "chat", "p1", 110)
	other := e.upload(t, "task", "p1", 111)
	code, out := e.json(t, "POST", "/api/board/alpha/messages", map[string]any{"subscriber_id": "Operator", "content": "see this", "images_draft": "p1", "images": map[string][]string{"content": {a}}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	msgs, err := e.h.bs.ListMessages(context.Background(), "alpha", 100, 0, 0)
	require.NoError(t, err)
	var id int64
	for _, m := range msgs {
		if strings.Contains(m.Content, "see this") {
			id = m.ID
			assert.Contains(t, m.Content, "coral://artifacts/"+a)
		}
	}
	require.NotZero(t, id)
	kept, err := e.h.bs.FieldImages(context.Background(), "alpha", board.FieldImagesMessage, strconv.FormatInt(id, 10))
	require.NoError(t, err)
	require.Len(t, kept["content"], 1)
	assert.Equal(t, a, kept["content"][0].Hex)

	// A picture for another scope, another field, and an agent are refused with nothing posted.
	before := len(msgs)
	for _, body := range []map[string]any{
		{"subscriber_id": "Operator", "content": "x1", "images_draft": "p1", "images": map[string][]string{"content": {other}}},
		{"subscriber_id": "Operator", "content": "x2", "images_draft": "p1", "images": map[string][]string{"title": {a}}},
	} {
		code, _ := e.json(t, "POST", "/api/board/alpha/messages", body)
		assert.Equal(t, http.StatusBadRequest, code)
	}
	raw, _ := json.Marshal(map[string]any{"subscriber_id": "Operator", "content": "x3", "images_draft": "p1", "images": map[string][]string{"content": {a}}})
	status, _ := e.send(t, e.anon, "POST", "/api/board/alpha/messages", "application/json", raw)
	assert.GreaterOrEqual(t, status, 400)
	msgs, _ = e.h.bs.ListMessages(context.Background(), "alpha", 100, 0, 0)
	assert.Len(t, msgs, before, "a refused picture posted nothing")
}

// Slice 2b: a goal edit replaces the goal's pictures as a set; a comment edit does the same for the comment's.
func TestAGoalEditReplacesItsPicturesAndAnOmittedFieldLeavesThem(t *testing.T) {
	_, h, _ := teamArtifactServer(t)
	old := uploaderLookup
	uploaderLookup = func(_ context.Context, sessionID string) (string, string, string) { return "alpha", "Alice", "worker" }
	t.Cleanup(func() { uploaderLookup = old })
	subscribeSession(t, h, "alpha", "Alice", sessAlice)
	registerTaskPlanner(t, h, "alpha", "Orchestrator")
	r := chi.NewRouter()
	asPerson := func(fn http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, req *http.Request) {
			req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
			fn(w, req)
		}
	}
	r.Post("/api/board/{project}/goal-images", asPerson(h.UploadGoalImage))
	r.Post("/api/board/{project}/goals", asPerson(h.CreateGoal))
	r.Patch("/api/board/{project}/goals/{goalID}", asPerson(h.UpdateGoal))
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	call := goalCall(t, srv.URL)
	up := func(shade uint8) string {
		req, _ := http.NewRequest("POST", srv.URL+"/api/board/alpha/goal-images", bytes.NewReader(shadePNG(t, shade)))
		req.Header.Set("Content-Type", "image/png")
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		return out["hex"].(string)
	}
	p1, p2 := up(120), up(121)
	code, g := call("POST", "/api/board/alpha/goals", map[string]any{"title": "Pictures", "outcome": "o", "done_when": "d", "subscriber_id": "Operator", "images": []string{p1}})
	require.Equal(t, http.StatusCreated, code, "%v", g)
	path := "/api/board/alpha/goals/" + itoa(int64(g["id"].(float64)))

	code, out := call("PATCH", path, map[string]any{"subscriber_id": "Operator", "outcome": "new words"})
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Len(t, out["images"], 1, "an edit that names no images leaves them")
	code, out = call("PATCH", path, map[string]any{"subscriber_id": "Operator", "images": map[string][]string{"description": {p2, p1}}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	imgs := out["images"].([]any)
	require.Len(t, imgs, 2)
	assert.Equal(t, p2, imgs[0].(map[string]any)["hex"], "the order sent, the new one added and the old one kept by naming it")
	code, out = call("PATCH", path, map[string]any{"subscriber_id": "Operator", "images": map[string][]string{"description": {}}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Empty(t, out["images"], "[] clears them")

	for name, body := range map[string]map[string]any{
		"never uploaded": {"subscriber_id": "Operator", "images": map[string][]string{"description": {strings.Repeat("ab", 32)}}},
		"another field":  {"subscriber_id": "Operator", "images": map[string][]string{"title": {p1}}},
		"an agent":       {"subscriber_id": "Orchestrator", "images": map[string][]string{"description": {p1}}},
		"five":           {"subscriber_id": "Operator", "images": map[string][]string{"description": {p1, p1, p1, p1, p1}}},
	} {
		code, _ := call("PATCH", path, body)
		assert.GreaterOrEqual(t, code, 400, name)
		assert.Less(t, code, 500, name)
	}
}

func TestACommentEditReplacesItsPicturesAndAnOmittedFieldLeavesThem(t *testing.T) {
	rig := newImageRig(t)
	up := func(shade uint8) string {
		code, out := rig.upload(cmtAsOwner, "image/png", "", shadePNG(t, shade))
		require.Equal(t, http.StatusCreated, code, "%v", out)
		return out["hex"].(string)
	}
	h1, h2 := up(130), up(131)
	code, out := rig.comment(cmtAsOwner, map[string]any{"body": "first", "images": []string{h1}, "anchor": map[string]any{"whole": true}, "board": "team-a"})
	require.Equal(t, http.StatusCreated, code, "%v", out)
	path := fmt.Sprintf("%s/%d", cp(rig.doc), int64(out["id"].(float64)))

	code, out = rig.do("PATCH", path, cmtAsOwner, map[string]any{"body": "edited"})
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Len(t, out["images"], 1, "an edit that names no images leaves them")
	code, out = rig.do("PATCH", path, cmtAsOwner, map[string]any{"body": "edited", "images": map[string][]string{"body": {h2, h1}}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	imgs := out["images"].([]any)
	require.Len(t, imgs, 2)
	assert.Equal(t, h2, imgs[0].(map[string]any)["hex"])
	code, out = rig.do("PATCH", path, cmtAsOwner, map[string]any{"body": "edited", "images": map[string][]string{"body": {}}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Empty(t, out["images"], "[] clears them")

	for name, tc := range map[string]struct {
		hdr  map[string]string
		body map[string]any
	}{
		"never uploaded": {cmtAsOwner, map[string]any{"body": "x", "images": map[string][]string{"body": {strings.Repeat("ab", 32)}}}},
		"another field":  {cmtAsOwner, map[string]any{"body": "x", "images": map[string][]string{"text": {h1}}}},
	} {
		code, _ := rig.do("PATCH", path, tc.hdr, tc.body)
		assert.GreaterOrEqual(t, code, 400, name)
		assert.Less(t, code, 500, name)
	}
}

// #20750: an upload stays nameable for 24 h across a restart (the memory is also in the store), and a write whose pictures could not be saved says so plainly (#20758).
func TestAnUploadIsStillNameableAfterARestart(t *testing.T) {
	e := newFieldWriteEnv(t)
	a := e.upload(t, "task", "rs", 60)
	recentFieldImages.Lock() // a restart: this process's memory is empty
	recentFieldImages.m = map[string]time.Time{}
	recentFieldImages.Unlock()

	code, out := e.json(t, "POST", "/api/board/alpha/tasks", map[string]any{"title": "after restart", "body": "x", "created_by": "Operator", "subscriber_id": "Operator", "images_draft": "rs", "images": map[string]any{"description": []string{a}}})
	require.Equal(t, http.StatusCreated, code, "%v", out)
	assert.Equal(t, []string{a}, imagesOf(out, "description"))

	// Another draft's upload is still not nameable, and a row older than 24 h is not either.
	code, out = e.json(t, "POST", "/api/board/alpha/tasks", map[string]any{"title": "other draft", "body": "x", "created_by": "Operator", "subscriber_id": "Operator", "images_draft": "elsewhere", "images": map[string]any{"description": []string{a}}})
	assert.Equal(t, http.StatusBadRequest, code, "%v", out)
	assert.Equal(t, "picture_not_yours", out["code"])
	require.NoError(t, e.h.bs.RememberFieldUpload(context.Background(), "alpha", "old-scope", a, time.Now().Add(-25*time.Hour)))
	assert.False(t, e.h.recentFieldUpload(context.Background(), "old-scope", a, time.Now()), "a 25 h row is not nameable")
}

func TestAnUploadRowOlderThanSevenDaysIsSwept(t *testing.T) {
	e := newFieldWriteEnv(t)
	ctx := context.Background()
	require.NoError(t, e.h.bs.RememberFieldUpload(ctx, "alpha", "s-old", strings.Repeat("a", 64), time.Now().Add(-8*24*time.Hour)))
	_, ok := e.h.bs.FieldUploadedAt(ctx, "s-old", strings.Repeat("a", 64))
	require.True(t, ok)
	require.NoError(t, e.h.bs.RememberFieldUpload(ctx, "alpha", "s-new", strings.Repeat("b", 64), time.Now())) // the next upload sweeps
	_, ok = e.h.bs.FieldUploadedAt(ctx, "s-old", strings.Repeat("a", 64))
	assert.False(t, ok, "an 8-day-old row is gone")
	_, ok = e.h.bs.FieldUploadedAt(ctx, "s-new", strings.Repeat("b", 64))
	assert.True(t, ok)
}

func TestAWriteWhosePicturesCouldNotBeSavedSaysSo(t *testing.T) {
	e := newFieldWriteEnv(t)
	a := e.upload(t, "task", "f1", 70)
	e.h.setFieldImages = func(context.Context, string, string, string, map[string][]board.GoalImage) error { return fmt.Errorf("disk full") }

	code, out := e.json(t, "POST", "/api/board/alpha/tasks", map[string]any{"title": "lossy", "body": "x", "created_by": "Operator", "subscriber_id": "Operator", "images_draft": "f1", "images": map[string]any{"description": []string{a}}})
	require.Equal(t, http.StatusCreated, code, "%v", out)
	assert.Equal(t, true, out["pictures_not_saved"], "the task is made and the answer says its pictures were not saved")
	assert.Empty(t, imagesOf(out, "description"))

	chat := e.upload(t, "chat", "f1", 71)
	code, out = e.json(t, "POST", "/api/board/alpha/messages", map[string]any{"content": "words", "images_draft": "f1", "subscriber_id": "Operator", "images": map[string]any{"content": []string{chat}}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, true, out["pictures_not_saved"], "a post says it too")

	e.h.setFieldImages = nil
	code, out = e.json(t, "POST", "/api/board/alpha/tasks", map[string]any{"title": "fine", "body": "x", "created_by": "Operator", "subscriber_id": "Operator", "images_draft": "f1", "images": map[string]any{"description": []string{a}}})
	require.Equal(t, http.StatusCreated, code, "%v", out)
	assert.Nil(t, out["pictures_not_saved"], "a saved write carries no such flag")
}

func TestARepeatedDecisionKeepsItsNewPicturesOrRefusesPlainly(t *testing.T) {
	old := uploaderLookup
	t.Cleanup(func() { uploaderLookup = old })
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
	first, second := fe.upload(t, "task", "rep", 110), fe.upload(t, "task", "rep", 111)

	code, out := c.changes(t, `{"decision":"approve","note":"good","images_draft":"rep","images":{"note":["`+first+`"]}}`)
	require.Equal(t, http.StatusOK, code, "%v", out)
	code, out = c.changes(t, `{"decision":"approve","note":"good","images_draft":"rep","images":{"note":["`+second+`"]}}`)
	kept, err := c.h.bs.FieldImages(context.Background(), "alpha", board.FieldImagesDecision, c.id)
	require.NoError(t, err)
	if code == http.StatusOK {
		require.Len(t, kept["note"], 1, "a repeat that is answered 200 has kept its pictures")
		assert.Equal(t, second, kept["note"][0].Hex)
	} else {
		assert.Equal(t, http.StatusConflict, code, "%v", out)
		assert.NotEmpty(t, out["code"], "a refusal says why")
		require.Len(t, kept["note"], 1)
		assert.Equal(t, first, kept["note"][0].Hex, "a refused repeat leaves the first pictures")
	}
	t.Logf("repeat: %d %v", code, out["code"])
}
