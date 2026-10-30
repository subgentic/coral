package agent

import (
	"strings"
	"testing"
)

// A one-shot Pi run (a scheduled job) pins --print --no-session --no-approve after every configured flag, as a workflow step's are: a flag that slipped through (--approve) is never the one that wins.
func TestPiOneShotPinsNoApproveAfterTheConfiguredFlags(t *testing.T) {
	cmd, err := (&PiAgent{}).LaunchCommand(LaunchParams{SessionID: "11111111-2222-4333-8444-555555555555", CoralDir: t.TempDir(), WorkingDir: t.TempDir(), Flags: []string{"--approve", "--model", "x"}, OneShot: true, Prompt: "do it"})
	if err != nil {
		t.Fatal(err)
	}
	approve, noApprove := strings.Index(cmd, "--approve"), strings.LastIndex(cmd, "--no-approve")
	if approve < 0 || noApprove < approve {
		t.Fatalf("--no-approve must come after --approve:\n%s", cmd)
	}
	for _, want := range []string{"--print", "--no-session"} {
		if !strings.Contains(cmd, want) {
			t.Errorf("missing %s in %s", want, cmd)
		}
	}
	plain, _ := (&PiAgent{}).LaunchCommand(LaunchParams{SessionID: "11111111-2222-4333-8444-555555555555", CoralDir: t.TempDir(), WorkingDir: t.TempDir(), Prompt: "do it"})
	if strings.Contains(plain, "--print") || strings.Contains(plain, "--no-session") {
		t.Errorf("an interactive launch is not one shot: %s", plain)
	}
}
