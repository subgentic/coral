package dropbox

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

// CallbackPath is the path Dropbox returns the browser to on the one-shot listener.
const CallbackPath = "/dropbox/callback"

// FlowCookie is the cookie that binds a sign-in to the browser that started it (set by the start route, sent back to the listener: a cookie on
// 127.0.0.1 is sent to every port of it).
const FlowCookie = "coral_dbx_flow"

// CallbackResult is what the listener got: the code and state from the URL (or Dropbox's error tag), and the flow cookie.
type CallbackResult struct {
	Code, State, Error, Binding string
}

// ServeCallbackOnce listens on 127.0.0.1:port (never another address, never Coral's own listener) for one request, hands it to handle, answers its
// text as text/plain, and closes: after that first request, whatever its path, or after ttl. It returns once the listener is open; the work runs in
// the background. A port already in use is an error (another sign-in is listening).
func ServeCallbackOnce(port int, ttl time.Duration, handle func(CallbackResult) string) (redirect string, err error) {
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return "", fmt.Errorf("could not open the sign-in callback on 127.0.0.1:%d: %w", port, err)
	}
	redirect = fmt.Sprintf("http://127.0.0.1:%d%s", ln.Addr().(*net.TCPAddr).Port, CallbackPath)
	var once sync.Once
	done := make(chan struct{})
	srv := &http.Server{ReadHeaderTimeout: 10 * time.Second}
	srv.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		first := false
		once.Do(func() { first = true })
		if !first {
			http.Error(w, "This sign-in link was already used.", http.StatusGone)
			return
		}
		defer close(done)
		if r.Method != http.MethodGet || r.URL.Path != CallbackPath {
			http.Error(w, "Not a Dropbox sign-in.", http.StatusNotFound)
			return
		}
		q := r.URL.Query()
		res := CallbackResult{Code: q.Get("code"), State: q.Get("state"), Error: q.Get("error")}
		if c, err := r.Cookie(FlowCookie); err == nil {
			res.Binding = c.Value
		}
		// The cookie has done its work: it is cleared whatever happens next.
		http.SetCookie(w, &http.Cookie{Name: FlowCookie, Value: "", Path: CallbackPath, MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode})
		fmt.Fprintln(w, handle(res))
	})
	go func() { _ = srv.Serve(ln) }()
	go func() {
		select {
		case <-done:
			time.Sleep(200 * time.Millisecond) // let the answer go out
		case <-time.After(ttl):
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}()
	return redirect, nil
}

// NewClientAt is a client for a test Dropbox at base (an http://127.0.0.1 URL only: anything else panics), for tests outside this package.
func NewClientAt(appKey, base string) *Client {
	u, err := url.Parse(base)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" {
		panic("dropbox.NewClientAt is for a local test server only")
	}
	return newClient(appKey, base, base, func(host string) bool { return host == u.Host })
}

var ioregUUID = regexp.MustCompile(`"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"`)

// MachineID is this computer's own identifier (macOS IOPlatformUUID, Linux /etc/machine-id, Windows MachineGuid), for the fingerprint only: it is
// never stored, logged or sent anywhere.
func MachineID() (string, error) {
	switch runtime.GOOS {
	case "darwin":
		out, err := exec.Command("/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice").Output()
		if err != nil {
			return "", err
		}
		if m := ioregUUID.FindSubmatch(out); m != nil {
			return string(m[1]), nil
		}
	case "linux":
		for _, p := range []string{"/etc/machine-id", "/var/lib/dbus/machine-id"} {
			if b, err := os.ReadFile(p); err == nil && strings.TrimSpace(string(b)) != "" {
				return strings.TrimSpace(string(b)), nil
			}
		}
	case "windows":
		out, err := exec.Command("reg", "query", `HKLM\SOFTWARE\Microsoft\Cryptography`, "/v", "MachineGuid").Output()
		if err != nil {
			return "", err
		}
		f := strings.Fields(string(out))
		if len(f) > 0 {
			return f[len(f)-1], nil
		}
	}
	return "", errors.New("this computer's id could not be read")
}
