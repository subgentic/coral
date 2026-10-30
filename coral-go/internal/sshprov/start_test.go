package sshprov

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

const testKey = "test-api-key-0123456789abcdef"

// startSide is a far computer with a fake tmux (it records the session and runs the command in the background) and a fake coral (it records its arguments, makes its API key a moment after it
// starts, and prints it for `api-key`), all inside a temp HOME.
func startSide(t *testing.T) (r Runner, home, argsLog, tmuxLog string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell scripts")
	}
	dir := t.TempDir()
	home = filepath.Join(dir, "home")
	bin := filepath.Join(dir, "bin")
	root := filepath.Join(home, ".coral-server", "2.0.10", "root")
	for _, d := range []string{bin, root} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	argsLog, tmuxLog = filepath.Join(dir, "coral.args"), filepath.Join(dir, "tmux.log")
	coral := `#!/bin/sh
if [ "$1" = "api-key" ]; then
  home=""; while [ $# -gt 0 ]; do [ "$1" = "--home" ] && home="$2"; shift; done
  [ -s "$home/api_key" ] || exit 1
  cat "$home/api_key"; exit 0
fi
echo "$@" >> '` + argsLog + `'
home=""; while [ $# -gt 0 ]; do [ "$1" = "--home" ] && home="$2"; shift; done
sleep 0.3; mkdir -p "$home"; printf '%s\n' '` + testKey + `' > "$home/api_key"
sleep 20
`
	if err := os.WriteFile(filepath.Join(root, "coral"), []byte(coral), 0o755); err != nil {
		t.Fatal(err)
	}
	tmux := `#!/bin/sh
echo "$@" >> '` + tmuxLog + `'
case "$1" in
  has-session) [ -e '` + filepath.Join(dir, "session") + `' ] && exit 0; exit 1;;
  new-session) touch '` + filepath.Join(dir, "session") + `'
    while [ $# -gt 0 ]; do cmd="$1"; shift; done
    nohup sh -c "$cmd" >/dev/null 2>&1 &
    exit 0;;
esac
`
	if err := os.WriteFile(filepath.Join(bin, "tmux"), []byte(tmux), 0o755); err != nil {
		t.Fatal(err)
	}
	ssh := filepath.Join(dir, "ssh")
	script := "#!/bin/sh\nfor a in \"$@\"; do last=\"$a\"; done\nHOME='" + home + "'; export HOME\nPATH='" + bin + ":'\"$PATH\"; export PATH\neval \"$last\"\n"
	if err := os.WriteFile(ssh, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	return Runner{SSH: ssh}, home, argsLog, tmuxLog
}

func TestStartTmuxStartsCoralOnLoopbackOnlyAndOnlyOnce(t *testing.T) {
	r, home, argsLog, tmuxLog := startSide(t)
	tg, _ := ParseTarget("rich@box.example.com")
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
	for _, want := range []string{"--host 127.0.0.1", "--port 8420", "--no-browser", "--backend tmux", "--home " + filepath.Join(home, ".coral-server", "data")} {
		if !strings.Contains(args, want) {
			t.Errorf("coral args lack %q: %s", want, args)
		}
	}
	for _, bad := range []string{"0.0.0.0", "--remote", "--cloud"} {
		if strings.Contains(args, bad) {
			t.Errorf("coral was started with %q: %s", bad, args)
		}
	}
	if b, _ := os.ReadFile(tmuxLog); strings.Count(string(b), "new-session") != 1 || !strings.Contains(string(b), "coral-server") {
		t.Errorf("tmux log:\n%s", b)
	}
	if st, err := os.Stat(filepath.Join(home, ".coral-server", "data")); err != nil || st.Mode().Perm()&0o077 != 0 {
		t.Errorf("the data folder: %v %v", st, err)
	}
}

func TestEnsureInstanceIDIsMadeOnceAndIs32Hex(t *testing.T) {
	r, home, _, _ := startSide(t)
	tg, _ := ParseTarget("rich@box.example.com")
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
	if st, err := os.Stat(filepath.Join(home, ".coral-server", "instance-id")); err != nil || st.Mode().Perm() != 0o600 {
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
	tg, _ := ParseTarget("rich@box.example.com")
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
	tg, _ := ParseTarget("rich@box.example.com")
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
		tg, _ := ParseTarget("rich@box.example.com")
		if key, err := r.ReadAPIKey(context.Background(), tg, "2.0.10"); err == nil {
			t.Errorf("accepted %q", key)
		}
	}
}

func TestStoredRoundTripsThroughTheParsers(t *testing.T) {
	for _, in := range []string{"rich@box.example.com:22", "rich@box.example.com:2222", "u@10.0.0.7:22", "u@[2001:db8::1]:2200"} {
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
