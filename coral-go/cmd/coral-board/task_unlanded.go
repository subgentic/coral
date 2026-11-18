package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/clierr"
	"github.com/subgentic/coral/internal/clitext"
	"github.com/subgentic/coral/internal/gitutil"
)

// task unlanded (#18240): the tasks approved in a window whose head commit is not on main (or a named trial), so approved work cannot silently miss a release. Read-only: it reads the board and asks git
// "is this commit an ancestor of the ref" in the repository it is run in; it writes nothing to either.

var (
	unlandedHeadRe = regexp.MustCompile(`(?i)\bhead\b[^0-9a-f]{0,3}([0-9a-f]{7,40})\b`)
	unlandedHexRe  = regexp.MustCompile(`\b[0-9a-f]{7,40}\b`)
)

// headSHAFromText is the commit a task was submitted at: the hex word after "head" in the submit message or reason. Without a "head <sha>" it takes the first commit-looking word (7 to 40 hex digits holding a
// letter and a digit; a plain word like "effaced" is not one) that follows "at", "commit" or "sha" and nothing else (an allow list, #18302: "rebased <sha>" or "branched from <sha>" name someone else's commit, and a
// base taken for the head would show the task as landed). "" when there is none.
func headSHAFromText(texts ...string) string {
	for _, t := range texts {
		if m := unlandedHeadRe.FindStringSubmatch(t); m != nil && hasLetterAndDigit(m[1]) {
			return strings.ToLower(m[1])
		}
	}
	for _, t := range texts {
		low := strings.ToLower(t)
		for _, loc := range unlandedHexRe.FindAllStringIndex(low, -1) {
			w := low[loc[0]:loc[1]]
			if !hasLetterAndDigit(w) {
				continue
			}
			prev := strings.Fields(strings.Trim(low[:loc[0]], " \t([`'\""))
			if len(prev) == 0 {
				continue
			}
			word := strings.Trim(prev[len(prev)-1], ":,;.([`'\"")
			if !headWords[word] {
				continue
			}
			if word == "at" && len(prev) > 1 && baseVerbs[strings.Trim(prev[len(prev)-2], ":,;.([`'\"")] {
				continue // "branched at <sha>" is where the work started, not where it is
			}
			return w
		}
	}
	return ""
}

// baseVerbs put "at <sha>" on the commit the work started from (#18302).
var baseVerbs = map[string]bool{"branched": true, "based": true, "rebased": true, "forked": true, "cut": true, "stacked": true, "merged": true, "started": true, "built": true, "branch": true, "base": true}

// headWords are the only words that put a commit's name in front of the work itself.
var headWords = map[string]bool{"at": true, "commit": true, "sha": true, "revision": true, "rev": true, "@": true, "pushed": true}

func hasLetterAndDigit(s string) bool {
	return strings.Trim(s, "0123456789") != "" && strings.Trim(s, "abcdef") != ""
}

// unlandedTask is one row of the answer.
type unlandedTask struct {
	ID    int64  `json:"id"`
	SHA   string `json:"sha"`
	Title string `json:"title"`
	Why   string `json:"why,omitempty"` // "not on <ref>", "no head SHA recorded" or "commit not in this repository"
}

// landedState says whether a commit is on the ref: landed, not landed, or unknown to the repository.
type landedState int

const (
	stateLanded landedState = iota
	stateNotLanded
	stateUnknown
)

// landedCheck is what findUnlanded asks of git (nil funcs say no). A head on the ref by ancestry is landed; so is one whose commits all came onto the ref as picks (a cherry-pick or a rebase changes the SHA
// and not the patch: Picked) and one the ref's log names (a trial's "Merge <sha> into the trial (#N)": Named). Picked and Named are asked only when the ancestry says no (#18373).
type landedCheck struct {
	Landed func(sha string) landedState
	Picked func(sha string) bool
	Named  func(id int64) bool
	// Pushed says whether any remote branch holds the commit; nil, or a repository with no remote branches, says nothing (#19603).
	Pushed func(sha string) bool
}

var approvedSHARe = regexp.MustCompile(`(?i)\bapproved\s+([0-9a-f]{7,40})\b`)

// approvedSHA is the commit the last approval named ("Approved <sha>" in a reviewer's note of the latest round that ended approved): what was approved, which is what must reach the release, not the first
// head a submit named (#18373). "" when no verdict names one.
func approvedSHA(d map[string]any) string {
	wf, _ := d["workflow"].(map[string]any)
	rounds, _ := wf["review_rounds"].([]any)
	for i := len(rounds) - 1; i >= 0; i-- {
		r, _ := rounds[i].(map[string]any)
		if res, _ := r["result"].(string); res != "approved" {
			continue
		}
		revs, _ := r["reviewers"].([]any)
		for j := len(revs) - 1; j >= 0; j-- {
			rv, _ := revs[j].(map[string]any)
			note, _ := rv["note"].(string)
			if m := approvedSHARe.FindStringSubmatch(note); m != nil && hasLetterAndDigit(m[1]) {
				return strings.ToLower(m[1])
			}
		}
	}
	return ""
}

var fullSHARe = regexp.MustCompile(`^[0-9a-fA-F]{7,40}$`)

// fieldHead is the head the board's own fields name when the submit text names none (#19603): the revision of an artifact the submit attached (an author's own word, so before the board's record), then the
// head the board recorded at the submit (workflow.submitted_head, which is set by --head and can be the repository's head when it is not).
func fieldHead(wf, cr map[string]any) string {
	arts, _ := cr["artifacts"].([]any)
	for _, a := range arts {
		if m, _ := a.(map[string]any); m != nil {
			if rev, _ := m["revision"].(string); fullSHARe.MatchString(rev) && hasLetterAndDigit(strings.ToLower(rev)) {
				return strings.ToLower(rev)
			}
		}
	}
	if h, _ := wf["submitted_head"].(string); fullSHARe.MatchString(h) && hasLetterAndDigit(strings.ToLower(h)) {
		return strings.ToLower(h)
	}
	return ""
}

// titleLine is a task title as one printable line: a title is another agent's text, so control sequences go (clitext.Clean) and a newline cannot start a fake row (#18191).
func titleLine(s string) string {
	return strings.Join(strings.Fields(clitext.Clean(s)), " ")
}

// markedLanded is whether the task's workflow holds a mark-landed record: an artifact the orchestrator stamped landed (a patch by digest, or a landed commit).
func markedLanded(wf map[string]any) bool {
	arts, _ := wf["artifacts"].([]any)
	for _, a := range arts {
		if m, _ := a.(map[string]any); m != nil {
			if at, _ := m["landed_at"].(string); at != "" {
				return true
			}
		}
	}
	return false
}

// unlandCounts is what the check did with the reviewed submits of the window, so a reader sees what the list leaves out and why (#18191): the submits checked, and how many were skipped as marked landed on the board,
// counted as picks (same patch under another SHA) or counted as named (the ref's log names the task).
type unlandCounts struct {
	Checked, MarkedLanded, Picked, Named int
}

// findUnlanded keeps the successful, completed tasks of the window whose head commit is not on the ref. detail reads one task in full; check asks git. The head is the SHA of the last approval, else of the latest submit (#18373). Oldest first.
func findUnlanded(tasks []map[string]any, since time.Time, ref string, detail func(id int64) (map[string]any, error), check landedCheck) ([]unlandedTask, error) {
	out, _, err := findUnlandedCounted(tasks, since, ref, detail, check)
	return out, err
}

// findUnlandedCounted is findUnlanded and the counts of what it skipped.
func findUnlandedCounted(tasks []map[string]any, since time.Time, ref string, detail func(id int64) (map[string]any, error), check landedCheck) ([]unlandedTask, unlandCounts, error) {
	var out []unlandedTask
	var n unlandCounts
	for _, t := range tasks {
		if s, _ := t["status"].(string); s != "completed" {
			continue
		}
		if o, _ := t["outcome"].(string); o != "success" {
			continue
		}
		if at, _ := t["completed_at"].(string); at != "" {
			if ts, err := time.Parse(time.RFC3339, at); err == nil && ts.Before(since) {
				continue
			}
		}
		idf, _ := t["id"].(float64)
		id := int64(idf)
		title, _ := t["title"].(string)
		if strings.HasPrefix(title, "Review #") {
			continue // a review task is a verdict on another task's commit, not work of its own
		}
		if rv, _ := t["reviewers"].([]any); len(rv) == 0 {
			continue // not a code submit: nothing went through review, so there is no commit to find on the ref (#18191)
		}
		title = titleLine(title)
		d, err := detail(id)
		if err != nil {
			return nil, n, fmt.Errorf("task #%d: %w", id, err)
		}
		wf, _ := d["workflow"].(map[string]any)
		if _, isReview := wf["review_of"]; isReview {
			continue
		}
		n.Checked++
		if markedLanded(wf) {
			n.MarkedLanded++
			continue // the orchestrator recorded it landed (mark-landed): the board's word stands (#18191)
		}
		cr, _ := wf["completion_review"].(map[string]any)
		sha := approvedSHA(d)
		if sha == "" {
			msg, _ := cr["message"].(string)
			reason, _ := cr["reason"].(string)
			sha = headSHAFromText(msg, reason)
		}
		if sha == "" {
			sha = fieldHead(wf, cr) // the board's own fields, when the submit text names no commit (#19603)
		}
		if sha == "" {
			out = append(out, unlandedTask{ID: id, Title: title, Why: "no head SHA recorded"})
			continue
		}
		state := check.Landed(sha)
		if state != stateLanded && check.Named != nil && check.Named(id) {
			n.Named++
			continue // the ref's log names the task: it came in as a merge or a pick
		}
		if state == stateNotLanded && check.Picked != nil && check.Picked(sha) {
			n.Picked++
			continue // every commit of its range is on the ref under another SHA
		}
		switch state {
		case stateNotLanded:
			if check.Pushed != nil && !check.Pushed(sha) {
				out = append(out, unlandedTask{ID: id, SHA: sha, Title: title, Why: "no remote branch holds it (never pushed)"})
				continue
			}
			out = append(out, unlandedTask{ID: id, SHA: sha, Title: title, Why: "not on " + ref})
		case stateUnknown:
			out = append(out, unlandedTask{ID: id, SHA: sha, Title: title, Why: "commit not in this repository (git fetch it)"})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, n, nil
}

// gitLanded asks git, in dir, whether sha is an ancestor of ref (read-only: merge-base --is-ancestor writes nothing).
func gitLanded(dir, ref string) func(sha string) landedState {
	return func(sha string) landedState {
		if gitutil.Command(context.Background(), dir, "cat-file", "-e", sha+"^{commit}").Run() != nil {
			return stateUnknown
		}
		err := gitutil.Command(context.Background(), dir, "merge-base", "--is-ancestor", sha, ref).Run()
		if err == nil {
			return stateLanded
		}
		var ee *exec.ExitError
		if errors.As(err, &ee) && ee.ExitCode() == 1 {
			return stateNotLanded
		}
		return stateUnknown
	}
}

// subjectTaskRe is the one way a subject names a task that landed: "(#N)" at its end, which both a squash and a trial's "Merge <sha> into the trial (#N)" carry. A "#N" elsewhere in a subject is a mention, and a Revert
// takes work off the ref, so neither lands the task (#18191).
var subjectTaskRe = regexp.MustCompile(`\(#(\d+)\)\s*$`)

func namedInSubject(line string) (int64, bool) {
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(line)), "revert") {
		return 0, false
	}
	m := subjectTaskRe.FindStringSubmatch(line)
	if m == nil {
		return 0, false
	}
	n, err := strconv.ParseInt(m[1], 10, 64)
	return n, err == nil
}

// gitChecks is gitLanded plus the two ways a pick shows on the ref (#18373), both read-only.
//   - Named: the task numbers in the subject lines of the ref's commits (a trial's merge subject carries "(#18082)"); only subjects, so a body that says "follows #17452" does not land #17452.
//   - Picked: every commit of ref..sha (merges left out) has the patch-id (git patch-id --stable) of some commit between the merge-base and the ref. A range with no patch at all is not a pick.
func gitChecks(dir, ref string) landedCheck {
	run := func(stdin []byte, args ...string) (string, bool) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		cmd := gitutil.Command(ctx, dir, args...)
		if stdin != nil {
			cmd.Stdin = bytes.NewReader(stdin)
		}
		out, err := cmd.Output()
		return string(out), err == nil
	}
	var named map[int64]bool
	// The sets are read once each (#19603): every head used to cost a process for "is it a commit here", one for ancestry and one for "is it on a remote branch", and a git process is most of what a head cost.
	hashes := func(args ...string) map[string]bool {
		set := map[string]bool{}
		if out, ok := run(nil, append([]string{"rev-list"}, args...)...); ok {
			for _, h := range strings.Fields(out) {
				set[h] = true
			}
		}
		return set
	}
	var onRef, onRemote map[string]bool
	var byPrefix map[string][]string // every commit of every ref, by its first 7 digits
	resolve := func(sha string) string {
		if byPrefix == nil {
			byPrefix = map[string][]string{}
			for h := range hashes("--all") {
				byPrefix[h[:7]] = append(byPrefix[h[:7]], h)
			}
		}
		var found []string
		for _, h := range byPrefix[strings.ToLower(sha)[:7]] {
			if strings.HasPrefix(h, strings.ToLower(sha)) {
				found = append(found, h)
			}
		}
		if len(found) == 1 {
			return found[0]
		}
		return "" // not on any ref here, or ambiguous: git decides
	}
	slowLanded := gitLanded(dir, ref)
	return landedCheck{
		Landed: func(sha string) landedState {
			full := resolve(sha)
			if full == "" {
				return slowLanded(sha) // a commit no ref holds, or a name that is ambiguous
			}
			if onRef == nil {
				onRef = hashes(ref)
			}
			if onRef[full] {
				return stateLanded
			}
			return stateNotLanded
		},
		Pushed: func(sha string) bool {
			if onRemote == nil {
				onRemote = hashes("--remotes")
			}
			if len(onRemote) == 0 {
				return true // no remote branches here: this repository cannot say
			}
			full := resolve(sha)
			return full == "" || onRemote[full]
		},
		Named: func(id int64) bool {
			if named == nil {
				named = map[int64]bool{}
				if out, ok := run(nil, "log", "--format=%s", "--max-count=20000", ref); ok {
					for _, line := range strings.Split(out, "\n") {
						if n, ok := namedInSubject(line); ok {
							named[n] = true
						}
					}
				}
			}
			return named[id]
		},
		Picked: func(sha string) bool {
			// One cheap count, then one git cherry (a single process: it marks each commit of ref..sha "-" when a commit of the ref holds the same patch, "+" when none does; merges are left out). A range with no
			// patch at all prints nothing and is not a pick (#19603: the old patch-id pipeline took 0.3 s a head).
			// An empty commit has the empty patch, which another empty commit of the ref "matches": a head with nothing but those carries no work (the pathspec drops the commits that change no file).
			if n, ok := run(nil, "rev-list", "--count", "--no-merges", ref+".."+sha, "--", ":/"); !ok || strings.TrimSpace(n) == "0" {
				return false
			}
			out, ok := run(nil, "cherry", ref, sha)
			if !ok {
				return false
			}
			lines := 0
			for _, line := range strings.Split(out, "\n") {
				if line = strings.TrimSpace(line); line == "" {
					continue
				}
				if !strings.HasPrefix(line, "- ") {
					return false
				}
				lines++
			}
			return lines > 0
		},
	}
}

// parseSince reads a window: 12h, 7d or 2w.
func parseSince(s string) (time.Duration, error) {
	if len(s) < 2 {
		return 0, fmt.Errorf("--since needs a window like 12h, 7d or 2w (got %q)", s)
	}
	n, err := strconv.Atoi(s[:len(s)-1])
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("--since needs a window like 12h, 7d or 2w (got %q)", s)
	}
	switch s[len(s)-1] {
	case 'h':
		return time.Duration(n) * time.Hour, nil
	case 'd':
		return time.Duration(n) * 24 * time.Hour, nil
	case 'w':
		return time.Duration(n) * 7 * 24 * time.Hour, nil
	}
	return 0, fmt.Errorf("--since needs a window like 12h, 7d or 2w (got %q)", s)
}

func cmdTaskUnlanded(st *boardState, args []string) {
	ref, since, repo, asJSON := "main", "7d", ".", false
	for i := 0; i < len(args); i++ {
		name, value, inline := strings.Cut(args[i], "=")
		take := func() string {
			if inline {
				return value
			}
			if i+1 < len(args) {
				i++
				return args[i]
			}
			return ""
		}
		switch name {
		case "--json":
			asJSON = true
		case "--ref":
			ref = take()
		case "--since":
			since = take()
		case "--repo":
			repo = take()
		default:
			fmt.Fprintln(os.Stderr, "usage: coral-board task unlanded [--ref main] [--since 7d] [--repo DIR] [--json]")
			os.Exit(clierr.ExitUsage)
		}
	}
	window, err := parseSince(since)
	if err != nil || ref == "" || strings.HasPrefix(ref, "-") {
		if err == nil {
			err = fmt.Errorf("--ref needs a branch or commit name")
		}
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(clierr.ExitUsage)
	}
	if gitutil.Command(context.Background(), repo, "rev-parse", "--verify", "--quiet", ref+"^{commit}").Run() != nil {
		fmt.Fprintf(os.Stderr, "%s is not a commit in %s: run this where the repository is, or name it with --repo and --ref\n", ref, repo)
		clierr.Exit1()
	}
	detail := func(id int64) (map[string]any, error) {
		data, status, err := apiCallRaw("GET", fmt.Sprintf("/%s/tasks/%d", url.PathEscape(st.Project), id), nil)
		if err != nil || status != http.StatusOK {
			return nil, fmt.Errorf("%s", clierr.Describe(err, status, data))
		}
		var m map[string]any
		return m, json.Unmarshal(data, &m)
	}
	rows, counts, err := findUnlandedCounted(fetchTasks(st, 0), time.Now().Add(-window), ref, detail, gitChecks(repo, ref))
	if err != nil {
		fmt.Fprintln(os.Stderr, "Unable to read tasks: "+err.Error())
		clierr.Exit1()
	}
	if asJSON {
		if rows == nil {
			rows = []unlandedTask{}
		}
		out, _ := json.MarshalIndent(rows, "", "  ")
		fmt.Println(string(out))
		return
	}
	for _, r := range rows {
		sha := r.SHA
		if sha == "" {
			sha = "-"
		}
		fmt.Printf("#%-5d %-12s %s  (%s)\n", r.ID, sha, clitext.Clean(r.Title), r.Why)
	}
	fmt.Printf("%d approved task(s) in the last %s are not on %s (checked %d: %d marked landed, %d picked, %d named on the ref).\n", len(rows), since, ref, counts.Checked, counts.MarkedLanded, counts.Picked, counts.Named)
}
