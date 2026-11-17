package main

import "testing"

// Claude's PreCompact hook is a compaction starting: Coral shows the agent as compacting (#19090).
func TestPreCompactIsACompactionStarting(t *testing.T) {
	ev := parseAgenticEvent(map[string]any{"hook_event_name": "PreCompact", "trigger": "manual", "custom_instructions": "keep: open tasks"}, "PreCompact", "sid")
	if ev == nil || ev["event_type"] != "compact_start" || ev["session_id"] != "sid" {
		t.Fatalf("PreCompact: %v", ev)
	}
	if s, _ := ev["summary"].(string); s != "Compacting conversation" {
		t.Fatalf("summary %q", s)
	}
}
