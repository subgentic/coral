package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/clierr"
)

// The Operator's clean-up of leftover board seats (#11112). Before #11013 an agent could seat itself, or an agent it started, on another team's board; Coral does not remove those seats itself. These two commands
// are the Operator's: they are refused in an agent's own shell (its session token is in the environment) before anything is sent, and the server refuses an agent's token for the routes they call.

const seatsUsage = "usage: coral-board seats --foreign [--json]"

// insideAnAgent reports whether this shell is an agent's own (Coral gives every agent its session token in the environment).
func insideAnAgent() bool { return os.Getenv("CORAL_SESSION_TOKEN") != "" }

var errOperatorOnly = fmt.Errorf("this is the Operator's command: run it in your own terminal, outside an agent")

// runSeats is `coral-board seats --foreign [--json]`: the seats of agents that were launched on another board than the one they sit on, with the command that removes each.
func runSeats(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("seats", flag.ContinueOnError)
	foreign := fs.Bool("foreign", false, "")
	asJSON := fs.Bool("json", false, "")
	fs.SetOutput(io.Discard)
	if err := fs.Parse(args); err != nil {
		return fmt.Errorf("%v\n%s", err, seatsUsage)
	}
	if !*foreign || fs.NArg() != 0 {
		return fmt.Errorf("seats needs --foreign (the seats of agents launched on another board)\n%s", seatsUsage)
	}
	if insideAnAgent() {
		return errOperatorOnly
	}
	data, status, err := apiCallRawAt("/api", "GET", "/board-seats/foreign", nil, 10*time.Second)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return seatsServerError(data, status)
	}
	if *asJSON {
		_, err := fmt.Fprintln(out, strings.TrimSpace(string(data)))
		return err
	}
	var reply struct {
		Seats []struct {
			BoardID          string `json:"board_id"`
			BoardLabel       string `json:"board_label"`
			SubscriberID     string `json:"subscriber_id"`
			AgentName        string `json:"agent_name"`
			LaunchBoard      string `json:"launch_board"`
			LaunchBoardLabel string `json:"launch_board_label"`
		} `json:"seats"`
	}
	if err := json.Unmarshal(data, &reply); err != nil {
		return fmt.Errorf("the server's answer was not understood")
	}
	if len(reply.Seats) == 0 {
		_, err := fmt.Fprintln(out, "No foreign seats: every agent's seats are on the board it was launched on.")
		return err
	}
	fmt.Fprintf(out, "%d seat(s) of agents launched on another board:\n", len(reply.Seats))
	for _, s := range reply.Seats {
		fmt.Fprintf(out, "  %s (%s): %s, launched on %s (%s)\n    remove: coral-board leave --board %s --as %q\n", s.BoardLabel, s.BoardID, s.SubscriberID, s.LaunchBoardLabel, s.LaunchBoard, s.BoardID, s.SubscriberID)
	}
	return nil
}

// runLeaveAs is `coral-board leave --board <board> --as <name>`: the Operator removes one seat from a board.
func runLeaveAs(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("leave", flag.ContinueOnError)
	board := fs.String("board", "", "")
	as := fs.String("as", "", "")
	fs.SetOutput(io.Discard)
	if err := fs.Parse(args); err != nil {
		return fmt.Errorf("%v\nusage: coral-board leave --board <board> --as <name>", err)
	}
	if strings.TrimSpace(*board) == "" || strings.TrimSpace(*as) == "" || fs.NArg() != 0 {
		return fmt.Errorf("usage: coral-board leave --board <board> --as <name>  (the Operator removes the seat <name> from <board>)")
	}
	if insideAnAgent() {
		return errOperatorOnly
	}
	data, status, err := apiCallRawAt("/api/board", "DELETE", "/"+url.PathEscape(*board)+"/seats/"+url.PathEscape(*as), nil, 10*time.Second)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return seatsServerError(data, status)
	}
	_, err = fmt.Fprintf(out, "Removed the seat %q from %s\n", *as, *board)
	return err
}

// seatsServerError is the server's own words for a refusal, or its status.
func seatsServerError(data []byte, status int) error {
	var e map[string]any
	if json.Unmarshal(data, &e) == nil {
		for _, k := range []string{"message", "error"} {
			if s, _ := e[k].(string); s != "" {
				return fmt.Errorf("%s", s)
			}
		}
	}
	return fmt.Errorf("the server answered %d", status)
}

func cmdSeats() {
	if err := runSeats(os.Args[2:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}
}
