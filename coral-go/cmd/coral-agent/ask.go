package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/askpage"
	"github.com/subgentic/coral/internal/clierr"
	"github.com/subgentic/coral/internal/clitext"
	"github.com/subgentic/coral/internal/hooks"
)

var askUsageText = `Usage: coral-agent ask "<question>" [--option LABEL]... (up to 3) [--open PAGE]

Asks the Operator a question from an agent that is not on a team. It appears in their
Needs you, and their answer is typed into this conversation. Ask one question at a time;
a new one replaces your older open one. On a team, use coral-board post --ask instead.

--open PAGE puts a button on the card that opens that page of Coral without answering
(Open Analytics, Open Settings). PAGE is one of: ` + askpage.Names() + `. Never a link.`

// cmdAsk files a question for the Operator (POST /api/agent-asks, #18106).
func cmdAsk(args []string, out io.Writer) error {
	o, err := splitOptions(args, []string{"option", "open"}, nil)
	if err != nil || len(o.Positional) != 1 || strings.TrimSpace(o.Positional[0]) == "" {
		return errors.New(askUsageText)
	}
	if len(o.All["option"]) > 3 {
		return errors.New("at most 3 --option\n" + askUsageText)
	}
	page := ""
	if p := o.All["open"]; len(p) > 1 {
		return errors.New("--open takes one page\n" + askUsageText)
	} else if len(p) == 1 {
		if page = strings.ToLower(strings.TrimSpace(p[0])); askpage.Label(page) == "" {
			return fmt.Errorf("--open %q is not a Coral page: use one of %s", p[0], askpage.Names())
		}
	}
	if err := refuseSignInLinkIn("a question", o.Positional[0]); err != nil {
		return err
	}
	data, _ := json.Marshal(map[string]any{"text": o.Positional[0], "options": o.All["option"], "open": page})
	req, err := http.NewRequest(http.MethodPost, serverURL+"/api/agent-asks", bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	wait := clierr.Timeout(10 * time.Second)
	resp, err := (&http.Client{Timeout: wait}).Do(req)
	if err != nil {
		return clierr.CannotReach(hooks.RedactedURL(serverURL), err, wait)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		b, _ := clitext.ReadReply(io.LimitReader(resp.Body, 4096), rawOutput)
		return fmt.Errorf("Coral answered %s: %s", resp.Status, strings.TrimSpace(string(b)))
	}
	fmt.Fprintln(out, "Asked: the Operator sees it in Needs you, and the answer arrives in this conversation. Stop and wait for it.")
	return nil
}
