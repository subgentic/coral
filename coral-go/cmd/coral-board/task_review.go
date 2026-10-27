package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/subgentic/coral/internal/clierr"
	"github.com/subgentic/coral/internal/clihelp"
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
	clihelp.ParseFlags(fs, args[1:], func() string { return commandUsage(os.Args[1], os.Args[2:]) })
	*message = flagText(*message, "completion message")
	if strings.TrimSpace(*reason) == "" {
		fmt.Fprintln(os.Stderr, "--reason is required")
		clierr.Exit1()
	}
	body := map[string]any{"subscriber_id": resolveSubscriberID(), "reason": *reason, "message": *message, "outcome": *outcome}
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
	if *candidateRevision != "" {
		body["candidate_revision"] = *candidateRevision
	}
	if *revision > 0 {
		body["expected_revision"] = *revision
	}
	if *manifest != "" {
		data, err := os.ReadFile(*manifest)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			clierr.Exit1()
		}
		var artifacts []map[string]any
		if err := json.Unmarshal(data, &artifacts); err != nil {
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
	case "reject":
		if strings.TrimSpace(*note) == "" {
			fmt.Fprintln(os.Stderr, `--note "why" is required`)
			os.Exit(2) // usage
		}
		body["note"] = *note
		body["round"] = *round
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
		Completed bool `json:"completed"`
		Rejected  bool `json:"rejected"`
		Reviews   []struct {
			ID         int64   `json:"id"`
			AssignedTo *string `json:"assigned_to"`
		} `json:"reviews"`
	}
	_ = json.Unmarshal(data, &out)
	switch {
	case action == "review":
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
	if werr != nil || cerr != nil || os.Chmod(tmp.Name(), 0o600) != nil || os.Rename(tmp.Name(), path) != nil {
		os.Remove(tmp.Name())
	}
}

// lastSeenRound is the review round recorded for a task, 0 when none was (the server then takes
// the current round).
func lastSeenRound(project string, id int64) int {
	return loadSeenRounds()[fmt.Sprintf("%s/%d", project, id)]
}

// lastSeenRevision is the revision of the round recorded for a task: how many patches joined it after it opened (#5689), 0 when none did
// or none was recorded. An approval names it; the server refuses one that names an older revision.
func lastSeenRevision(project string, id int64) int {
	return loadSeenRounds()[fmt.Sprintf("%s/%d#revision", project, id)]
}
