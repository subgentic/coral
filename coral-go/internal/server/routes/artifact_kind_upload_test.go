package routes

import (
	"context"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/store"
)

// #12144 (design v6, Security's rules): a non-default kind is accepted only when the server can check a fact for it, never on the agent's word. An agent cannot label its approval request as a release summary to
// get it muted, and a series keeps its kind.
type kindRig struct {
	*linkRig
	n int
}

func newKindRig(t *testing.T) *kindRig {
	t.Helper()
	l := newLinkRig(t)
	old := uploaderLookup
	t.Cleanup(func() { uploaderLookup = old })
	uploaderLookup = func(ctx context.Context, sid string) (string, string, string) { return "alpha", "Backend", "Backend" }
	ctx := context.Background()
	require.NoError(t, l.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: "s4", AgentName: "Lead", AgentType: "claude", WorkingDir: t.TempDir()}))
	_, err := l.h.bs.Subscribe(ctx, "alpha", "Lead", "Orchestrator", "agent-s4", nil, "all")
	require.NoError(t, err)
	return &kindRig{linkRig: l}
}

// up uploads a file for review with a question; query carries kind and anything else.
func (k *kindRig) up(session, extra string, headers map[string]string) (int, map[string]any) {
	k.t.Helper()
	k.n++
	return k.post(session+"&tag=for+review&question=Does+it+work%3F"+extra, "bytes number "+strings.Repeat("x", k.n), headers)
}

func (k *kindRig) task(title, member string) string {
	k.t.Helper()
	tk, err := k.h.bs.CreateTask(context.Background(), "alpha", title, "", "medium", "lead", member)
	require.NoError(k.t, err)
	return strconv.FormatInt(tk.ID, 10)
}

func (k *kindRig) kindOf(out map[string]any) string {
	k.t.Helper()
	id := strings.TrimPrefix(out["uri"].(string), "coral://artifacts/")
	got, err := k.h.bs.ArtifactKind(context.Background(), "alpha", id)
	require.NoError(k.t, err)
	return got
}

func taskHeader12144(id string) map[string]string { return map[string]string{"X-Artifact-Task": id} }

func TestAKindIsAcceptedOnlyWithTheFactTheServerChecks(t *testing.T) {
	k := newKindRig(t)
	// no --kind: a plain file, which an agent can never quiet
	code, out := k.up("s1", "", nil)
	require.Equal(t, 201, code, out)
	assert.Equal(t, board.KindFile, k.kindOf(out))
	assert.Nil(t, out["kind"])

	// done: needs an OPERATOR task assigned to the uploader
	op := k.task("OPERATOR fix the thing", "Backend")
	code, out = k.up("s1", "&kind=done", taskHeader12144(op))
	require.Equal(t, 201, code, out)
	assert.Equal(t, board.KindDone, k.kindOf(out))
	assert.Equal(t, "done", out["kind"])
	plain := k.task("Build the thing", "Backend")
	code, out = k.up("s1", "&kind=done", taskHeader12144(plain))
	assert.Equal(t, 400, code, "a task that is not an OPERATOR task: %v", out)
	assert.Equal(t, "kind_refused", out["code"])
	code, out = k.up("s1", "&kind=done", nil)
	assert.Equal(t, 400, code, "no task at all: %v", out)
	assert.Contains(t, out["error"], "--task")
	other := k.task("OPERATOR somebody else's", "Frontend")
	code, _ = k.up("s1", "&kind=done", taskHeader12144(other))
	assert.NotEqual(t, 201, code, "another member's task")

	// release: needs the task titled exactly Release vX.Y.Z
	rel := k.task("Release v2.0.39", "Backend")
	code, out = k.up("s1", "&kind=release", taskHeader12144(rel))
	require.Equal(t, 201, code, out)
	assert.Equal(t, board.KindRelease, k.kindOf(out))
	for _, title := range []string{"Release v2.0.39 notes", "release v2.0.39", "Release 2.0.39", "Release v2.0.39-beta", "Prepare Release v2.0.39"} {
		bad := k.task(title, "Backend")
		code, out = k.up("s1", "&kind=release", taskHeader12144(bad))
		assert.Equal(t, 400, code, "%q: %v", title, out)
	}

	// decided: only the team's Orchestrator
	code, out = k.up("s1", "&kind=decided", nil)
	assert.Equal(t, 400, code, "a member: %v", out)
	assert.Contains(t, out["error"], "Orchestrator")
	code, out = k.up("s4", "&kind=decided", nil)
	require.Equal(t, 201, code, out)
	assert.Equal(t, board.KindDecided, k.kindOf(out))

	// digest: only Coral writes one, whoever asks
	for _, s := range []string{"s1", "s4"} {
		code, out = k.up(s, "&kind=digest", nil)
		assert.Equal(t, 400, code, "%s: %v", s, out)
		assert.Contains(t, out["error"], "Coral itself")
	}
	// a word that is not a kind; a kind with no review
	code, out = k.up("s1", "&kind=quiet", nil)
	assert.Equal(t, 400, code, "%v", out)
	code, out = k.post("s1&kind=done", "not for review at all", taskHeader12144(op))
	assert.Equal(t, 400, code, "--kind is for a file for review: %v", out)
}

// The kind belongs to the series: a version carries the series' kind or none (and then has it), never a new one; and a plain file's series cannot turn into a quieter kind.
func TestAKindBelongsToTheSeries(t *testing.T) {
	k := newKindRig(t)
	op := k.task("OPERATOR do it", "Backend")
	code, out := k.up("s1", "&kind=done", taskHeader12144(op))
	require.Equal(t, 201, code, out)
	v1 := out["uri"].(string)
	ver := func(extra string) (int, map[string]any) {
		h := taskHeader12144(op)
		h["X-Artifact-New-Version-Of"] = v1
		return k.up("s1", extra, h)
	}
	code, out = ver("")
	require.Equal(t, 201, code, out)
	assert.Equal(t, board.KindDone, k.kindOf(out), "a version with no --kind has the series' kind")
	code, out = ver("&kind=done")
	require.Equal(t, 201, code, out)
	rel := k.task("Release v2.1.0", "Backend")
	h := taskHeader12144(rel)
	h["X-Artifact-New-Version-Of"] = v1
	code, out = k.up("s1", "&kind=release", h)
	assert.Equal(t, 400, code, "a new kind for a version: %v", out)
	assert.Contains(t, out["error"], "belongs to the series")

	// a plain file's series: a version cannot be a quieter kind
	code, out = k.up("s1", "", nil)
	require.Equal(t, 201, code, out)
	p1 := out["uri"].(string)
	h = taskHeader12144(op)
	h["X-Artifact-New-Version-Of"] = p1
	code, out = k.up("s1", "&kind=done", h)
	assert.Equal(t, 400, code, "version 2 of a loud file cannot be quiet: %v", out)
	assert.Contains(t, out["error"], "plain file")
}

func TestTheKindRulesAreAPureFunctionOfTheSeriesKindAndTheAskedKind(t *testing.T) {
	cases := []struct {
		series, asked, want string
		refused             bool
	}{
		{"", "", "", false}, {"done", "", "done", false}, {"done", "done", "done", false},
		{"done", "release", "", true}, {"", "done", "", true}, {"release", "decided", "", true},
	}
	for _, c := range cases {
		got, refused := seriesKindFor(c.series, c.asked)
		assert.Equal(t, c.want, got, "%+v", c)
		assert.Equal(t, c.refused, refused != "", "%+v", c)
	}
}

func (k *kindRig) followUp(title, member string, parent int64) int64 {
	k.t.Helper()
	tk, err := k.h.bs.CreateTaskWithOpts(context.Background(), "alpha", title, "", "medium", "lead", &board.CreateTaskOpts{Workflow: board.TaskWorkflow{ParentTaskID: parent}}, member)
	require.NoError(k.t, err)
	return tk.ID
}

func (k *kindRig) upTask(session string, task int64, content, extra string) (int, map[string]any) {
	k.t.Helper()
	return k.post(session+"&tag=for+review&question=Does+it+work%3F"+extra, content, taskHeader12144(strconv.FormatInt(task, 10)))
}

// One file per task chain, not per file name (#12144): an upload for review linked to a task joins the series of its chain's root while the chain's file is still open, with no --new-version-of from the agent;
// a follow-up (another task, another agent) joins the same series; a decided file starts a new one.
func TestAnUploadForReviewJoinsTheOpenFileOfItsTaskChain(t *testing.T) {
	k := newKindRig(t)
	ctx := context.Background()
	root, err := k.h.bs.CreateTask(ctx, "alpha", "OPERATOR the feature", "", "medium", "lead", "Backend")
	require.NoError(t, err)
	code, out := k.upTask("s1", root.ID, "the feature, version one", "&kind=done")
	require.Equal(t, 201, code, out)
	seriesID := out["series_id"]
	first := out["uri"].(string)
	assert.Nil(t, seriesID, "the first file of a chain is no series yet")

	code, out = k.upTask("s1", root.ID, "the feature, version two", "&kind=done")
	require.Equal(t, 201, code, out)
	assert.EqualValues(t, 2, out["version"], "the same task again: version 2 of the chain's file, with no --new-version-of")
	assert.NotNil(t, out["series_id"])
	assert.NotEqual(t, first, out["uri"])

	// a follow-up of the root, by another agent of the team, joins the same file
	kid := k.followUp("Follow-up fix", "Frontend", root.ID)
	code, out = k.upTask("s2", kid, "the follow-up changes", "")
	require.Equal(t, 201, code, out)
	assert.EqualValues(t, 3, out["version"], "a follow-up joins its parent's chain: the Operator reviews one file that grows")
	grandkid := k.followUp("Follow-up of the follow-up", "Backend", kid)
	code, out = k.upTask("s1", grandkid, "the grandchild's changes", "")
	require.Equal(t, 201, code, out)
	assert.EqualValues(t, 4, out["version"], "the chain is walked up to its root")
	assert.Equal(t, board.KindDone, k.kindOf(out), "a version with no --kind has the series' kind")

	// another chain is another file
	other, err := k.h.bs.CreateTask(ctx, "alpha", "OPERATOR something else", "", "medium", "lead", "Backend")
	require.NoError(t, err)
	code, out = k.upTask("s1", other.ID, "unrelated", "")
	require.Equal(t, 201, code, out)
	assert.Nil(t, out["series_id"], "a different chain does not join")
}

func TestADecidedChainFileStartsANewSeries(t *testing.T) {
	k := newKindRig(t)
	ctx := context.Background()
	root, err := k.h.bs.CreateTask(ctx, "alpha", "Build the page", "", "medium", "lead", "Backend")
	require.NoError(t, err)
	code, out := k.upTask("s1", root.ID, "page v1", "")
	require.Equal(t, 201, code, out)
	id := strings.TrimPrefix(out["uri"].(string), "coral://artifacts/")
	_, err = k.h.bs.AddArtifactTags(ctx, "alpha", id, []string{"approved"})
	require.NoError(t, err)
	code, out = k.upTask("s1", root.ID, "page v2 after the approval", "")
	require.Equal(t, 201, code, out)
	assert.Nil(t, out["series_id"], "the chain's file was approved: the next upload starts a new series")
	// a file whose changes were requested is still open: the next upload is its next version
	id2 := strings.TrimPrefix(out["uri"].(string), "coral://artifacts/")
	_, err = k.h.bs.AddArtifactTags(ctx, "alpha", id2, []string{board.ReviewChangesRequested})
	require.NoError(t, err)
	code, out = k.upTask("s1", root.ID, "page v3 after the changes", "")
	require.Equal(t, 201, code, out)
	assert.EqualValues(t, 2, out["version"])
}

// A join the server made itself never refuses an upload: a chain file of another kind, or one this agent cannot extend, is simply not joined.
func TestAnAutomaticJoinNeverRefusesAnUpload(t *testing.T) {
	k := newKindRig(t)
	ctx := context.Background()
	root, err := k.h.bs.CreateTask(ctx, "alpha", "Release v2.2.0", "", "medium", "lead", "Backend")
	require.NoError(t, err)
	code, out := k.upTask("s1", root.ID, "plain first", "")
	require.Equal(t, 201, code, out)
	code, out = k.upTask("s1", root.ID, "now a release file", "&kind=release")
	require.Equal(t, 201, code, "the chain's file is a plain file and this is a release: its own series, not a refusal: %v", out)
	assert.Nil(t, out["series_id"])
	assert.Equal(t, board.KindRelease, k.kindOf(out))
	// bytes the chain's file already has as an OLDER version are refused by an asked-for version; a join the server made itself just starts over
	other, err := k.h.bs.CreateTask(ctx, "alpha", "OPERATOR chain with history", "", "medium", "lead", "Backend")
	require.NoError(t, err)
	_, out = k.upTask("s1", other.ID, "history one", "")
	_, out = k.upTask("s1", other.ID, "history two", "")
	require.EqualValues(t, 2, out["version"])
	code, out = k.upTask("s1", other.ID, "history one", "")
	assert.Less(t, code, 300, "the older bytes again, joined by the server: not refused: %v", out)
	// the same bytes again, linked to the same task: nothing breaks
	code, out = k.upTask("s1", root.ID, "now a release file", "&kind=release")
	assert.Less(t, code, 300, "%v", out)
}

func TestTheRootOfAChainIsFoundWithinABoundAndOnItsBoard(t *testing.T) {
	k := newKindRig(t)
	ctx := context.Background()
	a, err := k.h.bs.CreateTask(ctx, "alpha", "root", "", "medium", "lead", "Backend")
	require.NoError(t, err)
	cur := a.ID
	for i := 0; i < 5; i++ {
		cur = k.followUp("kid", "Backend", cur)
	}
	assert.Equal(t, a.ID, k.h.bs.RootTask(ctx, "alpha", cur))
	assert.Equal(t, a.ID, k.h.bs.RootTask(ctx, "alpha", a.ID), "a root is its own root")
	assert.Equal(t, int64(99999), k.h.bs.RootTask(ctx, "alpha", 99999), "a task that is not there is its own root")
	assert.Equal(t, cur, k.h.bs.RootTask(ctx, "beta", cur), "never off the board")
}

// Security's MUST on #12144: an agent cannot quiet another agent's plain file for review by uploading the identical bytes with --kind. The kind is written only for a file that is new on the team's list; the asked kind
// is ignored (and the reply says so), and the first agent's ask stays a plain, counted file.
func TestAnAgentCannotQuietAnotherAgentsFileByUploadingTheSameBytesWithAKind(t *testing.T) {
	k := newKindRig(t)
	ctx := context.Background()
	code, out := k.post("s2&tag=for+review&question=Approve+the+plan%3F", "the same bytes", nil) // agent A (Frontend): a plain file for review
	require.Equal(t, 201, code, out)
	assert.Equal(t, board.KindFile, k.kindOf(out))
	op := k.task("OPERATOR a task of B's", "Backend")
	code, out = k.post("s1&tag=for+review&question=Does+it+work%3F&kind=done", "the same bytes", taskHeader12144(op)) // agent B (Backend), identical bytes
	require.Less(t, code, 300, "%v", out)
	assert.Equal(t, board.KindFile, k.kindOf(out), "A's file stays a plain file")
	assert.Nil(t, out["kind"])
	assert.NotEmpty(t, out["kind_ignored"], "B is told the kind was ignored")
	id := strings.TrimPrefix(out["uri"].(string), "coral://artifacts/")
	kinds, err := k.h.bs.ArtifactKindsOf(ctx, "alpha")
	require.NoError(t, err)
	assert.Empty(t, kinds[id], "no kind row was written")
	// and the Operator's switch for done does not touch it
	assert.False(t, readInboxPrefs(map[string]string{"inbox_kind_done": "false"}).muted("alpha", k.kindStr(t, id)), "a plain file is counted with the done switch off")
}

func (k *kindRig) kindStr(t *testing.T, id string) string {
	t.Helper()
	got, err := k.h.bs.ArtifactKind(context.Background(), "alpha", id)
	require.NoError(t, err)
	return got
}

// A file that is new on the list still gets its checked kind.
func TestAFileNewOnTheListStillGetsItsKind(t *testing.T) {
	k := newKindRig(t)
	op := k.task("OPERATOR new work", "Backend")
	code, out := k.up("s1", "&kind=done", taskHeader12144(op))
	require.Equal(t, 201, code, out)
	assert.Equal(t, board.KindDone, k.kindOf(out))
	assert.Nil(t, out["kind_ignored"])
}
