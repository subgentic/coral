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

const stopUsageText = `Usage: coral-board stop <member> [--board <project>]

  Stop an agent's current turn (the same as the red Stop in its composer: the agent reads "Interrupted" and waits with its conversation; it is not put to sleep).
  An agent that is idle or asleep gets a plain sentence, not an error.

  Only the board's Orchestrator, and only while the Operator has switched on "the orchestrator may wake, sleep, stop and start agents" for the board: any other caller, or the switch off, is refused with
  the server's reason.`

func cmdStop() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, stopUsageText)
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
	fs := flag.NewFlagSet("stop", flag.ContinueOnError)
	boardFlag := fs.String("board", "", "The board (default: the one you joined)")
	clihelp.ParseFlags(fs, args, func() string { return stopUsageText })
	member = strings.TrimSpace(member)
	if member == "" || strings.HasPrefix(member, "-") {
		fmt.Fprintf(os.Stderr, "Error: name the agent to stop.\n%s\n", stopUsageText)
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
	path := fmt.Sprintf("/%s/agents/%s/stop", url.PathEscape(project), url.PathEscape(member))
	data := goalCall("POST", path, nil, "stopping "+member, 200)
	var out struct {
		Stopped bool   `json:"stopped"`
		Name    string `json:"name"`
		Note    string `json:"note"`
	}
	_ = json.Unmarshal(data, &out)
	who := member
	if out.Name != "" {
		who = out.Name
	}
	who = clitext.Clean(who)
	if !out.Stopped {
		fmt.Println(clitext.Clean(out.Note))
		return
	}
	fmt.Printf("Stopped %s's turn.\n", who)
}
