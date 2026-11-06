//go:build windows

package routes

import (
	"os"
	"strings"
	"testing"
)

// The stand-in CLI of the launch tests runs a program of its own, never this test binary: a CLI probe that started the test binary would run the whole suite again, and probe again.
func TestTheStandInCLINeverRunsTheTestBinary(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(stubCLI(t))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.ToLower(string(body)), strings.ToLower(self)) {
		t.Fatalf("the stand-in CLI runs this test binary: %s", body)
	}
}
