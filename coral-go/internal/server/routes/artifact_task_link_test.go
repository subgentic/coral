package routes

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/jmoiron/sqlx"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	_ "modernc.org/sqlite"

	"github.com/subgentic/coral/internal/board/boardtest"
)

// An artifact an agent uploads is linked to its one task in progress (#7739).
type linkRig struct {
	*artifactRig
	boardDB string
}

func newLinkRig(t *testing.T) *linkRig {
	t.Helper()
	rig := uploadRig(t)
	dbPath := filepath.Join(t.TempDir(), "board.db")
	bs, err := boardtest.Open(dbPath)
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	rig.h.bs = bs
	ctx := context.Background()
	for board, members := range map[string]map[string]string{"alpha": {"Backend": "s1", "Frontend": "s2"}, "beta": {"Other": "s3"}} {
		for member, sid := range members {
			_, err := bs.Subscribe(ctx, board, member, member, "agent-"+sid, nil, "all")
			require.NoError(t, err)
		}
	}
	return &linkRig{artifactRig: rig, boardDB: dbPath}
}

// task makes a task of board assigned to member; started puts it in progress.
func (l *linkRig) task(board, member string, started bool) int64 {
	l.t.Helper()
	ctx := context.Background()
	tk, err := l.h.bs.CreateTask(ctx, board, "Work for "+member, "", "medium", "lead", member)
	require.NoError(l.t, err)
	if started {
		_, err = l.h.bs.ClaimTask(ctx, board, member, tk.ID)
		require.NoError(l.t, err)
	}
	return tk.ID
}

func (l *linkRig) post(session, content string, headers map[string]string) (int, map[string]any) {
	l.t.Helper()
	req, err := http.NewRequest(http.MethodPost, l.srv.URL+"/api/agent/artifacts?session_id="+session, strings.NewReader(content))
	require.NoError(l.t, err)
	req.Header.Set("X-Artifact-Name", "report.md")
	req.Header.Set("X-Artifact-Media-Type", "text/markdown")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := agentClient.Do(req)
	require.NoError(l.t, err)
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

// linkOf is the task the upload record of content, made by session, says it is linked to (0: none); ok says there is a record.
func (l *linkRig) linkOf(session, content string) (int64, bool) {
	l.t.Helper()
	sum := sha256.Sum256([]byte(content))
	raw, err := os.ReadFile(filepath.Join(uploadsDir(l.coralDir, session), hex.EncodeToString(sum[:])+".json"))
	if err != nil {
		return 0, false
	}
	var rec agentUploadRecord
	require.NoError(l.t, json.Unmarshal(raw, &rec))
	return rec.TaskID, true
}

func TestAnUploadIsLinkedToTheAgentsOneTaskInProgress(t *testing.T) {
	l := newLinkRig(t)
	mine := l.task("alpha", "Backend", true)
	l.task("alpha", "Backend", false) // a task waiting for it is not in progress
	l.task("alpha", "Frontend", true) // another member's task in progress is not its
	code, out := l.post("s1", "first", nil)
	require.Equal(t, http.StatusCreated, code, out)
	assert.EqualValues(t, mine, out["task_id"], "the reply says which task it is linked to")
	got, ok := l.linkOf("s1", "first")
	assert.True(t, ok)
	assert.Equal(t, mine, got)
}

func TestAnUploadWithNoTaskInProgressIsLinkedToNone(t *testing.T) {
	l := newLinkRig(t)
	l.task("alpha", "Backend", false)
	code, out := l.post("s1", "idle", nil)
	require.Equal(t, http.StatusCreated, code, out)
	assert.NotContains(t, out, "task_id")
	got, ok := l.linkOf("s1", "idle")
	assert.True(t, ok)
	assert.Zero(t, got)
}

func TestAnUploadOfAMemberWithTwoTasksInProgressIsLinkedToNone(t *testing.T) {
	l := newLinkRig(t)
	a, b := l.task("alpha", "Backend", true), l.task("alpha", "Backend", false)
	db, err := sqlx.Open("sqlite", l.boardDB)
	require.NoError(t, err)
	defer db.Close()
	_, err = db.Exec(`UPDATE board_tasks SET status = 'in_progress' WHERE id = ?`, b) // the store should never hold this: the upload guesses nothing
	require.NoError(t, err)
	code, out := l.post("s1", "two", nil)
	require.Equal(t, http.StatusCreated, code, out)
	assert.NotContains(t, out, "task_id", "tasks %d and %d are both in progress", a, b)
	got, _ := l.linkOf("s1", "two")
	assert.Zero(t, got)
}

func TestAnExplicitTaskWinsAndAnotherMembersOrBoardsTaskIsRefusedBeforeAnythingIsStored(t *testing.T) {
	l := newLinkRig(t)
	current := l.task("alpha", "Backend", true)
	named := l.task("alpha", "Backend", false)
	foreign := l.task("alpha", "Frontend", true)
	elsewhere := l.task("beta", "Other", true)

	code, out := l.post("s1", "named", map[string]string{taskHeader: strconv.FormatInt(named, 10)})
	require.Equal(t, http.StatusCreated, code, out)
	assert.EqualValues(t, named, out["task_id"], "the named task wins over the one in progress (%d)", current)

	var firstMessage any
	for i, id := range []int64{foreign, elsewhere, 99999, 0, -3} {
		code, out = l.post("s1", "refused "+strconv.Itoa(i), map[string]string{taskHeader: strconv.FormatInt(id, 10)})
		assert.Contains(t, []int{http.StatusNotFound, http.StatusBadRequest}, code, "task %d: %v", id, out)
		_, stored := l.linkOf("s1", "refused "+strconv.Itoa(i))
		assert.False(t, stored, "a refused task stores nothing (task %d)", id)
		if i == 0 {
			firstMessage = out["error"]
		} else if i < 3 {
			assert.Equal(t, firstMessage, out["error"], "another member's task, another board's and a missing one are the same refusal")
		}
	}
	code, _ = l.post("s1", "text", map[string]string{taskHeader: "abc"})
	assert.Equal(t, http.StatusNotFound, code)
}

func TestNoTaskUploadsUnlinkedAndASecondUploadOfTheSameBytesKeepsItsLink(t *testing.T) {
	l := newLinkRig(t)
	mine := l.task("alpha", "Backend", true)
	code, out := l.post("s1", "bytes", map[string]string{taskHeader: "none"})
	require.Equal(t, http.StatusCreated, code, out)
	assert.NotContains(t, out, "task_id", "none is none even with a task in progress")
	got, _ := l.linkOf("s1", "bytes")
	assert.Zero(t, got)

	code, _ = l.post("s1", "linked", nil)
	require.Equal(t, http.StatusCreated, code)
	got, _ = l.linkOf("s1", "linked")
	require.Equal(t, mine, got)
	// the task ends; the same bytes sent again with no task in progress keep the link they had
	_, err := l.h.bs.CompleteTaskWithArtifacts(context.Background(), "alpha", mine, "Backend", nil, "success", nil)
	require.NoError(t, err)
	code, _ = l.post("s1", "linked", nil)
	require.Equal(t, http.StatusCreated, code)
	got, _ = l.linkOf("s1", "linked")
	assert.Equal(t, mine, got, "an upload with no task does not drop an earlier link")
	// but an explicit none does
	code, _ = l.post("s1", "linked", map[string]string{taskHeader: "none"})
	require.Equal(t, http.StatusCreated, code)
	got, _ = l.linkOf("s1", "linked")
	assert.Zero(t, got)
}

func TestTheTeamListShowsAnUploadsTaskOnlyWhenItIsTheTeamsAndFiltersByIt(t *testing.T) {
	e := newTAEnv(t)
	task := completeWithArtifacts(t, e.h, "alpha", "The linked task", nil)
	linked := e.upload(sessAlice, "linked.md", "linked bytes", "text/markdown", "2026-10-09T10:00:00Z")
	foreign := e.upload(sessAlice, "foreign.md", "foreign bytes", "text/markdown", "2026-10-09T11:00:00Z")
	setTask := func(id string, n int64) {
		path := filepath.Join(uploadsDir(e.coralDir, sessAlice), id+".json")
		raw, err := os.ReadFile(path)
		require.NoError(t, err)
		var rec agentUploadRecord
		require.NoError(t, json.Unmarshal(raw, &rec))
		rec.TaskID = n
		raw, _ = json.Marshal(rec)
		require.NoError(t, os.WriteFile(path, raw, 0o644))
	}
	setTask(linked, task)
	setTask(foreign, 99999) // a number that is not a task of this team (another board's, or one that is gone)

	code, r, raw := e.get("")
	require.Equal(t, 200, code, taJSON(raw))
	byName := map[string]teamArtifact{}
	for _, a := range r.Artifacts {
		byName[a.Name] = a
	}
	assert.Equal(t, task, byName["linked.md"].TaskID)
	assert.Equal(t, "The linked task", byName["linked.md"].TaskTitle)
	assert.Zero(t, byName["foreign.md"].TaskID, "a task the team does not have is not shown")
	assert.Zero(t, byName["a_b.md"].TaskID, "an upload with no link is as before")

	assert.Equal(t, []string{"linked.md"}, e.names("?task="+strconv.FormatInt(task, 10)))
	assert.Empty(t, e.names("?task=99999"))
	for _, bad := range []string{"?task=abc", "?task=0", "?task=-1", "?task=1&task=2"} {
		code, _, _ = e.get(bad)
		assert.Equal(t, 400, code, bad)
	}
}
