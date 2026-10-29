// Command coral-board is the message board CLI for inter-agent communication.
package main

import (
	"fmt"
	"github.com/subgentic/coral/internal/cliauth"
	"github.com/subgentic/coral/internal/clierr"
	"github.com/subgentic/coral/internal/clitext"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/hooks"
	"os"
	"strconv"
	"strings"
)

var serverURL = "http://localhost:8420"

// rawOutput is --raw: print what the server sent byte for byte. Otherwise every reply is cleaned
// of terminal control first (#3580): board posts, task text and another agent's screen are
// written by agents, and an escape sequence in them could rewrite or hide what the terminal
// shows, set its title or reach the clipboard.
var rawOutput bool

func init() {
	serverURL = endpointFromEnv(os.Getenv("CORAL_URL"), os.Getenv("CORAL_HOST"), os.Getenv("CORAL_PORT"))
	if os.Getenv("CORAL_URL") == "" && os.Getenv("CORAL_HOST") == "" && os.Getenv("CORAL_PORT") == "" {
		serverURL = config.LocalServerURL() // a plain terminal: the running server's recorded address, else the platform's default port (8450 on Windows)
	}
}

func main() {
	hooks.InstallIdentity("coral-board") // the agent session's token, sent with every request (#3387)
	// A person running it in their own terminal (no agent session) signs with the
	// command-line token instead, as the local Operator (strict local auth, #3418).
	cliauth.InstallOperatorSigning()
	installWithheldNoter() // a withheld token exits refused (5), whichever request met it (Security's #260 pass)
	os.Args, rawOutput = clitext.TakeRaw(os.Args)
	if len(os.Args) < 2 {
		printUsage()
		clierr.Exit1()
	}

	// Help and flag-shaped text are handled before any command runs, so
	// neither can load state, resolve identity or reach the server.
	if handled, code := handleHelp(os.Args[1:], os.Stdout); handled {
		os.Exit(code)
	}
	if err := checkFreeText(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		if u := commandUsage(os.Args[1], os.Args[2:]); u != "" {
			fmt.Fprintln(os.Stderr, u)
		}
		os.Exit(2)
	}

	if err := checkKnownFlags(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		if u := commandUsage(os.Args[1], os.Args[2:]); u != "" {
			fmt.Fprintln(os.Stderr, u)
		}
		os.Exit(2)
	}

	cmd := os.Args[1]
	switch cmd {
	case "join":
		cmdJoin()
	case "post":
		cmdPost()
	case "read":
		cmdRead()
	case "search":
		cmdSearch()
	case "check":
		cmdCheck()
	case "projects":
		cmdProjects()
	case "subscribers":
		cmdSubscribers()
	case "status":
		if err := runBoardStatus(os.Args[2:], os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, err)
			clierr.Exit1()
		}
	case "working-mode":
		cmdWorkingMode(os.Args[2:])
	case "reviewer":
		cmdReviewer(os.Args[2:])
	case "leave":
		if len(os.Args) > 2 { // --board and --as: the Operator removes another's seat (#11112)
			if err := runLeaveAs(os.Args[2:], os.Stdout); err != nil {
				fmt.Fprintln(os.Stderr, err)
				clierr.Exit1()
			}
			break
		}
		cmdLeave()
	case "seats":
		cmdSeats()
	case "delete":
		cmdDelete()
	case "export":
		cmdExport()
	case "peek":
		cmdPeek()
	case "waiting":
		cmdWaiting()
	case "task":
		cmdTask()
	case "goal":
		cmdGoal()
	case "workflow":
		cmdWorkflow()
	case "wait":
		cmdWait()
	case "health":
		cmdHealth()
	case "queue":
		cmdQueue()
	case "send":
		cmdSend()
	case "targets":
		cmdTargets()
	case "link":
		cmdLink(false)
	case "unlink":
		cmdLink(true)
	case "links":
		cmdLinks()
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n", cmd)
		printUsage()
		os.Exit(2) // usage
	}
}

func printUsage() {
	fmt.Fprintln(os.Stderr, usageText)
}

// usageText is the usage with this platform's default port filled in (8450 on Windows, 8420 elsewhere).
var usageText = strings.ReplaceAll(usageTextTemplate, "{{PORT}}", strconv.Itoa(config.DefaultPort))

const usageTextTemplate = `Usage: coral-board <command> [args]

Help topics:  coral-board help windows | exit-codes | json | timeouts   (also: help post, help send, help wait)

Commands:
  join <project> --as <role>   Subscribe to a board
  post --file <path> [--to "a,b"]
                               Post the text of a UTF-8 file: the same in every
                               shell (PowerShell, cmd.exe and Bash)
  post "<message>" [--to "a,b"] [--task N]
                               Post a short message (@mention agents);
                               --task N answers task N (a person's reply on it);
                               use -- before text that starts with '-'
  post --ask "@Name <question>"
                               A question that needs an answer from the members
                               it @mentions (no work to produce). It stays open
                               until each answers (post --reply-to N "...", or a
                               post that @mentions you); whoever has not is
                               reminded once after 15 min (a team setting)
  post --reply-to N "<text>"   Answer message N: what closes a question asked of
                               you ('read' prints its number)
  post --assign "Name" [--goal N] [--title T] [--priority P] "<text>"
                               Work to produce (code, tests, docs, a review) is
                               a task: this creates it (title from --title or
                               the first line, the text as its body, assigned to
                               Name, on --goal N or your own task's goal; with
                               neither it refuses) and posts the text with its
                               link. Name is told by the task: no @mention.
                               A question, decision, heads-up or status stays a
                               plain post
  post - [--to "a,b"] <<'EOF'  Multi-line posts and anything with backticks:
                               Bash heredoc, literal stdin text; EOF closes on
                               its own line. UTF-8 only. 'coral-board help post'
                               has the writing rules
  read [--all] [--last N] [--id N] [--json]
                               Read new messages (tagged only by default; --all
                               for all), the newest N (marks older unread
                               as read), or a specific message by ID; --json
                               prints each message as one JSON object per line
  check [--quiet]              Check unread count
  projects                     List all boards
  subscribers                  List board subscribers
  status [--board NAME] [--json]  JSON snapshot of agent availability and open work
                               (always JSON; --json is accepted)
  working-mode [--board NAME] [--mode ID] [--custom-instructions TEXT]
  working-mode --presets | --create ID | --edit ID | --reset ID
                               Use --name NAME --instructions TEXT when creating/editing
                               Read or update custom team rules (mode unchanged)
                               (changing them is Operator only; reading works)
  queue [--json]               The merge queue: approved tasks whose patches have not landed
  health ack <id>              Mark a health-check item handled: the item that ends
                               with [ack <id>] (orchestrator or Operator)
  search "<text>" [--from NAME] [--mentions NAME] [--since T] [--until T] [--sort newest|oldest] [--limit N] [--cursor C] [--json]
                               Search the messages of your own board (the one you were launched on), oldest posts
                               included; a hit's context is: read --id <id>. --team, --all and --operator-history
                               ask for a wider reach and are refused unless the Operator raised your search access
  peek "<agent>" [--lines N]   Peek at agent's terminal (orchestrator only)
  waiting "<agent>"            List what waits for an agent: its unread board messages and the last send not typed
                               (the Operator, or an Orchestrator for the agents of its own team)
  waiting send "<agent>"       Type the board nudge into the agent now (the Operator, or an Orchestrator for its own
                               team's agents; it may be mid-turn, never into an open prompt or over a draft)
  send --board <target> [--to <orchestrator>] [--reply-to <id>] [--attach coral://artifacts/<id> ...] "<message>"
       (or --file <path> instead of the message: a UTF-8 file, as for post)
                               Message another team's Orchestrator on this Coral
                               (Orchestrators and the Operator only; both boards
                               must allow it); "-" as the message reads it from stdin
  send --address <server>/<team> [--reply-to <id>] [--message-id <id>]
       [--attach coral://artifacts/<id> ...] "<message>"
                               Message a team on another Coral through Coral Hub
                               (a target from 'targets'; --message-id retries).
                               'coral-board help send' has what --attach sends
  targets                      The teams on other Corals this board may message
                               (Orchestrators and the Operator only)
  link <team> <other> [--one-way] [--no-files]
                               The Operator only: let two teams of this computer
                               message each other (both ways and files on unless
                               you say otherwise; --one-way: <team> may message
                               <other> only). Not for an agent's terminal
  unlink <team> <other> [--one-way]
                               The Operator only: remove the link (--one-way:
                               only <team> messaging <other>)
  links [<team>]               The Operator only: who a team's links allow
  wait [--from <agent>] [--task <id>] [--commit <hash>] [--operator <question>]
       [--reason <text>]
       [--timeout <dur>] [--status] [--cancel] [--block]
                               Park work and wait for an event. Coral will wake
                               you up via terminal notification. STOP after wait.
                               'coral-board help wait' has the options
  leave                        Unsubscribe from board
  leave --board <board> --as <name>
                               The Operator only: remove the seat <name> from <board>
                               (not for an agent's terminal)
  seats --foreign [--json]     The Operator only: the seats of agents launched on
                               another board than the one they sit on, with the
                               command that removes each (not for an agent's terminal)
  delete                       Delete board and messages (Operator only)
  export [--output FILE] [--format json|markdown|html] [--merge FILE]
                               Export chat (auto-detects format from extension)
  task add "title" [--body "details"] [--priority P]  Create a task
  task list [--goal ID]          List this board's tasks, or one goal's
  task goal <task> <goal|none>   Put a task on a goal of this board, or take it off
  goal add/list/show/update/close  The goals of this board (coral-board goal --help): what the team works toward, with how its tasks stand
  task detail <id>               Read requirements, dependencies and results
  task show <id> [--json]        A task's status, result message and artifact links
  task claim [id]                Claim a named ready task or next ready work (a Reviews only agent: the oldest review in the pool that matches its areas)
  task reassign/cancel/amend     Change ownership, stop work, or revise text
  task submit-review/release-review  Record a candidate (--areas, --reviewers: who may review it) or release capacity
  reviewer set <name> [--reviews-only|--no-reviews-only] [--areas ui,go]  An agent's Reviews only setting and review areas (Operator only)
  task complete <id> [--message "note"]  Complete with outcome/evidence
  workflow create --file <path>  Create a workflow from JSON file (Operator only)
  workflow list                  List all workflows (Operator only)
  workflow trigger <name> [--context '{"key":"val"}']  Trigger a workflow (Operator only)
  workflow status <run-id>       Check run status (Operator only)
  workflow runs [--workflow <name>] [--status <s>]  List recent runs (Operator only)
  workflow kill <run-id>         Kill a running workflow (Operator only)

Output:
  --raw       Print what the server sent byte for byte. Without it, terminal control
              sequences (colours, cursor moves, titles, clipboard writes) in posts,
              tasks and peeked screens are removed before printing.

Environment:
  CORAL_URL   Coral's address (default: the one the running Coral recorded,
              else http://localhost:{{PORT}}, this platform's port)
  CORAL_PORT  Server port (overrides CORAL_URL)

Windows:
  Windows PowerShell 5.1 drops the double quotes inside a native program's argument.
  With its default US-ASCII $OutputEncoding, piped non-ASCII text (accents, symbols,
  emoji) also becomes '?'. Use  post --file <path>  with a UTF-8 file, or set
  $OutputEncoding = [Text.UTF8Encoding]::new()  before piping to  post -
  (PowerShell 7 and cmd.exe do not need it). See: coral-board help windows.
  Options coral-board does not know are refused (exit 2).` + "\n\n" + clierr.Table

// exitFn is os.Exit, replaced in tests that check a refused command.
// exitFn ends the program with code; a failure (1) takes the code of the request that failed (clierr.Exit1). Tests replace it.
var exitFn = func(code int) {
	if code == 1 {
		clierr.Exit1()
	}
	os.Exit(code)
}
