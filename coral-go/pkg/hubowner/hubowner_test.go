package hubowner

import (
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

var (
	t0     = time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)
	secret = strings.Repeat("ab", 32)
)

func verifier(now time.Time) *Verifier {
	return &Verifier{Secret: secret, RemoteID: "ssh-box", Start: t0.Add(-time.Hour), Now: func() time.Time { return now }}
}

const (
	method = "POST"
	path   = "/api/board/team/artifacts/" + "abc123" + "/review"
)

func sign(t *testing.T, body string, at time.Time) string {
	t.Helper()
	v, err := Sign(secret, "ssh-box", method, path, []byte(body), at)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func TestAStampMadeForARequestVerifiesOnceForThatRequest(t *testing.T) {
	body := `{"decision":"approve"}`
	stamp := sign(t, body, t0)
	v := verifier(t0.Add(2 * time.Second))
	if err := v.Verify(stamp, method, path, path, []byte(body)); err != nil {
		t.Fatalf("a good stamp: %v", err)
	}
	if err := v.Verify(stamp, method, path, path, []byte(body)); err != ErrReplay {
		t.Errorf("the same stamp twice: %v", err)
	}
}

func TestAStampIsBoundToEverythingItCovers(t *testing.T) {
	body := `{"decision":"approve"}`
	stamp := sign(t, body, t0)
	now := t0.Add(time.Second)
	for name, c := range map[string]struct {
		mutate                     func(v *Verifier)
		method, path, target, body string
		want                       error
	}{
		"another body":      {nil, method, path, path, `{"decision":"changes"}`, ErrBad},
		"another target":    {nil, method, path, path + "?x=1", body, ErrBad},
		"another method":    {nil, "PATCH", path, path, body, ErrRoute},
		"another route":     {nil, method, "/api/hub-auto-accept", "/api/hub-auto-accept", body, ErrRoute},
		"another remote id": {func(v *Verifier) { v.RemoteID = "other-box" }, method, path, path, body, ErrBad},
		"another secret":    {func(v *Verifier) { v.Secret = strings.Repeat("cd", 32) }, method, path, path, body, ErrBad},
		"no secret":         {func(v *Verifier) { v.Secret = "" }, method, path, path, body, ErrNoSecret},
		"a body too large":  {nil, method, path, path, strings.Repeat("x", MaxBody+1), ErrBody},
	} {
		v := verifier(now)
		if c.mutate != nil {
			c.mutate(v)
		}
		if err := v.Verify(stamp, c.method, c.path, c.target, []byte(c.body)); err != c.want {
			t.Errorf("%s: %v, want %v", name, err, c.want)
		}
	}
}

func TestAStampIsRefusedWhenOldNewOrFromBeforeTheProcessStarted(t *testing.T) {
	body := "{}"
	stamp := sign(t, body, t0)
	for name, c := range map[string]struct {
		now   time.Time
		start time.Time
		want  error
	}{
		"31 s later":                {t0.Add(31 * time.Second), t0.Add(-time.Hour), ErrStale},
		"31 s early (a future one)": {t0.Add(-31 * time.Second), t0.Add(-time.Hour), ErrStale},
		"29 s later":                {t0.Add(29 * time.Second), t0.Add(-time.Hour), nil},
		"made before the start":     {t0.Add(5 * time.Second), t0.Add(2 * time.Second), ErrStale},
		"made in the start second":  {t0.Add(time.Second), t0, nil},
	} {
		v := verifier(c.now)
		v.Start = c.start
		if err := v.Verify(stamp, method, path, path, []byte(body)); err != c.want {
			t.Errorf("%s: %v, want %v", name, err, c.want)
		}
	}
}

func TestMalformedStampsAreRefused(t *testing.T) {
	good := sign(t, "{}", t0)
	parts := strings.Split(good, ".")
	for name, s := range map[string]string{
		"empty":             "",
		"no version":        strings.Join(parts[1:], "."),
		"v2":                "v2." + strings.Join(parts[1:], "."),
		"three parts":       strings.Join(parts[:3], "."),
		"five parts":        good + ".x",
		"time not a number": "v1.abc." + parts[2] + "." + parts[3],
		"time with plus":    "v1.+" + parts[1] + "." + parts[2] + "." + parts[3],
		"short nonce":       "v1." + parts[1] + ".abcd." + parts[3],
		"upper nonce":       "v1." + parts[1] + "." + strings.ToUpper(parts[2]) + "." + parts[3],
		"short mac":         "v1." + parts[1] + "." + parts[2] + "." + parts[3][:10],
		"non-hex mac":       "v1." + parts[1] + "." + parts[2] + "." + strings.Repeat("z", 64),
	} {
		if err := verifier(t0.Add(time.Second)).Verify(s, method, path, path, []byte("{}")); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestAForgedStampFillsNothingAndAFailedOneIsNotRemembered(t *testing.T) {
	v := verifier(t0.Add(time.Second))
	forged := "v1." + "1793361601" + "." + strings.Repeat("0", 32) + "." + strings.Repeat("0", 64)
	for i := 0; i < 10000; i++ {
		_ = v.Verify(forged, method, path, path, []byte("{}"))
	}
	if len(v.seen) != 0 {
		t.Errorf("forged stamps were remembered: %d", len(v.seen))
	}
	good := sign(t, "{}", t0)
	if err := v.Verify(good, method, path, path, []byte("{}")); err != nil {
		t.Errorf("a good stamp after forgeries: %v", err)
	}
}

func TestSignRefusesWhatItCannotSign(t *testing.T) {
	for name, c := range map[string]struct{ secret, id, body string }{
		"no secret": {"", "ssh-box", "{}"},
		"short":     {"abcd", "ssh-box", "{}"},
		"upper hex": {strings.ToUpper(secret), "ssh-box", "{}"},
		"bad id":    {secret, "Ssh Box", "{}"},
		"empty id":  {secret, "", "{}"},
		"big body":  {secret, "ssh-box", strings.Repeat("x", MaxBody+1)},
	} {
		if _, err := Sign(c.secret, c.id, method, path, []byte(c.body), t0); err == nil {
			t.Errorf("%s: signed", name)
		}
	}
}

func TestAllowedIsTheListedDecisionsAndNothingElse(t *testing.T) {
	for _, ok := range []struct{ m, p string }{
		{"POST", "/api/board/team/artifacts/abc/review"},
		{"POST", "/api/artifacts/abc/comments/c1/send"},
		{"POST", "/api/sessions/live/claude-abc/send"}, // #13456: the owner's own message to an agent
		{"POST", "/api/board/team/asks/42/close"},
		{"POST", "/api/board/team/goals/7/driver"}, // #13517: the owner's change of a goal's driver and its move to another team
		{"POST", "/api/board/team/goals/7/move"},
		{"POST", "/api/artifacts/abc/opened"}, // #13910: generation 6
	} {
		if !Allowed(ok.m, ok.p) {
			t.Errorf("%v not allowed", ok)
		}
	}
	for _, bad := range []struct{ m, p string }{
		{"GET", "/api/board/team/artifacts/abc/review"},
		{"POST", "/api/board/team/artifacts/abc/review/extra"},
		{"POST", "/api/board/team/artifacts//review"},
		{"POST", "/api/board//artifacts/abc/review"},
		{"POST", "/api/artifacts/abc/comments/c1/resolve"},
		{"POST", "/api/artifacts/abc/opened/x"},
		{"POST", "/api/artifacts//opened"},
		{"POST", "/api/artifacts/abc/comments/c1/send/x"},
		{"POST", "/api/sessions/live//send"},
		{"POST", "/api/sessions/live/x/send/more"},
		{"GET", "/api/sessions/live/x/send"},
		{"POST", "/api/sessions/live/x/keys"},
		{"GET", "/api/board/team/asks/42/close"},
		{"POST", "/api/board/team/asks/42/close/extra"},
		{"POST", "/api/board/team/asks//close"},
		{"POST", "/api/board//asks/42/close"},
		{"GET", "/api/board/team/goals/7/driver"}, // #13517: only the two writes, on one goal of one board
		{"PUT", "/api/board/team/goals/7/move"},
		{"POST", "/api/board/team/goals/7/driver/extra"},
		{"POST", "/api/board/team/goals//driver"},
		{"POST", "/api/board//goals/7/move"},
		{"POST", "/api/board/team/goals/7/drive"},
		{"POST", ""},
		{"POST", "/"},
	} {
		if Allowed(bad.m, bad.p) {
			t.Errorf("%v allowed", bad)
		}
	}
	if n := len(Routes()); n != 89 { // 89 since generation 13 (#15720, the delete of ended agents' terminal logs); 88 since generation 12 (#15717, a team's daily-knowledge writes); 84 since generation 11 (#15715, the team import from a folder); 83 since generation 10 (#15713, the private mark of an artifact); 82 since generation 9 (#15708, the person-only reads of audit group 4); 66 since generation 8 (#15697, pause and resume of an agent's notices); 64 since generation 7 (#15380, the Hub's read of a computer's Needs you); 63 before it (#14730, the owner turns scripts on and off for one version of an HTML file); 61 since generation 6 (#13910, the opened version of a file); 60 since generation 5 (#13834, the done-state of a goal)
		t.Errorf("the allowlist has %d routes: a new one needs a reason and a review (Security's tiers, #13694)", n)
	}
	first := 0
	for _, r := range routes {
		if r.since == 1 {
			first++
		}
	}
	for gen, want := range map[int]int{3: 2, 4: 1, 5: 1, 10: 1, 11: 1, 12: 4, 13: 1} { // a released generation never gains a route (Security, #13834)
		n := 0
		for _, r := range routes {
			if r.since == gen {
				n++
			}
		}
		if n != want {
			t.Errorf("generation %d has %d routes, it is released with %d and never gains one", gen, n, want)
		}
	}
	if first != 8 {
		t.Errorf("generation 1 has %d routes, it is the original 8 and never changes", first)
	}
}

// #13694: a hub stamps a route only when the remote's generation covers it; an older remote keeps getting the original eight and nothing else.
func TestARouteIsStampedOnlyForARemoteThatListsIt(t *testing.T) {
	for _, c := range []struct {
		m, p    string
		v       int
		allowed bool
		must    bool
	}{
		{"POST", "/api/board/t/artifacts/a/review", 1, true, false},
		{"POST", "/api/board/t/tasks/7/complete", 1, false, true},
		{"POST", "/api/board/t/tasks/7/complete", 2, true, true},
		{"POST", "/api/board/t/tasks/7/complete", 0, false, true},
		{"DELETE", "/api/artifacts/abc", 1, false, true},
		{"DELETE", "/api/artifacts/abc", 2, true, true},
		{"POST", "/api/board/t/artifacts/abc/edit", 2, false, true}, // the editor's save (#13757) is generation 3: an older remote gets it unstamped
		{"POST", "/api/board/t/artifacts/abc/edit", 3, true, true},
		{"GET", "/api/board/t/artifacts/abc/edit", 3, false, false},
		{"POST", "/api/board/t/artifacts/abc/edit/send", 3, false, true}, // Send to agent with the diff (#13802) is generation 4: a generation 3 remote gets it unstamped
		{"POST", "/api/board/t/artifacts/abc/edit/send", 4, true, true},
		{"POST", "/api/board/t/goals/12/done-state", 4, false, true}, // the done-state of a goal row (#13834) is generation 5: a generation 4 remote gets it unstamped
		{"POST", "/api/board/t/goals/12/done-state", 5, true, true},
		{"POST", "/api/artifacts/abc/opened", 5, false, true}, // the opened version of a file (#13910) is generation 6: a generation 5 remote gets it unstamped
		{"POST", "/api/artifacts/abc/opened", 6, true, true},
		{"GET", "/api/needs-you", 6, false, true}, // #15380: the Hub reads a computer's Needs you as the signed-in owner (generation 7): a generation 6 remote gets it unstamped
		{"GET", "/api/needs-you", 7, true, true},
		{"POST", "/api/sessions/live/x/notices/pause", 7, false, true}, // #15697: pause and resume are generation 8: a generation 7 remote gets them unstamped
		{"POST", "/api/sessions/live/x/notices/pause", 8, true, true},
		{"POST", "/api/sessions/live/x/notices/resume", 8, true, true},
		{"GET", "/api/sessions/live/x/notices/pause", 8, false, false},
		{"GET", "/api/system/terminal-logs", 8, false, true}, // #15708: the person-only reads of audit group 4 are generation 9: a generation 8 remote gets them unstamped
		{"GET", "/api/system/terminal-logs", 9, true, true},
		{"GET", "/api/sessions/live/x/loaded-skills", 9, true, true},
		{"GET", "/api/sessions/live/x/mcp-servers", 9, true, true},
		{"GET", "/api/artifacts/abc/readers", 9, true, true},
		{"GET", "/api/threads", 9, true, true},
		{"POST", "/api/system/terminal-logs", 9, false, false},              // reads only: no write of the group is on the list yet
		{"POST", "/api/system/terminal-logs/delete-ended", 12, false, true}, // #15720: the delete of ended agents' logs is generation 13: a generation 12 remote gets it unstamped
		{"POST", "/api/system/terminal-logs/delete-ended", 13, true, true},
		{"GET", "/api/system/terminal-logs/delete-ended", 13, false, false},
		{"DELETE", "/api/system/terminal-logs", 13, false, false},
		{"PUT", "/api/artifacts/abc/private", 9, false, true}, // #15713: the private mark is generation 10: a generation 9 remote gets it unstamped
		{"PUT", "/api/artifacts/abc/private", 10, true, true},
		{"POST", "/api/artifacts/abc/private", 10, false, false},
		{"DELETE", "/api/artifacts/abc/private", 10, false, false},
		{"POST", "/api/teams/import", 10, false, true}, // #15715: the team import is generation 11: a generation 10 remote gets it unstamped
		{"POST", "/api/teams/import", 11, true, true},
		{"GET", "/api/teams/import", 11, false, false},
		{"POST", "/api/teams/generate", 11, false, false},               // the sibling that runs an agent CLI is not on the list
		{"PUT", "/api/teams/detail/t/daily-knowledge", 11, false, true}, // #15717: the daily-knowledge writes are generation 12: a generation 11 remote gets them unstamped
		{"PUT", "/api/teams/detail/t/daily-knowledge", 12, true, true},
		{"PUT", "/api/teams/detail/t/daily-knowledge/auto-apply", 12, true, true},
		{"POST", "/api/teams/detail/t/daily-knowledge/accept", 12, true, true},
		{"POST", "/api/teams/detail/t/daily-knowledge/revert", 12, true, true},
		{"GET", "/api/teams/detail/t/daily-knowledge", 12, false, false},
		{"DELETE", "/api/teams/detail/t/daily-knowledge", 12, false, false},
		{"PUT", "/api/teams/detail/t/knowledge/Lead", 12, false, false}, // one agent knowledge file is not on the list
		{"POST", "/api/needs-you", 7, false, false},                     // a read only
		{"GET", "/api/needs-you/x", 7, false, false},
		{"GET", "/api/artifacts/abc/opened", 6, false, false},
		{"POST", "/api/board/t/asks/9/buttons/b/settle", 2, true, true},
		{"POST", "/api/sessions/live/x/send", 1, true, true},
		{"POST", "/api/skills/3/approve", 2, false, false},
		{"POST", "/api/artifacts/abc/comment-images", 2, false, false},
		{"POST", "/api/board/t/goal-images", 2, false, false},
	} {
		if got := AllowedAt(c.m, c.p, c.v); got != c.allowed {
			t.Errorf("AllowedAt(%s %s, %d) = %v, want %v", c.m, c.p, c.v, got, c.allowed)
		}
		if got := MustBeSigned(c.m, c.p); got != c.must {
			t.Errorf("MustBeSigned(%s %s) = %v, want %v", c.m, c.p, got, c.must)
		}
	}
	if RoutesVersion != 13 {
		t.Errorf("RoutesVersion = %d: it moves with a widening, and the remote's health answer reports it", RoutesVersion)
	}
}

func TestTargetIsTheEscapedPathAndRawQuery(t *testing.T) {
	u, _ := url.Parse("http://x/api/a%2Fb/c?z=1&a=2")
	if got := Target(u); got != "/api/a%2Fb/c?z=1&a=2" {
		t.Errorf("Target = %q", got)
	}
	u, _ = url.Parse("http://x/api/c")
	if got := Target(u); got != "/api/c" {
		t.Errorf("Target = %q", got)
	}
}

func TestNewSecretAndValidators(t *testing.T) {
	a, err := NewSecret()
	if err != nil || !ValidSecret(a) {
		t.Fatalf("NewSecret = %q %v", a, err)
	}
	if b, _ := NewSecret(); a == b {
		t.Error("two secrets are the same")
	}
	for _, id := range []string{"a", "ssh-box-example-com", strings.Repeat("a", 32)} {
		if !ValidRemoteID(id) {
			t.Errorf("%q", id)
		}
	}
	for _, id := range []string{"", "A", "a_b", "a b", strings.Repeat("a", 33), "a\n"} {
		if ValidRemoteID(id) {
			t.Errorf("%q valid", id)
		}
	}
}

func TestTheSecretFileIsPrivateReadBackAndNeverThroughALink(t *testing.T) {
	dir := t.TempDir()
	if Installed(dir) {
		t.Fatal("installed before it was written")
	}
	if err := WriteFile(dir, "ssh-box", secret); err != nil {
		t.Fatal(err)
	}
	id, s, ok, err := ReadFile(dir)
	if err != nil || !ok || id != "ssh-box" || s != secret {
		t.Fatalf("ReadFile = %q %q %v %v", id, s, ok, err)
	}
	if !Installed(dir) {
		t.Error("not installed after it was written")
	}
	if runtime.GOOS != "windows" {
		fi, _ := os.Stat(filepath.Join(dir, FileName))
		if fi.Mode().Perm() != 0o600 {
			t.Errorf("mode %v", fi.Mode().Perm())
		}
		if err := os.Chmod(filepath.Join(dir, FileName), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, _, ok, err := ReadFile(dir); ok || err == nil {
			t.Errorf("a file readable by others was used: %v %v", ok, err)
		}
		if Installed(dir) {
			t.Error("installed with a loose mode")
		}
		_ = os.Chmod(filepath.Join(dir, FileName), 0o600)
	}
	// rotation replaces it
	other := strings.Repeat("cd", 32)
	if err := WriteFile(dir, "ssh-box", other); err != nil {
		t.Fatal(err)
	}
	if _, s, _, _ := ReadFile(dir); s != other {
		t.Error("the secret was not replaced")
	}
	// refuses invalid input and writes nothing
	d2 := t.TempDir()
	if WriteFile(d2, "Bad Id", secret) == nil || WriteFile(d2, "ssh-box", "short") == nil {
		t.Error("invalid input was written")
	}
	if _, err := os.Stat(filepath.Join(d2, FileName)); err == nil {
		t.Error("a refused write left a file")
	}
	// a link at the name is refused to read and to replace
	if runtime.GOOS != "windows" {
		d3 := t.TempDir()
		target := filepath.Join(d3, "elsewhere")
		os.WriteFile(target, []byte("ssh-box\n"+secret+"\n"), 0o600)
		if err := os.Symlink(target, filepath.Join(d3, FileName)); err != nil {
			t.Fatal(err)
		}
		if _, _, ok, err := ReadFile(d3); ok || err == nil {
			t.Errorf("read through a link: %v %v", ok, err)
		}
		if err := WriteFile(d3, "ssh-box", other); err == nil {
			t.Error("wrote over a link")
		}
	}
	// junk
	d4 := t.TempDir()
	os.WriteFile(filepath.Join(d4, FileName), []byte("ssh-box\nnot-a-secret\n"), 0o600)
	if _, _, ok, err := ReadFile(d4); ok || err == nil {
		t.Errorf("junk accepted: %v %v", ok, err)
	}
}

// #13757 (QA's SHOULD): the hub's refusal of a body too big to stamp says what the person was doing: an editor's save says where the file can be saved, an agent message keeps its own words.
func TestTheTooLongSentenceIsInTheWordsOfWhatThePersonWasDoing(t *testing.T) {
	code, text := TooLong("POST", "/api/board/t/artifacts/abc/edit")
	if code != "hub_file_too_large" || !strings.Contains(text, "save it on the computer") || strings.Contains(text, "message") {
		t.Errorf("an editor's save: %s %q", code, text)
	}
	code, text = TooLong("POST", "/api/sessions/live/x/send")
	if code != "hub_message_too_long" || !strings.Contains(text, "This message is too long") {
		t.Errorf("an agent message: %s %q", code, text)
	}
}
