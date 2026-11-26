package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/clierr"
	"github.com/subgentic/coral/internal/clihelp"
)

const workerUsageText = `Usage: coral-board worker <list|launch> ...
  worker list [--json]                          The workers the Operator approved for this team
  worker launch "NAME" [--task N]               Start a worker of that kind, with the task's text as its first message`

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
		clihelp.ParseFlags(fs, args[1:], func() string { return workerUsageText })
		data, status, err := apiCallRawAt("/api", "POST", base+"/"+url.PathEscape(name)+"/launch", map[string]any{"task_id": *task}, 60*time.Second)
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
	default:
		fmt.Fprintf(os.Stderr, "Error: unknown worker command %q.\n%s\n", sub, workerUsageText)
		os.Exit(2)
	}
}
