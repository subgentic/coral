package main

import (
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"

	"github.com/subgentic/coral/internal/clierr"
	"github.com/subgentic/coral/internal/clihelp"
)

// cmdTaskWaitOn is `coral-board task wait-on <id> (--member NAME | --condition TEXT) --reason TEXT`, and `task wait-on <id> --clear` (#21697): the owner says a task waits on a person or a condition, so its
// no-activity nudges stop and the member waited on is told. It clears when that member posts on the task (post --task N) or with --clear. --blocked-by stays for waits on other tasks.
func cmdTaskWaitOn(st *boardState, args []string) {
	usage := `Usage: coral-board task wait-on <id> --member NAME --reason "what you need from them"
       coral-board task wait-on <id> --condition "what you wait for" --reason "why"
       coral-board task wait-on <id> --clear`
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, usage)
		clierr.Exit1()
	}
	taskID, err := strconv.ParseInt(args[0], 10, 64)
	if err != nil || taskID <= 0 {
		fmt.Fprintf(os.Stderr, "Invalid task ID: %s\n%s\n", args[0], usage)
		clierr.Exit1()
	}
	fs := flag.NewFlagSet("task-wait-on", flag.ContinueOnError)
	member := fs.String("member", "", "the team member you wait on")
	condition := fs.String("condition", "", "something that is not a member: the Operator's choice, CI on main")
	reason := fs.String("reason", "", "why you wait, in a sentence")
	clear := fs.Bool("clear", false, "end the wait")
	clihelp.ParseFlags(fs, args[1:], func() string { return usage })
	body := map[string]any{"subscriber_id": resolveSubscriberID()}
	switch {
	case *clear:
		if *member != "" || *condition != "" || *reason != "" {
			fmt.Fprintln(os.Stderr, "--clear takes no other option\n"+usage)
			clierr.Exit1()
		}
		body["clear"] = true
	case (*member == "") == (*condition == ""):
		fmt.Fprintln(os.Stderr, "Name exactly one of --member and --condition.\n"+usage)
		clierr.Exit1()
	case *reason == "":
		fmt.Fprintln(os.Stderr, "--reason is required: say what you are waiting for.\n"+usage)
		clierr.Exit1()
	default:
		body["member"], body["condition"], body["reason"] = *member, *condition, *reason
	}
	data, status, err := apiCallRaw("POST", fmt.Sprintf("/%s/tasks/%d/wait-on", url.PathEscape(st.Project), taskID), body)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}
	if status != http.StatusOK {
		fmt.Fprintf(os.Stderr, "Error setting the wait: %s\n", clierr.Describe(nil, status, data))
		clierr.Exit1()
	}
	switch {
	case *clear:
		fmt.Printf("Task #%d no longer waits on anyone\n", taskID)
	case *member != "":
		fmt.Printf("Task #%d waits on %s: no no-activity nudges for it, and they are told. It clears when they post on it (post --task %d) or with --clear\n", taskID, *member, taskID)
	default:
		fmt.Printf("Task #%d waits on %q: no no-activity nudges for it. Clear it with task wait-on %d --clear\n", taskID, *condition, taskID)
	}
}
