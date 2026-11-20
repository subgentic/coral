package googlesignin

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/auth"
	"github.com/subgentic/coral/internal/safego"
)

// CallbackPath is the path Google returns the browser to on the one-shot listener.
const CallbackPath = "/google/callback"

// FlowCookie binds a sign-in to the browser that started it (set by the start route, sent back to the listener: a cookie on 127.0.0.1 goes to every port of it).
const FlowCookie = "coral_gdoc_flow"

// CallbackResult is what the listener got: the code and state from the URL (or Google's error tag), and the flow cookie.
type CallbackResult struct {
	Code, State, Error, Binding string
}

// ServeCallbackOnce listens on 127.0.0.1:port (0 is any free port; never another address, never Coral's own listener) for one request, hands it to handle,
// answers its text as text/plain, and closes: after that first request, whatever its path, or after ttl. It returns once the listener is open.
func ServeCallbackOnce(port int, ttl time.Duration, handle func(CallbackResult) string) (redirect string, err error) {
	cb, err := ReserveCallback(port)
	if err != nil {
		return "", err
	}
	cb.Serve(ttl, handle)
	return cb.Redirect, nil
}

// Callback is a port held on 127.0.0.1 that nothing answers yet: the sign-in's address is known (Start needs it) before the listener serves anything, so a sign-in
// that cannot start never has a listener answering (#20022 INFO 10). Serve begins answering; Close gives the port back when it never will.
type Callback struct {
	Redirect string
	ln       net.Listener
}

// ReserveCallback holds 127.0.0.1:port (0 is any free port) without answering.
func ReserveCallback(port int) (*Callback, error) {
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return nil, fmt.Errorf("could not open the sign-in callback on 127.0.0.1: %w", err)
	}
	return &Callback{Redirect: fmt.Sprintf("http://127.0.0.1:%d%s", ln.Addr().(*net.TCPAddr).Port, CallbackPath), ln: ln}, nil
}

// Close releases a reserved port that was never served.
func (c *Callback) Close() { _ = c.ln.Close() }

// Serve answers one request on the reserved port, as ServeCallbackOnce says.
func (c *Callback) Serve(ttl time.Duration, handle func(CallbackResult) string) {
	ln := c.ln
	var once sync.Once
	done := make(chan struct{})
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
			http.Error(w, "Not a Google sign-in.", http.StatusNotFound)
			return
		}
		q := r.URL.Query()
		res := CallbackResult{Code: q.Get("code"), State: q.Get("state"), Error: q.Get("error")}
		if c, err := r.Cookie(FlowCookie); err == nil {
			res.Binding = c.Value
		}
		http.SetCookie(w, &http.Cookie{Name: FlowCookie, Value: "", Path: CallbackPath, MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode})
		fmt.Fprintln(w, handle(res))
	})
	srv := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second, ConnContext: auth.ConnContext}
	go func() { defer safego.Recover("google sign-in callback server"); _ = srv.Serve(ln) }()
	go func() {
		defer safego.Recover("google sign-in callback shutdown")
		select {
		case <-done:
			time.Sleep(200 * time.Millisecond)
		case <-time.After(ttl):
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}()
}
