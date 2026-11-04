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
)

// coral-board wake <member> and coral-board sleep <member> (#13224): the board's Orchestrator wakes an agent that is asleep, or puts an awake one to sleep, with the Operator's grant (Team settings, the Orchestrator's
// switch; #11452's route POST /api/board/{project}/agents/{member}/wake|sleep). It had no command, so an Orchestrator called the route by hand. The server decides everything: an agent token, the grant being on, the seat,
// the hourly and live caps, a paused board, an agent that is archived or already in that state; its sentence is what is printed.

const wakeUsageText = `Usage: coral-board wake <member> [--board <project>]
       coral-board sleep <member> [--board <project>]

  wake    Wake an agent of this board that is asleep (it resumes its conversation and is told to read the board first).
  sleep   Put an awake agent of this board to sleep (it is woken again by wake, a task or a message for it that wakes it).

  Only the board's Orchestrator, and only while the Operator has switched on "the orchestrator may wake, sleep and start agents" for the board: any other caller, or the switch off, is refused with
  the server's reason. The grant's hourly and live-agent caps apply to wake; a refused wake says which cap.`

func cmdWakeSleep(sleep bool) {
	verb := "wake"
	if sleep {
		verb = "sleep"
	}
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, wakeUsageText)
		os.Exit(2)
	}
	member, args := os.Args[2], os.Args[3:]
	if strings.HasPrefix(member, "-") {
		// flags before the member: take the first plain word as the member
		for i, a := range os.Args[2:] {
			if !strings.HasPrefix(a, "-") && (i == 0 || os.Args[2+i-1] != "--board") {
				member, args = a, append(append([]string{}, os.Args[2:2+i]...), os.Args[3+i:]...)
				break
			}
		}
	}
	fs := flag.NewFlagSet(verb, flag.ContinueOnError)
	boardFlag := fs.String("board", "", "The board (default: the one you joined)")
	clihelp.ParseFlags(fs, args, func() string { return wakeUsageText })
	member = strings.TrimSpace(member)
	if member == "" || strings.HasPrefix(member, "-") {
		fmt.Fprintf(os.Stderr, "Error: name the agent to %s.\n%s\n", verb, wakeUsageText)
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
	path := fmt.Sprintf("/%s/agents/%s/%s", url.PathEscape(project), url.PathEscape(member), verb)
	data := goalCall("POST", path, nil, verb+"ing "+member, 200)
	var out struct {
		Woke  string `json:"woke"`
		Slept string `json:"slept"`
		Name  string `json:"name"`
	}
	_ = json.Unmarshal(data, &out)
	who := member
	for _, n := range []string{out.Woke, out.Slept, out.Name} {
		if n != "" {
			who = n
			break
		}
	}
	if sleep {
		fmt.Printf("Put %s to sleep.\n", who)
		return
	}
	fmt.Printf("Woke %s; it resumes where it left off and is told to read the board first.\n", who)
}
