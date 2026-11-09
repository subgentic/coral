package dropbox

import (
	"io"
	"net/http"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTheCallbackListenerAnswersOnceOn127AndCloses(t *testing.T) {
	var got CallbackResult
	redirect, err := ServeCallbackOnce(0, 5*time.Second, func(r CallbackResult) string { got = r; return "Connected. You can close this tab." })
	require.NoError(t, err)
	assert.True(t, strings.HasPrefix(redirect, "http://127.0.0.1:"), redirect)
	assert.True(t, strings.HasSuffix(redirect, CallbackPath))

	req, _ := http.NewRequest(http.MethodGet, redirect+"?code=the-code&state=the-state", nil)
	req.AddCookie(&http.Cookie{Name: FlowCookie, Value: "browser-1"})
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, "text/plain; charset=utf-8", resp.Header.Get("Content-Type"))
	assert.Contains(t, string(body), "Connected")
	assert.Equal(t, CallbackResult{Code: "the-code", State: "the-state", Binding: "browser-1"}, got)
	cleared := false
	for _, c := range resp.Cookies() {
		if c.Name == FlowCookie && c.MaxAge < 0 {
			cleared = true
		}
	}
	assert.True(t, cleared, "the flow cookie is cleared")

	require.Eventually(t, func() bool {
		r, err := http.Get(redirect + "?code=x&state=y")
		if err == nil {
			r.Body.Close()
		}
		return err != nil
	}, 3*time.Second, 50*time.Millisecond, "closed after its one request")
}

func TestTheCallbackListenerCountsAWrongRequestAsItsOne(t *testing.T) {
	called := false
	redirect, err := ServeCallbackOnce(0, 5*time.Second, func(CallbackResult) string { called = true; return "" })
	require.NoError(t, err)
	resp, err := http.Post(redirect, "text/plain", strings.NewReader("x"))
	require.NoError(t, err)
	resp.Body.Close()
	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
	assert.False(t, called, "only a GET of the callback path is handled")
}

func TestTheCallbackListenerClosesAfterItsTimeToLive(t *testing.T) {
	redirect, err := ServeCallbackOnce(0, 100*time.Millisecond, func(CallbackResult) string { return "" })
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		r, err := http.Get(redirect)
		if err == nil {
			r.Body.Close()
		}
		return err != nil
	}, 3*time.Second, 50*time.Millisecond)
}

func TestNewClientAtIsForALocalTestServerOnly(t *testing.T) {
	assert.Panics(t, func() { NewClientAt("k", "https://api.dropboxapi.com") })
	assert.Panics(t, func() { NewClientAt("k", "http://evil.example") })
	assert.NotPanics(t, func() { NewClientAt("k", "http://127.0.0.1:1234") })
}

func TestTheMachineIDReadsOnThisComputer(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" && runtime.GOOS != "windows" {
		t.Skip("no machine id here")
	}
	id, err := MachineID()
	if err != nil {
		t.Skipf("no machine id on this runner: %v", err)
	}
	assert.GreaterOrEqual(t, len(id), 16)
}
