package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/clierr"
	"github.com/subgentic/coral/internal/clihelp"
	"github.com/subgentic/coral/internal/fsreplace"
	"github.com/subgentic/coral/internal/gitutil"
)

// taskReviewRequested: a list item says review_requested; a full task (an older
// server) has workflow.completion_review.
func taskReviewRequested(task map[string]any) bool {
	if r, ok := task["review_requested"].(bool); ok && r {
		return true
	}
	workflow, ok := task["workflow"].(map[string]any)
	return ok && workflow["completion_review"] != nil
}

// Review operations are explicit: a rejected completion is never automatically
// retried through another endpoint or treated as accepted.
func cmdTaskReview(st *boardState, args []string, action string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "Usage: coral-board task", action, "<id> --reason <reason> [--message <message>] [--artifacts manifest.json]")
		clierr.Exit1()
	}
	id, err := strconv.ParseInt(args[0], 10, 64)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Invalid task ID")
		os.Exit(2) // usage
	}
	fs := flag.NewFlagSet(action, flag.ContinueOnError)
	reason := fs.String("reason", "", "Reason review is needed or capacity is being released")
	message := fs.String("message", "", "Candidate completion message")
	revision := fs.Int("revision", 0, "Expected task revision after amendments (submit-review)")
	outcome := fs.String("outcome", "success", "Proposed outcome: success or failed")
	manifest := fs.String("artifacts", "", "Candidate artifact manifest")
	candidateRevision := fs.String("candidate-revision", "", "Exact source/build revision represented by candidate evidence")
	areas := fs.String("areas", "", "The review's areas, comma-separated (submit-review): who may take it from the review pool")
	reviewers := fs.Int("reviewers", 0, "How many reviewers the review wants, 1 or 2 (submit-review)")
	head := fs.String("head", "", "The commit you submit (submit-review; default: HEAD of the folder you run it in: a linked worktree is accepted, a detached HEAD included, but the shared checkout and main are refused, so pass --head <sha> or --branch <name> there). A resubmit of the commit a reviewer rejected is refused")
	branch := fs.String("branch", "", "The branch you submit, when --head is not given (submit-review): its tip is the commit; use it from the shared checkout, where this folder's HEAD is refused")
	noTests := fs.String("no-tests", "", "Why the note carries no test result, e.g. a docs-only change (submit-review)")
	clihelp.ParseFlags(fs, args[1:], func() string { return commandUsage(os.Args[1], os.Args[2:]) })
	*message = flagText(*message, "completion message")
	if strings.TrimSpace(*reason) == "" {
		fmt.Fprintln(os.Stderr, "--reason is required")
		clierr.Exit1()
	}
	if action == "submit-review" && strings.TrimSpace(*noTests) == "" && !hasTestResult(*message+"\n"+*reason) {
		fmt.Fprintln(os.Stderr, noTestResultText(*message))
		clierr.Exit1()
	}
	body := map[string]any{"subscriber_id": resolveSubscriberID(), "reason": *reason, "message": *message, "outcome": *outcome}
	if action != "submit-review" && *noTests != "" {
		fmt.Fprintln(os.Stderr, "--no-tests belongs to submit-review")
		os.Exit(2) // usage
	}
	if action != "submit-review" && (*areas != "" || *reviewers != 0) {
		fmt.Fprintln(os.Stderr, "--areas and --reviewers belong to submit-review")
		os.Exit(2) // usage
	}
	if *areas != "" {
		var list []string
		for _, a := range strings.Split(*areas, ",") {
			if a = strings.TrimSpace(a); a != "" {
				list = append(list, a)
			}
		}
		body["areas"] = list
	}
	if *reviewers != 0 {
		body["reviewers"] = *reviewers
	}
	if action == "submit-review" {
		h := strings.TrimSpace(*head)
		if h == "" && strings.TrimSpace(*branch) != "" {
			h = branchHead(strings.TrimSpace(*branch))
			if h == "" {
				fmt.Fprintf(os.Stderr, "no branch %q here: name the commit with --head <sha>\n", *branch)
				clierr.Exit1()
			}
		}
		if h == "" {
			h = defaultSubmitHead(os.Stderr, "") // #21445: the worktree's own head, else none (and a note on how to name it)
		}
		if h != "" {
			body["head"] = h
		}
	} else if *head != "" {
		fmt.Fprintln(os.Stderr, "--head belongs to submit-review")
		os.Exit(2) // usage
	}
	if *candidateRevision != "" {
		body["candidate_revision"] = *candidateRevision
	}
	if *revision > 0 {
		body["expected_revision"] = *revision
	}
	if *manifest != "" {
		artifacts, err := clihelp.ReadArtifactManifest(*manifest)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			clierr.Exit1()
		}
		body["artifacts"] = artifacts
	}
	data, status, err := apiCallRaw("POST", fmt.Sprintf("/%s/tasks/%d/%s", url.PathEscape(st.Project), id, action), body)
	if err != nil || status != http.StatusOK {
		fmt.Fprintln(os.Stderr, "Review action failed: "+clierr.Describe(err, status, data))
		clierr.Exit1()
	}
	if action == "submit-review" {
		var t struct {
			Status     string  `json:"status"`
			AssignedTo *string `json:"assigned_to"`
			Workflow   struct {
				InPool          bool     `json:"review_in_pool"`
				Areas           []string `json:"review_areas"`
				ReviewersWanted int      `json:"reviewers_wanted"`
			} `json:"workflow"`
		}
		_ = json.Unmarshal(data, &t)
		switch {
		case t.Status == "completed":
			fmt.Printf("Task #%d completed: the team has no orchestrator to review it.\n", id)
		case t.Workflow.InPool:
			where, count := "any reviewer", "one reviewer"
			if len(t.Workflow.Areas) > 0 {
				where = "areas: " + strings.Join(t.Workflow.Areas, ", ")
			}
			if t.Workflow.ReviewersWanted == 2 {
				count = "two reviewers"
			}
			fmt.Printf("Task #%d is in the review pool (%s) and waits for %s; your slot is free.\n", id, where, count)
		case t.AssignedTo != nil:
			fmt.Printf("Task #%d is in review with %s; your slot is free.\n", id, *t.AssignedTo)
		default:
			fmt.Printf("Task #%d: submit-review recorded.\n", id)
		}
		printUnverifiedArtifacts(data)
		warnUnpushedCommit(*reason, "")
		return
	}
	fmt.Printf("Task #%d: %s recorded. Completion has not been accepted.\n", id, action)
}

// cmdTaskReviewFlow: the orchestrator delegates a task in review (review --to, which also changes
// the reviewers of an open round); a reviewer approves or rejects it any time it is in review,
// naming the round they reviewed with --round (#3725, #3787).
func cmdTaskReviewFlow(st *boardState, args []string, action string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, `Usage: coral-board task review <id> --to "Reviewer A,Reviewer B" | approve <id> [--round N] [--note "..."] | reject <id> [--round N] --note "why"`)
		clierr.Exit1()
	}
	id, err := strconv.ParseInt(args[0], 10, 64)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Invalid task ID")
		os.Exit(2) // usage
	}
	fs := flag.NewFlagSet(action, flag.ContinueOnError)
	to := fs.String("to", "", "Reviewers, comma-separated (review)")
	replace := fs.Bool("replace", false, "review: the named reviewers are the whole round; any other reviewer on it is taken off")
	note := fs.String("note", "", "Your note (approve; required for reject)")
	taskVersion := fs.Int("task-version", 0, "The task text version reviewed (default: last task detail)")
	revision := fs.Int("revision", -1, "The revision of the round you read (approve): patches that joined it since it opened; default: the one task detail last showed you")
	round := fs.Int("round", 0, "The review round you reviewed (default: the one task detail or your review task last showed you); a verdict on an earlier round is refused")
	clihelp.ParseFlags(fs, args[1:], func() string { return commandUsage(os.Args[1], os.Args[2:]) })
	explicitRound := false
	fs.Visit(func(f *flag.Flag) { explicitRound = explicitRound || f.Name == "round" })
	if !explicitRound && (action == "approve" || action == "reject") {
		// The round this reviewer last saw (#3805): a verdict typed after the task was
		// resubmitted is then refused instead of applying to a revision they haven't read.
		*round = lastSeenRound(st.Project, id)
	}
	*note = flagText(*note, "note")
	body := map[string]any{"subscriber_id": resolveSubscriberID()}
	switch action {
	case "review":
		var reviewers []string
		for _, r := range strings.Split(*to, ",") {
			if r = strings.TrimSpace(r); r != "" {
				reviewers = append(reviewers, r)
			}
		}
		if len(reviewers) == 0 {
			fmt.Fprintln(os.Stderr, `--to "Reviewer A,Reviewer B" is required`)
			os.Exit(2) // usage
		}
		body["reviewers"] = reviewers
		if *replace {
			body["replace"] = true
		}
	case "reject":
		if strings.TrimSpace(*note) == "" {
			fmt.Fprintln(os.Stderr, `--note "why" is required`)
			os.Exit(2) // usage
		}
		body["note"] = *note
		body["round"] = *round
		if *taskVersion > 0 {
			body["task_version"] = *taskVersion
		} else {
			body["task_version"] = loadSeenRounds()[fmt.Sprintf("%s/%d#task-version", st.Project, id)]
		}
	default:
		body["note"] = *note
		body["round"] = *round
		if *taskVersion > 0 {
			body["task_version"] = *taskVersion
		} else {
			body["task_version"] = loadSeenRounds()[fmt.Sprintf("%s/%d#task-version", st.Project, id)]
		}
		if *revision >= 0 {
			body["revision"] = *revision
		} else {
			body["revision"] = lastSeenRevision(st.Project, id)
		}
	}
	data, status, err := apiCallRaw("POST", fmt.Sprintf("/%s/tasks/%d/%s", url.PathEscape(st.Project), id, action), body)
	if err != nil || status != http.StatusOK {
		fmt.Fprintln(os.Stderr, "Review action failed: "+clierr.Describe(err, status, data))
		exitFn(1)
		return
	}
	var out struct {
		Completed bool   `json:"completed"`
		Rejected  bool   `json:"rejected"`
		Note      string `json:"note"`
		Reviews   []struct {
			ID         int64   `json:"id"`
			AssignedTo *string `json:"assigned_to"`
		} `json:"reviews"`
	}
	_ = json.Unmarshal(data, &out)
	switch {
	case action == "review":
		if out.Note != "" {
			fmt.Println(out.Note)
		}
		for _, r := range out.Reviews {
			if r.AssignedTo != nil {
				fmt.Printf("Review task #%d for %s\n", r.ID, *r.AssignedTo)
			}
		}
	case out.Completed:
		fmt.Printf("Task #%d approved by every reviewer: completed.\n", id)
	case out.Rejected:
		fmt.Printf("Task #%d rejected: back to its author.\n", id)
	default:
		fmt.Printf("Task #%d approved; waiting for the other reviewers.\n", id)
	}
}

// seenRoundsPath holds, per board task, the review round this agent was last shown (#3805). The
// name comes from a hash of the session name, never the raw value (Security's NIT: an env value
// with a path separator or ".." can't place the file elsewhere).
func seenRoundsPath() string {
	name := resolveSessionName()
	if name == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(name))
	return filepath.Join(coralDir(), "board_review_rounds_"+hex.EncodeToString(sum[:8])+".json")
}

func loadSeenRounds() map[string]int {
	seen := map[string]int{}
	if path := seenRoundsPath(); path == "" {
		return seen
	} else if data, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(data, &seen)
	}
	return seen
}

// noteSeenRound records the review round a task shows (task detail, a claim): the open round of
// a task under review, or a review task's own round (recorded for the task it reviews too).
func noteSeenRound(project string, task map[string]any) {
	id, _ := task["id"].(float64)
	w, _ := task["workflow"].(map[string]any)
	if id <= 0 {
		return
	}
	if w == nil {
		w = map[string]any{}
	}
	seen := loadSeenRounds()
	changed := false
	if v, _ := task["version"].(float64); v > 0 {
		seen[fmt.Sprintf("%s/%d#task-version", project, int64(id))] = int(v)
		changed = true
	}
	if rounds, _ := w["review_rounds"].([]any); len(rounds) > 0 {
		if last, _ := rounds[len(rounds)-1].(map[string]any); last != nil {
			if n, _ := last["round"].(float64); n > 0 {
				seen[fmt.Sprintf("%s/%d", project, int64(id))] = int(n)
				rev, _ := last["revision"].(float64) // patches that joined the round (#5689); absent is 0
				seen[fmt.Sprintf("%s/%d#revision", project, int64(id))] = int(rev)
				changed = true
			}
		}
	}
	if of, _ := w["review_of"].(float64); of > 0 {
		if n, _ := w["review_round"].(float64); n > 0 {
			seen[fmt.Sprintf("%s/%d", project, int64(id))] = int(n)
			seen[fmt.Sprintf("%s/%d", project, int64(of))] = int(n)
			changed = true
		}
	}
	if !changed {
		return
	}
	data, _ := json.Marshal(seen)
	path := seenRoundsPath()
	if path == "" {
		return
	}
	os.MkdirAll(filepath.Dir(path), 0o700)
	// A temp file and a rename (Security's NIT): two commands at once never leave half a file.
	tmp, err := os.CreateTemp(filepath.Dir(path), ".board_review_rounds_*")
	if err != nil {
		return
	}
	_, werr := tmp.Write(data)
	cerr := tmp.Close()
	if werr != nil || cerr != nil || os.Chmod(tmp.Name(), 0o600) != nil || fsreplace.Rename(tmp.Name(), path) != nil {
		os.Remove(tmp.Name())
	}
}

// lastSeenRound is the review round recorded for a task, 0 when none was (the server then takes
// the current round).
func lastSeenRound(project string, id int64) int {
	return loadSeenRounds()[fmt.Sprintf("%s/%d", project, id)]
}

var shaRe = regexp.MustCompile(`\b[0-9a-f]{7,40}\b`)

// warnUnpushedCommit prints a warning to stderr when the reason text names a
// commit SHA that no remote branch contains. Warn, never block (#17750).
func warnUnpushedCommit(reason, dir string) {
	shas := shaRe.FindAllString(reason, -1)
	if len(shas) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, sha := range shas {
		out, err := gitutil.Command(ctx, dir, "branch", "-r", "--contains", sha).Output()
		if err != nil || len(strings.TrimSpace(string(out))) == 0 {
			fmt.Fprintf(os.Stderr, "warning: commit %s is not on origin — push before review\n", sha)
		}
	}
}

// lastSeenRevision is the revision of the round recorded for a task: how many patches joined it after it opened (#5689), 0 when none did
// or none was recorded. An approval names it; the server refuses one that names an older revision.
func lastSeenRevision(project string, id int64) int {
	return loadSeenRounds()[fmt.Sprintf("%s/%d#revision", project, id)]
}

// defaultSubmitHead is the head a submit records when --head and --branch are not given (#21445): HEAD of the folder dir ("" is where the command runs) when that is a linked worktree on its own branch and the
// commit is on origin; else "", and the note says why and how to name it. A submit with no code, from the shared checkout, records none; it is no longer refused.
func defaultSubmitHead(w io.Writer, dir string) string {
	h := worktreeHead(dir)
	if h == "" {
		return ""
	}
	if !announceHead(w, dir, h) {
		fmt.Fprintln(w, "not recording a head: this folder is the shared checkout or main, not your work. Name the commit with --head <sha> or the branch with --branch <name>; a submit with no code needs none")
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if out, err := gitutil.Command(ctx, dir, "branch", "-r", "--contains", h).Output(); err != nil || strings.TrimSpace(string(out)) == "" {
		fmt.Fprintf(w, "not recording a head: commit %s is not on origin. Push it, then name it with --head <sha>\n", h[:min(len(h), 10)])
		return ""
	}
	return h
}

// worktreeHead is the commit checked out in dir ("" is where the command runs), or "" outside a repository (#18135).
func worktreeHead(dir string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := gitutil.Command(ctx, dir, "rev-parse", "HEAD").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// announceHead says on stderr which commit, from which folder, goes to the review, and warns when that folder is not a task worktree: the shared
// checkout (it has no linked-worktree .git file) or a branch named main. A head taken from the wrong folder is stored and a later unchanged resubmit
// is refused for it (#18457; the task's own branch is not known here, so the check is on the folder).
func announceHead(w io.Writer, dir, h string) (ok bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	git := func(args ...string) string {
		out, err := gitutil.Command(ctx, dir, args...).Output()
		if err != nil {
			return ""
		}
		return strings.TrimSpace(string(out))
	}
	top := git("rev-parse", "--show-toplevel")
	fmt.Fprintf(w, "submitting %s from %s\n", h, top)
	branch := git("rev-parse", "--abbrev-ref", "HEAD")
	// Both as absolute paths: from a subdirectory git prints --git-dir absolute and --git-common-dir as "../.git", which never compared equal (#21445).
	shared := git("rev-parse", "--path-format=absolute", "--git-dir") == git("rev-parse", "--path-format=absolute", "--git-common-dir")
	if shared || branch == "main" || branch == "master" {
		fmt.Fprintf(w, "warning: this is %s (branch %q), not a worktree of the task's branch: if %s is not the commit you mean, resubmit with --head <sha>\n", map[bool]string{true: "the shared checkout", false: "a worktree"}[shared], branch, h[:min(len(h), 10)])
		return false
	}
	return true
}

// branchHead is the tip of a branch (local, else origin's), or "" when there is none (#19263).
func branchHead(name string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for _, ref := range []string{"refs/heads/" + name, "refs/remotes/origin/" + name} {
		if out, err := gitutil.Command(ctx, "", "rev-parse", "--verify", "-q", ref+"^{commit}").Output(); err == nil {
			return strings.TrimSpace(string(out))
		}
	}
	return ""
}

// testResultLine matches a line of a test run pasted into a note: pass/fail counts, PASS/FAIL, a go test "ok  pkg" line or an exit code, as exit code 1 or exited with code 1 (#18292, #587).
var testResultLine = regexp.MustCompile(`(?i)(\b\d+\s+(passed|failed|passing|failing|tests?)\b|\b(passed|failed)\b\s*[:=]?\s*\d+|\bPASS\b|\bFAIL\b|\bok\s+\S*/|\bexit(ed\s+with)?(\s+code)?\s*[:=]?\s*\d+\b|\ball passed\b|\d+/\d+ suites? passed)`)

// hasTestResult reports whether the text has a line that looks like a test result: a plain text check, no state.
func hasTestResult(text string) bool { return testResultLine.MatchString(text) }

// noTestResultText is submit-review's refusal when the note has no test result. It holds no quotes, so an agent that pastes it into a
// command does not break the shell, and its example (N passed, M failed) has no digits, so the refusal pasted into --message is not
// itself taken for a test result (#587: a model pasted a quoted example into --message, then looped on the same refusal).
// When --message was given, it says the note was read and why it did not count.
func noTestResultText(message string) string {
	const how = "put the last line your test run printed (npm test:cloud, go test, or the one browser suite) in --message as it printed it: a line like N passed, M failed or exit code N counts. A change with no test to run, docs only for example, gives the reason with --no-tests instead."
	if strings.TrimSpace(message) == "" {
		return "submit-review needs a test result in the note: " + how
	}
	return "--message was read but has no test result line, so it does not count: " + how
}
