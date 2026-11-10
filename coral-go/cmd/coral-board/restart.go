package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/subgentic/coral/internal/clierr"
	"github.com/subgentic/coral/internal/clihelp"
	"github.com/subgentic/coral/internal/clitext"
)

// coral-board restart <member> (#15112): the board's Orchestrator restarts an agent of its board as a fresh session with the settings it was launched with, under the Operator's grant
// (route POST /api/board/{project}/agents/{member}/restart). The server decides everything; its sentence is what is printed.

const restartUsageText = `Usage: coral-board restart <member> [--board <project>] [--when-idle]

  Restart an agent of this board as a fresh session (no context) with the settings it was launched with: the same CLI, model, mode, folder, board seat and job title. The board says who restarted whom.

  Only the board's Orchestrator, and only while the Operator has switched on "the orchestrator may wake, sleep and start agents" for the board: any other caller, or the switch off, is refused with
  the server's reason. It counts toward the hourly cap shared with wake. An agent in the middle of a turn is refused; with --when-idle the restart is queued for its next idle (dropped after two hours).`

func cmdRestart() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, restartUsageText)
		os.Exit(2)
	}
	member, args := os.Args[2], os.Args[3:]
	if strings.HasPrefix(member, "-") {
		for i, a := range os.Args[2:] {
			if !strings.HasPrefix(a, "-") && (i == 0 || os.Args[2+i-1] != "--board") {
				member, args = a, append(append([]string{}, os.Args[2:2+i]...), os.Args[3+i:]...)
				break
			}
		}
	}
	fs := flag.NewFlagSet("restart", flag.ContinueOnError)
	boardFlag := fs.String("board", "", "The board (default: the one you joined)")
	whenIdle := fs.Bool("when-idle", false, "Queue the restart for the agent's next idle instead of refusing a busy one")
	clihelp.ParseFlags(fs, args, func() string { return restartUsageText })
	member = strings.TrimSpace(member)
	if member == "" || strings.HasPrefix(member, "-") {
		fmt.Fprintf(os.Stderr, "Error: name the agent to restart.\n%s\n", restartUsageText)
		os.Exit(2)
	}
	project := strings.TrimSpace(*boardFlag)
	if project == "" {
		st := loadState()
		if st == nil {
			fmt.Fprintln(os.Stderr, "Not subscribed to any board. Run: coral-board join <project> --as <role> or give --board <project>")
			clierr.Exit1()
		}
		project = st.Project
	}
	path := fmt.Sprintf("/%s/agents/%s/restart", url.PathEscape(project), url.PathEscape(member))
	if *whenIdle {
		path += "?when_idle=1"
	}
	data := goalCall("POST", path, nil, "restarting "+member, 200)
	var out struct {
		Restarted string `json:"restarted"`
		Queued    string `json:"queued"`
	}
	_ = json.Unmarshal(data, &out)
	if out.Queued != "" {
		fmt.Printf("%s is busy: its restart is queued for its next idle.\n", clitext.Clean(out.Queued))
		return
	}
	who := member
	if out.Restarted != "" {
		who = out.Restarted
	}
	fmt.Printf("Restarted %s as a fresh session with its launch settings.\n", clitext.Clean(who))
}
