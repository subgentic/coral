package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"

	"github.com/subgentic/coral/internal/clierr"
	"github.com/subgentic/coral/internal/clihelp"
)

func cmdTask() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, `Usage: coral-board task <subcommand> [args]

Subcommands:
  add "title" [--body "details"] [--priority P]
  list [--json]
  claim
  submit-review <id> --reason "review pending" [--revision N] [--candidate-revision REVISION] [--message "note"] [--outcome success|failed] [--artifacts manifest.json]
  release-review <id> --reason "slot released pending review" (orchestrator only)
  review <id> --to "Security Reviewer,QA Engineer"   (orchestrator: delegate a task in review)
  approve <id> [--round N] [--note "..."] / reject <id> [--round N] --note "why"   (a delegated reviewer)
  attach <id> --artifacts manifest.json / send-back <id> --note "why" / mark-landed <id> --digest D [--commit SHA[:subject]]   (the merge queue)
  complete <id> [--message "note"]`)
		clierr.Exit1()
	}

	st := loadState()
	if st == nil {
		fmt.Fprintln(os.Stderr, "Not subscribed to any board. Run: coral-board join <project> --as <role>")
		clierr.Exit1()
	}

	sub := os.Args[2]
	taskArgs := os.Args[3:]

	switch sub {
	case "edit":
		cmdTaskEdit(st, taskArgs)
	case "history":
		cmdTaskHistory(st, taskArgs)
	case "add":
		cmdTaskAdd(st, taskArgs)
	case "list":
		asJSON, goal := taskListArgs(taskArgs)
		cmdTaskListGoal(st, asJSON, goal)
	case "goal":
		cmdTaskGoal(st, taskArgs)
	case "claim":
		cmdTaskClaim(st, taskArgs...)
	case "current":
		cmdTaskCurrent(st, clihelp.HasFlag(taskArgs, "--json"))
	case "detail":
		wantJSON := clihelp.HasFlag(taskArgs, "--json")
		taskArgs = clihelp.WithoutFlag(taskArgs, "--json") // task detail always prints JSON; --json is accepted so a script can say so
		if len(taskArgs) == 0 {
			cmdTaskCurrent(st, wantJSON)
			return
		}
		id, err := strconv.ParseInt(taskArgs[0], 10, 64)
		if err != nil || id <= 0 {
			fmt.Fprintln(os.Stderr, "task detail requires a positive task ID")
			clierr.Exit1()
		}
		path := fmt.Sprintf("/%s/tasks/%d", url.PathEscape(st.Project), id)
		if len(taskArgs) > 1 {
			if len(taskArgs) != 3 || taskArgs[1] != "--version" {
				fmt.Fprintln(os.Stderr, "Usage: task detail N [--version K]")
				exitFn(2)
				return
			}
			v, err := strconv.Atoi(taskArgs[2])
			if err != nil || v < 1 {
				fmt.Fprintln(os.Stderr, "version must be positive")
				exitFn(2)
				return
			}
			path += fmt.Sprintf("?version=%d", v)
		}
		data, status, err := apiCallRaw("GET", path, nil)
		if err != nil || status != http.StatusOK {
			fmt.Fprintln(os.Stderr, "Unable to read task: "+clierr.Describe(err, status, data))
			clierr.Exit1()
		}
		var task map[string]any
		if err := json.Unmarshal(data, &task); err != nil {
			fmt.Fprintln(os.Stderr, err)
			clierr.Exit1()
		}
		if _, ok := task["id"]; !ok {
			task["id"] = float64(id)
		} // a historical snapshot still records the version this caller read
		noteSeenRound(st.Project, task)
		pretty, _ := json.MarshalIndent(task, "", "  ")
		fmt.Println(string(pretty))
	case "show":
		cmdTaskShow(st, taskArgs)
	case "submit-review", "release-review":
		cmdTaskReview(st, taskArgs, sub)
	case "review", "approve", "reject":
		cmdTaskReviewFlow(st, taskArgs, sub)
	case "attach", "send-back", "mark-landed":
		cmdTaskQueueVerb(st, taskArgs, sub)
	case "complete":
		cmdTaskComplete(st, taskArgs)
	case "cancel":
		cmdTaskCancel(st, taskArgs)
	case "reassign":
		cmdTaskReassign(st, taskArgs)
	case "unblock":
		cmdTaskUnblock(st, taskArgs)
	case "amend":
		cmdTaskAmend(st, taskArgs)
	case "park", "unpark":
		cmdTaskPark(st, taskArgs, sub == "unpark")
	case "--help", "-h", "help":
		fmt.Println(taskUsageText)
		os.Exit(0)
	default:
		fmt.Fprintf(os.Stderr, "Unknown task subcommand: %s\n", sub)
		os.Exit(2) // usage
	}
}

const taskUsageText = `Usage: coral-board task <subcommand> [args]

Subcommands:
  add "title" [--body "details"] [--priority P] [--assignee "Agent Name"] [--remind-at TIME] [--goal ID] [--follow-up ID]
                                   --follow-up ID: the work that came out of task ID: it takes that task's goal, reviewers and assignee unless you give your own,
                                   and ID lists it (task show ID, task detail ID, the goal page's "N follow-ups open")
  list [--json] [--goal ID]        Every task, or one goal's; --json prints the tasks as a JSON array
  goal <task-id> <goal-id|none>    Put a task on a goal of this board, move it, or take it off (coral-board goal ... manages the goals)
  claim [id]                       Claim a specific task or the next available one
  current                          Show your current in-progress task
  edit <id> --title TEXT [--priority P]  Edit text as a new version (creator, orchestrator or Operator)
  edit <id> --restore-version K     Restore old text as a new version; --base-version K refuses a concurrent edit
  history <id>                     Immutable text versions, editors, times and field diffs
  detail <id> [--version K] [--json]             Read task instructions, inputs and results (always JSON; --json is accepted)
  show <id> [--json]               A task for a person: title, status, assignee, body, outcome, result message and its
                                   artifacts' coral:// links (--json: those fields as one JSON object)
  submit-review <id> --reason "review pending" [--revision N] [--message "note"] [--outcome success|failed] [--artifacts manifest.json]
                                   Hands the task to the team's orchestrator (frees your slot); with no orchestrator, completes it
  review <id> --to "Security Reviewer,QA Engineer"  The orchestrator delegates a task in review: one review task each
  approve <id> [--task-version K] [--round N] [--revision N] [--note "..."]  A reviewer approves, any time the task is in review; the last approval completes it
  reject <id> [--round N] --note "why"     A reviewer rejects: back to its author; the reviewers stay on it and review the resubmission
  attach <id> --artifacts manifest.json    Add patch rows to a task in review (a next revision, a reviewer's fix); a reviewer who had approved reviews the new bytes again
  send-back <id> --note "why"              The orchestrator returns an approved, completed task to its author (a fix after approval, a patch that would not apply)
  mark-landed <id> --digest D [--digest D2] [--commit SHA[:subject]]  The orchestrator (or the Operator) records that the approved patches with these digests landed, and the commits that landed them; a digest its round did not approve is refused
  release-review <id> --reason "slot released pending review" (orchestrator only; for a candidate submitted before v1.4.56)
  complete <id> [--revision N] [--message "note"] [--outcome success|failed] [--candidate-revision REVISION] [--artifacts manifest.json]
  cancel <id> [--message "reason"]
  reassign <id> [--to "Agent Name"]
  unblock <id> (--blocker ID | --all) Remove one or all prerequisites (orchestrator only)
  park <id> --reason "why" [--until DATE]  Set a task aside: no reminders, nudges or check items for it until
                                   it is unparked or DATE passes (orchestrator or Operator only)
  unpark <id>                      Bring a parked task back
  amend <id> --revision N --reason "..." [--body "..." --workflow-instructions "..." --completion-gates JSON (experimental, disabled by default; "[]" clears)]

Workflow options for add:
  --workflow "name" --stage "Build" --outputs "build,test_report"
  --blocked-by '[{"task_id":1,"condition":"success","required_artifacts":["build"]}]'
  --workflow-instructions "project-specific guidance" --parent <id> --retry-of <id>
  --completion-gates '[{"type":"report","artifact":"report"}]'  (EXPERIMENTAL, disabled by default: the server rejects new gate declarations unless it enables the feature; existing gates are inactive)
Conditions: success (default), failure, termination. Completed results are immutable.`

func cmdTaskList(st *boardState, asJSON bool) { cmdTaskListGoal(st, asJSON, 0) }

// taskListArgs reads task list's options: --json and --goal ID (a whole number, 1 or more).
func taskListArgs(args []string) (asJSON bool, goal int64) {
	asJSON = clihelp.HasFlag(args, "--json")
	for i, a := range args {
		name, value, inline := strings.Cut(a, "=")
		if name != "--goal" {
			continue
		}
		if !inline && i+1 < len(args) {
			value = args[i+1]
		}
		n, err := strconv.ParseInt(value, 10, 64)
		if err != nil || n <= 0 {
			fmt.Fprintf(os.Stderr, "--goal needs a goal ID, a whole number (got %q)\n", value)
			clierr.Exit1()
		}
		goal = n
	}
	return asJSON, goal
}

// cmdTaskListGoal lists the board's tasks, or one goal's when goal is not 0.
func cmdTaskListGoal(st *boardState, asJSON bool, goal int64) {
	tasks := fetchTasks(st, goal)
	if asJSON {
		if tasks == nil {
			tasks = []map[string]any{} // an empty board is [], never null
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
	for _, task := range tasks {
		id, _ := task["id"].(float64)
		tStatus, _ := task["status"].(string)
		if taskReviewRequested(task) && tStatus == "in_progress" {
			tStatus = "review_requested"
		}
		tPriority, _ := task["priority"].(string)
		tAssignee := "—"
		if a, ok := task["assigned_to"].(string); ok && a != "" {
			tAssignee = a
		}
		tTitle, _ := task["title"].(string)

		fmt.Printf("#%-3.0f %-12s %-9s %-15s %s\n", id, tStatus, tPriority, tAssignee, tTitle)
	}
}

// fetchTasks reads every task of the board, or of one goal when goal is not 0, a page at a time (#3269, #7184), in the order the full list always had: priority, then id. A server from before pagination ignores the parameters and answers with every task and no next_cursor, which ends the loop.
func fetchTasks(st *boardState, goal int64) []map[string]any {
	var tasks []map[string]any
	cursor := ""
	for {
		path := "/" + url.PathEscape(st.Project) + "/tasks?status=all&limit=200"
		if goal > 0 {
			path += "&goal=" + strconv.FormatInt(goal, 10)
		}
		if cursor != "" {
			path += "&cursor=" + url.QueryEscape(cursor)
		}
		data, statusCode, err := apiCallRaw("GET", path, nil)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			clierr.Exit1()
		}
		if statusCode != http.StatusOK {
			fmt.Fprintf(os.Stderr, "Error listing tasks: %s\n", clierr.Describe(nil, statusCode, data))
			clierr.Exit1()
		}
		var page struct {
			Tasks      []map[string]any `json:"tasks"`
			NextCursor string           `json:"next_cursor"`
		}
		json.Unmarshal(data, &page)
		tasks = append(tasks, page.Tasks...)
		if page.NextCursor == "" || page.NextCursor == cursor {
			break
		}
		cursor = page.NextCursor
	}
	rank := map[string]int{"critical": 0, "high": 1, "medium": 2, "low": 3}
	sort.SliceStable(tasks, func(i, j int) bool {
		pi, pj := rank[fmt.Sprint(tasks[i]["priority"])], rank[fmt.Sprint(tasks[j]["priority"])]
		if pi != pj {
			return pi < pj
		}
		ii, _ := tasks[i]["id"].(float64)
		ij, _ := tasks[j]["id"].(float64)
		return ii < ij
	})
	return tasks
}

// printUnverifiedArtifacts says which coral://artifacts links in the result the server kept as plain
// links because this team never uploaded those files (#4379).
func printUnverifiedArtifacts(data []byte) {
	var r struct {
		N     int      `json:"artifacts_unverified"`
		Names []string `json:"artifacts_unverified_names"`
	}
	if json.Unmarshal(data, &r) != nil || r.N == 0 {
		return
	}
	fmt.Printf("Note: %d artifact link(s) are not uploads of this team and were kept as plain links: %s. Upload the file with 'coral-agent artifact upload <file>' and use the link it prints.\n", r.N, strings.Join(r.Names, ", "))
}

func printTaskWorkflow(task map[string]any) {
	if workflow, ok := task["workflow"]; ok {
		data, err := json.MarshalIndent(workflow, "", "  ")
		if err == nil {
			fmt.Printf("\nWorkflow instructions, inputs and outputs:\n%s\n", data)
		}
	}
}
