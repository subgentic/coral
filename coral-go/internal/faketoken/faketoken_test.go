package faketoken

import "testing"

func TestTheHelpersJoinThePrefixAndTheBody(t *testing.T) {
	if got := GitHub("abc"); got != "ghp_abc" {
		t.Fatalf("GitHub: %q", got)
	}
	if got := AWS("IOSFODNN7EXAMPLE"); got != "AKIAIOSFODNN7EXAMPLE" {
		t.Fatalf("AWS: %q", got)
	}
}
