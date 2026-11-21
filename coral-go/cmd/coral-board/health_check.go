package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/subgentic/coral/internal/clierr"
)

const healthCheckUsage = `Usage: coral-board health check <command>

  list                          The team's custom checks: state, schedule, who it speaks as.
  add <name> --script <full path> --dir <folder> (--every 30m | --daily 09:00 --tz Europe/Berlin)
      [--arg <a> ...] [--to <member>] [--as <member>] [--may-write]
                                Add a check. It is PENDING: nothing runs until the Operator approves exactly this
                                record (script SHA-256, arguments, folder, schedule, who it speaks as, may-write).
  change <name> [the same flags]  Change a check. Any change makes it pending again.
  pause <name> | resume <name>  Stop or restart a check (resume needs the same approved record).
  remove <name>                 Delete a check.

The orchestrator or the Operator only. --may-write lets the check post, add tasks, comment and reassign as the member it speaks as
(5 a run, 6 an hour), marked "via check <name>"; without it the check only reads.`

type repeated []string

func (r *repeated) String() string     { return strings.Join(*r, " ") }
func (r *repeated) Set(v string) error { *r = append(*r, v); return nil }

func cmdHealthCheck(args []string) {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" || args[0] == "help" {
		fmt.Println(healthCheckUsage)
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
	base := "/" + url.PathEscape(st.Project) + "/health/checks"
	switch args[0] {
	case "list":
		data, status, err := apiCallRaw("GET", base, nil)
		checkDone(data, status, err)
		var out struct {
			Checks []map[string]any `json:"checks"`
		}
		if json.Unmarshal(data, &out) != nil || len(out.Checks) == 0 {
			fmt.Println("No custom checks.")
			return
		}
		for _, c := range out.Checks {
			fmt.Printf("%v  %v  every %v  as %v  hash %.12v\n", c["name"], c["state"], c["every"], c["acts_as"], c["record_hash"])
		}
	case "add", "change":
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, healthCheckUsage)
			clierr.Exit1()
		}
		name := args[1]
		fs := flag.NewFlagSet("check "+args[0], flag.ContinueOnError)
		script := fs.String("script", "", "")
		dir := fs.String("dir", "", "")
		every := fs.String("every", "", "")
		daily := fs.String("daily", "", "")
		tz := fs.String("tz", "", "")
		to := fs.String("to", "", "")
		as := fs.String("as", "", "")
		mayWrite := fs.Bool("may-write", false, "")
		var argv repeated
		fs.Var(&argv, "arg", "")
		if err := fs.Parse(args[2:]); err != nil {
			clierr.Exit1()
		}
		body := map[string]any{}
		fs.Visit(func(f *flag.Flag) {
			switch f.Name {
			case "script":
				body["script"] = *script
			case "dir":
				body["dir"] = *dir
			case "every":
				body["every"] = *every
			case "daily":
				body["daily"] = *daily
			case "tz":
				body["tz"] = *tz
			case "to":
				body["to"] = *to
			case "as":
				body["acts_as"] = *as
			case "may-write":
				body["may_write"] = *mayWrite
			case "arg":
				body["args"] = []string(argv)
			}
		})
		method, path := "PUT", base+"/"+url.PathEscape(name)
		if args[0] == "add" {
			method, path = "POST", base
			body["name"] = name
		}
		data, status, err := apiCallRaw(method, path, body)
		checkDone(data, status, err)
		var c map[string]any
		_ = json.Unmarshal(data, &c)
		fmt.Printf("Check %s is %v. The Operator has to approve exactly this:\n%v\n", name, c["state"], c["approval_words"])
	case "pause", "resume":
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, healthCheckUsage)
			clierr.Exit1()
		}
		data, status, err := apiCallRaw("POST", base+"/"+url.PathEscape(args[1])+"/pause", map[string]any{"paused": args[0] == "pause"})
		checkDone(data, status, err)
		var c map[string]any
		_ = json.Unmarshal(data, &c)
		fmt.Printf("Check %s is %v\n", args[1], c["state"])
	case "remove":
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, healthCheckUsage)
			clierr.Exit1()
		}
		data, status, err := apiCallRaw("DELETE", base+"/"+url.PathEscape(args[1]), nil)
		checkDone(data, status, err)
		fmt.Printf("Check %s removed\n", args[1])
	default:
		fmt.Fprintln(os.Stderr, healthCheckUsage)
		clierr.Exit1()
	}
}

func checkDone(data []byte, status int, err error) {
	if err != nil || status != http.StatusOK {
		fmt.Fprintf(os.Stderr, "Error: %v %s\n", err, data)
		clierr.Exit1()
	}
}
