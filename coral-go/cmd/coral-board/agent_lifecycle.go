package main

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/subgentic/coral/internal/clierr"
)

// coral-board agent wake|sleep <name> (#13420): the Orchestrator seat's wake and sleep of an agent on its own board, through POST /api/board/<board>/agents/<name>/wake|sleep. The server decides who may: it
// refuses any agent that is not the seat the Operator named (and any caller while the switch is off), and the CLI passes that refusal on in the server's words.

const agentLifecycleUsage = "usage: coral-board agent wake|sleep <name> [--board <board>]"

func cmdAgent() {
	if err := runAgentLifecycle(os.Args[2:], os.Stdout); err != nil {
		if usage, ok := err.(errLinkUsage); ok {
			fmt.Fprintf(os.Stderr, "Error: %s\n%s\n", usage.msg, agentLifecycleUsage)
			os.Exit(2)
		}
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}
}

// runAgentLifecycle does agent wake or agent sleep for args (the action, the agent's name and --board) and writes what the server answered to out.
func runAgentLifecycle(args []string, out io.Writer) error {
	var pos []string
	board := ""
	for i := 0; i < len(args); i++ {
		if args[i] == "--board" {
			if i+1 >= len(args) || strings.HasPrefix(args[i+1], "--") {
				return errLinkUsage{"--board needs a board name"}
			}
			board = args[i+1]
			i++
			continue
		}
		pos = append(pos, args[i])
	}
	if len(pos) != 2 || (pos[0] != "wake" && pos[0] != "sleep") {
		return errLinkUsage{"name wake or sleep and one agent"}
	}
	action, name := pos[0], strings.TrimSpace(pos[1])
	if name == "" {
		return errLinkUsage{"name an agent of this board"}
	}
	if board == "" {
		if st := loadState(); st != nil {
			board = st.Project
		}
	}
	if board == "" {
		return errLinkUsage{"this shell is not on a board: add --board <board>"}
	}
	result, status, err := apiCall(http.MethodPost, "/"+url.PathEscape(board)+"/agents/"+url.PathEscape(name)+"/"+action, nil)
	if err != nil {
		return err
	}
	if e := serverError(status, result); e != nil {
		return e
	}
	who := name
	if action == "wake" {
		if s, _ := result["woke"].(string); s != "" {
			who = s
		}
		fmt.Fprintf(out, "Woke %s.\n", who)
		if n, _ := result["max_per_hour"].(float64); n > 0 { // a wake counts against the board's hourly limit; a sleep does not
			fmt.Fprintf(out, "This board's limit: %d launches and wakes an hour.\n", int(n))
		}
		return nil
	}
	if s, _ := result["slept"].(string); s != "" {
		who = s
	}
	fmt.Fprintf(out, "Put %s to sleep.\n", who)
	return nil
}
