package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestStartupTrustWaitsForAnAnswer(t *testing.T) {
	for _, tc := range []struct {
		keys     string
		accepted bool
	}{{"", false}, {"1", true}, {"2", false}, {"1\r", true}, {"2\r", false}, {"\x1b[B\r", false}, {"\x03", false}} {
		var out bytes.Buffer
		if got := readStartupTrust(strings.NewReader(tc.keys), &out); got != tc.accepted {
			t.Fatalf("%q accepted=%v", tc.keys, got)
		}
		if !strings.Contains(out.String(), "Do you trust the files in this folder?") {
			t.Fatal("missing screen")
		}
	}
}
