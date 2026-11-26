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

const stopUsageText = `Usage: coral-board stop <member> [--remove-worktree] [--board <project>]

  Stop an agent: its session ends and it is archived. It stays with the team (name, role, tasks and history), leaves the Agents list, and no longer gets nudges or tasks; coral-board wake <member> starts it
  again, coral-board sleep <member> turns it into a sleeping agent. A working agent is cut off with its session. To end only the current turn use coral-board interrupt <member>.
  --remove-worktree also removes the worktree the worker was started in with its own flag (task-N); it does nothing for a worker started without one. It is refused, with the reason, when the worktree has
  changes that are not committed (and one row says so in Activity). The branch is always kept. Files git ignores (such as .env or build output) are deleted with the folder.
  An agent already archived gets a plain sentence. The Orchestrator itself and the team's last Orchestrator are refused, and so is an agent that waits for a person's answer or sits at a dialog.

  Only the board's Orchestrator, and only while BOTH the main orchestrator switch AND the separate "stop" setting are on in the board's orchestrator grant: any other caller, either switch off, is refused
  with the server's reason.`

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
	removeWorktree := fs.Bool("remove-worktree", false, "Also remove the worker's own worktree (task-N); the branch is kept")
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
	var body any
	if *removeWorktree {
		body = map[string]any{"remove_worktree": true}
	}
	data := goalCall("POST", path, body, "stopping "+member, 200)
	var out struct {
		Stopped  bool   `json:"stopped"`
		Name     string `json:"name"`
		Note     string `json:"note"`
		Worktree *struct {
			State  string `json:"state"`
			Name   string `json:"name"`
			Reason string `json:"reason"`
		} `json:"worktree"`
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
	fmt.Printf("Stopped %s: its session ended and it is archived (coral-board wake %q starts it again).\n", who, who)
	if w := out.Worktree; w != nil { // the same words an Activity row carries when it was kept
		switch w.State {
		case "removed":
			fmt.Printf("Its worktree %s was removed. The branch is kept.\n", clitext.Clean(w.Name))
		case "kept":
			fmt.Printf("%s was archived, but its worktree was kept: %s\n", who, clitext.Clean(w.Reason))
		default:
			fmt.Println(clitext.Clean(w.Reason))
		}
	}
}
