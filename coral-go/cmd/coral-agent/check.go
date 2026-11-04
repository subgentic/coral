package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"github.com/subgentic/coral/internal/clierr"
	"github.com/subgentic/coral/internal/clitext"
	"net/http"
	"os"
	"strconv"
	"time"
)

const checkUsageText = `Usage: coral-agent check state <trigger-id> --state open|routed|waiting_on_operator|done [--summary TEXT] [--task N] [--ask N] [--brief N]

Reports only your own scheduled check's progress. Routed tasks must belong to the
check's board; waiting asks and brief messages must be from your own session.
A summary is your untrusted text kept on this computer; never include credentials.`

func cmdCheck(args []string) {
	if err := runCheck(args); err != nil {
		var ue usageError
		if errors.As(err, &ue) {
			failUsage(ue.msg, "check", args)
		}
		fmt.Fprintln(os.Stderr, clitext.Clean(err.Error()))
		clierr.Exit1()
	}
}
func runCheck(args []string) error {
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" {
		fmt.Println(checkUsageText)
		return nil
	}
	if len(args) < 2 || args[0] != "state" {
		return usageError{"check needs state and a trigger id"}
	}
	id, err := strconv.ParseInt(args[1], 10, 64)
	if err != nil || id < 1 {
		return usageError{"invalid trigger id"}
	}
	f := flag.NewFlagSet("check state", flag.ContinueOnError)
	state := f.String("state", "", "Trigger state")
	summary := f.String("summary", "", "Short result (no secrets)")
	task := f.Int64("task", 0, "Task on this board")
	ask := f.Int64("ask", 0, "Your own ask")
	brief := f.Int64("brief", 0, "Your own brief message")
	if err = f.Parse(args[2:]); err != nil {
		return usageError{err.Error()}
	}
	if f.NArg() != 0 {
		return usageError{"unexpected arguments"}
	}
	if *state != "open" && *state != "routed" && *state != "waiting_on_operator" && *state != "done" {
		return usageError{"invalid state"}
	}
	if len(*summary) > 2048 {
		return usageError{"summary is at most 2 KiB"}
	}
	body, _ := json.Marshal(map[string]any{"state": *state, "summary": *summary, "task_id": *task, "ask_id": *ask, "brief_id": *brief})
	req, err := http.NewRequest(http.MethodPost, serverURL+"/api/chief/triggers/"+strconv.FormatInt(id, 10)+"/state", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: clierr.Timeout(time.Minute)}).Do(req)
	if err != nil {
		return errors.New("could not reach Coral to update this trigger")
	}
	defer resp.Body.Close()
	clierr.NoteStatus(resp.StatusCode)
	data, err := clitext.ReadReply(resp.Body, rawOutput)
	if err != nil {
		return errors.New("could not read Coral's reply")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var out struct {
			Error string `json:"error"`
		}
		json.Unmarshal(data, &out)
		if out.Error == "" {
			out.Error = resp.Status
		}
		return errors.New(out.Error)
	}
	fmt.Printf("Trigger %d: %s\n", id, *state)
	return nil
}
