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

// PR state from the GitHub CLI (Security's #6802 MUST 3 and #6804): one `gh pr list` per repository, only for a repository whose origin is on github.com, with -R built from that parsed
// remote and never the repository's own default; only while the repository's tab was read recently (the collector's wanted rule); at most every prEvery, with jitter, and at most
// prReposPerPass repositories a pass. gh uses its own sign-in (the operator's GitHub identity; Coral never reads, passes or stores a token) and gets a small environment with prompts
// off and no input. Only the state, draft, checks and review decision of each PR are kept: no title, body or author. gh's own messages are never shown or stored: a rate limit stops
// it for prPause ("PR status paused (rate limit)"), a missing sign-in says "PR status needs gh signed in" and is asked again after prPause, and no gh at all hides PR state.

const (
	prEvery        = 2 * time.Minute
	prJitter       = 20 * time.Second
	prPause        = 15 * time.Minute
	prReposPerPass = 10
	prLimit        = "50"
	ghTimeout      = 15 * time.Second
	ghLookEvery    = time.Hour

	PRNoteSignIn = "PR status needs gh signed in"
	PRNotePaused = "PR status paused (rate limit)"
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
	note   string
}

// ghArgs is the one command gh is run with, for owner/name.
func ghArgs(r Remote) []string {
	return []string{"pr", "list", "-R", r.Owner + "/" + r.Name, "--state", "all", "--limit", prLimit, "--json", prFields}
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

// ghFailure is what a failed gh run means for the tab: a rate limit pauses it, a missing sign-in says so; anything else is asked again at the next interval.
func ghFailure(stderr string) string {
	s := strings.ToLower(stderr)
	switch {
	case strings.Contains(s, "rate limit"), strings.Contains(s, "http 403"), strings.Contains(s, "http 429"):
		return PRNotePaused
	case strings.Contains(s, "gh auth login"), strings.Contains(s, "not logged"), strings.Contains(s, "authentication"), strings.Contains(s, "http 401"):
		return PRNoteSignIn
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
	due := !now.Before(st.next)
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
		note := ghFailure(stderr)
		st.note = note
		st.next = now.Add(prEvery)
		if note != "" {
			st.next = now.Add(prPause)
		}
		return
	}
	byOid, byName, ok := parsePRs(out)
	if !ok {
		st.next = now.Add(prEvery)
		return
	}
	st.byOid, st.byName, st.note = byOid, byName, ""
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

// withPRs is repo with each worktree's PR, from the PR state of its repository: by the worktree's head commit, else by its branch's name. A merged PR whose head is the worktree's own
// commit means its commits are in (a squash merge, which git cannot see): no commits left to merge.
func withPRs(repo Repo, st *prState) Repo {
	if st == nil {
		return repo
	}
	repo.PRNote = st.note
	for i := range repo.Worktrees {
		w := &repo.Worktrees[i]
		pr, ok := st.byOid[w.tip]
		if !ok && w.Branch != "" {
			pr, ok = st.byName[w.Branch]
		}
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
