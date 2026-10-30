package config

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const goodID = "0123456789abcdef0123456789abcdef"

// record writes the lock file a server leaves in coralDir.
func record(t *testing.T, pid int, addr, id string) string {
	t.Helper()
	dir := t.TempDir()
	text := fmt.Sprintf("%d\n%s\n", pid, addr)
	if id != "" {
		text += id + "\n"
	}
	require.NoError(t, os.WriteFile(filepath.Join(dir, ServerLockFile), []byte(text), 0o600))
	return dir
}

// listener answers /api/health with body, counts every request and every one that carried a credential.
type listener struct {
	srv           *httptest.Server
	requests      atomic.Int32
	withCredentil atomic.Int32
}

func newListener(t *testing.T, status int, body string) *listener {
	t.Helper()
	l := &listener{}
	l.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		l.requests.Add(1)
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || strings.Contains(r.URL.RawQuery, "token") {
			l.withCredentil.Add(1)
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(l.srv.Close)
	return l
}

func deadPID(t *testing.T) int {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	require.NoError(t, cmd.Run())
	return cmd.Process.Pid // a process that has ended and been waited for
}

// A command that finds a server's address in the data folder sends it a credential only if that record is still true: the process runs, and the address answers as THAT server.
func TestAGenuineRecordedServerIsVerified(t *testing.T) {
	l := newListener(t, 200, `{"status":"ok","version":"2.0.7","hub":false,"instance_id":"`+goodID+`"}`)
	dir := record(t, os.Getpid(), l.srv.URL, goodID)
	assert.Equal(t, l.srv.URL, VerifiedServer(dir))
	assert.Equal(t, int32(0), l.withCredentil.Load(), "the question carries no credential")
}

func TestARecordWhoseProcessIsGoneIsNotUsedAndNothingIsAsked(t *testing.T) {
	l := newListener(t, 200, `{"status":"ok","version":"2.0.7","instance_id":"`+goodID+`"}`) // something now answers there, as it would after a crash
	dir := record(t, deadPID(t), l.srv.URL, goodID)
	assert.Empty(t, VerifiedServer(dir))
	assert.Equal(t, int32(0), l.requests.Load(), "a dead server's port is not even asked")
}

func TestAnUnrelatedListenerOnTheOldPortGetsNoCredentialAndIsNotUsed(t *testing.T) {
	for name, tc := range map[string]struct {
		status int
		body   string
	}{
		"another Coral (another instance id)": {200, `{"status":"ok","version":"2.0.7","instance_id":"ffffffffffffffffffffffffffffffff"}`},
		"a Coral without an instance id":      {200, `{"status":"ok","version":"2.0.7"}`},
		"a web server":                        {200, `<html>hello</html>`},
		"an error page":                       {404, `not found`},
		"a service that answers ok and more":  {200, `{"status":"fine"}`},
	} {
		l := newListener(t, tc.status, tc.body)
		dir := record(t, os.Getpid(), l.srv.URL, goodID)
		assert.Empty(t, VerifiedServer(dir), name)
		assert.Equal(t, int32(0), l.withCredentil.Load(), name+": it was asked once, with no credential")
		assert.LessOrEqual(t, l.requests.Load(), int32(1), name)
	}
}

func TestAHealthAnswerThatRedirectsElsewhereIsNotFollowed(t *testing.T) {
	other := newListener(t, 200, `{"status":"ok","version":"2.0.7","instance_id":"`+goodID+`"}`)
	redirecting := httptest.NewServer(http.RedirectHandler(other.srv.URL+"/api/health", http.StatusFound))
	t.Cleanup(redirecting.Close)
	dir := record(t, os.Getpid(), redirecting.URL, goodID)
	assert.Empty(t, VerifiedServer(dir))
	assert.Equal(t, int32(0), other.requests.Load(), "the redirect target was never asked")
}

// A record an older server wrote has no instance id: a live process and a Coral-shaped answer are all there is to check (said in VerifiedServer's comment).
func TestAnOlderRecordNeedsALiveProcessAndACoralShapedAnswer(t *testing.T) {
	l := newListener(t, 200, `{"status":"ok","version":"2.0.5","hub":false}`)
	assert.Equal(t, l.srv.URL, VerifiedServer(record(t, os.Getpid(), l.srv.URL, "")))
	assert.Empty(t, VerifiedServer(record(t, deadPID(t), l.srv.URL, "")))
	web := newListener(t, 200, `{"hello":"world"}`)
	assert.Empty(t, VerifiedServer(record(t, os.Getpid(), web.srv.URL, "")))
}

func TestARecordedAddressThatIsNotLoopbackIsNeverAsked(t *testing.T) {
	assert.Empty(t, VerifiedServer(record(t, os.Getpid(), "http://example.com:8420", goodID)))
	assert.Empty(t, VerifiedServer(t.TempDir()), "no record")
}

// LocalServerURL: a stale record falls back to the platform's default address, as no record does.
func TestLocalServerURLIgnoresAStaleRecord(t *testing.T) {
	l := newListener(t, 200, `{"status":"ok","version":"2.0.7","instance_id":"`+goodID+`"}`)
	t.Setenv("CORAL_DATA_DIR", record(t, deadPID(t), l.srv.URL, goodID))
	assert.Equal(t, scratchDefault(t), LocalServerURL())
	t.Setenv("CORAL_DATA_DIR", record(t, os.Getpid(), l.srv.URL, goodID))
	assert.Equal(t, l.srv.URL, LocalServerURL())
}

func TestTheInstanceIdInARecordMustHaveItsShape(t *testing.T) {
	for _, bad := range []string{"short", strings.Repeat("g", 32), strings.ToUpper(goodID), goodID + "0"} {
		_, _, id := RecordedInstance(record(t, os.Getpid(), "http://127.0.0.1:1", bad))
		assert.Empty(t, id, bad)
	}
	_, _, id := RecordedInstance(record(t, os.Getpid(), "http://127.0.0.1:1", goodID))
	assert.Equal(t, goodID, id)
}
