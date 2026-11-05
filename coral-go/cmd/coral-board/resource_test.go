package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// #13613: coral-board resource, against a stub of the routes.

type resStub struct {
	mu       sync.Mutex
	reqs     []string
	bodies   []map[string]any
	claims   int
	grantAt  int // the claim that is granted (1: at once)
	status   int
	respText string
}

func (s *resStub) handler(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reqs = append(s.reqs, r.Method+" "+r.URL.Path)
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	s.bodies = append(s.bodies, body)
	w.Header().Set("Content-Type", "application/json")
	if s.status != 0 {
		w.WriteHeader(s.status)
		w.Write([]byte(s.respText))
		return
	}
	if strings.HasSuffix(r.URL.Path, "/claim") {
		s.claims++
		if s.claims >= s.grantAt {
			w.Write([]byte(`{"granted":true,"place":0,"entry":{"id":1}}`))
			return
		}
		w.WriteHeader(http.StatusAccepted)
		w.Write([]byte(`{"granted":false,"place":2,"entry":{"id":1}}`))
		return
	}
	w.Write([]byte(`{"resources":[{"name":"mac-heavy","slots":1,"machine":"mac","holders":[{"id":1,"agent":"Dev\u001b[31mA","task":7,"note":"gate","lease_until":"2999-01-01T00:00:00Z"}],"queue":[{"id":2,"agent":"Me","place":1}]}],"ok":true}`))
}

func runResource(t *testing.T, s *resStub, args ...string) (out string, exited bool) {
	t.Helper()
	isolateBoardEnv(t)
	t.Setenv("CORAL_SUBSCRIBER_ID", "Me")
	srv := httptest.NewServer(http.HandlerFunc(s.handler))
	defer srv.Close()
	serverURL = srv.URL
	before := os.Args
	defer func() { os.Args = before }()
	os.Args = append([]string{"coral-board", "resource"}, args...)
	out = captureStdout(t, func() { exited = captureExit(t, cmdResource) })
	return out, exited
}

func TestResourceClaimGrantedAtOnceNamesTheCallerAndHowToRelease(t *testing.T) {
	s := &resStub{grantAt: 1}
	out, exited := runResource(t, s, "claim", "mac-heavy", "--note", "gate run")
	if exited || !strings.Contains(out, "You hold a slot of mac-heavy") || !strings.Contains(out, "resource release mac-heavy") {
		t.Fatalf("exited=%v out=%q", exited, out)
	}
	if s.reqs[0] != "POST /api/resources/mac-heavy/claim" || s.bodies[0]["subscriber_id"] != "Me" || s.bodies[0]["note"] != "gate run" {
		t.Fatalf("request %v %v", s.reqs, s.bodies)
	}
}

func TestResourceClaimThatMustWaitSaysSoAndExitsWithoutWait(t *testing.T) {
	s := &resStub{grantAt: 99}
	out, exited := runResource(t, s, "claim", "mac-heavy")
	if !exited || !strings.Contains(out, "number 2 in line") || !strings.Contains(out, "--wait") {
		t.Fatalf("exited=%v out=%q", exited, out)
	}
	if len(s.reqs) != 1 {
		t.Fatalf("looked again without --wait: %v", s.reqs)
	}
}

func TestResourceClaimWaitLooksAgainUntilItIsTheCallersTurn(t *testing.T) {
	prev := resourcePoll
	resourcePoll = 5 * time.Millisecond
	defer func() { resourcePoll = prev }()
	s := &resStub{grantAt: 3}
	out, exited := runResource(t, s, "claim", "mac-heavy", "--wait")
	if exited || !strings.Contains(out, "Your turn") {
		t.Fatalf("exited=%v out=%q", exited, out)
	}
	if s.claims != 3 {
		t.Fatalf("claims: %d", s.claims)
	}
}

func TestResourceClaimWaitGivesUpAndLeavesTheLine(t *testing.T) {
	prev := resourcePoll
	resourcePoll = 5 * time.Millisecond
	defer func() { resourcePoll = prev }()
	s := &resStub{grantAt: 9999}
	_, exited := runResource(t, s, "claim", "mac-heavy", "--wait", "--timeout", "30ms")
	if !exited {
		t.Fatal("did not exit")
	}
	last := s.reqs[len(s.reqs)-1]
	if last != "POST /api/resources/mac-heavy/release" {
		t.Fatalf("a claim that gave up must leave the line, last request: %s", last)
	}
}

func TestResourceListPrintsHoldersAndTheLineAndStripsControlCharacters(t *testing.T) {
	rawOutput = true // the reply is not cleaned on the way in: what the command prints must be
	defer func() { rawOutput = false }()
	s := &resStub{}
	out, _ := runResource(t, s, "list")
	for _, want := range []string{"mac-heavy: 1 of 1 slot(s) held on mac", "holds   #1 Dev[31mA (task #7): gate", "<- you"} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q in %q", want, out)
		}
	}
	if strings.ContainsRune(out, 0x1b) {
		t.Fatalf("an escape reached the terminal: %q", out)
	}
}

func TestResourceCommandsRefuseBadInputAndReportServerRefusals(t *testing.T) {
	s := &resStub{status: 403, respText: `{"error":"only the Operator or an Orchestrator can define, remove or reorder resources","code":"manager_only"}`}
	for _, args := range [][]string{{"define", "mac"}, {"define", "mac", "--slots", "0"}, {"move", "x", "up"}, {"move", "3", "sideways"}, {"kick"}, {"nonsense"}, {"claim"}} {
		if _, exited := runResource(t, &resStub{}, args...); !exited {
			t.Errorf("%v was accepted", args)
		}
	}
	if _, exited := runResource(t, s, "remove", "mac"); !exited {
		t.Error("a refusal did not end the command with an error")
	}
}

// A short lease says its seconds (it read "over" for anything under half a minute: found in the end-to-end run).
func TestLeaseWordsSaysWhatIsLeft(t *testing.T) {
	at := func(d time.Duration) string { return time.Now().Add(d).UTC().Format(time.RFC3339) }
	for _, c := range []struct {
		in, want string
	}{{at(20 * time.Second), "[lease "}, {at(45 * time.Minute), "[lease 45m0s left]"}, {at(-time.Minute), "lease over"}} {
		if got := leaseWords(c.in); !strings.Contains(got, c.want) {
			t.Errorf("%s: %q does not contain %q", c.in, got, c.want)
		}
	}
	if got := leaseWords(at(20 * time.Second)); !regexp.MustCompile(`\[lease (19|20)s left\]`).MatchString(got) {
		t.Errorf("20 s left reads %q", got)
	}
	if leaseWords("not a time") != "" {
		t.Error("a bad time prints something")
	}
}

func TestResourceDefineSendsEveryMatch(t *testing.T) {
	s := &resStub{}
	out, exited := runResource(t, s, "define", "mac-heavy", "--slots", "1", "--match", "go test ./...", "--match", "node run_cdp_suites.mjs")
	if exited || !strings.Contains(out, "Defined mac-heavy") {
		t.Fatalf("exited=%v out=%q", exited, out)
	}
	got, _ := s.bodies[0]["match"].([]any)
	if len(got) != 2 || got[0] != "go test ./..." || got[1] != "node run_cdp_suites.mjs" {
		t.Fatalf("match sent: %v", s.bodies[0])
	}
}
