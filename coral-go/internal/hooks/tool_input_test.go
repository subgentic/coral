package hooks

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// GetToolInput reads the tool's input from tool_input, else input, else tool.input, else arguments (#8389: arguments was set on a shadowed variable, so an agent that sends its tool input there got an empty map).
func TestGetToolInputSources(t *testing.T) {
	cmd := func(c string) map[string]any { return map[string]any{"command": c} }
	for _, tc := range []struct {
		name string
		data map[string]any
		want map[string]any
	}{
		{"tool_input", map[string]any{"tool_input": cmd("a")}, cmd("a")},
		{"input", map[string]any{"input": cmd("b")}, cmd("b")},
		{"tool.input", map[string]any{"tool": map[string]any{"input": cmd("c")}}, cmd("c")},
		{"arguments", map[string]any{"arguments": cmd("ls")}, cmd("ls")},
		{"tool_input first", map[string]any{"tool_input": cmd("a"), "input": cmd("b"), "tool": map[string]any{"input": cmd("c")}, "arguments": cmd("d")}, cmd("a")},
		{"input before tool.input and arguments", map[string]any{"input": cmd("b"), "tool": map[string]any{"input": cmd("c")}, "arguments": cmd("d")}, cmd("b")},
		{"tool.input before arguments", map[string]any{"tool": map[string]any{"input": cmd("c")}, "arguments": cmd("d")}, cmd("c")},
		{"arguments after a tool without input", map[string]any{"tool": map[string]any{"name": "Bash"}, "arguments": cmd("e")}, cmd("e")},
		{"arguments that is not a map", map[string]any{"arguments": "ls"}, map[string]any{}},
		{"tool_input that is not a map falls through", map[string]any{"tool_input": "x", "arguments": cmd("f")}, cmd("f")},
		{"none", map[string]any{"session_id": "s"}, map[string]any{}},
		{"empty", map[string]any{}, map[string]any{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, GetToolInput(tc.data))
		})
	}
}
