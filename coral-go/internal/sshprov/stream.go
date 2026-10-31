package sshprov

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"github.com/subgentic/coral/internal/executil"
	"github.com/subgentic/coral/internal/safego"
	"github.com/subgentic/coral/pkg/hubowner"
	proxy "github.com/subgentic/coral/pkg/hubproxy"
)

// StreamTarget is how the hub reaches a Coral server that listens on loopback only on the far computer (#11370, Security's condition b). Each connection is one `ssh -W 127.0.0.1:<port>`: the
// bytes go over the owner's SSH session to the remote's own loopback and nowhere else. There is NO listening port on the hub machine, so no other user or process here can reach the remote
// (a TCP forward would let any local user act as the remote's Operator: the remote treats loopback as local). hubproxy sees an ordinary direct target: its header allowlist, its refusals and
// the remote's API key as a Bearer all apply unchanged.
//
// Only this package makes one (the fields are unexported): the normal registration path (POST /api/servers) builds a target from a URL and has no way to name a stream.
type StreamTarget struct {
	r                    Runner
	target               Target
	port                 int
	apiKey               string
	once                 sync.Once
	tr                   *http.Transport
	slots                chan struct{} // one per ssh process alive: the cap on streams
	ownerID, ownerSecret string        // the hub's owner stamp for this remote (#11378), set by WithOwnerStamp
	mu                   sync.Mutex
	failed               time.Time // when a dial last failed: dials are refused for streamBackoff after it
}

// streamCap bounds the ssh processes one target keeps (the dashboard, the poller and the feed each hold a few); streamBackoff is how long dials are refused after one failed, so a dead host or a
// refused key is not hit again for every request of every poll.
const (
	streamCap     = 12
	streamBackoff = 3 * time.Second
)

// ErrStreamBusy and ErrStreamBackoff are the two ways a dial is refused before ssh is started.
var (
	ErrStreamBusy    = errors.New("sshprov: too many connections to this server")
	ErrStreamBackoff = errors.New("sshprov: the last connection failed; waiting a moment")
)

// NewStreamTarget is the target for the remote server of t, listening on its loopback at port, reached with apiKey. The key stays in this value only; it is never put in argv.
func NewStreamTarget(r Runner, t Target, port int, apiKey string) (*StreamTarget, error) {
	if port < 1 || port > 65535 || apiKey == "" {
		return nil, errors.Join(ErrBadTarget, errors.New("a port and the remote's key are needed"))
	}
	if t.Alias == "" && (!userRe.MatchString(t.User) || !validHostName(t.Host) || t.Port < 1 || t.Port > 65535) {
		return nil, ErrBadTarget
	}
	if t.Alias != "" && !aliasRe.MatchString(t.Alias) {
		return nil, ErrBadTarget
	}
	return &StreamTarget{r: r, target: t, port: port, apiKey: apiKey, slots: make(chan struct{}, streamCap)}, nil
}

func (s *StreamTarget) hostPort() string { return "127.0.0.1:" + strconv.Itoa(s.port) }

func (s *StreamTarget) transport() *http.Transport {
	s.once.Do(func() {
		s.tr = &http.Transport{
			Proxy:               nil,
			DialContext:         func(ctx context.Context, _, _ string) (net.Conn, error) { return s.dial(ctx) },
			MaxIdleConnsPerHost: 4,
			IdleConnTimeout:     time.Minute,
			DisableCompression:  true,
		}
	})
	return s.tr
}

// WithOwnerStamp gives the target the id the remote knows itself by and the secret the hub signs its owner stamps with (#11378); the hub's proxy asks it to sign the requests that need a person.
func (s *StreamTarget) WithOwnerStamp(remoteID, secret string) *StreamTarget {
	s.ownerID, s.ownerSecret = remoteID, secret
	return s
}

// OwnerStamp implements hubproxy.OwnerStamper.
func (s *StreamTarget) OwnerStamp(method, target string, body []byte) (string, bool) {
	if s.ownerSecret == "" || s.ownerID == "" {
		return "", false
	}
	v, err := hubowner.Sign(s.ownerSecret, s.ownerID, method, target, body, time.Now())
	return v, err == nil
}

// Close ends the idle ssh streams.
func (s *StreamTarget) Close() { s.transport().CloseIdleConnections() }

// RoundTrip implements hubproxy.Target.
func (s *StreamTarget) RoundTrip(req *http.Request) (*http.Response, error) {
	out := req.Clone(req.Context())
	host := s.hostPort() // the name the remote's own Host check accepts for itself: its loopback address and port (a made-up name is refused as DNS rebinding)
	out.URL.Scheme, out.URL.Host, out.Host = "http", host, host
	out.Header.Set("Authorization", "Bearer "+s.apiKey)
	return s.transport().RoundTrip(out)
}

// DialWS implements hubproxy.Target.
func (s *StreamTarget) DialWS(ctx context.Context, path, rawQuery string, protocols []string) (proxy.WSConn, error) {
	u := url.URL{Scheme: "ws", Host: s.hostPort(), RawPath: path, RawQuery: rawQuery}
	if dec, err := url.PathUnescape(path); err == nil {
		u.Path = dec
	}
	c, resp, err := websocket.Dial(ctx, u.String(), &websocket.DialOptions{
		HTTPClient:   &http.Client{Transport: s.transport()},
		HTTPHeader:   http.Header{"Authorization": []string{"Bearer " + s.apiKey}},
		Subprotocols: protocols,
	})
	if err != nil {
		if resp != nil && (resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden) {
			return nil, proxy.ErrRemoteRejected
		}
		return nil, err
	}
	c.SetReadLimit(32 << 20)
	return c, nil
}

// dial starts one `ssh -W` and returns its stdin and stdout as a connection. Closing it ends the process. The argv is fixed: the same options as the runner, then -W with the loopback address and
// the validated port.
func (s *StreamTarget) dial(ctx context.Context) (net.Conn, error) {
	s.mu.Lock()
	recent := !s.failed.IsZero() && time.Since(s.failed) < streamBackoff
	s.mu.Unlock()
	if recent {
		return nil, ErrStreamBackoff
	}
	select {
	case s.slots <- struct{}{}:
	default:
		return nil, ErrStreamBusy
	}
	conn, err := s.start(ctx)
	if err != nil {
		<-s.slots
		s.noteFailure()
		return nil, err
	}
	conn.release = func() { <-s.slots }
	conn.onFail = s.noteFailure
	return conn, nil
}

func (s *StreamTarget) noteFailure() {
	s.mu.Lock()
	s.failed = time.Now()
	s.mu.Unlock()
}

func (s *StreamTarget) start(ctx context.Context) (*sshConn, error) {
	ssh := s.r.SSH
	if ssh == "" {
		ssh = "ssh"
	}
	argv := append([]string{}, sshOptions...)
	argv = append(argv, "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-W", "127.0.0.1:"+strconv.Itoa(s.port))
	argv = append(argv, s.target.Args()...)
	argv = append(argv, "--", s.target.Destination())
	cmd := executil.Command(context.WithoutCancel(ctx), ssh, argv...) // the stream outlives the dial's context; closing the conn ends it
	cmd.Env = minimalEnv()
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &sshConn{cmd: cmd, in: in, out: out}, nil
}

type sshConn struct {
	cmd     *exec.Cmd
	in      io.WriteCloser
	out     io.ReadCloser
	closing atomic.Bool
	reaped  sync.Once
	release func() // gives the stream's slot back, once the process is gone
	onFail  func() // ssh could not connect (exit 255 before we closed it)
}

// reap waits for the process once, gives the slot back, and tells the target when ssh itself failed.
func (c *sshConn) reap() {
	c.reaped.Do(func() {
		err := c.cmd.Wait()
		if c.release != nil {
			c.release()
		}
		var ee interface{ ExitCode() int }
		if err != nil && !c.closing.Load() && errors.As(err, &ee) && ee.ExitCode() == 255 && c.onFail != nil {
			c.onFail()
		}
	})
}

func (c *sshConn) Read(p []byte) (int, error) {
	n, err := c.out.Read(p)
	if err != nil {
		safego.Go("ssh stream reap", c.reap) // the stream ended: collect the exit status (the pipe is drained or broken)
	}
	return n, err
}
func (c *sshConn) Write(p []byte) (int, error) { return c.in.Write(p) }
func (c *sshConn) Close() error {
	c.closing.Store(true)
	c.in.Close()
	if c.cmd.Process != nil {
		c.cmd.Process.Kill()
	}
	safego.Go("ssh stream reap", c.reap)
	return nil
}
func (c *sshConn) LocalAddr() net.Addr              { return streamAddr{} }
func (c *sshConn) RemoteAddr() net.Addr             { return streamAddr{} }
func (c *sshConn) SetDeadline(time.Time) error      { return nil }
func (c *sshConn) SetReadDeadline(time.Time) error  { return nil }
func (c *sshConn) SetWriteDeadline(time.Time) error { return nil }

type streamAddr struct{}

func (streamAddr) Network() string { return "ssh-stream" }
func (streamAddr) String() string  { return "ssh-stream" }
