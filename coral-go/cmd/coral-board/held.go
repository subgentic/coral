package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/clierr"
)

// cmdHeld lists the messages Coral holds for an agent, or sends them now (#7554). It is the Operator's: an agent's token is refused by the server.
//
//	coral-board held "<agent>"                     list what is held
//	coral-board held send "<agent>" [--id ID]      type it now (all of it without --id)
func cmdHeld() {
	args := os.Args[2:]
	send := len(args) > 0 && args[0] == "send"
	if send {
		args = args[1:]
	}
	id, rest := "", []string{}
	for i := 0; i < len(args); i++ {
		if args[i] == "--id" && i+1 < len(args) {
			id = args[i+1]
			i++
			continue
		}
		rest = append(rest, args[i])
	}
	if len(rest) != 1 || (id != "" && !send) {
		fmt.Fprintln(os.Stderr, "Usage: coral-board held \"<agent>\"   or   coral-board held send \"<agent>\" [--id ID]")
		clierr.Exit1()
	}
	st := loadState()
	if st == nil {
		fmt.Fprintln(os.Stderr, "Not subscribed to any board.")
		clierr.Exit1()
	}
	sessionName, agentType, sessionID := heldTarget(st.Project, rest[0])
	base := serverURL + "/api/sessions/live/" + url.PathEscape(sessionName) + "/held"
	if !send {
		var out struct {
			Held []struct{ ID, What, Since, Reason string } `json:"held"`
		}
		heldCall(http.MethodGet, base+"?agent_type="+url.QueryEscape(agentType)+"&session_id="+url.QueryEscape(sessionID), nil, &out)
		if len(out.Held) == 0 {
			fmt.Println("Nothing is held for", rest[0])
			return
		}
		for _, h := range out.Held {
			fmt.Printf("%s  %s  since %s  (%s)\n", h.ID, h.What, h.Since, h.Reason)
		}
		fmt.Printf("\nSend one now: coral-board held send %q --id <id>   (all: leave out --id)\nThe agent may be in the middle of a turn: the text goes into its input box.\n", rest[0])
		return
	}
	var out struct {
		Sent       int  `json:"sent"`
		HeldAgain  int  `json:"held_again"`
		Dropped    int  `json:"dropped"`
		Left       int  `json:"left"`
		PromptOpen bool `json:"prompt_open"`
		DraftInBox bool `json:"draft_in_box"`
	}
	heldCall(http.MethodPost, base+"/send", map[string]string{"agent_type": agentType, "session_id": sessionID, "id": id}, &out)
	fmt.Printf("Sent %d now (the agent may have been in the middle of a turn). Still held: %d.\n", out.Sent, out.Left)
	if out.PromptOpen {
		fmt.Println("A prompt or menu is open on the agent's terminal: nothing was typed into it. Answer it first.")
	}
	if out.DraftInBox {
		fmt.Println("There is a draft in the agent's input box: nothing was sent. Send or clear it first.")
	}
	if out.HeldAgain > 0 {
		fmt.Println("A prompt opened before the Enter of one: it stays held.")
	}
}

// heldTarget finds the live session of the agent on the board: its name, agent type and session id (a session name is "<agent type>-<session id>").
func heldTarget(project, target string) (name, agentType, sessionID string) {
	data, status, err := apiCallRaw("GET", "/"+url.PathEscape(project)+"/subscribers", nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}
	if status != http.StatusOK {
		fmt.Fprintf(os.Stderr, "Error: could not list the board's agents (HTTP %d)\n", status)
		clierr.Exit1()
	}
	var subs []struct {
		SubscriberID string `json:"subscriber_id"`
		SessionName  string `json:"session_name"`
		JobTitle     string `json:"job_title"`
	}
	_ = json.Unmarshal(data, &subs)
	for _, s := range subs {
		if s.SubscriberID != target && s.JobTitle != target {
			continue
		}
		if len(s.SessionName) > 37 && s.SessionName[len(s.SessionName)-37] == '-' {
			cut := len(s.SessionName) - 37
			return s.SessionName, s.SessionName[:cut], s.SessionName[cut+1:]
		}
		break
	}
	fmt.Fprintf(os.Stderr, "Error: no live agent %q on this board\n", target)
	clierr.Exit1()
	return
}

func heldCall(method, u string, body any, into any) {
	var r *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	} else {
		r = bytes.NewReader(nil)
	}
	req, err := http.NewRequest(method, u, r)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	wait := clierr.Timeout(40 * time.Second) // a send waits for the agent's own sends to finish
	resp, err := (&http.Client{Timeout: wait}).Do(req)
	if err != nil {
		fmt.Fprintln(os.Stderr, clierr.CannotReach(redactedServerURL(), err, wait))
		clierr.Exit1()
	}
	defer resp.Body.Close()
	clierr.NoteStatus(resp.StatusCode)
	data, _ := readServer(resp.Body)
	if resp.StatusCode != http.StatusOK {
		var e map[string]any
		_ = json.Unmarshal(data, &e)
		msg, _ := e["message"].(string)
		if msg == "" {
			msg, _ = e["error"].(string)
		}
		fmt.Fprintf(os.Stderr, "Error: %s\n", strings.TrimSpace(msg+" (HTTP "+fmt.Sprint(resp.StatusCode)+")"))
		clierr.Exit1()
	}
	_ = json.Unmarshal(data, into)
}
