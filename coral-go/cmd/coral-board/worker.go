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
	"github.com/subgentic/coral/internal/clitext"
)

// taskAssignee is who task id is assigned to, for `worker archive #N`; it stops with a plain sentence when the task has no assignee.
func taskAssignee(project string, id int64) string {
	data, status, err := apiCallRaw("GET", fmt.Sprintf("/%s/tasks/%d", url.PathEscape(project), id), nil)
	if err != nil || status != http.StatusOK {
		fmt.Fprintln(os.Stderr, "Unable to read task: "+clierr.Describe(err, status, data))
		clierr.Exit1()
	}
	t, err := parseTaskShow(data)
	if err != nil || strings.TrimSpace(t.AssignedTo) == "" {
		fmt.Fprintf(os.Stderr, "Task #%d has no assignee, so there is no worker to archive. Name the worker instead.\n", id)
		clierr.Exit1()
	}
	return t.AssignedTo
}

const workerUsageText = `Usage: coral-board worker <list|launch|archive> ...
  worker list [--json]                          The workers the Operator approved for this team
  worker launch "NAME" [--task N] [--worktree]  Start a worker of that kind, with the task's text as its first message. --worktree (needs --task N) starts it in its own git worktree task-N
  worker archive NAME|#N [--remove-worktree]    Stop a worker and archive it (the same as coral-board stop). #N is task N's assignee. --remove-worktree also removes its own worktree task-N when it has no
                                                changes that are not committed (the branch is kept; files git ignores, such as .env or build output, go with the folder)`

// cmdWorker is the Orchestrator's side of the team's approved workers (mock v3 idea 2): the list, and a launch of one for a task. The Operator saves the workers on the team's page; the server runs the
// launch with the same rules as any launch an agent makes (what the new agent may do without asking, the team's limit, the folders).
func cmdWorker() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, workerUsageText)
		os.Exit(2)
	}
	st := loadState()
	if st == nil || st.Project == "" {
		fmt.Fprintln(os.Stderr, "Error: this terminal has not joined a board, so there is no team's worker list to use.")
		clierr.Exit1()
	}
	sub, args := os.Args[2], os.Args[3:]
	base := "/board/" + url.PathEscape(st.Project) + "/workers"
	switch sub {
	case "list":
		fs := flag.NewFlagSet("worker-list", flag.ContinueOnError)
		asJSON := fs.Bool("json", false, "Print the list as JSON")
		clihelp.ParseFlags(fs, args, func() string { return workerUsageText })
		data, status, err := apiCallRawAt("/api", "GET", base, nil, 10*time.Second)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			clierr.Exit1()
		}
		if status != http.StatusOK {
			fmt.Fprintf(os.Stderr, "Error reading the workers: %s\n", clierr.Describe(nil, status, data))
			clierr.Exit1()
		}
		if *asJSON {
			fmt.Println(string(data))
			return
		}
		var out struct {
			Brief string `json:"brief"`
		}
		_ = json.Unmarshal(data, &out)
		if out.Brief == "" {
			fmt.Println("This team has no approved workers: the Operator adds them on the team's page (Agents > Workers). You can still start your own setup with coral-agent launch.")
			return
		}
		fmt.Println(out.Brief)
	case "launch":
		if len(args) < 1 || strings.HasPrefix(args[0], "-") {
			fmt.Fprintln(os.Stderr, workerUsageText)
			clierr.Exit1()
		}
		name := args[0]
		fs := flag.NewFlagSet("worker-launch", flag.ContinueOnError)
		task := fs.Int64("task", 0, "The task whose text the worker starts with")
		worktree := fs.Bool("worktree", false, "Start the worker in its own git worktree task-N (needs --task N)")
		clihelp.ParseFlags(fs, args[1:], func() string { return workerUsageText })
		if *worktree && *task <= 0 {
			fmt.Fprintln(os.Stderr, "--worktree needs --task N: the worktree is called task-N")
			os.Exit(2)
		}
		body := map[string]any{"task_id": *task}
		if *worktree {
			body["worktree"] = true
		}
		data, status, err := apiCallRawAt("/api", "POST", base+"/"+url.PathEscape(name)+"/launch", body, 60*time.Second)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			clierr.Exit1()
		}
		var out map[string]any
		_ = json.Unmarshal(data, &out)
		if status != http.StatusOK {
			fmt.Fprintf(os.Stderr, "Error launching the worker: %s\n", clierr.Describe(nil, status, data))
			clierr.Exit1()
		}
		shown, _ := out["display_name"].(string)
		sess, _ := out["session_name"].(string)
		fmt.Printf("Launched %s from the approved worker %q\n  Session: %s\n", shown, name, sess)
		if *task > 0 {
			fmt.Printf("  It starts with task #%d's text. Assign it: coral-board task reassign %d --to %q\n", *task, *task, shown)
		}
		if wt, _ := out["worktree"].(map[string]any); wt != nil {
			if n, _ := wt["name"].(string); n != "" {
				fmt.Printf("  Own worktree: %s (coral-board worker archive %q --remove-worktree takes it away when it is clean; the branch is kept)\n", clitext.Clean(n), shown)
			}
		}
	case "archive":
		fs := flag.NewFlagSet("worker-archive", flag.ContinueOnError)
		removeWorktree := fs.Bool("remove-worktree", false, "Also remove the worker's own worktree (task-N); the branch is kept")
		if len(args) < 1 || strings.HasPrefix(args[0], "-") {
			fmt.Fprintln(os.Stderr, workerUsageText)
			os.Exit(2)
		}
		who := strings.TrimSpace(args[0])
		clihelp.ParseFlags(fs, args[1:], func() string { return workerUsageText })
		if strings.HasPrefix(who, "#") {
			id, err := strconv.ParseInt(strings.TrimPrefix(who, "#"), 10, 64)
			if err != nil || id <= 0 {
				fmt.Fprintf(os.Stderr, "Error: %q is not a task number. Give a worker name or #N for task N.\n", who)
				os.Exit(2)
			}
			who = taskAssignee(st.Project, id)
		}
		archiveAgent(st.Project, who, *removeWorktree)
	default:
		fmt.Fprintf(os.Stderr, "Error: unknown worker command %q.\n%s\n", sub, workerUsageText)
		os.Exit(2)
	}
}
