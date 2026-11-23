package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #20750, pictures on a scheduled job's prompt: images {"prompt": [hex]} on the create and the edit (present replaces, [] clears, omitted leaves), the Operator's alone, kept until replaced or the job is deleted,
// given to a run as coral://artifacts lines after the words.
type jobPicturesEnv struct {
	srv   *httptest.Server
	sh    *ScheduleHandler
	bh    *BoardHandler
	jobs  *store.ScheduleStore
	repo  string
	draft int
}

func newJobPicturesEnv(t *testing.T) *jobPicturesEnv {
	t.Helper()
	_, bh := setupBoardTestServer(t)
	bh.SetTaskArtifactWriter(t.TempDir(), nil)
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "sched.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	sh := NewScheduleHandler(db, &config.Config{})
	sh.SetPictures(bh)
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
	r.Post("/api/scheduled/jobs", sh.CreateJob)
	r.Get("/api/scheduled/jobs/{jobID}", sh.GetJob)
	r.Put("/api/scheduled/jobs/{jobID}", sh.UpdateJob)
	r.Delete("/api/scheduled/jobs/{jobID}", sh.DeleteJob)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return &jobPicturesEnv{srv: srv, sh: sh, bh: bh, jobs: store.NewScheduleStore(db), repo: gitRepo(t)}
}

func (e *jobPicturesEnv) upload(t *testing.T, draft string, shade uint8) string {
	t.Helper()
	req, err := http.NewRequest("POST", e.srv.URL+"/api/field-images?scope=instruction&draft="+draft, bytes.NewReader(shadePNG(t, shade)))
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

func (e *jobPicturesEnv) call(t *testing.T, caller, method, path string, body any) (int, map[string]any) {
	t.Helper()
	return sendJSONHeader(t, method, e.srv.URL+path, body, map[string]string{"X-Test-Caller": caller})
}

func TestAJobPromptCarriesPicturesUntilReplaced(t *testing.T) {
	e := newJobPicturesEnv(t)
	a, b := e.upload(t, "j1", 120), e.upload(t, "j1", 121)

	code, out := e.call(t, "dash", "POST", "/api/scheduled/jobs", newJob(e.repo, map[string]any{"images_draft": "j1", "images": map[string]any{"prompt": []string{a}}}))
	require.Equal(t, http.StatusOK, code, "%v", out)
	id := strconv.FormatInt(int64(out["id"].(float64)), 10)
	assert.Equal(t, []string{a}, imagesOf(out, "prompt"))
	_, got := e.call(t, "dash", "GET", "/api/scheduled/jobs/"+id, nil)
	assert.Equal(t, []string{a}, imagesOf(got, "prompt"), "the read returns them")
	n, _ := strconv.ParseInt(id, 10, 64)
	assert.Equal(t, "\ncoral://artifacts/"+a, e.sh.JobPictureLines(context.Background(), n), "a run's prompt gets one line per picture")

	// An edit that leaves images out keeps them, even with a new prompt; images replaces; [] clears.
	code, out = e.call(t, "dash", "PUT", "/api/scheduled/jobs/"+id, map[string]any{"prompt": "new words"})
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, []string{a}, imagesOf(out, "prompt"), "omitted leaves them")
	code, out = e.call(t, "dash", "PUT", "/api/scheduled/jobs/"+id, map[string]any{"images_draft": "j1", "images": map[string]any{"prompt": []string{b, a}}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, []string{b, a}, imagesOf(out, "prompt"), "only the pictures changed: replaced, in order")
	assert.Equal(t, "new words", out["prompt"])
	code, out = e.call(t, "dash", "PUT", "/api/scheduled/jobs/"+id, map[string]any{"images": map[string]any{"prompt": []string{}}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Empty(t, imagesOf(out, "prompt"))
	assert.Empty(t, e.sh.JobPictureLines(context.Background(), n))

	// Deleted with the job.
	code, out = e.call(t, "dash", "PUT", "/api/scheduled/jobs/"+id, map[string]any{"images_draft": "j1", "images": map[string]any{"prompt": []string{a}}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	code, _ = e.call(t, "dash", "DELETE", "/api/scheduled/jobs/"+id, nil)
	require.Equal(t, http.StatusOK, code)
	m, err := e.bh.bs.FieldImages(context.Background(), "", board.FieldImagesJob, id)
	require.NoError(t, err)
	assert.Empty(t, m, "a deleted job's pictures go with it")
}

func TestAJobRefusesPicturesThatAreNotItsOwnOrNotTheOperators(t *testing.T) {
	e := newJobPicturesEnv(t)
	a := e.upload(t, "j2", 122)

	code, out := e.call(t, "dash", "POST", "/api/scheduled/jobs", newJob(e.repo, map[string]any{"images_draft": "other", "images": map[string]any{"prompt": []string{a}}}))
	assert.Equal(t, http.StatusBadRequest, code, "%v", out)
	assert.Equal(t, "picture_not_yours", out["code"])
	code, out = e.call(t, "dash", "POST", "/api/scheduled/jobs", newJob(e.repo, map[string]any{"images_draft": "j2", "images": map[string]any{"name": []string{a}}}))
	assert.Equal(t, http.StatusBadRequest, code)
	assert.Equal(t, "picture_field_unknown", out["code"])
	code, out = e.call(t, "agent", "POST", "/api/scheduled/jobs", newJob(e.repo, map[string]any{"images_draft": "j2", "images": map[string]any{"prompt": []string{a}}}))
	assert.GreaterOrEqual(t, code, 400, "an agent cannot name pictures: %v", out)
	list, err := e.jobs.ListScheduledJobs(context.Background(), false)
	require.NoError(t, err)
	assert.Empty(t, list, "a refused picture writes no job")
}

func TestAJobSaysSoWhenItsPicturesCouldNotBeSaved(t *testing.T) {
	e := newJobPicturesEnv(t)
	a := e.upload(t, "j3", 123)
	e.bh.setFieldImages = func(context.Context, string, string, string, map[string][]board.GoalImage) error { return fmt.Errorf("disk full") }
	code, out := e.call(t, "dash", "POST", "/api/scheduled/jobs", newJob(e.repo, map[string]any{"images_draft": "j3", "images": map[string]any{"prompt": []string{a}}}))
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, true, out["pictures_not_saved"])
}
