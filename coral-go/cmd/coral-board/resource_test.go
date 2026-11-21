package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"syscall"
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
	lease    string // the granted entry's lease_until, when set (#18488)
	how      string // the answer to GET /api/resources/<name> when set (#17560)
	entry    string // the granted entry's JSON, when set (#20221: where it runs)
	goneAt   int    // from this claim on, a claim that names its place (poll_entry) is answered 410 cancelled (#20345)
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
		if _, polling := body["poll_entry"]; polling && s.goneAt > 0 && s.claims >= s.goneAt {
			w.WriteHeader(http.StatusGone)
			w.Write([]byte(`{"code":"cancelled","error":"your place in line was cancelled"}`))
			return
		}
		if s.claims >= s.grantAt {
			if s.entry != "" {
				w.Write([]byte(`{"granted":true,"place":0,"entry":` + s.entry + `}`))
				return
			}
			if s.lease != "" {
				w.Write([]byte(`{"granted":true,"place":0,"entry":{"id":1,"lease_until":"` + s.lease + `"}}`))
				return
			}
			w.Write([]byte(`{"granted":true,"place":0,"entry":{"id":1}}`))
			return
		}
		w.WriteHeader(http.StatusAccepted)
		w.Write([]byte(`{"granted":false,"place":2,"entry":{"id":1}}`))
		return
	}
	if s.how != "" && r.Method == "GET" && strings.Count(r.URL.Path, "/") == 3 {
		w.Write([]byte(s.how))
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
	if n := strings.Count(strings.Join(s.reqs, " "), "POST "); n != 1 {
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
	if keep, _ := s.bodies[len(s.bodies)-1]["keep_place"].(bool); !keep {
		t.Fatalf("a wait that timed out asks to KEEP its place for the grace (#13706), body: %v", s.bodies[len(s.bodies)-1])
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

// #13718: the claim names the shell that runs coral-board (its parent), so the server can keep a background job's slot while its work runs; every claim (and each look again while waiting) carries it.
func TestAClaimSendsItsParentProcessSoABackgroundJobCanKeepTheSlot(t *testing.T) {
	s := &resStub{grantAt: 2}
	if _, exited := runResource(t, s, "claim", "mac-heavy", "--wait"); exited {
		t.Fatal("exited")
	}
	if len(s.bodies) < 2 {
		t.Fatalf("want a claim and a look again, got %d", len(s.bodies))
	}
	for _, b := range s.bodies {
		if len(b) == 0 { // the read of the resource's description after the grant (#17560) has no body
			continue
		}
		if got, _ := b["parent_pid"].(float64); int(got) != os.Getppid() {
			t.Fatalf("parent_pid %v, want %d: %v", b["parent_pid"], os.Getppid(), b)
		}
	}
}

// #13719: a pool is defined with --pool a,b (no --slots), a claim on it says which machine it was granted, and the list names the members and each holder's machine.
func TestResourceDefineAPoolSendsItsMembersAndNeedsNoSlots(t *testing.T) {
	s := &resStub{}
	out, exited := runResource(t, s, "define", "heavy", "--pool", "mac-heavy,mini")
	if exited || !strings.Contains(out, "Defined heavy") || !strings.Contains(out, "mac-heavy, mini") {
		t.Fatalf("exited=%v out=%q", exited, out)
	}
	got, _ := s.bodies[0]["members"].([]any)
	if len(got) != 2 || got[0] != "mac-heavy" || got[1] != "mini" {
		t.Fatalf("members sent: %v", s.bodies[0])
	}
	if _, has := s.bodies[0]["slots"]; has && s.bodies[0]["slots"] != float64(0) {
		t.Fatalf("a pool has no slots of its own: %v", s.bodies[0])
	}
	_, exited = runResource(t, &resStub{}, "define", "heavy", "--pool", "mini", "--slots", "2")
	if !exited {
		t.Fatal("a pool with slots must be refused")
	}
}

func TestAPoolClaimAndListSayWhichMachine(t *testing.T) {
	s := &resStub{status: 200, respText: `{"granted":true,"place":0,"entry":{"id":4,"member":"mini","machine":"Mac mini"}}`}
	out, exited := runResource(t, s, "claim", "heavy")
	if exited || !strings.Contains(out, "on Mac mini") || !strings.Contains(out, "mini") {
		t.Fatalf("exited=%v out=%q", exited, out)
	}
	list := captureStdout(t, func() {
		printResource(resView{Name: "heavy", Slots: 2, Members: []string{"mac-heavy", "mini"}, Holders: []resEntry{{ID: 4, Agent: "Dev A", Member: "mini", Machine: "Mac mini"}}}, "Me")
	})
	for _, want := range []string{"pool of mac-heavy, mini", "Dev A", "on Mac mini"} {
		if !strings.Contains(list, want) {
			t.Fatalf("the list lacks %q: %q", want, list)
		}
	}
}

// #14079: the list says a holder with nothing running is idle, and says nothing of one that works.
func TestTheListShowsAnIdleHolder(t *testing.T) {
	three, none := 3, (*int)(nil)
	out := captureStdout(t, func() {
		printResource(resView{Name: "mac-heavy", Slots: 2, Holders: []resEntry{{ID: 1, Agent: "Idle Dev", IdleMin: &three}, {ID: 2, Agent: "Busy Dev", IdleMin: none}}}, "Me")
	})
	if !strings.Contains(out, "Idle Dev [idle for 3 min") || strings.Contains(strings.Split(out, "Busy Dev")[1], "idle") {
		t.Fatalf("the list: %q", out)
	}
}

const howJSON = `{"name":"epoch-go","slots":2,"machine":"epoch","description":"Linux box: Go tests only, no node or Chrome.\nReach it: ssh epoch\nRule: nothing during a tag run.\nFourth line.","stats":{"state":"ok","load_per_core":0.5,"cpu_count":8,"mem_available_mb":24000,"disk_free_gb":50}}`

// #17560: a claim tells the agent what the machine is for and how it is doing, in a few lines, before it runs; resource info says all of it.
func TestAClaimPrintsTheResourcesHowToAndInfoPrintsAllOfIt(t *testing.T) {
	s := &resStub{grantAt: 1, how: howJSON}
	out, exited := runResource(t, s, "claim", "epoch-go")
	if exited || !strings.Contains(out, "You hold a slot of epoch-go") || !strings.Contains(out, "Go tests only, no node or Chrome.") || !strings.Contains(out, "ssh epoch") {
		t.Fatalf("exited=%v out=%q", exited, out)
	}
	if strings.Contains(out, "Fourth line.") || !strings.Contains(out, "more: coral-board resource info epoch-go") {
		t.Fatalf("a claim says three lines and where the rest is: %q", out)
	}
	if !strings.Contains(out, "machine now: up; load 0.50 per core on 8 cores; 24000 MB memory free; 50 GB disk free") {
		t.Fatalf("the stats line: %q", out)
	}
	info, exited := runResource(t, &resStub{how: howJSON}, "info", "epoch-go")
	if exited || !strings.Contains(info, "Fourth line.") || !strings.Contains(info, "epoch-go on epoch: 2 slot(s)") || !strings.Contains(info, "machine now: up") {
		t.Fatalf("info: exited=%v out=%q", exited, info)
	}
	none, _ := runResource(t, &resStub{how: `{"name":"old","slots":1}`}, "info", "old")
	if !strings.Contains(none, "no description yet") {
		t.Fatalf("a resource defined before descriptions says so: %q", none)
	}
}

func TestResourceDefineSendsTheDescription(t *testing.T) {
	s := &resStub{}
	if out, exited := runResource(t, s, "define", "epoch-go", "--slots", "2", "--description", "Linux, Go only. ssh epoch"); exited {
		t.Fatalf("out=%q", out)
	}
	if s.bodies[0]["description"] != "Linux, Go only. ssh epoch" {
		t.Fatalf("body %v", s.bodies[0])
	}
}

// #18488: a claim made with --run follows the run, not the shell that launched it: the command runs after the grant, the slot is renewed while it runs and is given back when it ends, with the command's own exit code.
func TestAClaimWithRunKeepsTheSlotWhileTheCommandRunsAndGivesItBackAtItsEnd(t *testing.T) {
	prev := heavyRenewFloor
	heavyRenewFloor = 20 * time.Millisecond
	defer func() { heavyRenewFloor = prev }()
	s := &resStub{grantAt: 1, lease: time.Now().Add(150 * time.Millisecond).UTC().Format(time.RFC3339Nano)}
	out, exited := runResource(t, s, "claim", "mac-heavy", "--wait", "--run", "--", "sleep 0.3; echo ran-under-claim")
	if exited {
		t.Fatal("exited: the command succeeded")
	}
	if !strings.Contains(out, "ran-under-claim") {
		t.Fatalf("the command did not run: %q", out)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	renews, releaseAt, claimAt := 0, -1, -1
	for i, r := range s.reqs {
		switch {
		case strings.HasSuffix(r, "/claim") && claimAt < 0:
			claimAt = i
		case strings.HasSuffix(r, "/renew"):
			renews++
			if releaseAt >= 0 {
				t.Fatalf("renewed after the release: %v", s.reqs)
			}
		case strings.HasSuffix(r, "/release"):
			releaseAt = i
		}
	}
	if renews == 0 {
		t.Fatalf("the slot was not renewed while the command ran: %v", s.reqs)
	}
	if releaseAt < 0 || releaseAt != len(s.reqs)-1 {
		t.Fatalf("the slot is given back last, once the command has ended: %v", s.reqs)
	}
	if !strings.Contains(out, "given back (exit 0)") {
		t.Fatalf("it says it gave the slot back: %q", out)
	}
}

func TestAClaimWithRunSaysTheCommandsExitCodeAndStillGivesTheSlotBack(t *testing.T) {
	s := &resStub{grantAt: 1}
	out, exited := runResource(t, s, "claim", "mac-heavy", "--run", "--", "exit 7")
	if !exited {
		t.Fatalf("a failing command must exit non-zero: %q", out)
	}
	if !strings.Contains(out, "given back (exit 7)") {
		t.Fatalf("%q", out)
	}
	last := s.reqs[len(s.reqs)-1]
	if !strings.HasSuffix(last, "/release") {
		t.Fatalf("the slot was not given back: %v", s.reqs)
	}
}

// #19309: closing the terminal that launched a --run claim sends SIGHUP; the run stops its command and gives the slot back, like Ctrl-C or kill does, instead of dying with the command running on and the slot held until its lease ran out.
func TestAClaimWithRunStopsTheCommandAndGivesTheSlotBackOnSIGHUP(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no SIGHUP on Windows")
	}
	s := &resStub{grantAt: 1}
	go func() {
		time.Sleep(300 * time.Millisecond)
		p, _ := os.FindProcess(os.Getpid())
		_ = p.Signal(syscall.SIGHUP)
	}()
	start := time.Now()
	out, _ := runResource(t, s, "claim", "mac-heavy", "--run", "--", "sleep 30")
	if time.Since(start) > 10*time.Second {
		t.Fatalf("the command was not stopped by SIGHUP: %q", out)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.reqs) == 0 || !strings.HasSuffix(s.reqs[len(s.reqs)-1], "/release") {
		t.Fatalf("the slot was not given back after SIGHUP: %v", s.reqs)
	}
}

func TestAClaimWithRunAndNoCommandIsRefusedBeforeAnythingIsClaimed(t *testing.T) {
	s := &resStub{grantAt: 1}
	_, exited := runResource(t, s, "claim", "mac-heavy", "--run")
	if !exited {
		t.Fatal("it must refuse")
	}
	for _, r := range s.reqs {
		if strings.HasSuffix(r, "/claim") {
			t.Fatalf("a claim was made with nothing to run: %v", s.reqs)
		}
	}
}

// #20345: a claim --wait whose place was released or removed while it waited stops, says so and runs nothing; it does not queue again and run later.
func TestResourceClaimWaitStopsWhenItsPlaceWasCancelled(t *testing.T) {
	prev := resourcePoll
	resourcePoll = 5 * time.Millisecond
	defer func() { resourcePoll = prev }()
	s := &resStub{grantAt: 9999, goneAt: 3}
	out, exited := runResource(t, s, "claim", "mac-heavy", "--wait", "--run", "--", "echo", "should-not-run")
	if !exited {
		t.Fatal("did not exit")
	}
	if strings.Contains(out, "Your turn") || strings.Contains(out, "should-not-run") {
		t.Fatalf("a cancelled wait must not run: %q", out)
	}
	if s.claims != 3 {
		t.Fatalf("claims after the cancel: %d (want 3: the first, one look, the cancelled one)", s.claims)
	}
	var claimBodies []map[string]any
	for i, r := range s.reqs {
		if r == "POST /api/resources/mac-heavy/claim" {
			claimBodies = append(claimBodies, s.bodies[i])
		}
	}
	if len(claimBodies) != 3 {
		t.Fatalf("claim requests: %v", s.reqs)
	}
	if _, first := claimBodies[0]["poll_entry"]; first {
		t.Fatalf("the first claim names no place: %v", claimBodies[0])
	}
	if id, _ := claimBodies[1]["poll_entry"].(float64); id != 1 {
		t.Fatalf("a look names the place the first claim queued, body: %v", claimBodies[1])
	}
}

// #20345: releasing a place that was only queued says so.
func TestResourceReleaseOfAQueuedPlaceSaysItWasCancelled(t *testing.T) {
	s := &resStub{status: 200, respText: `{"ok":true,"left_line":true}`}
	out, exited := runResource(t, s, "release", "mac-heavy")
	if exited || !strings.Contains(out, "Left the line for mac-heavy") || !strings.Contains(out, "stops without running") {
		t.Fatalf("exited=%v out=%q", exited, out)
	}
	s = &resStub{status: 200, respText: `{"ok":true,"left_line":false}`}
	out, exited = runResource(t, s, "release", "mac-heavy")
	if exited || !strings.Contains(out, "Released mac-heavy.") {
		t.Fatalf("a held slot is released as before: exited=%v out=%q", exited, out)
	}
}
