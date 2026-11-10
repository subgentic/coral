package main

import "testing"

// After a /clear the CLI's session has a new id (#14849): the session_reset event tells it, so Coral reads the new transcript. A fresh start, a resume or the same id tell nothing.
func TestAClearTellsTheNewSessionID(t *testing.T) {
	const coral, own = "aaaaaaaa-1111-4111-8111-111111111111", "bbbbbbbb-2222-4222-8222-222222222222"
	clear := parseAgenticEvent(map[string]any{"hook_event_name": "SessionStart", "source": "clear", "session_id": own}, "SessionStart", coral)
	detail, _ := clear["detail_json"].(map[string]any)
	if clear["event_type"] != "session_reset" || detail["claude_session_id"] != own {
		t.Errorf("a clear says the new id: %v", clear)
	}
	for name, d := range map[string]map[string]any{
		"a fresh start":    {"hook_event_name": "SessionStart", "source": "startup", "session_id": own},
		"a resume":         {"hook_event_name": "SessionStart", "source": "resume", "session_id": own},
		"a clear, same id": {"hook_event_name": "SessionStart", "source": "clear", "session_id": coral},
	} {
		ev := parseAgenticEvent(d, "SessionStart", coral)
		if _, told := ev["detail_json"]; told {
			t.Errorf("%s tells no id: %v", name, ev)
		}
	}
}
