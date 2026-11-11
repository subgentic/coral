package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/subgentic/coral/internal/cliauth"
	"github.com/subgentic/coral/internal/config"
)

// relaunch is the remote half of `coral-update push` (#15379): it asks THIS computer's running Coral to relaunch into the update that was staged, exactly as the
// dashboard's own button does, by the existing POST /api/system/update/relaunch-local. It adds no route, no way around the acknowledgement token, the local-caller
// check or the audit row. It reads the status first and sends nothing unless the status offers a token; it prints only fixed words and a count.
//
//	coral-update relaunch [--port N] --check    what would happen: {"result":"ready"|"not_ready","reason":word,"agents":N}
//	coral-update relaunch            do it:             {"result":"relaunched"|"not_ready"|"refused"|"failed", "reason":word}
//
// A process inside a Coral agent session is refused before anything is read: the command is for the person at this computer (their own login on it), and the
// server refuses an agent's session token a second time (humanInputCaller).
type relaunchOut struct {
	Result string `json:"result"`
	Reason string `json:"reason,omitempty"`
	Agents int    `json:"agents,omitempty"`
}

var relaunchWord = regexp.MustCompile(`^[a-z][a-z_]{0,39}$`)

// relaunchEnv is what the command needs from outside: whether it is inside an agent session, the transport that signs as the person, and the server's address.
type relaunchEnv struct {
	insideAgent func() bool
	transport   func() http.RoundTripper
	base        string
}

func defaultRelaunchEnv(port int) relaunchEnv {
	if port == 0 {
		port = config.DefaultPort
	}
	return relaunchEnv{
		insideAgent: cliauth.InsideAgentSession,
		transport:   func() http.RoundTripper { return cliauth.OperatorRoundTripper(http.DefaultTransport, io.Discard) },
		base:        "http://127.0.0.1:" + strconv.Itoa(port),
	}
}

// relaunchArgs reads [--check] [--port N]: nothing else. The port is the one this computer's Coral listens on when it is not the default (the update's own environment is never read: guard_test).
func relaunchArgs(args []string) (check bool, port int, ok bool) {
	for i := 0; i < len(args); i++ {
		switch {
		case args[i] == "--check" && !check:
			check = true
		case args[i] == "--port" && port == 0 && i+1 < len(args):
			i++
			n, err := strconv.Atoi(args[i])
			if err != nil || n < 1 || n > 65535 || strconv.Itoa(n) != args[i] {
				return false, 0, false
			}
			port = n
		default:
			return false, 0, false
		}
	}
	return check, port, true
}

func fixedWord(s string) string {
	if relaunchWord.MatchString(s) {
		return s
	}
	return "other"
}

func runRelaunch(args []string, env relaunchEnv, stdout io.Writer) int {
	emit := func(o relaunchOut, code int) int {
		_ = json.NewEncoder(stdout).Encode(o)
		return code
	}
	check, _, ok := relaunchArgs(args)
	if !ok {
		return emit(relaunchOut{Result: "failed", Reason: "usage"}, 2)
	}
	if env.insideAgent() {
		return emit(relaunchOut{Result: "refused", Reason: "agent_session"}, 1)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	client := &http.Client{Transport: env.transport(), Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, env.base+"/api/system/update", nil)
	resp, err := client.Do(req)
	if err != nil {
		return emit(relaunchOut{Result: "failed", Reason: "no_coral"}, 1)
	}
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	resp.Body.Close()
	var st struct {
		Relaunch struct {
			Available bool              `json:"available"`
			Reason    string            `json:"reason"`
			Ack       string            `json:"ack"`
			Restarts  []json.RawMessage `json:"restarts"`
		} `json:"relaunch"`
	}
	if resp.StatusCode != http.StatusOK || json.Unmarshal(raw, &st) != nil {
		return emit(relaunchOut{Result: "failed", Reason: "status_unavailable"}, 1)
	}
	r := st.Relaunch
	if !r.Available || r.Ack == "" {
		reason := fixedWord(r.Reason)
		if r.Reason == "" {
			reason = "not_ready"
		}
		return emit(relaunchOut{Result: "not_ready", Reason: reason}, 1)
	}
	if check {
		return emit(relaunchOut{Result: "ready", Agents: len(r.Restarts)}, 0)
	}
	body, _ := json.Marshal(map[string]string{"ack": r.Ack})
	req, _ = http.NewRequestWithContext(ctx, http.MethodPost, env.base+"/api/system/update/relaunch-local", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err = client.Do(req)
	if err != nil {
		// A server that quit to be replaced may drop the connection before it answers: the sender reads the version afterwards.
		return emit(relaunchOut{Result: "relaunched"}, 0)
	}
	io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusAccepted, http.StatusOK:
		return emit(relaunchOut{Result: "relaunched"}, 0)
	case http.StatusForbidden, http.StatusConflict, http.StatusNotFound:
		return emit(relaunchOut{Result: "refused", Reason: "server_refused"}, 1)
	}
	return emit(relaunchOut{Result: "failed", Reason: "server_error"}, 1)
}
