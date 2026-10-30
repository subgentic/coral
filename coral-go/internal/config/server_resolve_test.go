package config

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// scratchDefault points the platform default address at a scratch server that answers as a Coral (status ok and a version), and returns its address.
func scratchDefault(t *testing.T) string {
	t.Helper()
	l := newListener(t, 200, `{"status":"ok","version":"2.0.7"}`)
	old := defaultServerURL
	defaultServerURL = l.srv.URL
	t.Cleanup(func() { defaultServerURL = old })
	return l.srv.URL
}

// A Coral with TLS on a port of its own (loopback) is found: the health question skips certificate verification (no credential is sent; the instance id is the identity).
func TestATLSCoralOnAnotherPortIsFoundByItsInstanceId(t *testing.T) {
	var asked atomic.Int32
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked.Add(1)
		assert.Empty(t, r.Header.Get("Authorization"))
		_, _ = w.Write([]byte(`{"status":"ok","version":"2.0.7","instance_id":"` + goodID + `"}`))
	}))
	t.Cleanup(srv.Close)
	require.True(t, strings.HasPrefix(srv.URL, "https://127.0.0.1:"))
	assert.Equal(t, srv.URL, VerifiedServer(record(t, os.Getpid(), srv.URL, goodID)))
	assert.Equal(t, int32(1), asked.Load())
	// Another instance id on that TLS port is still refused.
	assert.Empty(t, VerifiedServer(record(t, os.Getpid(), srv.URL, "ffffffffffffffffffffffffffffffff")))
}

// A Coral that is running but whose recorded address does not answer as it is an ERROR: the default port is not tried, and nothing is asked there.
func TestALiveRecordThatDoesNotVerifyIsAnErrorNotTheDefaultPort(t *testing.T) {
	def := newListener(t, 200, `{"status":"ok","version":"2.0.7"}`)
	old := defaultServerURL
	defaultServerURL = def.srv.URL
	t.Cleanup(func() { defaultServerURL = old })
	other := newListener(t, 200, `{"status":"ok","version":"2.0.7","instance_id":"ffffffffffffffffffffffffffffffff"}`)
	addr, err := ResolveServer(record(t, os.Getpid(), other.srv.URL, goodID))
	assert.Empty(t, addr)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "did not answer as this Coral")
	assert.Contains(t, err.Error(), "CORAL_URL")
	assert.Equal(t, int32(0), def.requests.Load(), "the default port was never asked")
}

// With no record, or one whose process is gone, the default address is used only if it answers as a Coral: status ok AND a version.
func TestTheDefaultAddressIsUsedOnlyIfItAnswersAsACoral(t *testing.T) {
	old := defaultServerURL
	t.Cleanup(func() { defaultServerURL = old })
	for name, tc := range map[string]struct {
		status int
		body   string
		ok     bool
	}{
		"a Coral":              {200, `{"status":"ok","version":"2.0.7"}`, true},
		"ok but no version":    {200, `{"status":"ok"}`, false},
		"a version but not ok": {200, `{"status":"down","version":"2.0.7"}`, false},
		"a web server":         {200, `<html></html>`, false},
		"an error":             {500, `{"status":"ok","version":"2.0.7"}`, false},
	} {
		l := newListener(t, tc.status, tc.body)
		defaultServerURL = l.srv.URL
		for _, dir := range []string{t.TempDir(), record(t, deadPID(t), "http://127.0.0.1:9", goodID)} {
			addr, err := ResolveServer(dir)
			if tc.ok {
				assert.NoError(t, err, name)
				assert.Equal(t, l.srv.URL, addr, name)
			} else {
				assert.Error(t, err, name)
				assert.Empty(t, addr, name)
				assert.Contains(t, err.Error(), "no Coral answered", name)
			}
		}
		assert.Equal(t, int32(0), l.withCredentil.Load(), name+": no credential")
	}
}

// A lock file over 4 KB is not read at all, so it names no server.
func TestARecordOverFourKilobytesIsRefused(t *testing.T) {
	l := newListener(t, 200, `{"status":"ok","version":"2.0.7","instance_id":"`+goodID+`"}`)
	body := "4242\n" + l.srv.URL + "\n" + goodID + "\n" + strings.Repeat("x", 4096)
	dir := lockIn(t, body)
	pid, addr, id := RecordedInstance(dir)
	assert.Zero(t, pid)
	assert.Empty(t, addr)
	assert.Empty(t, id)
	assert.Empty(t, VerifiedServer(dir))
	// Just under the cap is read.
	body = "4242\n" + l.srv.URL + "\n" + goodID + "\n" + strings.Repeat("x", 4096-len("4242\n"+l.srv.URL+"\n"+goodID+"\n"))
	_, addr, _ = RecordedInstance(lockIn(t, body))
	assert.Equal(t, l.srv.URL, addr)
}

// An older record has no instance id, and one whose answer has no version is refused: a live process and a Coral-shaped (ok and a version) answer are all there is to check.
func TestAnOlderRecordWhoseAnswerHasNoVersionIsRefused(t *testing.T) {
	noVersion := newListener(t, 200, `{"status":"ok"}`)
	assert.Empty(t, VerifiedServer(record(t, os.Getpid(), noVersion.srv.URL, "")))
	withVersion := newListener(t, 200, `{"status":"ok","version":"2.0.5"}`)
	assert.Equal(t, withVersion.srv.URL, VerifiedServer(record(t, os.Getpid(), withVersion.srv.URL, "")))
}

// #235: the address a command falls back to is this platform's default port (8450 on Windows), not 8420 (hooks.CoralBase goes through it; asking it needs a Coral there, so the value is checked, not dialed).
func TestTheFallbackAddressIsThisPlatformsDefaultPort(t *testing.T) {
	assert.Equal(t, "http://localhost:"+strconv.Itoa(DefaultPort), defaultServerURL)
}

// The certificate is left unverified only for an https address on this computer: never for another host, another scheme, or a name that merely starts like localhost.
func TestCertificateCheckIsSkippedOnlyForLoopbackHttps(t *testing.T) {
	for _, addr := range []string{"https://127.0.0.1:8450", "https://localhost:9443", "https://[::1]:9443", "https://127.1.2.3:9443"} {
		assert.True(t, skipsCertificateCheck(addr), addr)
	}
	for _, addr := range []string{"http://127.0.0.1:8450", "https://example.com:8450", "https://10.0.0.5:8450", "https://localhost.example.com:9443",
		"https://127.0.0.1.example.com:9443", "https://user:pw@127.0.0.1:9443", "https://127.0.0.1", "ftp://127.0.0.1:21", "", "not a url"} {
		assert.False(t, skipsCertificateCheck(addr), addr)
	}
}
