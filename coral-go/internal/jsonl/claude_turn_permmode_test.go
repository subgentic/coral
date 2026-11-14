package jsonl

import "testing"

// #16523: the permission mode a Claude transcript line carries; a value that is no Claude mode, or a line without one, is "".
func TestClaudeLinePermissionMode(t *testing.T) {
	for _, tc := range []struct{ line, want string }{
		{`{"type":"user","permissionMode":"plan","timestamp":"2026-11-14T01:00:00Z"}`, "plan"},
		{`{"type":"user","permissionMode":"bypassPermissions"}`, "bypassPermissions"},
		{`{"type":"user","permissionMode":"acceptEdits"}`, "acceptEdits"},
		{`{"type":"user","permissionMode":"yolo"}`, ""},
		{`{"type":"user","permissionMode":""}`, ""},
		{`{"type":"assistant","message":{"role":"assistant"}}`, ""},
		{`{"type":"user","toolUseResult":{"permissionMode":"plan"}}`, ""}, // a tool's own result is not the record's top-level key
		{`not json "permissionMode":"plan"`, ""},
	} {
		if got := claudeLinePermissionMode([]byte(tc.line)); got != tc.want {
			t.Errorf("%s: got %q, want %q", tc.line, got, tc.want)
		}
	}
}
