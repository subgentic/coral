package routes

import (
	"fmt"

	"github.com/subgentic/coral/internal/permreview"
)

// What auto-accept judges of a pending tool (#11399). The pending tool the chat shows is cut (a command at 4,000 bytes, a path at 1,000, a value over its limit dropped), but the risk rules must read the WHOLE
// command or path: a harmful part after the cut would never be seen, and the request would be allowed. So the whole text of each judged field is kept beside the shown one (never served), up to riskMaxBytes;
// anything that cannot be judged whole (longer than that, not text, or holding a character that hides what it does) is recorded as Unjudged, and auto-accept refuses it: it is left to the person.

// riskMaxBytes is the most of one field auto-accept will read. A longer command is not auto-accepted.
const riskMaxBytes = 64 << 10

// riskKeys are the tool input fields the risk rules read.
var riskKeys = []string{"command", "CommandLine", "file_path", "notebook_path", "path", "TargetFile", "AbsolutePath"}

// riskInputOf keeps the whole text of each judged field and says why the request cannot be judged ("" when it can).
func riskInputOf(in map[string]any) (whole map[string]string, unjudged string) {
	for _, k := range riskKeys {
		v, ok := in[k]
		if !ok || v == nil {
			continue
		}
		s, isText := v.(string)
		switch {
		case !isText:
			if unjudged == "" {
				unjudged = fmt.Sprintf("the tool's %s is not plain text, so it cannot be judged", k)
			}
		case len(s) > riskMaxBytes:
			if unjudged == "" {
				unjudged = fmt.Sprintf("the tool's %s is longer than %d bytes, so it cannot be judged", k, riskMaxBytes)
			}
		default:
			if whole == nil {
				whole = map[string]string{}
			}
			whole[k] = s
			if unjudged == "" && permreview.Of(s).Hidden {
				unjudged = fmt.Sprintf("the tool's %s holds a character that can hide what it does, so it cannot be judged", k)
			}
		}
	}
	return whole, unjudged
}
