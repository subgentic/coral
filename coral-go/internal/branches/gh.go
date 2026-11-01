package branches

import (
	"bytes"
	"context"
	"encoding/json"
	"math/rand/v2"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/executil"
)

// PR state from the GitHub CLI (Security's #6802 MUST 3, #6804 and #6985): one `gh pr list` per repository, only for a repository whose origin is on github.com, with -R built from that
// parsed remote, host included, and never the repository's own default or gh's default host; only while the repository's tab was read recently (the collector's wanted rule); at most every prEvery, with jitter, and at most
// prReposPerPass repositories a pass. gh uses its own sign-in (the operator's GitHub identity; Coral never reads, passes or stores a token) and gets a small environment with prompts
// off and no input. Only the state, draft, checks and review decision of each PR are kept: no title, body or author. gh's own messages are never shown or stored: a rate limit stops
// every gh call of the collector for prPause ("PR status paused (rate limit)"), a missing sign-in says "PR status needs gh signed in" and stops them for prPause too, a refusal (a 403
// that is not a rate limit) stops that repository's for prPause ("PR status not available"), and no gh at all hides PR state.
//
// A PR is shown for a worktree by commit only (matchPRs): its head is the worktree's tip, or its branch's name matches and its head is an ancestor of the tip. Its state is the
// operator's GitHub identity's view, so it is shown only for commits the repository already has.

const (
	prEvery        = 2 * time.Minute
	prJitter       = 20 * time.Second
	prPause        = 15 * time.Minute
	prReposPerPass = 10
	prLimit        = "50"
	ghTimeout      = 15 * time.Second
	ghLookEvery    = time.Hour

	PRNoteSignIn   = "PR status needs gh signed in"
	PRNotePaused   = "PR status paused (rate limit)"
	PRNoteNoAccess = "PR status not available"
)

// prHosts are the hosts PR state is asked for: github.com only.
var prHosts = map[string]bool{"github.com": true}

// prFields are the only fields asked of gh.
const prFields = "number,headRefName,headRefOid,state,isDraft,reviewDecision,statusCheckRollup"

// PR is one pull request's state, as the tab shows it.
type PR struct {
	Number int    `json:"number"`
	State  string `json:"state"`            // open, merged, closed
	Draft  bool   `json:"draft,omitempty"`  // an open draft
	Checks string `json:"checks,omitempty"` // passing, failing, pending, or "" when it has none
	Review string `json:"review,omitempty"` // approved, changes_requested, review_required, or ""
	oid    string // the PR's head commit
}

// prState is one repository's PR state.
type prState struct {
	next   time.Time // when to ask again
	byOid  map[string]PR
	byName map[string]PR
	note   string          // this repository's own note (PRNoteNoAccess); the collector-wide one is Collector.ghNote
	match  map[string]PR   // each worktree's PR, by matchKey: what withPRs shows
	anc    map[string]bool // ancestor answers (PR head..tip), kept until the next gh answer
}

// matchKey is a worktree's key in prState.match.
func matchKey(w Worktree) string { return w.Branch + "\x00" + w.tip }

// ghArgs is the one command gh is run with, for owner/name.
func ghArgs(r Remote) []string {
	return []string{"pr", "list", "-R", r.Host + "/" + r.Owner + "/" + r.Name, "--state", "all", "--limit", prLimit, "--json", prFields}
}

// ghEnv is gh's whole environment: what it needs to find itself and its sign-in, and nothing of the repository's or Coral's.
func ghEnv() []string {
	env := []string{"GH_PROMPT_DISABLED=1", "GH_NO_UPDATE_NOTIFIER=1", "NO_COLOR=1"}
	for _, k := range []string{"PATH", "SystemRoot", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "GH_CONFIG_DIR", "GH_TOKEN", "GITHUB_TOKEN", "TEMP", "TMP"} {
		if v, ok := os.LookupEnv(k); ok {
			env = append(env, k+"="+v)
		}
	}
	return env
}

// runGh runs gh at path with args: no input, a hidden console on Windows, ghTimeout. Its error output is returned only to be classified (ghFailure), never kept.
func runGh(ctx context.Context, path string, args ...string) ([]byte, string, error) {
	ctx, cancel := context.WithTimeout(ctx, ghTimeout)
	defer cancel()
	cmd := executil.Command(ctx, path, args...)
	cmd.Env = ghEnv()
	cmd.Stdin = nil
	var out, errOut bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errOut
	err := cmd.Run()
	return out.Bytes(), errOut.String(), err
}

// ghFailure is what a failed gh run means for the tab: a rate limit pauses it, a missing sign-in says so, a 403 that is not a rate limit is that repository's refusal (Security's #6985
// INFO a); anything else is asked again at the next interval.
func ghFailure(stderr string) string {
	s := strings.ToLower(stderr)
	switch {
	case strings.Contains(s, "rate limit"), strings.Contains(s, "http 429"):
		return PRNotePaused
	case strings.Contains(s, "gh auth login"), strings.Contains(s, "not logged"), strings.Contains(s, "authentication"), strings.Contains(s, "http 401"):
		return PRNoteSignIn
	case strings.Contains(s, "http 403"):
		return PRNoteNoAccess
	}
	return ""
}

// ghPath is gh's absolute path, looked up at most every ghLookEvery; "" when it is not installed.
func (c *Collector) ghPath() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.now().Sub(c.ghLooked) < ghLookEvery && !c.ghLooked.IsZero() {
		return c.ghFound
	}
	c.ghLooked = c.now()
	c.ghFound = ""
	if p, err := exec.LookPath("gh"); err == nil {
		c.ghFound = p
	}
	return c.ghFound
}

// refreshPRs asks gh for the PR state of the repository key (origin r) when it is due, and keeps what it answers.
func (c *Collector) refreshPRs(ctx context.Context, key string, r Remote) {
	if !prHosts[r.Host] {
		return
	}
	now := c.now()
	c.mu.Lock()
	st := c.prs[key]
	if st == nil {
		st = &prState{}
		c.prs[key] = st
	}
	due := !now.Before(st.next) && !now.Before(c.ghPause) // one pause for every repository: a rate limit or a sign-in is the operator's, not a repository's
	c.mu.Unlock()
	if !due {
		return
	}
	path := c.ghPath()
	if path == "" {
		c.mu.Lock()
		st.next, st.note, st.byOid, st.byName = now.Add(prPause), "", nil, nil // no gh: PR state is hidden
		c.mu.Unlock()
		return
	}
	out, stderr, err := c.gh(ctx, path, ghArgs(r)...)
	c.mu.Lock()
	defer c.mu.Unlock()
	if err != nil {
		st.next = now.Add(prEvery)
		switch note := ghFailure(stderr); note {
		case PRNotePaused, PRNoteSignIn:
			c.ghPause, c.ghNote = now.Add(prPause), note
		case PRNoteNoAccess: // gh was answered, signed in: only this repository is refused
			c.ghNote = ""
			st.next, st.note, st.byOid, st.byName, st.match, st.anc = now.Add(prPause), note, nil, nil, nil, nil
		}
		return
	}
	byOid, byName, ok := parsePRs(out)
	if !ok {
		st.next = now.Add(prEvery)
		return
	}
	c.ghNote = ""
	st.byOid, st.byName, st.note, st.anc = byOid, byName, "", nil
	st.next = now.Add(prEvery + time.Duration(rand.Int64N(int64(prJitter))))
}

// parsePRs reads gh's JSON: each PR's state, by its head commit and by its head branch's name (the newest PR of a name wins: gh lists newest first).
func parsePRs(out []byte) (map[string]PR, map[string]PR, bool) {
	var raw []struct {
		Number         int    `json:"number"`
		HeadRefName    string `json:"headRefName"`
		HeadRefOid     string `json:"headRefOid"`
		State          string `json:"state"`
		IsDraft        bool   `json:"isDraft"`
		ReviewDecision string `json:"reviewDecision"`
		Checks         []struct {
			Status     string `json:"status"`
			Conclusion string `json:"conclusion"`
			State      string `json:"state"`
		} `json:"statusCheckRollup"`
	}
	if err := json.Unmarshal(out, &raw); err != nil {
		return nil, nil, false
	}
	byOid, byName := map[string]PR{}, map[string]PR{}
	for _, p := range raw {
		pr := PR{Number: p.Number, Draft: p.IsDraft, oid: p.HeadRefOid}
		switch p.State {
		case "OPEN":
			pr.State = "open"
		case "MERGED":
			pr.State = "merged"
		case "CLOSED":
			pr.State = "closed"
		default:
			continue
		}
		switch p.ReviewDecision {
		case "APPROVED":
			pr.Review = "approved"
		case "CHANGES_REQUESTED":
			pr.Review = "changes_requested"
		case "REVIEW_REQUIRED":
			pr.Review = "review_required"
		}
		failing, pending := false, false
		for _, ck := range p.Checks {
			v := strings.ToUpper(ck.Conclusion + " " + ck.State + " " + ck.Status)
			switch {
			case strings.Contains(v, "FAILURE"), strings.Contains(v, "ERROR"), strings.Contains(v, "TIMED_OUT"), strings.Contains(v, "CANCELLED"), strings.Contains(v, "ACTION_REQUIRED"):
				failing = true
			case strings.Contains(v, "PENDING"), strings.Contains(v, "IN_PROGRESS"), strings.Contains(v, "QUEUED"), strings.Contains(v, "WAITING"):
				pending = true
			}
		}
		switch {
		case failing:
			pr.Checks = "failing"
		case pending:
			pr.Checks = "pending"
		case len(p.Checks) > 0:
			pr.Checks = "passing"
		}
		if validSHA(p.HeadRefOid) {
			if _, seen := byOid[p.HeadRefOid]; !seen {
				byOid[p.HeadRefOid] = pr
			}
		}
		if name := cleanName(p.HeadRefName); name != "" && name == p.HeadRefName {
			if _, seen := byName[name]; !seen {
				byName[name] = pr
			}
		}
	}
	return byOid, byName, true
}

// matchPRs finds each worktree's PR in repository key (read in root) by commit only (Security's #6985 SHOULD 1): the PR whose head is the worktree's tip, else the PR of the branch's
// name when its head is an ancestor of the tip (merge-base --is-ancestor, commit ids only). A name alone never shows a PR: its head must be in the worktree's own history.
func (c *Collector) matchPRs(ctx context.Context, key, root string) {
	type check struct {
		k, oid, tip string
		pr          PR
	}
	c.mu.Lock()
	st, r := c.prs[key], c.repos[key]
	if st == nil || r == nil {
		c.mu.Unlock()
		return
	}
	match := map[string]PR{}
	var checks []check
	for _, w := range r.Worktrees {
		if !validSHA(w.tip) {
			continue
		}
		if pr, ok := st.byOid[w.tip]; ok {
			match[matchKey(w)] = pr
			continue
		}
		pr, ok := st.byName[w.Branch]
		if !ok || w.Branch == "" || !validSHA(pr.oid) {
			continue
		}
		if is, known := st.anc[pr.oid+".."+w.tip]; known {
			if is {
				match[matchKey(w)] = pr
			}
			continue
		}
		checks = append(checks, check{matchKey(w), pr.oid, w.tip, pr})
	}
	c.mu.Unlock()
	found := map[string]bool{}
	for _, ck := range checks {
		_, err := c.run(ctx, root, "merge-base", "--is-ancestor", "--end-of-options", ck.oid, ck.tip)
		if ctx.Err() != nil {
			break // out of time: asked again next pass, never taken for a "no"
		}
		found[ck.oid+".."+ck.tip] = err == nil // a head this repository does not have is not an ancestor
		if err == nil {
			match[ck.k] = ck.pr
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.prs[key] != st {
		return
	}
	if st.anc == nil {
		st.anc = map[string]bool{}
	}
	for k, v := range found {
		st.anc[k] = v
	}
	st.match = match
}

// withPRs is repo with each worktree's PR, as matchPRs found it, and the note of why PR state is not shown (ghNote, the collector's, else the repository's). A merged PR whose head is
// the worktree's own commit means its commits are in (a squash merge, which git cannot see): no commits left to merge.
func withPRs(repo Repo, st *prState, ghNote string) Repo {
	if st == nil {
		return repo
	}
	repo.PRNote = ghNote
	if repo.PRNote == "" {
		repo.PRNote = st.note
	}
	for i := range repo.Worktrees {
		w := &repo.Worktrees[i]
		pr, ok := st.match[matchKey(*w)]
		if !ok {
			continue
		}
		p := pr
		w.PR = &p
		if pr.State == "merged" && pr.oid == w.tip && w.tip != "" {
			w.NothingToMerge = true
		}
	}
	return repo
}
