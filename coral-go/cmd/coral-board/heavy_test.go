package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// #13750: coral-board heavy run: claim the pool, run on the machine the grant names.

type heavyStub struct {
	mu     sync.Mutex
	reqs   []string
	grants []string // the claim answers, in order (the last repeats)
	n      int
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
