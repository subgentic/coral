package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/subgentic/coral/internal/clierr"
	"github.com/subgentic/coral/internal/clihelp"
	"github.com/subgentic/coral/internal/taskcli"
)

func cmdTaskClaim(st *boardState, args ...string) {
	subscriberID := resolveSubscriberID()
	body := map[string]any{"subscriber_id": subscriberID}
	if len(args) > 0 {
		id, err := strconv.ParseInt(args[0], 10, 64)
		if err != nil || id <= 0 {
			fmt.Fprintln(os.Stderr, "task claim requires a positive task ID")
			clierr.Exit1()
		}
		body["task_id"] = id
	}

	data, status, err := apiCallRaw("POST", "/"+url.PathEscape(st.Project)+"/tasks/claim", body)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}

	if status == http.StatusNotFound {
		fmt.Println("No available tasks")
		taskcli.PrintBlocked(os.Stdout, data)
		return
	}
	if status != http.StatusOK {
		fmt.Fprintf(os.Stderr, "Error claiming task: %s\n", clierr.Describe(nil, status, data))
		taskcli.PrintBlocked(os.Stderr, data)
		clierr.Exit1()
	}

	var task map[string]any
	json.Unmarshal(data, &task)
	noteSeenRound(st.Project, task)
	id, _ := task["id"].(float64)
	title, _ := task["title"].(string)
	taskBody, _ := task["body"].(string)
	priority, _ := task["priority"].(string)
	fmt.Printf("Claimed Task #%.0f (%s): %s\n", id, priority, title)
	printTaskWorkflow(task)
	if taskBody != "" {
		fmt.Printf("\n%s\n", taskBody)
	}
}

// cmdTaskCurrent prints the task in progress; with asJSON the task as JSON, or null when there is none.
func cmdTaskCurrent(st *boardState, asJSON bool) {
	subscriberID := resolveSubscriberID()
	body := map[string]string{"subscriber_id": subscriberID}

	data, status, err := apiCallRaw("POST", "/"+url.PathEscape(st.Project)+"/tasks/current", body)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}

	if status == http.StatusNotFound {
		if asJSON {
			fmt.Println("null")
			return
		}
		fmt.Println("No active task")
		return
	}
	if status != http.StatusOK {
		fmt.Fprintf(os.Stderr, "Error: %s\n", clierr.Describe(nil, status, data))
		clierr.Exit1()
	}

	var task map[string]any
	json.Unmarshal(data, &task)
	if asJSON {
		pretty, _ := json.MarshalIndent(task, "", "  ")
		fmt.Println(string(pretty))
		return
	}
	id, _ := task["id"].(float64)
	title, _ := task["title"].(string)
	taskBody, _ := task["body"].(string)
	priority, _ := task["priority"].(string)
	status_, _ := task["status"].(string)
	revision, _ := task["revision"].(float64)
	fmt.Printf("Task #%.0f (revision %.0f, %s) [%s]: %s\n", id, revision, priority, status_, title)
	printTaskWorkflow(task)
	if taskBody != "" {
		fmt.Printf("\n%s\n", taskBody)
	}
}

func cmdTaskComplete(st *boardState, args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "Usage: coral-board task complete <id> [--revision N] [--message \"note\"]")
		clierr.Exit1()
	}

	taskID, err := strconv.ParseInt(args[0], 10, 64)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Invalid task ID: %s\n", args[0])
		clierr.Exit1()
	}

	fs := flag.NewFlagSet("task-complete", flag.ContinueOnError)
	message := fs.String("message", "", "Completion message")
	outcome := fs.String("outcome", "success", "success or failed")
	artifactsFile := fs.String("artifacts", "", "JSON file containing named artifacts (name, uri or content, revision, digest)")
	expectedRevision := fs.Int("revision", 0, "Expected task revision after amendments")
	candidateRevision := fs.String("candidate-revision", "", "Exact source/build revision represented by completion evidence")
	clihelp.ParseFlags(fs, args[1:], func() string { return commandUsage(os.Args[1], os.Args[2:]) })
	*message = flagText(*message, "completion message")

	subscriberID := resolveSubscriberID()
	body := map[string]any{
		"subscriber_id": subscriberID,
		"outcome":       *outcome,
	}
	if *expectedRevision > 0 {
		body["expected_revision"] = *expectedRevision
	}
	if *candidateRevision != "" {
		body["candidate_revision"] = *candidateRevision
	}
	if *artifactsFile != "" {
		data, err := os.ReadFile(*artifactsFile)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			clierr.Exit1()
		}
		var artifacts []map[string]any
		if err := json.Unmarshal(data, &artifacts); err != nil {
			fmt.Fprintln(os.Stderr, "Invalid artifacts JSON:", err)
			clierr.Exit1()
		}
		body["artifacts"] = artifacts
	}
	if *message != "" {
		body["message"] = *message
	}

	data, status, err := apiCallRaw("POST", fmt.Sprintf("/%s/tasks/%d/complete", url.PathEscape(st.Project), taskID), body)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}
	if status != http.StatusOK {
		fmt.Fprintf(os.Stderr, "Error completing task: %s\n", clierr.Describe(nil, status, data))
		clierr.Exit1()
	}

	var task map[string]any
	json.Unmarshal(data, &task)
	title, _ := task["title"].(string)
	fmt.Printf("Finished Task #%d (%s): %s\n", taskID, *outcome, title)
	printUnverifiedArtifacts(data)
}

func cmdTaskCancel(st *boardState, args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "Usage: coral-board task cancel <id> [--message \"reason\"]")
		clierr.Exit1()
	}

	taskID, err := strconv.ParseInt(args[0], 10, 64)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Invalid task ID: %s\n", args[0])
		clierr.Exit1()
	}

	fs := flag.NewFlagSet("task-cancel", flag.ContinueOnError)
	message := fs.String("message", "", "Cancellation reason")
	clihelp.ParseFlags(fs, args[1:], func() string { return commandUsage(os.Args[1], os.Args[2:]) })
	*message = flagText(*message, "cancellation reason")

	subscriberID := resolveSubscriberID()
	body := map[string]any{
		"subscriber_id": subscriberID,
	}
	if *message != "" {
		body["message"] = *message
	}

	data, status, err := apiCallRaw("POST", fmt.Sprintf("/%s/tasks/%d/cancel", url.PathEscape(st.Project), taskID), body)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}
	if status != http.StatusOK {
		fmt.Fprintf(os.Stderr, "Error cancelling task: %s\n", clierr.Describe(nil, status, data))
		clierr.Exit1()
	}

	var task map[string]any
	json.Unmarshal(data, &task)
	title, _ := task["title"].(string)
	fmt.Printf("Cancelled Task #%d: %s\n", taskID, title)
}

// parseReassignAssignee reads the --to flag. A bare name is rejected rather
// than ignored: Go's flag package stops at the first positional argument, so
// "reassign 5 Orchestrator" used to leave --to empty and silently unassign the
// task, returning it to the pool every worker can claim from.
func parseReassignAssignee(args []string) (string, error) {
	fs := flag.NewFlagSet("task-reassign", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	assignee := fs.String("to", "", "New assignee (empty = unassigned)")
	if err := fs.Parse(args); err != nil {
		return "", fmt.Errorf("invalid reassign options: %v (usage: task reassign <id> [--to \"Agent Name\"])", err)
	}
	if fs.NArg() > 0 {
		return "", fmt.Errorf("unexpected argument %q: use --to %q to assign; omit --to only to unassign", fs.Arg(0), fs.Arg(0))
	}
	return *assignee, nil
}

func cmdTaskReassign(st *boardState, args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, `Usage: coral-board task reassign <id> [--to "Agent Name"]`)
		clierr.Exit1()
	}

	taskID, err := strconv.ParseInt(args[0], 10, 64)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Invalid task ID: %s\n", args[0])
		clierr.Exit1()
	}

	newAssignee, err := parseReassignAssignee(args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	assignee := &newAssignee

	subscriberID := resolveSubscriberID()
	body := map[string]any{
		"subscriber_id": subscriberID,
		"assignee":      *assignee,
	}

	data, status, err := apiCallRaw("POST", fmt.Sprintf("/%s/tasks/%d/reassign", url.PathEscape(st.Project), taskID), body)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}
	if status != http.StatusOK {
		fmt.Fprintf(os.Stderr, "Error reassigning task: %s\n", clierr.Describe(nil, status, data))
		clierr.Exit1()
	}

	var task map[string]any
	json.Unmarshal(data, &task)
	title, _ := task["title"].(string)
	if *assignee != "" {
		fmt.Printf("Reassigned Task #%d to %s: %s\n", taskID, *assignee, title)
	} else {
		fmt.Printf("Reassigned Task #%d (now unassigned): %s\n", taskID, title)
	}
}

func cmdTaskAmend(st *boardState, args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, `Usage: coral-board task amend <id> --revision N --reason "..." [--body "..."]`)
		clierr.Exit1()
	}
	taskID, err := strconv.ParseInt(args[0], 10, 64)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Invalid task ID: %s\n", args[0])
		clierr.Exit1()
	}
	fs := flag.NewFlagSet("task-amend", flag.ContinueOnError)
	revision := fs.Int("revision", 0, "Expected current task revision")
	reason := fs.String("reason", "", "Why this amendment is authoritative")
	bodyText := fs.String("body", "", "Replacement task body")
	instructions := fs.String("workflow-instructions", "", "Replacement task-specific instructions")
	completionGates := fs.String("completion-gates", "", "Replacement completion gates JSON (experimental and disabled by default)")
	clihelp.ParseFlags(fs, args[1:], func() string { return commandUsage(os.Args[1], os.Args[2:]) })
	*bodyText = flagText(*bodyText, "task body")
	if *revision <= 0 || strings.TrimSpace(*reason) == "" {
		fmt.Fprintln(os.Stderr, "--revision and --reason are required")
		clierr.Exit1()
	}
	changes := map[string]any{}
	if *bodyText != "" {
		changes["body"] = *bodyText
	}
	if *instructions != "" {
		changes["workflow_instructions"] = *instructions
	}
	if *completionGates != "" {
		var gates any
		if err := json.Unmarshal([]byte(*completionGates), &gates); err != nil {
			fmt.Fprintln(os.Stderr, "Invalid --completion-gates JSON:", err)
			clierr.Exit1()
		}
		changes["completion_gates"] = gates
	}
	if len(changes) == 0 {
		fmt.Fprintln(os.Stderr, "at least --body or --workflow-instructions is required")
		clierr.Exit1()
	}
	data, status, err := apiCallRaw("PATCH", fmt.Sprintf("/%s/tasks/%d/amend", url.PathEscape(st.Project), taskID), map[string]any{"subscriber_id": resolveSubscriberID(), "base_revision": *revision, "reason": *reason, "changes": changes})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}
	if status != http.StatusOK {
		fmt.Fprintf(os.Stderr, "Error amending task: %s\n", clierr.Describe(nil, status, data))
		clierr.Exit1()
	}
	var task map[string]any
	_ = json.Unmarshal(data, &task)
	fmt.Printf("Amended Task #%d to revision %.0f: %s\n", taskID, task["revision"], task["title"])
}
