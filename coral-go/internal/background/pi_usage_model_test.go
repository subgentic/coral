package background

import "testing"

// A Pi turn whose message names no model ("model":"" or none) was recorded under the empty model, a bucket of its own beside the real ones in the token summary (#11293 row 11).
// The model of the session at that point is the one its model_change entry (or the last turn that named one) gave.
func TestPiUsageWithNoModelNamedTakesTheSessionsModel(t *testing.T) {
	var p piParser
	for _, l := range []string{
		`{"type":"session","id":"s","timestamp":"2026-10-29T19:44:35.010Z"}`,
		`{"type":"model_change","timestamp":"2026-10-29T19:44:35.028Z","provider":"openai","modelId":"gpt-6-luna"}`,
		`{"type":"message","timestamp":"2026-10-29T19:44:36.000Z","message":{"role":"assistant","model":"","usage":{"input":10,"output":2,"totalTokens":12}}}`,
		`{"type":"message","timestamp":"2026-10-29T19:44:37.000Z","message":{"role":"assistant","model":"gpt-6.1-sol","usage":{"input":20,"output":3,"totalTokens":23}}}`,
		`{"type":"message","timestamp":"2026-10-29T19:44:38.000Z","message":{"role":"assistant","usage":{"input":30,"output":4,"totalTokens":34}}}`,
	} {
		p.line(l)
	}
	want := []string{"gpt-6-luna", "gpt-6.1-sol", "gpt-6.1-sol"}
	if len(p.Calls) != len(want) {
		t.Fatalf("calls = %d, want %d", len(p.Calls), len(want))
	}
	for i, w := range want {
		if p.Calls[i].Model != w {
			t.Errorf("call %d model = %q, want %q", i, p.Calls[i].Model, w)
		}
	}
}

func TestPiUsageBeforeAnyModelIsKnownStaysEmpty(t *testing.T) {
	var p piParser
	p.line(`{"type":"message","timestamp":"2026-10-29T19:44:36.000Z","message":{"role":"assistant","usage":{"input":10,"output":2,"totalTokens":12}}}`)
	if len(p.Calls) != 1 || p.Calls[0].Model != "" {
		t.Fatalf("calls = %+v", p.Calls)
	}
}

// With no model named anywhere in the session file, a Pi turn is on the model the agent was launched with (the live session's model, "provider/id" or "provider/id:level" as Pi takes it), written
// the way Pi writes its turns' models: the id alone.
func TestPiLaunchModelNamesATurnThatNamesNone(t *testing.T) {
	str := func(s string) *string { return &s }
	for _, tc := range []struct {
		turn   string
		launch *string
		want   string
	}{
		{"gpt-6-luna", str("openai/other"), "gpt-6-luna"}, // a turn that names its model keeps it
		{"", str("openai/gpt-6-luna"), "gpt-6-luna"},
		{"", str("openai/gpt-6-luna:high"), "gpt-6-luna"},
		{"", str("gpt-6-luna"), "gpt-6-luna"},
		{"", nil, ""},
		{"", str(""), ""},
	} {
		if got := piRecordModel(tc.turn, tc.launch); got != tc.want {
			t.Errorf("piRecordModel(%q, %v) = %q, want %q", tc.turn, tc.launch, got, tc.want)
		}
	}
}
