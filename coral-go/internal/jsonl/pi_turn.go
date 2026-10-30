package jsonl

import (
	"bytes"
	"encoding/json"
	"regexp"
	"time"
)

// Pi's working or idle state and its model and thinking level, read from its session file (#11091). Pi writes an entry per message when the message is complete: a user message begins a turn;
// an assistant message ends it when its stopReason is stop, length, aborted or error, and carries on with it when it is toolUse (its tools run, a toolResult follows, then another assistant
// message). A turn in the middle of a model call has only the user entry, which is a turn going on.

var (
	piUserRole      = []byte(`"user"`)
	piAssistantRole = []byte(`"assistant"`)
	piToolCallType  = []byte(`"toolCall"`)
)

// piToolNameOK is what a tool name looks like; anything else is not counted by name (and the names kept are bounded).
var piToolNameOK = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.*+-]{0,63}$`)

const (
	piMaxToolNames = 128
	piMaxToolHours = 24 * 62 // about two months of hours
)

// countPiToolCalls counts the toolCall blocks of an assistant message's content, by tool and by the hour of the entry's timestamp.
func countPiToolCalls(state *piTurnCache, timestamp string, content json.RawMessage) {
	var blocks []struct {
		Type string `json:"type"`
		Name string `json:"name"`
	}
	if json.Unmarshal(content, &blocks) != nil {
		return
	}
	hour := ""
	if len(timestamp) >= 13 && piHourR.MatchString(timestamp[:13]) {
		hour = timestamp[:13]
	}
	for _, b := range blocks {
		if b.Type != "toolCall" {
			continue
		}
		if state.toolByTool == nil {
			state.toolByTool, state.toolByHour = map[string]int{}, map[string]int{}
		}
		if _, known := state.toolByTool[b.Name]; piToolNameOK.MatchString(b.Name) && (known || len(state.toolByTool) < piMaxToolNames) {
			state.toolByTool[b.Name]++
		}
		if _, known := state.toolByHour[hour]; hour != "" && (known || len(state.toolByHour) < piMaxToolHours) {
			state.toolByHour[hour]++
		}
	}
}

var piHourR = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}$`)

// ReadPiTurn is the newest turn event of a Pi session: "prompt_submit" while a turn is going on, "stop" once it ended, "" when the file has none. activity says the event is a record of the turn
// going on (a tool result, an assistant message that ended in a tool call) rather than a turn's start, so it never answers an open request. It reads only what the file gained since the last call.
func (r *SessionReader) ReadPiTurn(sessionID, workingDir string) (kind string, at time.Time, activity bool) {
	c := r.getOrCreateSessionCache(sessionID)
	c.mu.Lock()
	defer c.mu.Unlock()
	scanPi(c, sessionID, workingDir)
	return c.piState.event, c.piState.at, c.piState.activity
}

// PiToolStats is how many tool calls a Pi session made, by tool and by hour of the assistant message that made them (#11105), counted from the toolCall blocks of its session file as it is read (with the
// turn state: only what the file gained is read). The maps are copies; empty when the session has no file or no calls.
func (r *SessionReader) PiToolStats(sessionID, workingDir string) (byTool, byHour map[string]int) {
	c := r.getOrCreateSessionCache(sessionID)
	c.mu.Lock()
	defer c.mu.Unlock()
	scanPi(c, sessionID, workingDir)
	byTool, byHour = make(map[string]int, len(c.piState.toolByTool)), make(map[string]int, len(c.piState.toolByHour))
	for k, v := range c.piState.toolByTool {
		byTool[k] = v
	}
	for k, v := range c.piState.toolByHour {
		byHour[k] = v
	}
	return byTool, byHour
}

// scanPi reads what a Pi session's file gained into the cache's Pi state (the caller holds c.mu).
func scanPi(c *sessionCache, sessionID, workingDir string) {
	if c.path == "" {
		if c.lastResolved.IsZero() || time.Since(c.lastResolved) >= 2*time.Second {
			c.lastResolved = time.Now()
			c.path = resolveTranscriptPath(sessionID, workingDir, "pi")
		}
	}
	scanTranscriptAppend(c.path, &c.piState.transcriptReadState, func() {
		c.piState.event, c.piState.at, c.piState.active, c.piState.activity = "", time.Time{}, false, false
		c.piState.model, c.piState.effort, c.piState.turnAt = "", "", time.Time{}
		c.piState.toolByTool, c.piState.toolByHour = nil, nil
	}, func(line []byte) { updatePiTurnState(&c.piState, line) })
}

// updatePiTurnState applies one session-file line to the cache.
func updatePiTurnState(state *piTurnCache, line []byte) {
	if !bytes.Contains(line, []byte(`"type"`)) {
		return
	}
	var entry struct {
		Type          string `json:"type"`
		Timestamp     string `json:"timestamp"`
		ModelID       string `json:"modelId"`
		ThinkingLevel string `json:"thinkingLevel"`
		Message       struct {
			Role          string          `json:"role"`
			Model         string          `json:"model"`
			ThinkingLevel string          `json:"thinkingLevel"`
			StopReason    string          `json:"stopReason"`
			Content       json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal(line, &entry) != nil {
		return
	}
	at, _ := time.Parse(time.RFC3339Nano, entry.Timestamp)
	switch entry.Type {
	case "model_change":
		if m := cleanModelID(entry.ModelID); m != "" {
			state.model = m
		}
	case "thinking_level_change":
		if e := cleanEffort(entry.ThinkingLevel); e != "" {
			state.effort = e
		}
	case "message":
		switch entry.Message.Role {
		case "user":
			setPiTurn(state, "prompt_submit", at, true, false)
		case "toolResult":
			setPiTurn(state, "prompt_submit", at, true, true)
		case "assistant":
			if m := cleanModelID(entry.Message.Model); m != "" {
				state.model = m
			}
			if e := cleanEffort(entry.Message.ThinkingLevel); e != "" {
				state.effort = e
			}
			if !at.IsZero() {
				state.turnAt = at
			}
			if bytes.Contains(line, piToolCallType) {
				countPiToolCalls(state, entry.Timestamp, entry.Message.Content)
			}
			switch entry.Message.StopReason {
			case "toolUse", "pending", "deferred":
				setPiTurn(state, "prompt_submit", at, true, true)
			case "stop", "length", "aborted", "error":
				setPiTurn(state, "stop", at, false, false)
			}
		}
	}
}

func setPiTurn(state *piTurnCache, kind string, at time.Time, active, activity bool) {
	if at.IsZero() {
		return
	}
	state.event, state.at, state.active, state.activity = kind, at, active, activity
}
