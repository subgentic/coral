package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/clierr"
	"github.com/subgentic/coral/internal/clitext"
	"github.com/subgentic/coral/internal/hooks"
	"github.com/subgentic/coral/internal/mediatype"
)

// The result of a goal (#21811, the Operator): closing a goal sends its finished result to the Operator's Needs you, or says why there is none. `goal close` takes --result <file or coral://artifacts link> or
// --no-result "why", and refuses to close with neither: a result posted as plain text never reached Needs you, and the one agent that knew what was finished had to remember a three-step upload.

const goalResultWords = `goal close needs --result <file or coral://artifacts/<digest> link> (the finished result, sent to the Operator's Needs you) or --no-result "why there is none"`

var resultLinkRe = regexp.MustCompile(`^(?:coral://artifacts/)?([0-9a-f]{64})$`)

// sendGoalResult puts the goal's result in the Operator's Needs you as a finished result (kind done) and returns its digest. A file is uploaded as a file for the goal; a link is the newest version of a file the
// team already has (or was sent), sent for review. The question is one line.
func sendGoalResult(goal int64, result string) (digest string, err error) {
	question := fmt.Sprintf("Goal #%d is closed: is its result right?", goal)
	sid := hooks.ResolveSessionID("")
	if sid == "" {
		return "", fmt.Errorf("the result goes to the Operator's Needs you from an agent session: no Coral agent session here (no tmux session name or CORAL_SESSION_NAME)")
	}
	if m := resultLinkRe.FindStringSubmatch(strings.TrimSpace(result)); m != nil {
		payload, _ := json.Marshal(map[string]string{"question": question})
		data, status, cerr := apiCallRawAt("/api/agent", "POST", "/artifacts/"+m[1]+"/review?session_id="+url.QueryEscape(sid), json.RawMessage(payload), time.Minute)
		if cerr != nil {
			return "", cerr
		}
		if status < 200 || status >= 300 {
			return "", fmt.Errorf("could not send the result for review: %s", clierr.Describe(nil, status, data))
		}
		var reply struct {
			Digest string `json:"digest"`
		}
		_ = json.Unmarshal(data, &reply)
		if !resultLinkRe.MatchString(reply.Digest) {
			reply.Digest = m[1]
		}
		return reply.Digest, nil
	}
	info, serr := os.Stat(result)
	if serr != nil || !info.Mode().IsRegular() {
		return "", fmt.Errorf("--result %q is neither a file nor a coral://artifacts/<digest> link", clitext.Clean(result))
	}
	f, oerr := os.Open(result)
	if oerr != nil {
		return "", oerr
	}
	defer f.Close()
	name := mediatype.EnsureExtension(filepath.Base(result), result)
	q := "?session_id=" + url.QueryEscape(sid) + "&tag=" + url.QueryEscape("for review") + "&question=" + url.QueryEscape(question) + "&kind=done&goal=" + fmt.Sprint(goal)
	req, rerr := http.NewRequest(http.MethodPost, serverURL+"/api/agent/artifacts"+q, f)
	if rerr != nil {
		return "", rerr
	}
	req.Header.Set("X-Artifact-Name", name)
	req.Header.Set("X-Artifact-Task", "none") // the result belongs to the goal, not to whatever task this agent has open
	if mt := mediatype.Resolve("", result, name); mt != "" {
		req.Header.Set("X-Artifact-Media-Type", mt)
	}
	wait := clierr.Timeout(5 * time.Minute)
	resp, derr := (&http.Client{Timeout: wait}).Do(req)
	if derr != nil {
		return "", clierr.CannotReach(redactedServerURL(), derr, wait)
	}
	defer resp.Body.Close()
	clierr.NoteStatus(resp.StatusCode)
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var reply struct {
		URI string `json:"uri"`
	}
	_ = json.Unmarshal(bytes.TrimSpace(body), &reply)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || !strings.HasPrefix(reply.URI, "coral://artifacts/") {
		return "", fmt.Errorf("could not upload the result: %s", clierr.Describe(nil, resp.StatusCode, body))
	}
	return strings.TrimPrefix(reply.URI, "coral://artifacts/"), nil
}
