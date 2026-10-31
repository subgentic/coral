package sshprov

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const testKey = "test-api-key-0123456789abcdef"

// startSide is a far computer (the stand-in ssh, see farside_test.go) with its tmux and coral recorded in files: coral's arguments, the tmux session, and an API key that appears 0.3 s after coral
// starts.
func startSide(t *testing.T) (r Runner, home, argsLog, tmuxLog string) {
	t.Helper()
	dir := t.TempDir()
	home = filepath.Join(dir, "home")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	argsLog, tmuxLog = filepath.Join(dir, "coral.args"), filepath.Join(dir, "tmux.log")
	ssh := newStandIn(t, "ssh", standCfg{Far: &farCfg{Home: home, TmuxLog: tmuxLog, ArgsLog: argsLog, Key: testKey}})
	return Runner{SSH: ssh}, home, argsLog, tmuxLog
}

func TestStartTmuxStartsCoralOnLoopbackOnlyAndOnlyOnce(t *testing.T) {
	r, home, argsLog, tmuxLog := startSide(t)
	tg, _ := ParseTarget("user@box.example.com")
	ctx := context.Background()
	if err := r.StartTmux(ctx, tg, "2.0.10"); err != nil {
		t.Fatal(err)
	}
	if err := r.StartTmux(ctx, tg, "2.0.10"); err != nil { // a re-run
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	var args string
	for time.Now().Before(deadline) {
		if b, err := os.ReadFile(argsLog); err == nil && len(b) > 0 {
			args = string(b)
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if args == "" {
		t.Fatal("coral was not started")
	}
	if strings.Count(args, "\n") != 1 {
		t.Errorf("coral was started more than once:\n%s", args)
	}
	for _, want := range []string{"--host 127.0.0.1", "--port 8420", "--no-browser", "--cloud-url off", "--backend tmux", "--home " + filepath.Join(home, ".coral-server", "data")} {
		if !strings.Contains(args, want) {
			t.Errorf("coral args lack %q: %s", want, args)
		}
	}
	for _, bad := range []string{"0.0.0.0", "--remote", "--cloud-connect", "--cloud-url http"} {
		if strings.Contains(args, bad) {
			t.Errorf("coral was started with %q: %s", bad, args)
		}
	}
	if b, _ := os.ReadFile(tmuxLog); strings.Count(string(b), "new-session") != 1 || !strings.Contains(string(b), "coral-server") {
		t.Errorf("tmux log:\n%s", b)
	}
	if st, err := os.Stat(filepath.Join(home, ".coral-server", "data")); err != nil || permsApply() && st.Mode().Perm()&0o077 != 0 {
		t.Errorf("the data folder: %v %v", st, err)
	}
}

func TestEnsureInstanceIDIsMadeOnceAndIs32Hex(t *testing.T) {
	r, home, _, _ := startSide(t)
	tg, _ := ParseTarget("user@box.example.com")
	a, err := r.EnsureInstanceID(context.Background(), tg)
	if err != nil {
		t.Fatal(err)
	}
	if !instanceIDRe.MatchString(a) {
		t.Fatalf("id = %q", a)
	}
	b, err := r.EnsureInstanceID(context.Background(), tg)
	if err != nil || b != a {
		t.Errorf("a re-run gave %q, %v; the first was %q", b, err, a)
	}
	if st, err := os.Stat(filepath.Join(home, ".coral-server", "instance-id")); err != nil || permsApply() && st.Mode().Perm() != 0o600 {
		t.Errorf("instance-id file: %v %v", st, err)
	}
	// a file with anything else in it is not an id
	if err := os.WriteFile(filepath.Join(home, ".coral-server", "instance-id"), []byte("not hex; rm -rf ~\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if id, err := r.EnsureInstanceID(context.Background(), tg); err == nil {
		t.Errorf("accepted %q", id)
	}
}

func TestReadAPIKeyWaitsForACoralThatIsStartingAndNeverLogsIt(t *testing.T) {
	r, _, _, _ := startSide(t)
	oldPoll := keyPoll
	keyPoll = 100 * time.Millisecond
	defer func() { keyPoll = oldPoll }()
	tg, _ := ParseTarget("user@box.example.com")
	ctx := context.Background()
	if err := r.StartTmux(ctx, tg, "2.0.10"); err != nil {
		t.Fatal(err)
	}
	key, err := r.ReadAPIKey(ctx, tg, "2.0.10") // the fake coral makes it 0.3 s after it starts
	if err != nil || key != testKey {
		t.Fatalf("key = %q, %v", key, err)
	}
}

func TestReadAPIKeyGivesUpAndSaysNothingOfTheKey(t *testing.T) {
	r, _, _, _ := startSide(t)
	oldPoll, oldWait := keyPoll, keyWait
	keyPoll, keyWait = 50*time.Millisecond, 400*time.Millisecond
	defer func() { keyPoll, keyWait = oldPoll, oldWait }()
	tg, _ := ParseTarget("user@box.example.com")
	_, err := r.ReadAPIKey(context.Background(), tg, "2.0.10") // never started: no key
	if err == nil || strings.Contains(err.Error(), testKey) {
		t.Fatalf("err = %v", err)
	}
	if _, err := r.ReadAPIKey(context.Background(), tg, "../x"); !errors.Is(err, ErrNotAllowed) {
		t.Errorf("a version that is a path: %v", err)
	}
}

func TestReadAPIKeyRefusesAnythingThatIsNotAKey(t *testing.T) {
	r, home, _, _ := startSide(t)
	oldPoll, oldWait := keyPoll, keyWait
	keyPoll, keyWait = 50*time.Millisecond, 300*time.Millisecond
	defer func() { keyPoll, keyWait = oldPoll, oldWait }()
	data := filepath.Join(home, ".coral-server", "data")
	if err := os.MkdirAll(data, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"short", "has space in the key 0123456789", "quote'inside-0123456789abcd", "semi;colon-0123456789abcdef"} {
		if err := os.WriteFile(filepath.Join(data, "api_key"), []byte(bad+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		tg, _ := ParseTarget("user@box.example.com")
		if key, err := r.ReadAPIKey(context.Background(), tg, "2.0.10"); err == nil {
			t.Errorf("accepted %q", key)
		}
	}
}

func TestStoredRoundTripsThroughTheParsers(t *testing.T) {
	for _, in := range []string{"user@box.example.com:22", "user@box.example.com:2222", "u@10.0.0.7:22", "u@[2001:db8::1]:2200"} {
		tg, err := ParseTarget(in)
		if err != nil {
			t.Fatalf("%s: %v", in, err)
		}
		if got := tg.Stored(); got != in {
			t.Errorf("Stored(%s) = %s", in, got)
		}
		if back, err := ParseTarget(tg.Stored()); err != nil || back != tg {
			t.Errorf("round trip of %s: %+v %v", in, back, err)
		}
	}
	a, _ := FromAlias("build-box")
	if a.Stored() != "build-box" {
		t.Errorf("alias = %s", a.Stored())
	}
}

func TestAcceptTermsGoesOnStdinNeverInArgv(t *testing.T) {
	r, _, argsLog, _ := startSide(t)
	tg, _ := ParseTarget("user@box.example.com")
	payload := []byte(`{"version":"2026-03-26","sha256":"` + strings.Repeat("ab", 32) + `","by":"hub-owner@build-host"}`)
	if err := r.AcceptTerms(context.Background(), tg, "2.0.10", payload); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(argsLog + ".stdin")
	if err != nil || string(got) != string(payload) {
		t.Fatalf("stdin = %q, %v", got, err)
	}
	args, _ := os.ReadFile(argsLog + ".accept")
	if strings.TrimSpace(string(args)) != "accept-terms" {
		t.Errorf("coral got arguments: %q", args)
	}
	text, err := remoteText(CmdAcceptTerms, "2.0.10")
	if err != nil || strings.Contains(text, "ab") && strings.Contains(text, "hub-owner") {
		t.Errorf("the remote text carries the payload: %q %v", text, err)
	}
	if _, err := r.RunInput(context.Background(), tg, strings.NewReader("x"), CmdAcceptTerms, "../x"); !errors.Is(err, ErrNotAllowed) {
		t.Errorf("a version that is a path: %v", err)
	}
}

func TestTmuxNamesAreExactSoAnotherUsersSessionIsNeverTouched(t *testing.T) {
	for _, c := range []Command{CmdStartTmux, CmdStopTmux, CmdCheckStopped} {
		text, err := remoteText(c, "2.0.10")
		if c != CmdStartTmux {
			text, err = remoteText(c)
		}
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(text, "-t coral-server") {
			t.Errorf("%d matches a session by a prefix: %s", c, text)
		}
		if !strings.Contains(text, "-t =coral-server") {
			t.Errorf("%d does not name the session exactly: %s", c, text)
		}
	}
}

func TestStopAndConfirmReturnsOnlyOnAConfirmedStop(t *testing.T) {
	oldW, oldP := stopWait, stopPoll
	stopWait, stopPoll = 300*time.Millisecond, 50*time.Millisecond
	defer func() { stopWait, stopPoll = oldW, oldP }()
	tg, _ := ParseTarget("user@box.example.com")
	ctx := context.Background()

	r, _, _, tmuxLog := startSide(t)
	if err := r.StartTmux(ctx, tg, "2.0.10"); err != nil {
		t.Fatal(err)
	}
	if err := r.StopAndConfirm(ctx, tg); err != nil {
		t.Fatalf("a normal stop: %v", err)
	}
	if b, _ := os.ReadFile(tmuxLog); !strings.Contains(string(b), "kill-session -t =coral-server") {
		t.Errorf("tmux log:\n%s", b)
	}
	if err := r.StopAndConfirm(ctx, tg); err != nil { // nothing running: still confirmed
		t.Errorf("a stop with no session: %v", err)
	}

	r, home, _, _ := startSide(t)
	dir := filepath.Dir(home)
	if err := r.StartTmux(ctx, tg, "2.0.10"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "stuck"), nil, 0o600); err != nil { // the session will not die
		t.Fatal(err)
	}
	if err := r.StopAndConfirm(ctx, tg); !errors.Is(err, ErrNotStopped) {
		t.Errorf("a session that stays: %v", err)
	}

	r, home, _, _ = startSide(t)
	dir = filepath.Dir(home)
	if err := os.WriteFile(filepath.Join(dir, "listening"), nil, 0o600); err != nil { // something listens on 8420
		t.Fatal(err)
	}
	if err := r.StopAndConfirm(ctx, tg); !errors.Is(err, ErrNotStopped) {
		t.Errorf("a listener on 8420: %v", err)
	}

	r, home, _, _ = startSide(t)
	dir = filepath.Dir(home)
	if err := os.WriteFile(filepath.Join(dir, "noproc"), nil, 0o600); err != nil { // cannot tell
		t.Fatal(err)
	}
	stopWait = 5 * time.Second // a check that cannot tell does not wait this out
	start := time.Now()
	if err := r.StopAndConfirm(ctx, tg); !errors.Is(err, ErrNotStopped) || time.Since(start) > 3*time.Second {
		t.Errorf("a check that cannot tell must refuse at once: %v after %v", err, time.Since(start))
	}
}

func TestInstallOwnerSecretGoesOnStdinNeverInArgv(t *testing.T) {
	r, home, argsLog, _ := startSide(t)
	tg, _ := ParseTarget("rich@box.example.com")
	secret := strings.Repeat("ab", 32)
	if err := r.InstallOwnerSecret(context.Background(), tg, "2.0.10", "ssh-box", secret); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(argsLog + ".owner.stdin")
	if err != nil || string(got) != `{"remote":"ssh-box","secret":"`+secret+`"}` {
		t.Fatalf("stdin = %q, %v", got, err)
	}
	args, _ := os.ReadFile(argsLog + ".owner")
	if strings.TrimSpace(string(args)) != "hub-owner-secret --home "+filepath.Join(home, ".coral-server", "data") {
		t.Errorf("coral got arguments: %q", args)
	}
	text, err := remoteText(CmdInstallOwnerSecret, "2.0.10")
	if err != nil || strings.Contains(text, secret) || strings.Contains(text, "ssh-box") {
		t.Errorf("the remote text carries the payload: %q %v", text, err)
	}
	if _, err := r.RunInput(context.Background(), tg, strings.NewReader("x"), CmdInstallOwnerSecret, "../x"); !errors.Is(err, ErrNotAllowed) {
		t.Errorf("a version that is a path: %v", err)
	}
}
