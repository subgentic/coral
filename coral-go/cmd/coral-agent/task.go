package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/subgentic/coral/internal/clierr"
	"github.com/subgentic/coral/internal/clihelp"
	"github.com/subgentic/coral/internal/taskcli"
)

func taskUsageText() string {
	return `Usage: coral-agent task <subcommand> [args]

Subcommands:
  add "title" [--body "details"] [--priority P]
  list [--json]                  List your tasks (--json: a JSON array)
  claim [id]                     Claim a specific ready task or next ready work
  current [--json]               Show your current in-progress task
                                 (--json: the task as JSON, null when there is none)
  detail <id> [--json]           Read instructions, prerequisites and artifacts
  edit <id> [--title TEXT] [--body TEXT] [--priority P] [--blocked-by JSON]
                                 Edit an unstarted task (any of the options)
  publish <id>                   Publish a draft
  complete <id> [--message "note"] [--outcome success|failed]
       [--artifacts manifest.json] [--candidate-revision REVISION]
                                 Complete with outcome/evidence
  cancel <id> [--message "reason"]

Add options:
  --blocked-by '[{"task_id":1,"condition":"success","required_artifacts":["build"]}]'
  --outputs "build,report" --workflow NAME --stage NAME
  --workflow-instructions TEXT --parent ID --retry-of ID
  --completion-gates '[{"type":"report","artifact":"report"}]'  (EXPERIMENTAL, disabled by default: the server rejects new gate declarations unless it enables the feature; existing gates are inactive)
Completion options:
  --outcome success|failed --artifacts manifest.json --candidate-revision REVISION
Completed results are immutable. Dependencies must belong to this agent session.`
}

func printTaskUsage() {
	fmt.Fprintln(os.Stderr, taskUsageText())
}

func cmdTask() {
	if len(os.Args) < 3 {
		printTaskUsage()
		clierr.Exit1()
	}

	sub := os.Args[2]
	taskArgs := os.Args[3:]

	if err := checkTaskFlags(sub, taskArgs); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		printTaskUsage()
		os.Exit(2)
	}

	switch sub {
	case "add":
		cmdTaskAdd(taskArgs)
	case "list":
		cmdTaskList(clihelp.HasFlag(taskArgs, "--json"))
	case "claim":
		cmdTaskClaim(taskArgs...)
	case "current":
		cmdTaskCurrent(clihelp.HasFlag(taskArgs, "--json"))
	case "detail":
		cmdTaskDetail(taskArgs)
	case "edit":
		cmdTaskEdit(taskArgs)
	case "publish":
		cmdTaskPublish(taskArgs)
	case "complete":
		cmdTaskFinish(taskArgs, "complete")
	case "cancel":
		cmdTaskFinish(taskArgs, "cancel")
	case "--help", "-h", "help":
		printTaskUsage()
		os.Exit(0)
	default:
		fmt.Fprintf(os.Stderr, "Unknown task subcommand: %s\n", sub)
		os.Exit(2) // usage
	}
}

func cmdTaskAdd(args []string) {
	// Reorder args: pull the title (first non-flag arg) out so flags can appear after it.
	var reordered []string
	var title string
	for i := 0; i < len(args); i++ {
		if strings.HasPrefix(args[i], "-") {
			reordered = append(reordered, args[i])
			if i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
				reordered = append(reordered, args[i+1])
				i++ // skip flag value
			}
		} else if title == "" {
			title = args[i]
		}
	}

	fs := flag.NewFlagSet("task-add", flag.ContinueOnError)
	priority := fs.String("priority", "medium", "Task priority (critical, high, medium, low)")
	taskBody := fs.String("body", "", "Detailed description/instructions")
	blockedBy := fs.String("blocked-by", "", "Dependency IDs or rule objects as JSON")
	outputs := fs.String("outputs", "", "Comma-separated required artifact names")
	workflow := fs.String("workflow", "", "Workflow name")
	stage := fs.String("stage", "", "Workflow stage")
	instructions := fs.String("workflow-instructions", "", "Additional workflow instructions")
	parent := fs.Int64("parent", 0, "Parent task ID")
	retry := fs.Int64("retry-of", 0, "Finished task ID to retry")
	completionGates := fs.String("completion-gates", "", "JSON completion gates (experimental and disabled by default)")
	clihelp.ParseFlags(fs, reordered, func() string { return commandUsage(os.Args[1], os.Args[2:]) })

	if title == "" {
		fmt.Fprintln(os.Stderr, `Usage: coral-agent task add "title" [--body "details"] [--priority P]`)
		clierr.Exit1()
	}

	reqBody := map[string]any{
		"title":      title,
		"priority":   *priority,
		"session_id": resolveSessionID(),
	}
	if *taskBody != "" {
		reqBody["body"] = *taskBody
	}
	if *blockedBy != "" {
		var deps any
		if err := json.Unmarshal([]byte(*blockedBy), &deps); err != nil {
			fmt.Fprintln(os.Stderr, "Invalid --blocked-by JSON:", err)
			clierr.Exit1()
		}
		reqBody["blocked_by"] = deps
	}
	var names []string
	for _, name := range strings.Split(*outputs, ",") {
		if name = strings.TrimSpace(name); name != "" {
			names = append(names, name)
		}
	}
	workflowBody := map[string]any{"name": *workflow, "stage": *stage, "instructions": *instructions, "required_outputs": names, "parent_task_id": *parent, "retry_of": *retry}
	if *completionGates != "" {
		var gates any
		if err := json.Unmarshal([]byte(*completionGates), &gates); err != nil {
			fmt.Fprintln(os.Stderr, "Invalid --completion-gates JSON:", err)
			clierr.Exit1()
		}
		workflowBody["completion_gates"] = gates
	}
	reqBody["workflow"] = workflowBody

	data, status, err := apiCallRaw("POST", "/tasks", reqBody)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}
	if status != http.StatusCreated && status != http.StatusOK {
		fmt.Fprintf(os.Stderr, "Error creating task: %s\n", clierr.Describe(nil, status, data))
		clierr.Exit1()
	}

	var task map[string]any
	json.Unmarshal(data, &task)
	fmt.Printf("Created Task #%.0f: %s\n", task["id"], title)
}

func cmdTaskList(asJSON bool) {
	data, statusCode, err := apiCallRaw("GET", "/tasks?session_id="+url.QueryEscape(resolveSessionID()), nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}
	if statusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "Error listing tasks: %s\n", clierr.Describe(nil, statusCode, data))
		clierr.Exit1()
	}

	var result map[string]any
	json.Unmarshal(data, &result)
	tasks, _ := result["tasks"].([]any)

	if asJSON {
		if tasks == nil {
			tasks = []any{} // no tasks is [], never null
		}
		out, _ := json.MarshalIndent(tasks, "", "  ")
		fmt.Println(string(out))
		return
	}
	if len(tasks) == 0 {
		fmt.Println("No tasks found.")
		return
	}

	fmt.Printf("%-4s %-12s %-9s %-15s %s\n", "ID", "Status", "Priority", "Assignee", "Title")
	for _, t := range tasks {
		task, _ := t.(map[string]any)
		id, _ := task["id"].(float64)
		tStatus, _ := task["status"].(string)
		tPriority, _ := task["priority"].(string)
		tAssignee := "—"
		if a, ok := task["assigned_to"].(string); ok && a != "" {
			tAssignee = a
		}
		tTitle, _ := task["title"].(string)

		fmt.Printf("#%-3.0f %-12s %-9s %-15s %s\n", id, tStatus, tPriority, tAssignee, tTitle)
	}
}

func cmdTaskClaim(args ...string) {
	body := map[string]any{"session_id": resolveSessionID()}
	if len(args) > 0 {
		body["task_id"] = positiveTaskID(args[0])
	}

	data, status, err := apiCallRaw("POST", "/tasks/claim", body)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}

	if status == http.StatusNotFound && isNoTask(data) {
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
func cmdTaskCurrent(asJSON bool) {
	body := map[string]string{"session_id": resolveSessionID()}

	data, status, err := apiCallRaw("POST", "/tasks/current", body)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}

	if status == http.StatusNotFound && isNoTask(data) {
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
	fmt.Printf("Task #%.0f (%s) [%s]: %s\n", id, priority, status_, title)
	printTaskWorkflow(task)
	if taskBody != "" {
		fmt.Printf("\n%s\n", taskBody)
	}
}

// cmdTaskFinish is `task complete` / `task cancel`.
func cmdTaskFinish(args []string, verb string) {
	flagName, flagHelp, done, errWord := "message", "Completion message", "Completed", "completing"
	usageArg := `"note"`
	if verb == "cancel" {
		flagHelp, done, errWord, usageArg = "Cancellation reason", "Cancelled", "cancelling", `"reason"`
	}
	if len(args) < 1 || args[0] == "--help" || args[0] == "-h" || args[0] == "-help" {
		fmt.Fprintf(os.Stderr, "Usage: coral-agent task %s <id> [--message %s]\n", verb, usageArg)
		clierr.Exit1()
	}

	taskID, err := strconv.ParseInt(args[0], 10, 64)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Invalid task ID: %s\nUsage: coral-agent task %s <id> [--message %s]\n", args[0], verb, usageArg)
		clierr.Exit1()
	}

	fs := flag.NewFlagSet("task-"+verb, flag.ContinueOnError)
	message := fs.String(flagName, "", flagHelp)
	outcome := fs.String("outcome", "success", "success or failed")
	artifactsFile := fs.String("artifacts", "", "JSON artifact manifest")
	candidateRevision := fs.String("candidate-revision", "", "Exact source/build revision represented by completion evidence")
	clihelp.ParseFlags(fs, args[1:], func() string { return commandUsage(os.Args[1], os.Args[2:]) })

	body := map[string]any{"session_id": resolveSessionID()}
	if verb == "complete" {
		body["outcome"] = *outcome
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
	}
	if *message != "" {
		body["message"] = *message
	}

	data, status, err := apiCallRaw("POST", fmt.Sprintf("/tasks/%d/%s", taskID, verb), body)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}
	if status != http.StatusOK {
		fmt.Fprintf(os.Stderr, "Error %s task: %s\n", errWord, clierr.Describe(nil, status, data))
		clierr.Exit1()
	}

	var task map[string]any
	json.Unmarshal(data, &task)
	title, _ := task["title"].(string)
	if verb == "complete" {
		fmt.Printf("Finished Task #%d (%s): %s\n", taskID, *outcome, title)
	} else {
		fmt.Printf("%s Task #%d: %s\n", done, taskID, title)
	}
}

func printTaskWorkflow(task map[string]any) {
	if workflow, ok := task["workflow"]; ok {
		data, _ := json.MarshalIndent(workflow, "", "  ")
		fmt.Printf("\nWorkflow instructions, inputs and outputs:\n%s\n", data)
	}
}

func positiveTaskID(arg string) int64 {
	id, err := strconv.ParseInt(arg, 10, 64)
	if err != nil || id <= 0 {
		failUsage("Task ID must be a positive integer", "task", os.Args[2:])
	}
	return id
}

func cmdTaskDetail(args []string) {
	args = clihelp.WithoutFlag(args, "--json") // task detail always prints JSON; --json is accepted so a script can say so
	if len(args) != 1 {
		fmt.Fprintln(os.Stderr, "Usage: coral-agent task detail <id>")
		clierr.Exit1()
	}
	id := positiveTaskID(args[0])
	data, status, err := apiCallRaw("GET", fmt.Sprintf("/tasks/%d?session_id=%s", id, url.QueryEscape(resolveSessionID())), nil)
	if err != nil || status != http.StatusOK {
		fmt.Fprintln(os.Stderr, "Error reading task: "+clierr.Describe(err, status, data))
		clierr.Exit1()
	}
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, data, "", "  "); err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}
	fmt.Println(pretty.String())
}

func cmdTaskEdit(args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "Usage: coral-agent task edit <id> [--title TEXT] [--body TEXT] [--priority P] [--blocked-by JSON]")
		clierr.Exit1()
	}
	id := positiveTaskID(args[0])
	fs := flag.NewFlagSet("task-edit", flag.ContinueOnError)
	fs.String("title", "", "Task title")
	fs.String("body", "", "Task details")
	fs.String("priority", "", "Task priority")
	fs.String("blocked-by", "", "Dependency JSON")
	clihelp.ParseFlags(fs, args[1:], func() string { return commandUsage(os.Args[1], os.Args[2:]) })
	body := map[string]any{"session_id": resolveSessionID()}
	fs.Visit(func(f *flag.Flag) {
		if f.Name == "blocked-by" {
			var deps any
			if err := json.Unmarshal([]byte(f.Value.String()), &deps); err != nil {
				fmt.Fprintln(os.Stderr, err)
				clierr.Exit1()
			}
			body["blocked_by"] = deps
		} else {
			body[f.Name] = f.Value.String()
		}
	})
	data, status, err := apiCallRaw("PATCH", fmt.Sprintf("/tasks/%d", id), body)
	if err != nil || status != http.StatusOK {
		fmt.Fprintf(os.Stderr, "Error editing task: %s %v\n", data, err)
		clierr.Exit1()
	}
	fmt.Printf("Updated Task #%d\n", id)
}

func cmdTaskPublish(args []string) {
	if len(args) != 1 {
		fmt.Fprintln(os.Stderr, "Usage: coral-agent task publish <id>")
		clierr.Exit1()
	}
	id := positiveTaskID(args[0])
	data, status, err := apiCallRaw("POST", fmt.Sprintf("/tasks/%d/publish", id), map[string]string{"session_id": resolveSessionID()})
	if err != nil || status != http.StatusOK {
		fmt.Fprintf(os.Stderr, "Error publishing task: %s %v\n", data, err)
		clierr.Exit1()
	}
	fmt.Printf("Published Task #%d\n", id)
}

// isNoTask tells an empty queue (404 "No available tasks"/"No active task")
// apart from an unknown session (also 404), which is an error.
func isNoTask(data []byte) bool {
	var e struct {
		Error string `json:"error"`
	}
	json.Unmarshal(data, &e)
	return e.Error == "No available tasks" || e.Error == "No active task"
}
