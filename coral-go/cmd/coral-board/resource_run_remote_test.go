//go:build !windows

package main

import (
	"os"
	"strings"
	"testing"
)

// #20221: a resource defined remote says "a run through it is sent there", and resource claim --run ran the command on this computer. It is now sent where the resource says, as heavy run does.
func TestAClaimWithRunOnARemoteResourceIsSentThereNotRunHere(t *testing.T) {
	inTempRepo(t)
	here, _ := os.Getwd()
	prev := heavyTestTransport
	heavyTestTransport = wrapperTransport(t)
	defer func() { heavyTestTransport = prev }()
	s := &resStub{grantAt: 1, entry: `{"id":1,"machine":"Mini","where":"remote"}`}
	out, exited := runResource(t, s, "claim", "mini", "--run", "--", "pwd; echo from-the-mini; exit 6")
	if !exited || !strings.Contains(out, "from-the-mini") {
		t.Fatalf("exited=%v out=%q", exited, out)
	}
	if !strings.Contains(out, "running on Mini (over ssh)") {
		t.Fatalf("it says where it runs: %q", out)
	}
	if strings.Contains(out, here+"\n") {
		t.Fatalf("it ran in this folder, not on the other machine: %q", out)
	}
	if !strings.Contains(out, "given back (exit 6)") {
		t.Fatalf("the slot is given back with the command's own exit code: %q", out)
	}
}

// A remote run is never a command for this machine only, and a resource that says it is here runs here as before.
func TestAClaimWithRunRefusesAThisMachineCommandOnARemoteResourceAndRunsHereWhenHere(t *testing.T) {
	inTempRepo(t)
	prev := heavyTestTransport
	heavyTestTransport = wrapperTransport(t)
	defer func() { heavyTestTransport = prev }()
	s := &resStub{grantAt: 1, entry: `{"id":1,"machine":"Mini","where":"remote"}`}
	out, exited := runResource(t, s, "claim", "mini", "--run", "--", "ls ~/.coral")
	if !exited || !strings.Contains(out, "this machine only") || strings.Contains(out, "running on") {
		t.Fatalf("a this-machine command is refused on a remote resource: exited=%v %q", exited, out)
	}
	if last := s.reqs[len(s.reqs)-1]; last != "POST /api/resources/mini/release" {
		t.Fatalf("the slot is given back when nothing ran: %v", s.reqs)
	}
	h := &resStub{grantAt: 1, entry: `{"id":1,"machine":"Mac","where":"here"}`}
	out, exited = runResource(t, h, "claim", "mac-heavy", "--run", "--", "echo ran-here")
	if exited || !strings.Contains(out, "ran-here") || strings.Contains(out, "over ssh") {
		t.Fatalf("here runs here: exited=%v %q", exited, out)
	}
}
