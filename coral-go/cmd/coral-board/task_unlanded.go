package main

import (
	"encoding/json"
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
)

// task unlanded (#18240): the tasks approved in a window whose head commit is not on main (or a named trial), so approved work cannot silently miss a release. Read-only: it reads the board and asks git
// "is this commit an ancestor of the ref" in the repository it is run in; it writes nothing to either.

var (
	unlandedHeadRe = regexp.MustCompile(`(?i)\bhead\b[^0-9a-f]{0,3}([0-9a-f]{7,40})\b`)
	unlandedHexRe  = regexp.MustCompile(`\b[0-9a-f]{7,40}\b`)
)

// headSHAFromText is the commit a task was submitted at: the hex word after "head" in the submit message or reason, else the first hex word of 7 to 40 digits that holds both a letter and a digit (a plain word like "effaced"
// is not a commit). "" when there is none.
func headSHAFromText(texts ...string) string {
	for _, t := range texts {
		if m := unlandedHeadRe.FindStringSubmatch(t); m != nil && hasLetterAndDigit(m[1]) {
			return strings.ToLower(m[1])
		}
	}
	for _, t := range texts {
		for _, w := range unlandedHexRe.FindAllString(strings.ToLower(t), -1) {
			if hasLetterAndDigit(w) {
				return w
			}
		}
	}
	return ""
}

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

// findUnlanded keeps the successful, completed tasks of the window whose head commit is not on the ref. detail reads one task in full; landed asks git. Oldest first.
func findUnlanded(tasks []map[string]any, since time.Time, ref string, detail func(id int64) (map[string]any, error), landed func(sha string) landedState) ([]unlandedTask, error) {
	var out []unlandedTask
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
		d, err := detail(id)
		if err != nil {
			return nil, fmt.Errorf("task #%d: %w", id, err)
		}
		wf, _ := d["workflow"].(map[string]any)
		if _, isReview := wf["review_of"]; isReview {
			continue
		}
		cr, _ := wf["completion_review"].(map[string]any)
		msg, _ := cr["message"].(string)
		reason, _ := cr["reason"].(string)
		sha := headSHAFromText(msg, reason)
		switch {
		case sha == "":
			out = append(out, unlandedTask{ID: id, Title: title, Why: "no head SHA recorded"})
		default:
			switch landed(sha) {
			case stateNotLanded:
				out = append(out, unlandedTask{ID: id, SHA: sha, Title: title, Why: "not on " + ref})
			case stateUnknown:
				out = append(out, unlandedTask{ID: id, SHA: sha, Title: title, Why: "commit not in this repository (git fetch it)"})
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// gitLanded asks git, in dir, whether sha is an ancestor of ref (read-only: merge-base --is-ancestor writes nothing).
func gitLanded(dir, ref string) func(sha string) landedState {
	return func(sha string) landedState {
		if exec.Command("git", "-C", dir, "cat-file", "-e", sha+"^{commit}").Run() != nil {
			return stateUnknown
		}
		err := exec.Command("git", "-C", dir, "merge-base", "--is-ancestor", sha, ref).Run()
		if err == nil {
			return stateLanded
		}
		if ee, ok := err.(*exec.ExitError); ok && ee.ExitCode() == 1 {
			return stateNotLanded
		}
		return stateUnknown
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
	if exec.Command("git", "-C", repo, "rev-parse", "--verify", "--quiet", ref+"^{commit}").Run() != nil {
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
	rows, err := findUnlanded(fetchTasks(st, 0), time.Now().Add(-window), ref, detail, gitLanded(repo, ref))
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
	fmt.Printf("%d approved task(s) in the last %s are not on %s.\n", len(rows), since, ref)
}
