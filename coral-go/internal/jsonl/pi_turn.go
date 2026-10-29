package jsonl

import (
	"bytes"
	"encoding/json"
	"time"
)

// Pi's working or idle state and its model and thinking level, read from its session file (#11091). Pi writes an entry per message when the message is complete: a user message begins a turn;
// an assistant message ends it when its stopReason is stop, length, aborted or error, and carries on with it when it is toolUse (its tools run, a toolResult follows, then another assistant
// message). A turn in the middle of a model call has only the user entry, which is a turn going on.

var (
	piUserRole      = []byte(`"user"`)
	piAssistantRole = []byte(`"assistant"`)
)

// ReadPiTurn is the newest turn event of a Pi session: "prompt_submit" while a turn is going on, "stop" once it ended, "" when the file has none. activity says the event is a record of the turn
// going on (a tool result, an assistant message that ended in a tool call) rather than a turn's start, so it never answers an open request. It reads only what the file gained since the last call.
func (r *SessionReader) ReadPiTurn(sessionID, workingDir string) (kind string, at time.Time, activity bool) {
	c := r.getOrCreateSessionCache(sessionID)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.path == "" {
		if c.lastResolved.IsZero() || time.Since(c.lastResolved) >= 2*time.Second {
			c.lastResolved = time.Now()
			c.path = resolveTranscriptPath(sessionID, workingDir, "pi")
		}
	}
	scanTranscriptAppend(c.path, &c.piState.transcriptReadState, func() {
		c.piState.event, c.piState.at, c.piState.active, c.piState.activity = "", time.Time{}, false, false
		c.piState.model, c.piState.effort, c.piState.turnAt = "", "", time.Time{}
	}, func(line []byte) { updatePiTurnState(&c.piState, line) })
	return c.piState.event, c.piState.at, c.piState.activity
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
			Role          string `json:"role"`
			Model         string `json:"model"`
			ThinkingLevel string `json:"thinkingLevel"`
			StopReason    string `json:"stopReason"`
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
