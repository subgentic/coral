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
		"another method":    {nil, "PUT", path, path, body, ErrRoute},
		"another route":     {nil, method, "/api/saved", "/api/saved", body, ErrRoute},
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

func TestAllowedIsTheTwoDecisionsAndNothingElse(t *testing.T) {
	for _, ok := range []struct{ m, p string }{
		{"POST", "/api/board/team/artifacts/abc/review"},
		{"POST", "/api/artifacts/abc/comments/c1/send"},
	} {
		if !Allowed(ok.m, ok.p) {
			t.Errorf("%v not allowed", ok)
		}
	}
	for _, bad := range []struct{ m, p string }{
		{"GET", "/api/board/team/artifacts/abc/review"},
		{"PUT", "/api/board/team/artifacts/abc/review"},
		{"POST", "/api/board/team/artifacts/abc/review/extra"},
		{"POST", "/api/board/team/artifacts//review"},
		{"POST", "/api/board//artifacts/abc/review"},
		{"POST", "/api/artifacts/abc/comments/c1/resolve"},
		{"POST", "/api/artifacts/abc/comments/c1/send/x"},
		{"POST", "/api/sessions/live/x/send"},
		{"DELETE", "/api/artifacts/abc"},
		{"POST", ""},
		{"POST", "/"},
	} {
		if Allowed(bad.m, bad.p) {
			t.Errorf("%v allowed", bad)
		}
	}
	if len(Routes()) != 2 {
		t.Errorf("the allowlist has %d routes: a new one needs a reason and a review", len(Routes()))
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
