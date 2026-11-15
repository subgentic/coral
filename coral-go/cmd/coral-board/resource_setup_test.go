package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// #17588: resource setup reads each box, checks it, and defines its resource; a re-run updates it and keeps what a person wrote.

var lastSetupStderr, lastSetupOut string
var lastSetupBoxCalls int

type setupStub struct {
	mu       sync.Mutex
	defined  map[string]map[string]any // PUT bodies by name
	existing map[string]string         // GET answers by name; missing: 404
	reqs     []string
	refuse   bool // the caller may not define: a PUT ?check=1 answers 403
}

func (s *setupStub) handler(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	name := strings.TrimPrefix(r.URL.Path, "/api/resources/")
	s.reqs = append(s.reqs, r.Method+" "+name)
	w.Header().Set("Content-Type", "application/json")
	if r.Method == "PUT" && r.URL.Query().Get("check") == "1" {
		s.reqs = append(s.reqs, "CHECK "+name)
		if s.refuse {
			w.WriteHeader(http.StatusForbidden)
			w.Write([]byte(`{"error":"only the Operator or an Orchestrator can define, remove or reorder resources"}`))
			return
		}
		w.Write([]byte(`{"ok":true,"may_define":true}`))
		return
	}
	if r.Method == "PUT" {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		s.defined[name] = body
		w.Write([]byte(`{"ok":true}`))
		return
	}
	if v, ok := s.existing[name]; ok {
		w.Write([]byte(v))
		return
	}
	w.WriteHeader(http.StatusNotFound)
	w.Write([]byte(`{"error":"no such resource"}`))
}

func runSetup(t *testing.T, s *setupStub, answers map[string]string, args ...string) (string, bool) {
	t.Helper()
	isolateBoardEnv(t)
	t.Setenv("CORAL_SUBSCRIBER_ID", "Me")
	srv := httptest.NewServer(http.HandlerFunc(s.handler))
	defer srv.Close()
	serverURL = srv.URL
	prev := boxRun
	lastSetupBoxCalls = 0
	boxRun = func(alias string, here bool, script string, _ time.Duration) (string, error) {
		lastSetupBoxCalls++
		a, ok := answers[alias+"|"+firstWord(script)]
		if !ok {
			return "", os.ErrDeadlineExceeded
		}
		return a, nil
	}
	defer func() { boxRun = prev }()
	before := os.Args
	defer func() { os.Args = before }()
	os.Args = append([]string{"coral-board", "resource", "setup"}, args...)
	var exited bool
	lastSetupStderr = captureStderr(t, func() {
		out := captureStdout(t, func() { exited = captureExit(t, cmdResource) })
		lastSetupOut = out
	})
	return lastSetupOut, exited
}

// firstWord tells the probe script from the check script by its second line.
func firstWord(script string) string {
	if strings.Contains(script, "probe-end") {
		return "probe"
	}
	return "check"
}

const epochAnswer = "os=linux\narch=x86_64\ncores=48\nmem_mb=128000\ndisk_gb=900\ngo=go version go1.26.1 linux/amd64\nnode=\nprobe-end\n"

func TestSetupDefinesABoxFromWhatItSaysAndAFailedCheckLeavesItAlone(t *testing.T) {
	s := &setupStub{defined: map[string]map[string]any{}, existing: map[string]string{}}
	out, exited := runSetup(t, s, map[string]string{
		"epoch|probe": epochAnswer, "epoch|check": "ok  \tcheck\t0.1s\ncheck-end\n",
		"bad|probe": epochAnswer, "bad|check": "--- FAIL: TestCheck\nFAIL\ncheck-end\n",
	}, "epoch", "bad")
	if !exited {
		t.Fatalf("one box failed, so the command exits 1: %q", out)
	}
	e := s.defined["epoch"]
	if e == nil || e["slots"] != float64(4) || e["weight"] != float64(48) || e["where"] != "remote" || e["machine"] != "epoch" {
		t.Fatalf("epoch body: %v", e)
	}
	if f, _ := e["facts"].(map[string]any); f["os"] != "linux" || f["go"] != "1.26" || f["cores"] != "48" {
		t.Fatalf("facts: %v", e["facts"])
	}
	if d, _ := e["description"].(string); !strings.Contains(d, "ssh epoch") {
		t.Fatalf("a new resource gets a description made from the box: %q", d)
	}
	if _, ok := s.defined["bad"]; ok {
		t.Fatal("a box whose check failed must not be defined")
	}
	if !strings.Contains(out, "epoch: defined") {
		t.Fatalf("out %q", out)
	}
}

func TestSetupAgainUpdatesAndKeepsWhatAPersonWrote(t *testing.T) {
	s := &setupStub{defined: map[string]map[string]any{}, existing: map[string]string{
		"epoch": `{"name":"epoch","slots":2,"max_lease_seconds":2700,"allowed":["QA"],"match":["go test ./..."],"description":"Linux, Go only. Rig and CI live here."}`,
	}}
	out, exited := runSetup(t, s, map[string]string{"epoch|probe": epochAnswer, "epoch|check": "ok  \tcheck\t0.1s\ncheck-end\n"}, "epoch")
	if exited {
		t.Fatalf("out %q", out)
	}
	e := s.defined["epoch"]
	if _, has := e["description"]; has {
		t.Fatalf("the person's description is kept (not sent): %v", e)
	}
	if e["max_lease_seconds"] != float64(2700) || e["allowed"].([]any)[0] != "QA" || e["match"].([]any)[0] != "go test ./..." {
		t.Fatalf("lease, allow and match are carried over: %v", e)
	}
	if e["slots"] != float64(2) {
		t.Fatalf("the slots a person set are kept (they limit how hard the box is worked): %v", e["slots"])
	}
	if !strings.Contains(out, "updated") || !strings.Contains(out, "2 slot(s) (kept") {
		t.Fatalf("out %q", out)
	}
	s.defined = map[string]map[string]any{}
	if _, exited := runSetup(t, s, map[string]string{"epoch|probe": epochAnswer, "epoch|check": "ok  \tcheck\t0.1s\ncheck-end\n"}, "epoch", "--slots", "3"); exited || s.defined["epoch"]["slots"] != float64(3) {
		t.Fatalf("--slots changes them: %v", s.defined["epoch"])
	}
}

func TestSetupDryRunAndAnUnreadableBoxDefineNothing(t *testing.T) {
	s := &setupStub{defined: map[string]map[string]any{}, existing: map[string]string{}}
	out, exited := runSetup(t, s, map[string]string{"epoch|probe": epochAnswer, "epoch|check": "ok  \tcheck\t0.1s\ncheck-end\n"}, "epoch", "gone", "--dry-run")
	if !exited || len(s.defined) != 0 || !strings.Contains(out, "would define") {
		t.Fatalf("exited=%v defined=%v out=%q", exited, s.defined, out)
	}
}

func TestSetupAddsTheBoxesToAPoolKeepingItsMembers(t *testing.T) {
	s := &setupStub{defined: map[string]map[string]any{}, existing: map[string]string{
		"heavy": `{"name":"heavy","members":["mac-heavy"],"machine":"pool","match":["go test ./..."],"max_lease_seconds":1800}`,
	}}
	_, exited := runSetup(t, s, map[string]string{"epoch|probe": epochAnswer, "epoch|check": "ok  \tcheck\t0.1s\ncheck-end\n"}, "epoch", "--pool", "heavy")
	if exited {
		t.Fatal("exited")
	}
	m, _ := s.defined["heavy"]["members"].([]any)
	if len(m) != 2 || m[0] != "mac-heavy" || m[1] != "epoch" || s.defined["heavy"]["match"] == nil {
		t.Fatalf("pool body: %v", s.defined["heavy"])
	}
}

func TestSetupRefusesBadNamesAndAliases(t *testing.T) {
	s := &setupStub{defined: map[string]map[string]any{}, existing: map[string]string{}}
	for _, bad := range []string{"-oProxyCommand=x", "a b", "x=y=z;"} {
		if _, exited := runSetup(t, s, nil, "--", bad); !exited {
			t.Fatalf("%q was accepted", bad)
		}
	}
	if len(s.reqs) != 0 {
		t.Fatalf("nothing is sent for a bad box: %v", s.reqs)
	}
}

// The flag check in front of every command knows each option resource define and setup take: --description, --facts, --weight and --needs were refused by the real binary (the tests above call the commands directly and skip the check).
func TestTheFlagCheckKnowsEveryResourceDefineAndSetupOption(t *testing.T) {
	for _, args := range [][]string{
		{"resource", "define", "epoch", "--slots", "2", "--description", "Linux, Go only", "--facts", "os=linux", "--facts", "go=1.26", "--weight", "48", "--here", "--machine", "epoch", "--lease", "30m", "--allow", "QA", "--match", "go test ./..."},
		{"resource", "define", "heavy", "--pool", "a,b", "--needs", "os=linux", "--needs", "go>=1.26", "--description", "pool"},
		{"resource", "setup", "epoch", "frontier", "mini", "mac=here", "--pool", "heavy", "--slots", "2", "--description", "x", "--dry-run"},
	} {
		if err := checkKnownFlags(args); err != nil {
			t.Fatalf("%v: %v", args, err)
		}
	}
	if err := checkKnownFlags([]string{"resource", "setup", "epoch", "--dry-runs"}); err == nil {
		t.Fatal("a misspelt option is still refused")
	}
}

// Security on #17588 (#17894): a toolchain error is not a pass, a hostile box cannot print control characters into the terminal, a caller who may not define reaches no ssh, and a pool is not turned into a box.
func TestSetupCheckPassesOnlyOnAnOkLine(t *testing.T) {
	s := &setupStub{defined: map[string]map[string]any{}, existing: map[string]string{}}
	_, exited := runSetup(t, s, map[string]string{"epoch|probe": epochAnswer, "epoch|check": "go: command not found\ncheck-end\n"}, "epoch")
	if !exited || s.defined["epoch"] != nil {
		t.Fatalf("a toolchain error is not a pass: exited=%v defined=%v", exited, s.defined)
	}
}

func TestSetupPrintsNoControlCharactersFromTheBox(t *testing.T) {
	s := &setupStub{defined: map[string]map[string]any{}, existing: map[string]string{}}
	hostile := "\x1b]0;owned\x07\x1b[2Jlast words\x00\u202e\ncheck-end\n"
	out, _ := runSetup(t, s, map[string]string{"epoch|probe": epochAnswer, "epoch|check": hostile}, "epoch")
	errOut := lastSetupStderr
	for _, r := range out + errOut {
		if r != '\n' && (r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) || r == 0x202e) {
			t.Fatalf("control character %U reached the terminal: %q %q", r, out, errOut)
		}
	}
	if !strings.Contains(errOut, "last words") {
		t.Fatalf("the words stay: %q", errOut)
	}
}

func TestSetupByACallerWhoMayNotDefineProbesNothing(t *testing.T) {
	s := &setupStub{defined: map[string]map[string]any{}, existing: map[string]string{}, refuse: true}
	probed := false
	out, exited := runSetup(t, s, map[string]string{}, "epoch", "--dry-run")
	_ = probed
	if !exited || !strings.Contains(out+lastSetupStderr, "Orchestrator") {
		t.Fatalf("refused with the reason: exited=%v %q %q", exited, out, lastSetupStderr)
	}
	if lastSetupBoxCalls != 0 {
		t.Fatalf("ssh was reached %d time(s) before the permission was checked", lastSetupBoxCalls)
	}
}

func TestSetupRefusesANameThatIsAPoolWithMembers(t *testing.T) {
	s := &setupStub{defined: map[string]map[string]any{}, existing: map[string]string{
		"heavy": `{"name":"heavy","members":["mac-heavy","epoch"],"machine":"pool"}`,
	}}
	_, exited := runSetup(t, s, map[string]string{"heavy|probe": epochAnswer, "heavy|check": "ok  \tcheck\t0.1s\ncheck-end\n"}, "heavy")
	if !exited || s.defined["heavy"] != nil {
		t.Fatalf("setup must not redefine a pool as a box: exited=%v defined=%v", exited, s.defined)
	}
	if lastSetupBoxCalls != 0 {
		t.Fatalf("the pool is refused before any ssh: %d", lastSetupBoxCalls)
	}
}

// captureStderr returns what fn printed to os.Stderr.
func captureStderr(t *testing.T, fn func()) string {
	t.Helper()
	old := os.Stderr
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stderr = w
	defer func() { os.Stderr = old }()
	fn()
	w.Close()
	b, _ := io.ReadAll(r)
	return string(b)
}
