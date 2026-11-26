package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/clierr"
)

// Inside a workflow step of an automation (a workflow whose board is set, #21502) coral-board has one command: post. The step's environment carries the run's token and the team; the post goes to the
// automation route, which the server answers as "Automation: NAME" (the sender and the mark are the server's, from the token). This mode never signs as the Operator and never sends the token anywhere
// but the route it is for.
const (
	automationTokenEnv    = "CORAL_AUTOMATION_TOKEN"
	automationBoardEnv    = "CORAL_AUTOMATION_BOARD"
	automationTokenHeader = "X-Coral-Automation-Token"
	maxAutomationStdin    = 64 << 10
)

// inAutomationStep reports whether this command runs in a step that has an automation token.
func inAutomationStep() bool { return strings.TrimSpace(os.Getenv(automationTokenEnv)) != "" }

// runAutomationCommand is the whole of coral-board in an automation step: "post TEXT" or "post -" (the text on stdin). Everything else is refused before anything is sent.
func runAutomationCommand(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	text, err := automationPostText(args, stdin)
	if err != nil {
		fmt.Fprintf(stderr, "Error: %v\n", err)
		return 2
	}
	token, board := strings.TrimSpace(os.Getenv(automationTokenEnv)), strings.TrimSpace(os.Getenv(automationBoardEnv))
	if board == "" {
		fmt.Fprintln(stderr, "Error: this step has no team to post to (CORAL_AUTOMATION_BOARD is empty)")
		return 2
	}
	base := endpointFromEnv(os.Getenv("CORAL_URL"), os.Getenv("CORAL_HOST"), os.Getenv("CORAL_PORT"))
	data, _ := json.Marshal(map[string]string{"content": text})
	req, err := http.NewRequest(http.MethodPost, base+"/api/board/"+url.PathEscape(board)+"/automation/post", bytes.NewReader(data))
	if err != nil {
		fmt.Fprintf(stderr, "Error: %v\n", err)
		return 1
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(automationTokenHeader, token)
	client := &http.Client{Timeout: clierr.Timeout(15 * time.Second), CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }} // the token follows no redirect
	resp, err := client.Do(req)
	if err != nil {
		fmt.Fprintf(stderr, "Error: could not reach Coral: %v\n", err)
		return 1
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var out map[string]any
	_ = json.Unmarshal(body, &out)
	if resp.StatusCode != http.StatusOK {
		msg, _ := out["message"].(string)
		if msg == "" {
			msg, _ = out["error"].(string)
		}
		if msg == "" {
			msg = http.StatusText(resp.StatusCode)
		}
		fmt.Fprintf(stderr, "Error: %s (HTTP %d)\n", msg, resp.StatusCode)
		return 1
	}
	fmt.Fprintf(stdout, "Posted as %v (message %v)\n", out["sender"], out["id"])
	return 0
}

// automationPostText is the text of "post TEXT" or "post -", and an error for anything else.
func automationPostText(args []string, stdin io.Reader) (string, error) {
	if len(args) == 0 || args[0] != "post" {
		return "", fmt.Errorf(`inside an automation step coral-board can only post: coral-board post "text" (or "post -" with the text on standard input)`)
	}
	rest := args[1:]
	if len(rest) != 1 {
		return "", fmt.Errorf(`inside an automation step "post" takes one argument, the text (or "-"): no flags, no team, no sender`)
	}
	if rest[0] != "-" {
		return rest[0], nil
	}
	raw, err := io.ReadAll(io.LimitReader(stdin, maxAutomationStdin+1))
	if err != nil {
		return "", err
	}
	if len(raw) > maxAutomationStdin {
		return "", fmt.Errorf("the text is over %d KiB: put the long text in an artifact", maxAutomationStdin>>10)
	}
	return string(raw), nil
}
