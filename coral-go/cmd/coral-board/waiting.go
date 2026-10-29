package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"github.com/subgentic/coral/internal/clitext"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/clierr"
)

// cmdWaiting lists what waits for an agent (its unread board messages, and the last automated send Coral did not type and why), or types the board nudge into it now (#7727).
// It is the Operator's: an agent's token is refused by the server.
//
//	coral-board waiting "<agent>"          list what waits
//	coral-board waiting send "<agent>"     type the nudge now (a person's own action; still never into an open prompt or over a draft)
func cmdWaiting() {
	args := os.Args[2:]
	send := len(args) > 0 && args[0] == "send"
	if send {
		args = args[1:]
	}
	if len(args) != 1 {
		fmt.Fprintln(os.Stderr, "Usage: coral-board waiting \"<agent>\"   or   coral-board waiting send \"<agent>\"")
		clierr.Exit1()
	}
	st := loadState()
	if st == nil {
		fmt.Fprintln(os.Stderr, "Not subscribed to any board.")
		clierr.Exit1()
	}
	sessionName, agentType, sessionID := waitingTarget(st.Project, args[0])
	base := serverURL + "/api/sessions/live/" + url.PathEscape(sessionName) + "/waiting"
	if !send {
		var out struct {
			Unread   int `json:"unread"`
			Messages []struct {
				ID     int64
				Sender string
				At     string
				Text   string
			} `json:"messages"`
			Skipped *struct{ Why, What, At, Since string } `json:"skipped"`
		}
		waitingCall(http.MethodGet, base+"?agent_type="+url.QueryEscape(agentType)+"&session_id="+url.QueryEscape(sessionID), nil, &out)
		if out.Unread == 0 && out.Skipped == nil {
			fmt.Println("Nothing waits for", args[0])
			return
		}
		fmt.Printf("%d unread board message(s) for %s\n", out.Unread, args[0])
		for _, m := range out.Messages {
			fmt.Printf("  #%d  %s  %s\n      %s\n", m.ID, plainText(m.Sender), m.At, plainText(oneLine(m.Text, 200)))
		}
		if out.Skipped != nil {
			fmt.Printf("\nThe last automated send (%s) was not typed since %s: %s\n", plainText(out.Skipped.What), out.Skipped.Since, plainText(out.Skipped.Why))
		}
		fmt.Printf("\nType the nudge now: coral-board waiting send %q\nThe agent may be in the middle of a turn: the text goes into its input box.\n", args[0])
		return
	}
	var out struct {
		Sent           bool   `json:"sent"`
		NothingWaiting bool   `json:"nothing_waiting"`
		Why            string `json:"why"`
		PromptOpen     bool   `json:"prompt_open"`
		DraftInBox     bool   `json:"draft_in_box"`
	}
	waitingCall(http.MethodPost, base+"/send", map[string]string{"agent_type": agentType, "session_id": sessionID}, &out)
	switch {
	case out.NothingWaiting:
		fmt.Println("No unread board messages wait for the agent: nothing was sent.")
	case out.Sent:
		fmt.Println("Sent now (the agent may have been in the middle of a turn).")
	case out.PromptOpen:
		fmt.Println("A prompt or menu is open on the agent's terminal: nothing was typed into it. Answer it first.")
	case out.DraftInBox:
		fmt.Println("There is a draft in the agent's input box: nothing was sent. Send or clear it first.")
	default:
		fmt.Println("Not sent:", plainText(out.Why))
	}
}

// oneLine is s on one line, cut to n characters.
func oneLine(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > n {
		return string(r[:n]) + "..."
	}
	return s
}

// waitingTarget finds the live session of the agent on the board: its name, agent type and session id (a session name is "<agent type>-<session id>").
func waitingTarget(project, target string) (name, agentType, sessionID string) {
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

func waitingCall(method, u string, body any, into any) {
	refuseSignInLinkInBody(body)
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
	data, _ := clitext.ReadReply(resp.Body, rawOutput)
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
