package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/clierr"
	"github.com/subgentic/coral/internal/clitext"
	"github.com/subgentic/coral/internal/gitutil"
)

// task unlanded is the landing check (#18181): every reviewed completed task whose commit is not an ancestor of main. Read-only: it reads the board and runs git in the repository.

const unlandedUsage = `task unlanded [--since YYYY-MM-DD] [--main REF] [--repo DIR] [--json]
  Lists the code submits (completed tasks that went through review) since DATE (default: 14 days ago) whose commit is not on main: the commit named in the
  task's submit reason, note or completion message, else the head of a branch whose name holds the task's id.
  Prints the task, the commit and the branch; a task with no commit to check is counted, not listed, and so is one the
  orchestrator marked landed (mark-landed).
  --main is the ref a commit must be an ancestor of, or have its subject on (default origin/main); --repo is the checkout git runs in (default: here).`

var hexWordRe = regexp.MustCompile(`\b[0-9a-f]{7,40}\b`)

// shaCandidates are the hex words (7 to 40 digits) in text, in order, that could be a commit.
func shaCandidates(text string) []string {
	var out []string
	for _, w := range hexWordRe.FindAllString(strings.ToLower(text), -1) {
		if strings.Trim(w, "0123456789") == "" { // all digits: a number, not a commit
			continue
		}
		out = append(out, w)
	}
	return out
}

// landTask is a completed task as the check needs it.
type landTask struct {
	ID    int64
	Title string
	Texts []string // the author's words, in order of trust: submit reason, submit note, completion message
	// Landed: the orchestrator recorded it landed (mark-landed): the board says so, whatever git shows on this ref (#18191).
	Landed bool
}

// unlandedRow is a completed task whose commit is not on main.
type unlandedRow struct {
	Task   int64  `json:"task"`
	Title  string `json:"title"`
	SHA    string `json:"sha"`
	Branch string `json:"branch,omitempty"`
}

// gitRun runs git in repo and answers its trimmed stdout and whether it succeeded.
func gitRun(ctx context.Context, repo string, args ...string) (string, bool) {
	out, err := gitutil.Command(ctx, repo, args...).Output()
	return strings.TrimSpace(string(out)), err == nil
}

// resolveCommit is the full id of the commit the word names in repo, or "".
func resolveCommit(ctx context.Context, repo, word string) string {
	full, ok := gitRun(ctx, repo, "rev-parse", "--verify", "--quiet", word+"^{commit}")
	if !ok {
		return ""
	}
	return full
}

var numberRe = regexp.MustCompile(`[0-9]+`)

// branchIndex lists the remote branches once (there are thousands) and indexes them by every whole number in their name (fix-17655, fd2-17632-file-download): task id to branch name to head commit.
func branchIndex(ctx context.Context, repo string) map[int64]map[string]string {
	out, ok := gitRun(ctx, repo, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/remotes/origin")
	idx := map[int64]map[string]string{}
	if !ok {
		return idx
	}
	for _, line := range strings.Split(out, "\n") {
		name, sha, found := strings.Cut(line, " ")
		if !found {
			continue
		}
		for _, n := range numberRe.FindAllString(name, -1) {
			id, err := strconv.ParseInt(n, 10, 64)
			if err != nil || id < 100 {
				continue
			}
			if idx[id] == nil {
				idx[id] = map[string]string{}
			}
			idx[id][name] = sha
		}
	}
	return idx
}

// findUnlanded checks each task: the last commit its texts name (and that git knows) must be an ancestor of mainRef; a task naming none is checked by the heads of its branches. checked is how many tasks had something to check.
func findUnlanded(ctx context.Context, repo, mainRef string, tasks []landTask) (rows []unlandedRow, checked int) {
	branches := branchIndex(ctx, repo)
	subjects := map[string]bool{} // work lands by cherry-pick or rebase under a new id: a commit with the same subject on main is the same work
	if out, ok := gitRun(ctx, repo, "log", "--format=%s", mainRef); ok {
		for _, line := range strings.Split(out, "\n") {
			subjects[line] = true
		}
	}
	onMain := func(sha string) bool {
		if _, ok := gitRun(ctx, repo, "merge-base", "--is-ancestor", sha, mainRef); ok {
			return true
		}
		subj, ok := gitRun(ctx, repo, "log", "-1", "--format=%s", sha)
		return ok && subj != "" && subjects[subj]
	}
	for _, t := range tasks {
		if t.Landed {
			checked++
			continue // recorded landed on the board (mark-landed): not listed, whatever this ref holds
		}
		var sha string
		for _, text := range t.Texts {
			for _, w := range shaCandidates(text) {
				if full := resolveCommit(ctx, repo, w); full != "" {
					sha = full
				}
			}
			if sha != "" {
				break // the first text that names a commit is the author's own submit
			}
		}
		if sha != "" {
			checked++
			if !onMain(sha) {
				row := unlandedRow{Task: t.ID, Title: titleLine(t.Title), SHA: sha}
				for name, head := range branches[t.ID] {
					if head == sha {
						row.Branch = strings.TrimPrefix(name, "origin/")
					}
				}
				rows = append(rows, row)
			}
			continue
		}
		heads := branches[t.ID]
		if len(heads) == 0 {
			continue
		}
		checked++
		names := make([]string, 0, len(heads))
		for n := range heads {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			if !onMain(heads[n]) {
				rows = append(rows, unlandedRow{Task: t.ID, Title: titleLine(t.Title), SHA: heads[n], Branch: strings.TrimPrefix(n, "origin/")})
			}
		}
	}
	return rows, checked
}

// titleLine is a task title as one printable line: a title is another agent's text, so control sequences go (clitext.Clean) and a newline cannot start a fake row.
func titleLine(s string) string {
	return strings.Join(strings.Fields(clitext.Clean(s)), " ")
}

// unlandedArgs reads the options of task unlanded.
func unlandedArgs(args []string) (since time.Time, mainRef, repo string, asJSON bool, err error) {
	since, mainRef = time.Now().AddDate(0, 0, -14), "origin/main"
	for i := 0; i < len(args); i++ {
		name, value, inline := strings.Cut(args[i], "=")
		next := func() (string, bool) {
			if inline {
				return value, true
			}
			if i+1 < len(args) {
				i++
				return args[i], true
			}
			return "", false
		}
		switch name {
		case "--json":
			asJSON = true
		case "--since":
			v, ok := next()
			d, perr := time.Parse("2006-01-02", v)
			if !ok || perr != nil {
				return since, mainRef, repo, asJSON, fmt.Errorf("--since needs a date like 2026-11-08 (got %q)", v)
			}
			since = d
		case "--main":
			v, ok := next()
			if !ok || v == "" || strings.HasPrefix(v, "-") {
				return since, mainRef, repo, asJSON, fmt.Errorf("--main needs a ref such as origin/main")
			}
			mainRef = v
		case "--repo":
			v, ok := next()
			if !ok || v == "" {
				return since, mainRef, repo, asJSON, fmt.Errorf("--repo needs a folder")
			}
			repo = v
		default:
			return since, mainRef, repo, asJSON, fmt.Errorf("unknown option %q", args[i])
		}
	}
	return since, mainRef, repo, asJSON, nil
}

// cmdTaskUnlanded is coral-board task unlanded.
func cmdTaskUnlanded(st *boardState, args []string) {
	for _, a := range args {
		if a == "--help" || a == "-h" {
			fmt.Println(unlandedUsage)
			return
		}
	}
	since, mainRef, repo, asJSON, err := unlandedArgs(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error()+"\nUsage: coral-board "+unlandedUsage)
		exitFn(2)
		return
	}
	ctx := context.Background()
	if _, ok := gitRun(ctx, repo, "rev-parse", "--verify", "--quiet", mainRef+"^{commit}"); !ok {
		fmt.Fprintf(os.Stderr, "%s is not a commit in this repository: run it in a coral checkout (or pass --repo), after git fetch\n", mainRef)
		clierr.Exit1()
	}
	var ids []int64
	titles := map[int64]string{}
	for _, t := range fetchTasks(st, 0) {
		if !isReviewedSubmit(t) {
			continue
		}
		at, perr := time.Parse(time.RFC3339, fmt.Sprint(t["completed_at"]))
		if perr != nil || at.Before(since) {
			continue
		}
		f, _ := t["id"].(float64)
		ids = append(ids, int64(f))
		titles[int64(f)], _ = t["title"].(string)
	}
	tasks := make([]landTask, len(ids))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 6)
	for i, id := range ids {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			texts, landed := readSubmitRecord(st, id)
			tasks[i] = landTask{ID: id, Title: titles[id], Texts: texts, Landed: landed}
		}()
	}
	wg.Wait()
	rows, checked := findUnlanded(ctx, repo, mainRef, tasks)
	if asJSON {
		if rows == nil {
			rows = []unlandedRow{}
		}
		out, _ := json.MarshalIndent(map[string]any{"since": since.Format("2006-01-02"), "main": mainRef, "completed": len(ids), "checked": checked, "unlanded": rows}, "", "  ")
		fmt.Println(string(out))
		return
	}
	fmt.Printf("%d completed since %s, %d with a commit to check, %d not on %s\n", len(ids), since.Format("2006-01-02"), checked, len(rows), mainRef)
	for _, r := range rows {
		sha := r.SHA
		if len(sha) > 10 {
			sha = sha[:10]
		}
		branch := r.Branch
		if branch == "" {
			branch = "(no branch)"
		}
		fmt.Printf("#%-6d %-10s %-32s %s\n", r.Task, sha, branch, r.Title)
	}
}

// isReviewedSubmit is a completed, successful code submit: one that went through review (the list names its reviewers). A review task, a plain task done with a message and a goal have no
// commit of their own to find on main, and listing them buried the real ones (536 candidates, #18191).
func isReviewedSubmit(t map[string]any) bool {
	if t["status"] != "completed" || t["outcome"] != "success" || strings.HasPrefix(fmt.Sprint(t["title"]), "Review #") {
		return false
	}
	rv, _ := t["reviewers"].([]any)
	return len(rv) > 0
}

// readSubmitRecord is the author's words on a completed task (the reason and the note of its submit for review, then its completion message) and whether the board records it landed
// (a mark-landed artifact). A task that cannot be read has no words and is not landed.
func readSubmitRecord(st *boardState, id int64) ([]string, bool) {
	data, status, err := apiCallRaw("GET", fmt.Sprintf("/%s/tasks/%d", url.PathEscape(st.Project), id), nil)
	if err != nil || status != http.StatusOK {
		return nil, false
	}
	var d struct {
		CompletionMessage string `json:"completion_message"`
		Workflow          struct {
			Artifacts []struct {
				LandedAt string `json:"landed_at"`
			} `json:"artifacts"`
			CompletionReview struct {
				Reason  string `json:"reason"`
				Message string `json:"message"`
			} `json:"completion_review"`
		} `json:"workflow"`
	}
	if json.Unmarshal(data, &d) != nil {
		return nil, false
	}
	landed := false
	for _, a := range d.Workflow.Artifacts {
		if a.LandedAt != "" { // a patch or a commit mark-landed recorded
			landed = true
		}
	}
	return []string{d.Workflow.CompletionReview.Reason, d.Workflow.CompletionReview.Message, d.CompletionMessage}, landed
}
