package main

import (
	"bytes"
	"testing"
)

// A dialog's lines go to its own writer through sayTo (dialogs.go): unset, they print what they always did; MOCK_AGENT_QUIET=1 (#13180) silences them like the other mock lines.
func TestSayToFollowsQuietMode(t *testing.T) {
	var b bytes.Buffer
	t.Setenv("MOCK_AGENT_QUIET", "")
	sayTo(&b, "[mock-agent] DIALOG %s dismissed\r\n", "trust")
	if b.String() != "[mock-agent] DIALOG trust dismissed\r\n" {
		t.Errorf("unset: %q", b.String())
	}
	b.Reset()
	t.Setenv("MOCK_AGENT_QUIET", "1")
	sayTo(&b, "[mock-agent] DIALOG %s dismissed\r\n", "trust")
	if b.Len() != 0 {
		t.Errorf("quiet: %q", b.String())
	}
}
