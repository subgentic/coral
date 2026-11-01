package branches

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Security's #6804 point 4: a remote is parsed, three shapes only, and keeps the host and owner/repo: never a user, a token, a query or a fragment.
func TestARemoteIsParsedToItsHostAndRepositoryOnly(t *testing.T) {
	for raw, want := range map[string]Remote{
		"https://github.com/subgentic/coral.git":                  {"github.com", "subgentic", "coral"},
		"https://user:ghp_secrettoken@github.com/subgentic/coral": {"github.com", "subgentic", "coral"},
		"https://github.com/subgentic/coral.git?token=x#frag":     {"github.com", "subgentic", "coral"},
		"ssh://git@github.com:22/subgentic/coral.git":             {"github.com", "subgentic", "coral"},
		"git@github.com:subgentic/coral.git":                      {"github.com", "subgentic", "coral"},
		"git@GitHub.com:subgentic/coral":                          {"github.com", "subgentic", "coral"},
		"https://gitlab.example.com/team/project.git":             {"gitlab.example.com", "team", "project"},
	} {
		got, ok := parseRemote(raw)
		require.True(t, ok, raw)
		assert.Equal(t, want, got, raw)
		b, _ := json.Marshal(got)
		assert.NotContains(t, string(b), "secret")
		assert.NotContains(t, string(b), "token")
	}
	for _, raw := range []string{"", "http://github.com/a/b", "file:///c/repo", "git://github.com/a/b", "ext::sh -c x", "https://github.com/a/b/c", "https://github.com/a",
		"https://github.com/../b", "C:\\repo", "/srv/repo.git", "https://gith ub.com/a/b", "javascript:alert(1)", "https://github.com/a/b\nx"} {
		_, ok := parseRemote(raw)
		assert.False(t, ok, "%q is not a remote Coral reads", raw)
	}
}

// The marks: an upstream deleted, and no commit for 14 days. Read from for-each-ref's fixed format; names matched as text.
func TestABranchsMarksAreReadFromItsRefs(t *testing.T) {
	now := time.Date(2026, 11, 1, 8, 0, 0, 0, time.UTC)
	old := now.Add(-15 * 24 * time.Hour).Unix()
	recent := now.Add(-time.Hour).Unix()
	out := []byte("refs/heads/gone-one\x00[gone]\x00" + itoa(recent) + "\nrefs/heads/quiet-one\x00\x00" + itoa(old) + "\nrefs/heads/fresh\x00[ahead 1]\x00" + itoa(recent) + "\nrefs/tags/v1\x00\x001\n")
	refs := parseRefs(out)
	require.Len(t, refs, 3, "branches only")
	for name, want := range map[string][2]bool{"gone-one": {true, false}, "quiet-one": {false, true}, "fresh": {false, false}} {
		w := Worktree{Branch: name}
		mark(&w, refs, now)
		assert.Equal(t, want, [2]bool{w.UpstreamGone, w.Quiet}, name)
	}
	hidden := Worktree{NameHidden: true}
	mark(&hidden, refs, now)
	assert.False(t, hidden.UpstreamGone || hidden.Quiet, "a branch whose name is not shown gets no marks")

	assert.True(t, readAllowed([]string{"for-each-ref", refsFormat, "refs/heads"}))
	assert.True(t, readAllowed([]string{"config", "--get", "remote.origin.url"}))
	for _, args := range [][]string{{"for-each-ref", refsFormat, "refs/remotes"}, {"for-each-ref", "--format=%(contents)", "refs/heads"}, {"config", "--get", "user.email"},
		{"config", "--get", "credential.helper"}, {"config", "--unset", "remote.origin.url"}, {"config", "remote.origin.url", "x"}} {
		assert.False(t, readAllowed(args), "%v", args)
	}
}

func itoa(n int64) string { b, _ := json.Marshal(n); return string(b) }

// ghFake answers gh with out, or fails with stderr, and counts the calls and their arguments.
type ghFake struct {
	out    string
	stderr string
	calls  [][]string
}

func (f *ghFake) run(_ context.Context, _ string, args ...string) ([]byte, string, error) {
	f.calls = append(f.calls, args)
	if f.stderr != "" {
		return nil, f.stderr, errors.New("exit status 1")
	}
	return []byte(f.out), "", nil
}

func newPRCollector(f *ghFake, now *time.Time) *Collector {
	c := New()
	c.gh = f.run
	c.now = func() time.Time { return *now }
	c.ghLooked, c.ghFound = *now, `C:\gh\gh.exe`
	return c
}

const tipA = "0123456789012345678901234567890123456789"
const tipB = "abcdefabcdefabcdefabcdefabcdefabcdefabcd"

// Security's MUST 3 and #6804: gh only for github.com, with -R from the parsed remote and a fixed set of flags; only state, draft, checks and review are kept; a merged PR whose head
// is the worktree's own commit is a squash merge, so no commits are left to merge; a rate limit pauses it for 15 minutes; a missing sign-in says so.
func TestPRStateComesFromOneFixedGhCommandForGithubRemotesOnly(t *testing.T) {
	now := time.Date(2026, 11, 1, 8, 0, 0, 0, time.UTC)
	f := &ghFake{out: `[{"number":12,"headRefName":"feature","headRefOid":"` + tipA + `","state":"MERGED","isDraft":false,"reviewDecision":"APPROVED","statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS"}],"title":"never kept"},
		{"number":13,"headRefName":"wip","headRefOid":"ffffffffffffffffffffffffffffffffffffffff","state":"OPEN","isDraft":true,"reviewDecision":"REVIEW_REQUIRED","statusCheckRollup":[{"status":"IN_PROGRESS"},{"state":"FAILURE"}]}]`}
	c := newPRCollector(f, &now)

	c.refreshPRs(context.Background(), "k-other", Remote{"gitlab.example.com", "team", "project"})
	assert.Empty(t, f.calls, "a remote on another host: no gh call at all")

	c.refreshPRs(context.Background(), "k", Remote{"github.com", "subgentic", "coral"})
	require.Len(t, f.calls, 1)
	assert.Equal(t, []string{"pr", "list", "-R", "subgentic/coral", "--state", "all", "--limit", "50", "--json", "number,headRefName,headRefOid,state,isDraft,reviewDecision,statusCheckRollup"}, f.calls[0])
	c.refreshPRs(context.Background(), "k", Remote{"github.com", "subgentic", "coral"})
	assert.Len(t, f.calls, 1, "not again before its interval")

	repo := withPRs(Repo{Worktrees: []Worktree{{Branch: "feature", tip: tipA}, {Branch: "wip", tip: tipB}, {Branch: "none", tip: tipB}}}, c.prs["k"])
	assert.Equal(t, &PR{Number: 12, State: "merged", Review: "approved", Checks: "passing", oid: tipA}, repo.Worktrees[0].PR)
	assert.True(t, repo.Worktrees[0].NothingToMerge, "merged with this very commit: a squash merge git cannot see")
	assert.Equal(t, &PR{Number: 13, State: "open", Draft: true, Review: "review_required", Checks: "failing", oid: "ffffffffffffffffffffffffffffffffffffffff"}, repo.Worktrees[1].PR, "found by its branch's name")
	assert.False(t, repo.Worktrees[1].NothingToMerge)
	assert.Nil(t, repo.Worktrees[2].PR)
	b, _ := json.Marshal(repo)
	assert.NotContains(t, string(b), "never kept", "no title is kept")

	now = now.Add(prEvery + prJitter)
	f.stderr = "HTTP 403: API rate limit exceeded for user"
	c.refreshPRs(context.Background(), "k", Remote{"github.com", "subgentic", "coral"})
	assert.Equal(t, PRNotePaused, c.prs["k"].note)
	calls := len(f.calls)
	now = now.Add(prPause - time.Minute)
	c.refreshPRs(context.Background(), "k", Remote{"github.com", "subgentic", "coral"})
	assert.Len(t, f.calls, calls, "paused for 15 minutes")
	now = now.Add(2 * time.Minute)
	f.stderr = "To get started with GitHub CLI, please run:  gh auth login"
	c.refreshPRs(context.Background(), "k", Remote{"github.com", "subgentic", "coral"})
	assert.Equal(t, PRNoteSignIn, c.prs["k"].note)
	assert.NotContains(t, c.prs["k"].note, "gh auth", "gh's own words are never kept")
}

func TestNoGhMeansNoCallAndNoNote(t *testing.T) {
	now := time.Date(2026, 11, 1, 8, 0, 0, 0, time.UTC)
	f := &ghFake{out: "[]"}
	c := newPRCollector(f, &now)
	c.ghFound = ""
	c.refreshPRs(context.Background(), "k", Remote{"github.com", "a", "b"})
	assert.Empty(t, f.calls)
	assert.Empty(t, c.prs["k"].note, "no gh: PR state is hidden, not an error")
	env := ghEnv()
	assert.Contains(t, env, "GH_PROMPT_DISABLED=1")
	for _, kv := range env {
		assert.NotRegexp(t, `^(GH_HOST|GH_REPO|GIT_[A-Z_]*|CORAL_[A-Z_]*)=`, kv, "nothing of the repository's or Coral's")
	}
}
