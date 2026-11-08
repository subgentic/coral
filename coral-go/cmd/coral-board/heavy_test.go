package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// #13750: coral-board heavy run: claim the pool, run on the machine the grant names.

type heavyStub struct {
	mu          sync.Mutex
	reqs        []string
	grants      []string // the claim answers, in order (the last repeats)
	n           int
	renewStatus int    // 0: 200; else the renew answer (409: the slot is no longer ours)
	statusBody  string // the answer to a GET of the resource itself (its own machine), when set
	renews      int
}

func (s *heavyStub) handler(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reqs = append(s.reqs, r.Method+" "+r.URL.Path)
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	w.Header().Set("Content-Type", "application/json")
	if strings.HasSuffix(r.URL.Path, "/claim") {
		i := s.n
		if i >= len(s.grants) {
			i = len(s.grants) - 1
		}
		s.n++
		g := s.grants[i]
		if strings.Contains(g, `"granted":false`) {
			w.WriteHeader(http.StatusAccepted)
		}
		w.Write([]byte(g))
		return
	}
	if r.Method == http.MethodGet && s.statusBody != "" {
		w.Write([]byte(s.statusBody))
		return
	}
	if strings.HasSuffix(r.URL.Path, "/renew") {
		s.renews++
		if s.renewStatus != 0 {
			w.WriteHeader(s.renewStatus)
			w.Write([]byte(`{"error":"not_holder"}`))
			return
		}
	}
	w.Write([]byte(`{}`))
}

func (s *heavyStub) saw(suffix string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range s.reqs {
		if strings.HasSuffix(r, suffix) {
			return true
		}
	}
	return false
}

const macGrant = `{"granted":true,"place":0,"entry":{"id":1,"member":"mac-heavy","machine":"Mac"}}`
const miniGrant = `{"granted":true,"place":0,"entry":{"id":1,"member":"mini","machine":"Mini"}}`

func runHeavy(t *testing.T, s *heavyStub, args ...string) (out string, code int) {
	t.Helper()
	if heavyUnsupportedHere() != "" {
		t.Skip("coral-board heavy run does not run on Windows (it says so; see TestHeavyRunOnWindowsSaysSoAndStartsNothing)")
	}
	return runHeavyAnyOS(t, s, args...)
}

func runHeavyAnyOS(t *testing.T, s *heavyStub, args ...string) (out string, code int) {
	t.Helper()
	isolateBoardEnv(t)
	t.Setenv("CORAL_SUBSCRIBER_ID", "Me")
	srv := httptest.NewServer(http.HandlerFunc(s.handler))
	defer srv.Close()
	serverURL = srv.URL
	before := os.Args
	prev := exitFn
	code = 0
	exitFn = func(c int) { code = c; panic(exitCalled{}) }
	defer func() {
		os.Args = before
		exitFn = prev
		if r := recover(); r != nil {
			if _, ok := r.(exitCalled); !ok {
				panic(r)
			}
		}
	}()
	os.Args = append([]string{"coral-board", "heavy"}, args...)
	out = captureStdout(t, func() {
		func() {
			defer func() {
				if r := recover(); r != nil {
					if _, ok := r.(exitCalled); !ok {
						panic(r)
					}
				}
			}()
			cmdHeavy()
		}()
	})
	return out, code
}

func TestHeavyRunOnTheMacRunsTheCommandHereAndPassesItsExitCodeThrough(t *testing.T) {
	s := &heavyStub{grants: []string{macGrant}}
	out, code := runHeavy(t, s, "run", "--", "echo hi-from-heavy; exit 3")
	if code != 3 || !strings.Contains(out, "hi-from-heavy") {
		t.Fatalf("code=%d out=%q", code, out)
	}
	if !s.saw("/heavy/claim") || !s.saw("/heavy/release") {
		t.Fatalf("the pool is claimed and given back: %v", s.reqs)
	}
	if !strings.Contains(out, "on Mac") {
		t.Fatalf("it says where it runs: %q", out)
	}
}

func TestHeavyRunWaitsInLineAndThenRuns(t *testing.T) {
	prev := resourcePoll
	resourcePoll = 10 * time.Millisecond
	defer func() { resourcePoll = prev }()
	s := &heavyStub{grants: []string{`{"granted":false,"place":2,"entry":{"id":1}}`, `{"granted":false,"place":1,"entry":{"id":1}}`, macGrant}}
	out, code := runHeavy(t, s, "run", "--", "echo after-the-wait")
	if code != 0 || !strings.Contains(out, "after-the-wait") || !strings.Contains(out, "number 2 in line") {
		t.Fatalf("code=%d out=%q", code, out)
	}
}

func TestHeavyRunGrantedTheMiniRefusesACommandThatIsForTheMacOnlyAndGivesTheSlotBack(t *testing.T) {
	for _, cmd := range []string{"cat ~/.coral/sessions.db", "curl http://127.0.0.1:8420/api/health", "go test ./... --coral-dir ~/.coral"} {
		s := &heavyStub{grants: []string{miniGrant}}
		out, code := runHeavy(t, s, "run", "--", cmd)
		if code != 2 || !strings.Contains(out, "Mac only") {
			t.Fatalf("%q: code=%d out=%q", cmd, code, out)
		}
		if !s.saw("/heavy/release") {
			t.Fatalf("%q: the slot is given back: %v", cmd, s.reqs)
		}
	}
}

func TestHeavyRunNeedsACommandAndHeavyWhereDecidesByMachine(t *testing.T) {
	s := &heavyStub{grants: []string{macGrant}}
	if _, code := runHeavy(t, s, "run"); code != 1 {
		t.Fatalf("no command: exit 1, got %d", code)
	}
	if s.saw("/claim") {
		t.Fatal("nothing is claimed without a command")
	}
	for member, machine := range map[string]string{"mini": "", "x": "Mini", "other": "mini", "y": "MINI"} {
		if !heavyOnMini(member, machine) {
			t.Errorf("%q %q is the mini", member, machine)
		}
	}
	for _, c := range [][2]string{{"mac-heavy", "Mac"}, {"mac-heavy", ""}, {"", ""}, {"minibar", "Mac"}} {
		if heavyOnMini(c[0], c[1]) {
			t.Errorf("%q %q is not the mini", c[0], c[1])
		}
	}
}

func TestHeavyCommandJoinsAnArgumentListWithQuotingAndKeepsOneArgumentAsAShellLine(t *testing.T) {
	if got := heavyCommand([]string{"go", "test", "./..."}); got != "go test ./..." {
		t.Errorf("got %q", got)
	}
	if got := heavyCommand([]string{"echo", "a b", "it's"}); got != `echo 'a b' 'it'\''s'` {
		t.Errorf("got %q", got)
	}
	if got := heavyCommand([]string{"cd x && go test | tail"}); got != "cd x && go test | tail" {
		t.Errorf("one argument is a shell line as it is: %q", got)
	}
}

// QA Reviewer 2's MUST on #13750: a heavy run longer than its lease must renew it, or the slot goes to the next agent while the run is still using the machine.
func TestAHeavyRunLongerThanItsLeaseRenewsTheSlotWhileItRuns(t *testing.T) {
	prevFloor := heavyRenewFloor
	heavyRenewFloor = 50 * time.Millisecond
	defer func() { heavyRenewFloor = prevFloor }()
	soon := time.Now().Add(900 * time.Millisecond).UTC().Format(time.RFC3339Nano)
	s := &heavyStub{grants: []string{`{"granted":true,"place":0,"entry":{"id":1,"member":"mac-heavy","machine":"Mac","lease_until":"` + soon + `"}}`}}
	out, code := runHeavy(t, s, "run", "--", "sleep 2; echo finished")
	if code != 0 || !strings.Contains(out, "finished") {
		t.Fatalf("code=%d out=%q", code, out)
	}
	if s.renews < 1 {
		t.Fatalf("a run longer than its lease renews it while it runs: %d renewals, %v", s.renews, s.reqs)
	}
}

func TestAHeavyRunThatLosesItsSlotIsStoppedAndSaysSo(t *testing.T) {
	prevFloor := heavyRenewFloor
	heavyRenewFloor = 50 * time.Millisecond
	defer func() { heavyRenewFloor = prevFloor }()
	soon := time.Now().Add(600 * time.Millisecond).UTC().Format(time.RFC3339Nano)
	s := &heavyStub{renewStatus: 409, grants: []string{`{"granted":true,"place":0,"entry":{"id":1,"member":"mac-heavy","machine":"Mac","lease_until":"` + soon + `"}}`}}
	start := time.Now()
	out, code := runHeavy(t, s, "run", "--", "sleep 30; echo should-not-print")
	if code == 0 || strings.Contains(out, "should-not-print") || time.Since(start) > 10*time.Second {
		t.Fatalf("a run that has lost its slot is stopped: code=%d after %v out=%q", code, time.Since(start), out)
	}
	if !strings.Contains(out, "lost its slot") {
		t.Fatalf("and says why: %q", out)
	}
}

func TestTheRenewIntervalIsAThirdOfTheLeaseWithinLimits(t *testing.T) {
	for in, want := range map[time.Duration]time.Duration{45 * time.Minute: 5 * time.Minute, 90 * time.Second: 30 * time.Second, 3 * time.Second: 5 * time.Second, 0: 60 * time.Second} {
		if got := heavyRenewEvery(in); got != want {
			t.Errorf("lease %v: renew every %v, want %v", in, got, want)
		}
	}
}

// QA Reviewer 2's SHOULD: a run that lost its slot never reports success, even when the command itself exited 0.
func TestALostSlotIsNeverReportedAsSuccess(t *testing.T) {
	if got := heavyFinalCode(0, true); got == 0 {
		t.Fatal("a command that succeeded but ran without its slot is not a success")
	}
	if got := heavyFinalCode(0, false); got != 0 {
		t.Fatalf("an ordinary success stays 0, got %d", got)
	}
	if got := heavyFinalCode(7, true); got != 7 {
		t.Fatalf("a real exit code is kept: %d", got)
	}
	if got := heavyFinalCode(3, false); got != 3 {
		t.Fatalf("%d", got)
	}
}

// #14262: a heavy run for the mini printed "running on " with no destination and ran the command on THIS Mac while holding the mini's claim (the claim reply named neither a member nor a machine, because the mini is a plain
// slot resource, not a pool). A destination that is unknown, or that is neither the mini nor this Mac, now runs nothing, gives the slot back and exits non-zero.
func TestAHeavyRunWhoseClaimNamesNoMachineRunsNothingHere(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "ran-here")
	s := &heavyStub{grants: []string{`{"granted":true,"place":0,"entry":{"id":1}}`}}
	out, code := runHeavy(t, s, "run", "--pool", "mini", "--", "touch "+marker)
	if code == 0 {
		t.Fatalf("no destination is a refusal, not a run: code=%d out=%q", code, out)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatalf("the command ran on this Mac under a claim for another machine: %q", out)
	}
	if !strings.Contains(out, "could not tell which machine") || !strings.Contains(out, "never falls back to this Mac") {
		t.Fatalf("it says why: %q", out)
	}
	if !s.saw("/mini/release") {
		t.Fatalf("the slot is given back: %v", s.reqs)
	}
	if strings.Contains(out, "running on") {
		t.Fatalf("it never says it is running: %q", out)
	}
}

func TestAHeavyRunWhoseClaimIsSilentAsksTheResourceItsMachine(t *testing.T) {
	inTempRepo(t)
	prev := heavyTestTransport
	heavyTestTransport = wrapperTransport(t)
	defer func() { heavyTestTransport = prev }()
	// an older server: the claim names no machine for a plain resource; the resource itself says mini
	s := &heavyStub{grants: []string{`{"granted":true,"place":0,"entry":{"id":1}}`}, statusBody: `{"name":"mini","machine":"mini"}`}
	out, code := runHeavy(t, s, "run", "--pool", "mini", "--", "echo hi-from-the-mini-path")
	if code != 0 || !strings.Contains(out, "running on mini (over ssh)") {
		t.Fatalf("it runs on the mini, over ssh, saying so: code=%d out=%q", code, out)
	}
	// and a plain resource whose own machine is the Mac runs here
	s = &heavyStub{grants: []string{`{"granted":true,"place":0,"entry":{"id":1}}`}, statusBody: `{"name":"mac-heavy","machine":"mac"}`}
	out, code = runHeavy(t, s, "run", "--pool", "mac-heavy", "--", "echo hi-from-here")
	if code != 0 || !strings.Contains(out, "hi-from-here") || !strings.Contains(out, "(on this Mac)") {
		t.Fatalf("a Mac resource runs here and says so: code=%d out=%q", code, out)
	}
}

func TestAHeavyRunOnAMachineItDoesNotDriveRunsNothing(t *testing.T) {
	for _, grant := range []string{
		`{"granted":true,"place":0,"entry":{"id":1,"member":"epoch-go","machine":"epoch"}}`,
		`{"granted":true,"place":0,"entry":{"id":1,"member":"mac-heavy"}}`, // a member with no machine is not known to be the Mac
	} {
		marker := filepath.Join(t.TempDir(), "ran-here")
		s := &heavyStub{grants: []string{grant}}
		out, code := runHeavy(t, s, "run", "--", "touch "+marker)
		if code == 0 {
			t.Fatalf("%s: a machine heavy run does not drive is refused: %q", grant, out)
		}
		if _, err := os.Stat(marker); err == nil {
			t.Fatalf("%s: it ran here: %q", grant, out)
		}
		if !s.saw("/heavy/release") {
			t.Fatalf("%s: the slot is given back: %v", grant, s.reqs)
		}
	}
}
