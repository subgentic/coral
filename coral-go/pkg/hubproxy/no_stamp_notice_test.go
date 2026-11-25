package hubproxy

import (
	"bytes"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/subgentic/coral/pkg/hubowner"
)

// #21285: a remote that served a private read to the Hub's key with no owner stamp says so in a header; the Hub turns it into its own warning (one a day per remote and kind), never repeats a remote's own
// words, and the header does not reach the page.
func TestTheHubWarnsWhenARemoteServedAPrivateReadToItsKeyAlone(t *testing.T) {
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelWarn})))
	defer slog.SetDefault(old)
	noStampLogged.Lock()
	noStampLogged.at = map[string]time.Time{}
	noStampLogged.Unlock()
	h := &Handler{}
	resp := func(v string) *http.Response {
		r := &http.Response{Header: http.Header{}}
		if v != "" {
			r.Header.Set(hubowner.KeyReadNoticeHeader, v)
		}
		return r
	}

	r := resp("saved")
	h.noteNoStamp("box", r)
	if r.Header.Get(hubowner.KeyReadNoticeHeader) != "" {
		t.Error("the notice header must not reach the page")
	}
	if !strings.Contains(buf.String(), "no Approve set up") || !strings.Contains(buf.String(), "saved") {
		t.Errorf("no warning: %q", buf.String())
	}
	n := strings.Count(buf.String(), "no Approve set up")
	h.noteNoStamp("box", resp("saved"))
	if strings.Count(buf.String(), "no Approve set up") != n {
		t.Error("a second read the same day warns again")
	}
	h.noteNoStamp("box", resp("skills"))
	if strings.Count(buf.String(), "no Approve set up") != n+1 {
		t.Error("another kind is its own warning")
	}
	h.noteNoStamp("box2", resp("<script>alert(1)</script>"))
	if strings.Contains(buf.String(), "script") {
		t.Error("a remote's own words are never logged")
	}
	before := buf.Len()
	h.noteNoStamp("box", resp(""))
	if buf.Len() != before {
		t.Error("no header, no warning")
	}
}

// The same, through the proxy itself: the call is on the path of every remote answer, so a remote that sets the header gets the Hub's warning and the browser never sees the header.
func TestAProxiedAnswerWithTheNoticeHeaderWarnsTheHubAndLosesTheHeader(t *testing.T) {
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelWarn})))
	defer slog.SetDefault(old)
	noStampLogged.Lock()
	noStampLogged.at = map[string]time.Time{}
	noStampLogged.Unlock()
	rem := httptest.NewServer(keyed(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(hubowner.KeyReadNoticeHeader, "saved")
		io.WriteString(w, `{"saved":[]}`)
	})))
	t.Cleanup(rem.Close)
	res := &fakeResolver{targets: map[string]HTTPTarget{"a": {URL: rem.URL, APIKey: remoteKey, AllowPrivate: true}}, errs: map[string]error{}}
	hub := httptest.NewServer(newHub(res))
	t.Cleanup(hub.Close)

	resp, err := http.Get(hub.URL + "/api/remote/a/api/saved")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if resp.Header.Get(hubowner.KeyReadNoticeHeader) != "" {
		t.Error("the notice header reached the browser")
	}
	if !strings.Contains(buf.String(), "no Approve set up") {
		t.Errorf("the Hub did not warn: %q", buf.String())
	}
}
