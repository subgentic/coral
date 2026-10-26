package ptymanager

import "bytes"

// CodexCLIState reads the latest complete OSC 7501 state emitted by Codex's
// TUI. Unlike PermissionRequest, blocked is a person-facing wait, not automatic
// approval review (verified with Codex 0.163.0, #8471). Missing, truncated and
// foreign-app signals are unknown; never reuse an earlier blocked marker then.
func CodexCLIState(output []byte) string {
	const prefix = "\x1b]7501;"
	i := bytes.LastIndex(output, []byte(prefix))
	if i < 0 {
		return ""
	}
	tail := output[i+len(prefix):]
	end := -1
	for j, b := range tail {
		if b == 7 || (b == 27 && j+1 < len(tail) && tail[j+1] == '\\') {
			end = j
			break
		}
	}
	if end < 0 {
		return ""
	}
	switch string(tail[:end]) {
	case "state=blocked:app=codex":
		return "blocked"
	case "state=working:app=codex":
		return "working"
	case "state=idle:app=codex":
		return "idle"
	}
	return ""
}
