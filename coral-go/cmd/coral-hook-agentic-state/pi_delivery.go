package main

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/subgentic/coral/internal/hooks"
)

// Board message delivery to a Pi agent (#11107 slice 2). When a Pi agent's turn settles, the same program that posted its Stop asks Coral's turn-end route, the one a Claude agent's Stop hook asks: the route
// holds every rule (the agent's own token, the board, the setting, a person's send in flight, unread messages, one hand-off per window) and COMPOSES the text. This program passes that text on to the Pi extension
// as ONE line of JSON on standard output, {"deliver":"<text>"}, after checking it once more; it writes nothing else to standard output, ever, and nothing at all when there is nothing to deliver. It composes no text.

// piNoticeOpener is the fixed start of the text (board.PiNoticeOpener: a test pins the two together; this program does not link the board package).
const piNoticeOpener = "[Coral board] "

// piNoticeMax is the longest text it passes on, in bytes (board's own bound is the same).
const piNoticeMax = 300

// piDeliverable is the text when it is fit to be handed to the extension, else "": the opener first, printable ASCII only, one line, at most piNoticeMax bytes.
func piDeliverable(s string) string {
	if len(s) == 0 || len(s) > piNoticeMax || !strings.HasPrefix(s, piNoticeOpener) {
		return ""
	}
	for i := 0; i < len(s); i++ {
		if s[i] < 0x20 || s[i] > 0x7e {
			return ""
		}
	}
	return s
}

// piHandoff asks the route and, when it hands over, writes the one JSON line to out. Any failure, refusal or odd answer writes nothing.
func piHandoff(base, agentName string, out io.Writer) {
	raw, err := hooks.CoralAPI(base, "POST", hooks.LivePath(agentName, "/turn-end"), map[string]any{"stop_hook_active": false})
	if err != nil {
		hooks.DebugLog(fmt.Sprintf("PI_HANDOFF_FAILED: %v", err))
		return
	}
	var r struct {
		Handoff bool   `json:"handoff"`
		Context string `json:"context"`
	}
	if json.Unmarshal(raw, &r) != nil || !r.Handoff {
		return
	}
	text := piDeliverable(r.Context)
	if text == "" {
		hooks.DebugLog("PI_HANDOFF_DROPPED: the text is not a Coral board notice")
		return
	}
	line, err := json.Marshal(map[string]string{"deliver": text})
	if err != nil {
		return
	}
	_, _ = out.Write(append(line, '\n'))
}
