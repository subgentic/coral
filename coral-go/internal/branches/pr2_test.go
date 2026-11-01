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

// Security's MUST 3, #6804 and #6985: gh only for github.com, with -R from the parsed remote, host included, and a fixed set of flags; only state, draft, checks and review are
// kept; a merged PR whose head is the worktree's own commit is a squash merge, so no commits are left to merge.
func TestPRStateComesFromOneFixedGhCommandForGithubRemotesOnly(t *testing.T) {
	now := time.Date(2026, 11, 1, 8, 0, 0, 0, time.UTC)
	f := &ghFake{out: `[{"number":12,"headRefName":"feature","headRefOid":"` + tipA + `","state":"MERGED","isDraft":false,"reviewDecision":"APPROVED","statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS"}],"title":"never kept"},
		{"number":13,"headRefName":"wip","headRefOid":"` + headWip + `","state":"OPEN","isDraft":true,"reviewDecision":"REVIEW_REQUIRED","statusCheckRollup":[{"status":"IN_PROGRESS"},{"state":"FAILURE"}]}]`}
	c := newPRCollector(f, &now)
	g := &ancestorFake{yes: map[string]bool{headWip + ".." + tipB: true}}
	c.run = g.run

	c.refreshPRs(context.Background(), "k-other", Remote{"gitlab.example.com", "team", "project"})
	assert.Empty(t, f.calls, "a remote on another host: no gh call at all")

	c.refreshPRs(context.Background(), "k", Remote{"github.com", "subgentic", "coral"})
	require.Len(t, f.calls, 1)
	assert.Equal(t, []string{"pr", "list", "-R", "github.com/subgentic/coral", "--state", "all", "--limit", "50", "--json", "number,headRefName,headRefOid,state,isDraft,reviewDecision,statusCheckRollup"}, f.calls[0],
		"the host is named: gh never falls back to its default host")
	c.refreshPRs(context.Background(), "k", Remote{"github.com", "subgentic", "coral"})
	assert.Len(t, f.calls, 1, "not again before its interval")

	c.repos["k"] = &Repo{key: "k", Worktrees: []Worktree{{Branch: "feature", tip: tipA}, {Branch: "wip", tip: tipB}, {Branch: "none", tip: tipB}}}
	c.matchPRs(context.Background(), "k", `C:\repo`)
	repo, _ := c.forKey("k")
	assert.Equal(t, &PR{Number: 12, State: "merged", Review: "approved", Checks: "passing", oid: tipA}, repo.Worktrees[0].PR)
	assert.True(t, repo.Worktrees[0].NothingToMerge, "merged with this very commit: a squash merge git cannot see")
	assert.Equal(t, &PR{Number: 13, State: "open", Draft: true, Review: "review_required", Checks: "failing", oid: headWip}, repo.Worktrees[1].PR, "its name and an ancestor head")
	assert.False(t, repo.Worktrees[1].NothingToMerge)
	assert.Nil(t, repo.Worktrees[2].PR)
	assert.Equal(t, [][]string{{"merge-base", "--is-ancestor", "--end-of-options", headWip, tipB}}, g.calls, "commit ids only")
	b, _ := json.Marshal(repo)
	assert.NotContains(t, string(b), "never kept", "no title is kept")
	c.matchPRs(context.Background(), "k", `C:\repo`)
	assert.Len(t, g.calls, 1, "an ancestor answer is kept until gh answers again")
}

// Security's #6985 SHOULD 1: a PR is never shown by its branch's name alone. A worktree whose branch has a PR's name, but whose history lacks the PR's head, shows no PR.
func TestAPRIsShownByCommitNeverByNameAlone(t *testing.T) {
	now := time.Date(2026, 11, 1, 8, 0, 0, 0, time.UTC)
	f := &ghFake{out: `[{"number":7,"headRefName":"release","headRefOid":"` + headWip + `","state":"OPEN","reviewDecision":"APPROVED"}]`}
	c := newPRCollector(f, &now)
	g := &ancestorFake{} // the PR's head is not in this repository: is-ancestor fails
	c.run = g.run
	c.refreshPRs(context.Background(), "k", Remote{"github.com", "someone", "private"})
	c.repos["k"] = &Repo{key: "k", Worktrees: []Worktree{{Branch: "release", tip: tipB}, {Branch: "release", tip: "not-a-commit"}}}
	c.matchPRs(context.Background(), "k", `C:\repo`)
	repo, _ := c.forKey("k")
	assert.Nil(t, repo.Worktrees[0].PR, "same name, unknown head: nothing is shown")
	assert.Nil(t, repo.Worktrees[1].PR)
	assert.Len(t, g.calls, 1, "a tip that is not a commit id is never given to git")

	for _, args := range [][]string{{"merge-base", "--is-ancestor", "--end-of-options", headWip, tipB}} {
		assert.True(t, readAllowed(args), "%v", args)
	}
	for _, args := range [][]string{{"merge-base", "--is-ancestor", headWip, tipB}, {"merge-base", "--is-ancestor", "--end-of-options", "release", tipB},
		{"merge-base", "--fork-point", "--end-of-options", headWip, tipB}, {"merge-base", "--is-ancestor", "--end-of-options", "HEAD", tipB}} {
		assert.False(t, readAllowed(args), "%v", args)
	}
}

// Security's #6985 SHOULD 3 and INFO a: a rate limit or a missing sign-in pauses every repository's gh call for 15 minutes; a 403 that is not a rate limit pauses that repository only.
func TestGhPausesOnceForTheCollectorAndA403IsNotARateLimit(t *testing.T) {
	now := time.Date(2026, 11, 1, 8, 0, 0, 0, time.UTC)
	f := &ghFake{stderr: "HTTP 403: API rate limit exceeded for user"}
	c := newPRCollector(f, &now)
	a, b := Remote{"github.com", "o", "a"}, Remote{"github.com", "o", "b"}
	c.refreshPRs(context.Background(), "a", a)
	c.refreshPRs(context.Background(), "b", b)
	assert.Len(t, f.calls, 1, "the pause holds every repository's call")
	c.prs["b"].note = ""
	repo := withPRs(Repo{}, c.prs["b"], c.ghNote)
	assert.Equal(t, PRNotePaused, repo.PRNote, "shown on every repository")

	now = now.Add(prPause - time.Minute)
	c.refreshPRs(context.Background(), "b", b)
	assert.Len(t, f.calls, 1, "paused for 15 minutes")
	now = now.Add(2 * time.Minute)
	f.stderr = "To get started with GitHub CLI, please run:  gh auth login"
	c.refreshPRs(context.Background(), "b", b)
	assert.Len(t, f.calls, 2)
	assert.Equal(t, PRNoteSignIn, c.ghNote)
	assert.NotContains(t, c.ghNote, "gh auth", "gh's own words are never kept")
	c.refreshPRs(context.Background(), "a", a)
	assert.Len(t, f.calls, 2, "a missing sign-in pauses every repository too")

	now = now.Add(prPause + time.Minute)
	f.stderr = "HTTP 403: Resource not accessible by integration"
	c.refreshPRs(context.Background(), "a", a)
	assert.Equal(t, PRNoteNoAccess, c.prs["a"].note, "a 403 alone is a refusal, not a rate limit")
	assert.Empty(t, c.ghNote)
	f.stderr = ""
	f.out = "[]"
	c.refreshPRs(context.Background(), "b", b)
	assert.Len(t, f.calls, 4, "the other repository is still asked")
	c.refreshPRs(context.Background(), "a", a)
	assert.Len(t, f.calls, 4, "the refused one waits 15 minutes")
}

// ancestorFake answers merge-base --is-ancestor: yes for the head..tip pairs in yes, a failure otherwise.
type ancestorFake struct {
	yes   map[string]bool
	calls [][]string
}

func (g *ancestorFake) run(_ context.Context, _ string, args ...string) ([]byte, error) {
	g.calls = append(g.calls, args)
	if !readAllowed(args) {
		return nil, errNotRead
	}
	if len(args) == 5 && g.yes[args[3]+".."+args[4]] {
		return nil, nil
	}
	return nil, errors.New("exit status 1")
}

// forKey is For for repository key, by its first worktree's tip (the tests' repositories have no folders).
func (c *Collector) forKey(key string) (Repo, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	r := c.repos[key]
	if r == nil {
		return Repo{}, false
	}
	cp := *r
	cp.Worktrees = append([]Worktree(nil), r.Worktrees...)
	return withPRs(cp, c.prs[key], c.ghNote), true
}

const headWip = "ffffffffffffffffffffffffffffffffffffffff"

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

// The ancestor read on a real repository: a head in the branch's history is an ancestor, the tip is not an ancestor of its parent, and a commit the repository lacks is not one.
func TestTheAncestorReadIsGitsOwnAnswer(t *testing.T) {
	main, feature, _ := repoWithWorktrees(t)
	tip := runGit(t, feature, "rev-parse", "HEAD")
	parent := runGit(t, feature, "rev-parse", "HEAD~1")
	ctx := context.Background()
	_, err := readGit(ctx, main, "merge-base", "--is-ancestor", "--end-of-options", parent, tip)
	assert.NoError(t, err)
	_, err = readGit(ctx, main, "merge-base", "--is-ancestor", "--end-of-options", tip, parent)
	assert.Error(t, err)
	_, err = readGit(ctx, main, "merge-base", "--is-ancestor", "--end-of-options", headWip, tip)
	assert.Error(t, err, "a commit this repository does not have")
}
