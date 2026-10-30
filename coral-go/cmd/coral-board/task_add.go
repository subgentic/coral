package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/clierr"
	"github.com/subgentic/coral/internal/clihelp"
)

func cmdTaskAdd(st *boardState, args []string) {
	// Reorder args: pull the title (first non-flag arg) out so flags can appear after it.
	// Go's flag package stops at the first non-flag arg, so we move flags before the title.
	var reordered []string
	var title string
	for i := 0; i < len(args); i++ {
		if strings.HasPrefix(args[i], "-") {
			reordered = append(reordered, args[i])
			if args[i] == "--self" || args[i] == "-self" {
				continue // a switch: the word after it is the title, not its value
			}
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
	assignee := fs.String("assignee", "", "Assign task to a specific agent")
	blockedBy := fs.String("blocked-by", "", "Dependency JSON: [1] or [{\"task_id\":1,\"condition\":\"success\",\"required_artifacts\":[\"build\"]}]")
	outputs := fs.String("outputs", "", "Comma-separated required output artifact names")
	workflow := fs.String("workflow", "", "Workflow name (e.g. Build -> Test -> Release)")
	stage := fs.String("stage", "", "Stage name")
	instructions := fs.String("workflow-instructions", "", "Additional instructions appended to Coral's default task workflow")
	reviewers := fs.String("reviewers", "", "Who reviews it, comma separated (\"Security Reviewer,QA Engineer\"): Coral delegates the review to them when the task is submitted (used when the orchestrator or the Operator adds the task)")
	completionGates := fs.String("completion-gates", "", "JSON completion gates (experimental and disabled by default)")
	remindAt := fs.String("remind-at", "", "A one-time reminder to the assignee (or the orchestrator) at that time: \"2026-10-19 21:58\", 21:58, 2026-10-19, 30m, 2h or 3d")
	parent := fs.Int64("parent", 0, "Parent task ID")
	retryOf := fs.Int64("retry-of", 0, "Finished task ID this new task retries")
	goal := fs.Int64("goal", 0, "The goal of this board the task serves")
	followUp := fs.Int64("follow-up", 0, "Make this a follow-up of that task: it takes the task's goal, reviewers and assignee unless you give your own")
	self := fs.Bool("self", false, "Make the task for yourself: it is assigned to you and needs --goal; a repeat of an open title returns that task, and at most 5 can be open (#11247)")
	goalFrom := fs.Int64("goal-from", 0, "Accept this goal request another team sent: the task is made already linked to its goal (write your own title and body; the request text is not copied)")
	clihelp.ParseFlags(fs, reordered, func() string { return commandUsage(os.Args[1], os.Args[2:]) })
	goalGiven := false
	fs.Visit(func(f *flag.Flag) { goalGiven = goalGiven || f.Name == "goal" })
	*taskBody = flagText(*taskBody, "task body")

	if title == "" {
		fmt.Fprintln(os.Stderr, `Usage: coral-board task add "title" [--body "details"] [--priority P] [--assignee "Agent Name"] [--reviewers "A,B"]`)
		clierr.Exit1()
	}
	subscriberID := resolveSubscriberID()
	if *followUp > 0 {
		fu := resolveFollowUp(st, *followUp, *parent, *retryOf, *goalFrom)
		*parent = *followUp
		if !goalGiven && fu.goal > 0 {
			*goal = fu.goal
		}
		if *reviewers == "" {
			*reviewers = fu.reviewers
		}
		if *assignee == "" {
			*assignee = fu.assignee
		}
	}

	if *self {
		// A task for yourself alone (#11247): an agent opens its own work, with a goal, without an orchestrator. It can never name another assignee.
		if *assignee != "" && !strings.EqualFold(strings.TrimSpace(*assignee), subscriberID) {
			fmt.Fprintln(os.Stderr, "--self makes a task for you alone: leave out --assignee (or ask the orchestrator for a task for someone else)")
			clierr.Exit1()
		}
		if !goalGiven || *goal <= 0 {
			fmt.Fprintln(os.Stderr, "--self needs --goal N: say which goal of this board the task serves (coral-board goal list)")
			clierr.Exit1()
		}
		if *goalFrom > 0 {
			fmt.Fprintln(os.Stderr, "--self cannot be used with --goal-from")
			clierr.Exit1()
		}
		*assignee = ""
	}
	reqBody := map[string]any{
		"title":         title,
		"priority":      *priority,
		"subscriber_id": subscriberID,
	}
	if *self {
		reqBody["self"] = true
	}
	if *taskBody != "" {
		reqBody["body"] = *taskBody
	}
	if *assignee != "" {
		reqBody["assigned_to"] = *assignee
	}
	if *goalFrom > 0 {
		cmdTaskAddFromRequest(st, *goalFrom, title, *taskBody, *priority, *assignee, subscriberID, goalGiven || *blockedBy != "" || *workflow != "" || *outputs != "" || *reviewers != "" || *remindAt != "" || *parent != 0 || *retryOf != 0 || *completionGates != "" || *stage != "" || *instructions != "")
		return
	}
	if goalGiven && *goal <= 0 { // --goal 0 is a goal that does not exist, as the API says (#7239), not "no goal"
		fmt.Fprintf(os.Stderr, "--goal needs a goal ID, a whole number of 1 or more (got %d)\n", *goal)
		clierr.Exit1()
	}
	if *goal > 0 {
		reqBody["goal_id"] = *goal
	}
	if *remindAt != "" {
		at, err := parseWhen(*remindAt, time.Now())
		if err != nil {
			fmt.Fprintln(os.Stderr, "--remind-at:", err)
			clierr.Exit1()
		}
		reqBody["remind_at"] = at.UTC().Format(time.RFC3339)
	}
	if *blockedBy != "" {
		var deps any
		if err := json.Unmarshal([]byte(*blockedBy), &deps); err != nil {
			fmt.Fprintln(os.Stderr, "Invalid --blocked-by JSON:", err)
			clierr.Exit1()
		}
		reqBody["blocked_by"] = deps
	}
	var required []string
	for _, name := range strings.Split(*outputs, ",") {
		if name = strings.TrimSpace(name); name != "" {
			required = append(required, name)
		}
	}
	workflowBody := map[string]any{"name": *workflow, "stage": *stage, "instructions": *instructions, "required_outputs": required, "parent_task_id": *parent, "retry_of": *retryOf}
	if *completionGates != "" {
		var gates any
		if err := json.Unmarshal([]byte(*completionGates), &gates); err != nil {
			fmt.Fprintln(os.Stderr, "Invalid --completion-gates JSON:", err)
			clierr.Exit1()
		}
		workflowBody["completion_gates"] = gates
	}
	if *reviewers != "" {
		var names []string
		for _, r := range strings.Split(*reviewers, ",") {
			if r = strings.TrimSpace(r); r != "" {
				names = append(names, r)
			}
		}
		workflowBody["reviewers"] = names
	}
	reqBody["workflow"] = workflowBody

	data, status, err := apiCallRaw("POST", "/"+url.PathEscape(st.Project)+"/tasks", reqBody)
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
	id := task["id"]
	if existing, _ := task["existing"].(bool); *self && existing { // a repeat of an open title of yours: the existing task, nothing new
		fmt.Printf("Task #%.0f: %s is already open and yours: nothing was created.\n", id, title)
		return
	}
	fmt.Printf("Created Task #%.0f: %s\n", id, title)
	if *followUp > 0 {
		fmt.Printf("  A follow-up of task #%d (it is listed there).\n", *followUp)
	}
	if _, linked := task["goal_id"]; !goalGiven && !(linked && task["goal_id"] != nil) {
		if line := goalHintLine(st.Project, id); line != "" {
			fmt.Println(line)
		}
	}
}

// cmdTaskAddFromRequest is task add --goal-from <request>: it accepts a goal request another team sent this board, in one step (#7361). The title and body are the caller's own words; the request's
// text is never copied into the task. A request's task has no goal of this board's and takes none of the options that set one up (a goal, dependencies, a workflow, a reminder).
func cmdTaskAddFromRequest(st *boardState, request int64, title, body, priority, assignee, subscriberID string, other bool) {
	if other {
		fmt.Fprintln(os.Stderr, "--goal-from takes only a title, --body, --priority and --assignee: the task is made for the other team's goal and has no goal, dependencies, workflow or reminder of its own here")
		clierr.Exit1()
	}
	reqBody := map[string]any{"subscriber_id": subscriberID, "title": title, "priority": priority}
	if body != "" {
		reqBody["body"] = body
	}
	if assignee != "" {
		reqBody["assigned_to"] = assignee
	}
	data, status, err := apiCallRaw("POST", "/"+url.PathEscape(st.Project)+"/goal-requests/"+strconv.FormatInt(request, 10)+"/accept", reqBody)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}
	if status != http.StatusCreated && status != http.StatusOK { // as task add: the answer is the created task
		fmt.Fprintf(os.Stderr, "Error accepting goal request #%d: %s\n", request, clierr.Describe(nil, status, data))
		clierr.Exit1()
	}
	var out struct {
		Task map[string]any `json:"task"`
	}
	_ = json.Unmarshal(data, &out)
	fmt.Printf("Created Task #%.0f: %s (for goal request #%d; the asking team is told it was accepted)\n", out.Task["id"], title, request)
}

// followUpInherits is what a follow-up takes from the task it follows when the caller gave none of its own.
type followUpInherits struct {
	goal      int64
	reviewers string // comma separated
	assignee  string
}

// resolveFollowUp reads the task a follow-up is made from (#7791): its goal, its reviewers (as named when it was made) and who did its work, else who has it. It refuses a task that is not on this
// board and options that name another kind of link.
func resolveFollowUp(st *boardState, id, parent, retryOf, goalFrom int64) followUpInherits {
	if parent != 0 || retryOf != 0 || goalFrom != 0 {
		fmt.Fprintln(os.Stderr, "--follow-up can't be combined with --parent, --retry-of or --goal-from: it is the task's own link to the task it follows")
		clierr.Exit1()
	}
	data, status, err := apiCallRaw("GET", fmt.Sprintf("/%s/tasks/%d", url.PathEscape(st.Project), id), nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}
	if status == http.StatusNotFound {
		fmt.Fprintf(os.Stderr, "--follow-up: task #%d is not on this board\n", id)
		clierr.Exit1()
	}
	if status != http.StatusOK {
		fmt.Fprintf(os.Stderr, "--follow-up: unable to read task #%d: %s\n", id, clierr.Describe(nil, status, data))
		clierr.Exit1()
	}
	var parentTask struct {
		GoalID     *int64  `json:"goal_id"`
		AssignedTo *string `json:"assigned_to"`
		WorkedBy   string  `json:"worked_by"`
		Workflow   struct {
			Reviewers []string `json:"reviewers"`
		} `json:"workflow"`
	}
	if err := json.Unmarshal(data, &parentTask); err != nil {
		fmt.Fprintln(os.Stderr, "--follow-up: unable to read task:", err)
		clierr.Exit1()
	}
	var out followUpInherits
	if parentTask.GoalID != nil && *parentTask.GoalID > 0 {
		out.goal = *parentTask.GoalID
	}
	out.reviewers = strings.Join(parentTask.Workflow.Reviewers, ",")
	if parentTask.WorkedBy != "" {
		out.assignee = parentTask.WorkedBy
	} else if parentTask.AssignedTo != nil {
		out.assignee = *parentTask.AssignedTo
	}
	return out
}
