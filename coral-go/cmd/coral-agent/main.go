// Command coral-agent is the command-line interface to Coral agents. `launch`
// starts a new agent from any terminal, the same way + New Agent does. The
// task commands are what an agent uses to work with its own tasks in Coral:
// the tasks the operator gives an agent that is not on a team board.
//
// Its task commands use the same workflow engine as coral-board task, scoped
// to a personal session, and call the matching agent task API
// (/api/agent/tasks/...). The agent is identified by its Coral session (tmux
// session name or the CORAL_SESSION_NAME variable Coral exports), the same way
// Coral's hooks resolve it. Team boards keep using coral-board.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/cliauth"
	"github.com/subgentic/coral/internal/clierr"
	"github.com/subgentic/coral/internal/clitext"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/hooks"
	"github.com/subgentic/coral/internal/transcriptlink"
)

var serverURL = hooks.CoralBase()

func printUsage() {
	fmt.Println(agentUsageText)
}

// agentUsageText is the usage with this platform's default port filled in (8450 on Windows, 8420 elsewhere).
var agentUsageText = strings.ReplaceAll(agentUsageTextTemplate, "{{PORT}}", strconv.Itoa(config.DefaultPort))

const agentUsageTextTemplate = `coral-agent - launch Coral agents and work with your own tasks

Commands:
  bind-codex <coral-id> <thread-id> Link a verified native Codex transcript
  ui <publish|list|events|remove>  Publish interactive sidebar panels
  artifact upload <file>           Store long reports/logs/diffs/evidence; link the
                                 returned coral://artifacts/<digest> in a short post
  artifact download <uri> [--output FILE] [--force] Download and verify an artifact; prints local path
  launch [dir] [--type T] [--name N] [--model M] [--prompt P] [--board ID]
                                 Launch an agent in dir (default: current
                                 directory) with your default settings;
                                 --board joins it to that board (its id)
  task add "title" [--body "details"] [--priority P]  Create a task
  task list [--json]             List your tasks (--json: a JSON array)
  task detail <id> [--json]      Read requirements, dependencies and results (always JSON)
  task claim [id]                Claim a named ready task or next ready work
  task edit <id> [options]       Edit unstarted task text/dependencies (task edit --help)
  task current [--json]          Show your current in-progress task
  task complete <id> [--message "note"]  Complete with outcome/evidence
  task cancel <id> [--message "reason"]  Cancel a task
  history search <query> [flags] Search conversation history (post-compaction)
  history context [sess] <idx>   Retrieve surrounding conversation context
  search <query> [flags]         Shortcut for 'history search'
  notify --title T [--message M] [--level L] [--alert]
                                 Show a notification on the dashboard
  docs [topic|all]               List Coral's docs for agents, or print one

Output:
  --raw       Print what the server sent byte for byte. Without it, terminal control
              sequences in task text, history and messages are removed before printing.
              (Downloaded artifacts are always byte for byte.)

Environment:
  CORAL_URL   Coral's address (default: the one the running Coral recorded,
              else http://localhost:{{PORT}}, this platform's port)
  CORAL_PORT  Server port (overrides CORAL_URL)

Help topics:  coral-agent help windows | exit-codes | json | timeouts` + "\n\n" + clierr.Table

func main() {
	hooks.InstallIdentity("coral-agent") // the agent session's token, sent with every request (#3387)
	// A person running it in their own terminal (no agent session) signs with the
	// command-line token instead, as the local Operator (strict local auth, #3418).
	cliauth.InstallOperatorSigning()
	os.Args, rawOutput = clitext.TakeRaw(os.Args)
	if len(os.Args) < 2 {
		printUsage()
		clierr.Exit1()
	}
	// Help and option-shaped text are handled before any command runs, so
	// neither can reach the server or be taken as data.
	if handled, code := handleHelp(os.Args[1:], os.Stdout); handled {
		os.Exit(code)
	}
	if err := checkFreeText(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		fmt.Fprintln(os.Stderr, commandUsage(os.Args[1], os.Args[2:]))
		os.Exit(2)
	}
	switch os.Args[1] {
	case "bind-codex":
		if len(os.Args) != 4 {
			fmt.Fprintln(os.Stderr, "Usage: coral-agent bind-codex <coral-id> <thread-id>")
			clierr.Exit1()
		}
		if err := transcriptlink.BindCodex(os.Args[2], os.Args[3]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			clierr.Exit1()
		}
		fmt.Println("Codex transcript linked")
	case "ui":
		cmdUI(os.Args[2:])
	case "launch":
		cmdLaunch(os.Args[2:])
	case "artifact":
		cmdArtifact(os.Args[2:])
	case "task":
		cmdTask()
	case "history":
		cmdHistory(os.Args[2:])
	case "search":
		cmdHistorySearch(os.Args[2:])
	case "docs":
		if err := cmdDocs(os.Args[2:], os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, err)
			clierr.Exit1()
		}
	case "notify":
		if err := cmdNotify(os.Args[2:], os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, err)
			clierr.Exit1()
		}
	case "--help", "-h", "help":
		printUsage()
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s. Run coral-agent help for the commands.\n", os.Args[1])
		os.Exit(2) // usage
	}
}

// resolveSessionID identifies the calling agent (as coral-board's
// resolveSubscriberID identifies a board member).
func resolveSessionID() string {
	sid := hooks.ResolveSessionID("")
	if sid == "" {
		fmt.Fprintln(os.Stderr, "Not inside a Coral agent session (no tmux session name or CORAL_SESSION_NAME).")
		clierr.Exit1()
	}
	return sid
}

func apiCallRaw(method, path string, body any) ([]byte, int, error) {
	return apiCall(method, "/api/agent"+path, body, 10*time.Second)
}

func apiCall(method, path string, body any, timeout time.Duration) ([]byte, int, error) {
	if err := refuseSignInLinkInBody(body); err != nil { // nothing other people read carries a sign-in link
		return nil, 0, err
	}
	var bodyReader io.Reader
	if body != nil {
		data, _ := json.Marshal(body)
		bodyReader = bytes.NewReader(data)
	}

	req, err := http.NewRequest(method, serverURL+path, bodyReader)
	if err != nil {
		return nil, 0, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	timeout = clierr.Timeout(timeout) // CORAL_TIMEOUT, when set, replaces the command's own
	client := &http.Client{Timeout: timeout}
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, clierr.CannotReach(hooks.RedactedURL(serverURL), err, timeout)
	}
	defer resp.Body.Close()
	clierr.NoteStatus(resp.StatusCode)

	respData, _ := clitext.ReadReply(resp.Body, rawOutput)
	return respData, resp.StatusCode, nil
}

// rawOutput is --raw: print what the server sent byte for byte. Otherwise every reply is cleaned
// of terminal control first (#3580): task text, history and messages are written by agents, and
// an escape sequence in them could rewrite or hide what the terminal shows, set its title or
// reach the clipboard. Artifact downloads are never changed.
var rawOutput bool
