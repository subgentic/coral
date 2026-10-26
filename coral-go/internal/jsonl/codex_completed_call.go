package jsonl

import (
	"encoding/json"
	"strings"
	"time"
)

// Codex has PermissionRequest but no approval-resolved hook. A completed outer
// exec result can prove its nested approval is over, including when the shell
// process itself is still running. Never use generic activity or yielded outer
// scripts: either can be written while another approval remains open (#7896).
// Keep bounded, per-turn intervals, reusing the incremental transcript scan.
type codexCallInterval struct {
	start, end      time.Time
	exec, ambiguous bool
}

type codexCallTracker struct {
	resolvedRequestAt, resolvedAt time.Time
	pending                       map[string]codexCallInterval
	completed                     []codexCallInterval
	invalid                       bool
}

func (s *codexCallTracker) read(line []byte) {
	var e struct {
		Timestamp time.Time `json:"timestamp"`
		Type      string    `json:"type"`
		Payload   struct {
			Type   string          `json:"type"`
			CallID string          `json:"call_id"`
			Name   string          `json:"name"`
			Output json.RawMessage `json:"output"`
		} `json:"payload"`
	}
	if json.Unmarshal(line, &e) != nil {
		return
	}
	if e.Type == "event_msg" {
		switch e.Payload.Type {
		case "task_started", "user_message", "task_complete", "turn_aborted":
			*s = codexCallTracker{}
		}
		return
	}
	if e.Type != "response_item" || s.invalid {
		return
	}
	p := e.Payload
	switch p.Type {
	case "function_call", "custom_tool_call":
		if p.CallID == "" || e.Timestamp.IsZero() || len(s.pending) >= 8 {
			s.invalid = true
			return
		}
		if _, exists := s.pending[p.CallID]; exists {
			s.invalid = true
			return
		}
		if s.pending == nil {
			s.pending = map[string]codexCallInterval{}
		}
		// Once calls overlap, keep both ambiguous, even if one finishes first.
		for id, call := range s.pending {
			call.ambiguous = true
			s.pending[id] = call
		}
		s.pending[p.CallID] = codexCallInterval{start: e.Timestamp, exec: p.Type == "custom_tool_call" && p.Name == "exec", ambiguous: len(s.pending) > 0}
	case "function_call_output", "custom_tool_call_output":
		call, ok := s.pending[p.CallID]
		if !ok {
			if len(s.pending) > 0 {
				s.invalid = true
			}
			return
		}
		delete(s.pending, p.CallID)
		if p.Type != "custom_tool_call_output" || !call.exec || call.ambiguous || !e.Timestamp.After(call.start) || !codexScriptCompleted(p.Output) {
			return
		}
		call.end = e.Timestamp
		s.completed = append(s.completed, call)
		if len(s.completed) > 32 {
			s.completed = s.completed[len(s.completed)-32:]
		}
	}
}

func codexScriptCompleted(raw json.RawMessage) bool {
	// Code mode's first block is the execution harness status, not tool output.
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &blocks) != nil || len(blocks) == 0 || blocks[0].Type != "input_text" {
		return false
	}
	first, _, _ := strings.Cut(blocks[0].Text, "\n")
	return first == "Script completed"
}

// ReadCodexCompletedCall returns the completion time of a single, nonoverlapping
// native exec call that contained the request. No match is deliberately sticky:
// missing IDs, parallel calls and a still-yielded script cannot release input.
func (r *SessionReader) ReadCodexCompletedCall(sessionID, workingDir string, requestAt time.Time) time.Time {
	if requestAt.IsZero() {
		return time.Time{}
	}
	r.ReadCodexTurn(sessionID, workingDir)
	c := r.getOrCreateSessionCache(sessionID)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.codexState.calls.invalid {
		return time.Time{}
	}
	if c.codexState.calls.resolvedRequestAt.Equal(requestAt) {
		return c.codexState.calls.resolvedAt
	}
	for _, call := range c.codexState.calls.completed {
		if call.start.Before(requestAt) && call.end.After(requestAt) {
			c.codexState.calls.resolvedRequestAt, c.codexState.calls.resolvedAt = requestAt, call.end
			return call.end
		}
	}
	return time.Time{}
}
