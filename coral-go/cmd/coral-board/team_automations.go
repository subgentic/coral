package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"

	"github.com/subgentic/coral/internal/clierr"
)

const teamAutomationUsage = `Usage: coral-board automation <command>

  list                        The team's proposed automations: state, schedule, hash.
  show <name>                 One automation whole (every step in full) and its latest runs.
  propose --file <json>       Propose a new automation. It starts OFF: it waits in the Operator's Needs you with
                              every step in full and a hash, and runs only after the Operator's own Approve.
  change <name> --file <json> Replace its definition. Any change turns it off and asks the Operator again.
  disable <name>              Turn it off. (There is no command that turns one on: only the Operator's Approve does.)
  delete <name>               Remove it.
  run <name>                  One test run of an automation the Operator approved in its current version.

The file is {"name", "description", "steps":[{"name","type":"shell"|"agent","command"|"prompt", "continue_on_failure","timeout_s"}],
"schedule":{"cron":"30 7 * * 1-5","timezone":"America/Chicago"} (optional), "max_duration_s"}. It runs in this team's own repo folder.
The Orchestrator of the team only. Agent steps set their agent type and model only (no flags, tools or hooks). A step that runs a
file of the repo ("./scripts/check.sh --x") has that file's bytes approved with it: if the file changes the run stops and the
Operator is asked again. Limits: 10 steps, 6 proposals an hour, a schedule no more often than every 15 minutes.`

func cmdTeamAutomation(args []string) {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" || args[0] == "help" {
		fmt.Println(teamAutomationUsage)
		if len(args) == 0 {
			clierr.Exit1()
		}
		os.Exit(0)
	}
	st := loadState()
	if st == nil {
		fmt.Fprintln(os.Stderr, "Not subscribed to any board. Run: coral-board join <project> --as <role>")
		clierr.Exit1()
	}
	base := "/" + url.PathEscape(st.Project) + "/automations"
	need := func(n int) {
		if len(args) < n {
			fmt.Fprintln(os.Stderr, teamAutomationUsage)
			clierr.Exit1()
		}
	}
	fileBody := func() json.RawMessage {
		for i, a := range args {
			if (a == "--file" || a == "-f") && i+1 < len(args) {
				data, err := os.ReadFile(args[i+1])
				if err != nil {
					fmt.Fprintf(os.Stderr, "Error reading file: %v\n", err)
					clierr.Exit1()
				}
				var probe map[string]any
				if json.Unmarshal(data, &probe) != nil {
					fmt.Fprintln(os.Stderr, "Invalid JSON in the file")
					clierr.Exit1()
				}
				return data
			}
		}
		fmt.Fprintln(os.Stderr, teamAutomationUsage)
		clierr.Exit1()
		return nil
	}
	switch args[0] {
	case "list":
		data, status, err := apiCallRaw("GET", base, nil)
		checkDone(data, status, err)
		var out struct {
			Automations []map[string]any `json:"automations"`
		}
		if json.Unmarshal(data, &out) != nil || len(out.Automations) == 0 {
			fmt.Println("No automations.")
			return
		}
		for _, a := range out.Automations {
			fmt.Printf("%v  %v  %v %v  hash %.12v\n", a["name"], a["state"], a["cron"], a["timezone"], a["hash"])
		}
	case "show":
		need(2)
		data, status, err := apiCallRaw("GET", base+"/"+url.PathEscape(args[1]), nil)
		checkDone(data, status, err)
		var out struct {
			Automation map[string]any   `json:"automation"`
			Runs       []map[string]any `json:"runs"`
		}
		_ = json.Unmarshal(data, &out)
		fmt.Println(out.Automation["words"])
		fmt.Printf("\nState: %v\n", out.Automation["state"])
		for _, r := range out.Runs {
			fmt.Printf("run %v  %v  %v\n", r["id"], r["status"], r["started_at"])
		}
	case "propose", "change":
		var path, method string
		if args[0] == "propose" {
			method, path = "POST", base
		} else {
			need(2)
			method, path = "PUT", base+"/"+url.PathEscape(args[1])
		}
		data, status, err := apiCallRaw(method, path, fileBody())
		if err != nil || (status != 200 && status != 201) {
			fmt.Fprintf(os.Stderr, "Error: %v %s\n", err, data)
			clierr.Exit1()
		}
		var a map[string]any
		_ = json.Unmarshal(data, &a)
		fmt.Printf("Automation %v is %v and OFF. The Operator has to approve exactly this (hash %v):\n\n%v\n", a["name"], a["state"], a["hash"], a["words"])
	case "disable":
		need(2)
		data, status, err := apiCallRaw("POST", base+"/"+url.PathEscape(args[1])+"/disable", map[string]any{})
		checkDone(data, status, err)
		fmt.Printf("Automation %s is off\n", args[1])
	case "delete":
		need(2)
		data, status, err := apiCallRaw("DELETE", base+"/"+url.PathEscape(args[1]), nil)
		checkDone(data, status, err)
		fmt.Printf("Automation %s removed\n", args[1])
	case "run":
		need(2)
		data, status, err := apiCallRaw("POST", base+"/"+url.PathEscape(args[1])+"/run", map[string]any{})
		checkDone(data, status, err)
		var out map[string]any
		_ = json.Unmarshal(data, &out)
		fmt.Printf("Started run %v of %s\n", out["run_id"], args[1])
	default:
		fmt.Fprintln(os.Stderr, teamAutomationUsage)
		clierr.Exit1()
	}
}
