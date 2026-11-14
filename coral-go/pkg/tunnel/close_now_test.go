package tunnel

import (
	"context"
	"net"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// blackholedSession is a hub session whose peer's bytes have stopped moving (sockets open, nothing answers): the peer never replies to a close.
func blackholedSession(t *testing.T) (*Session, *flakyProxy) {
	t.Helper()
	hub := newHub(t, fastCfg())
	proxy := newFlakyProxy(t, strings.TrimPrefix(hub.Server.URL, "http://"))
	cs, err := Dial(context.Background(), "ws://"+proxy.Addr(), testToken, ClientOptions{
		SessionConfig: fastCfg(), Handler: &LocalHandler{BaseURL: "http://127.0.0.1:1", AllowPath: allowAll}, AllowInsecure: true,
	})
	require.NoError(t, err)
	t.Cleanup(func() { cs.Close() })
	s := hub.next(t)
	proxy.Blackhole(true)
	return s, proxy
}

// A peer whose bytes have stopped (it never answers the close): CloseNow returns at once and Done fires. (Close returns in about 0.1 ms in this setup too, with this library version: the stall coral-hub saw
// is not reproduced by a blackholed or a non-reading peer, so this test pins the contract, not the difference.)
func TestCloseNowDoesNotWaitForAPeerThatNeverAnswers(t *testing.T) {
	s, _ := blackholedSession(t)
	start := time.Now()
	require.NoError(t, s.CloseNow())
	assert.Less(t, time.Since(start), 100*time.Millisecond, "no close-handshake wait")
	select {
	case <-s.Done():
	case <-time.After(time.Second):
		t.Fatal("Done did not fire")
	}
}

// Safe with Close in any order, from several goroutines, and idempotent.
func TestCloseNowIsSafeAndIdempotent(t *testing.T) {
	s, _ := blackholedSession(t)
	var wg sync.WaitGroup
	start := time.Now()
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if i%2 == 0 {
				_ = s.Close() // stuck on the peer's close handshake until CloseNow releases it
			} else {
				_ = s.CloseNow()
			}
		}(i)
	}
	wg.Wait()
	assert.Less(t, time.Since(start), 2*time.Second, "a Close stuck on the peer is released by CloseNow")
	assert.NoError(t, s.CloseNow(), "after Close, and again")
	assert.NoError(t, s.CloseNow())
	select {
	case <-s.Done():
	default:
		t.Fatal("Done did not fire")
	}
}

// CloseNow on a healthy session ends its streams and leaves no goroutine behind.
func TestCloseNowLeavesNoGoroutines(t *testing.T) {
	before := runtime.NumGoroutine()
	for i := 0; i < 5; i++ {
		s, _ := blackholedSession(t)
		require.NoError(t, s.CloseNow())
	}
	require.Eventually(t, func() bool { return runtime.NumGoroutine() <= before+25 }, 10*time.Second, 50*time.Millisecond,
		"goroutines after five CloseNow calls: %d (before %d)", runtime.NumGoroutine(), before)
}

// coral-hub's case: a peer that stops reading while bulk stream data fills the TCP send buffer. The session is alive (no keepalive has fired), a write is stuck, and Close and CloseNow both return at once:
// Close does not stall even then (measured: about 0.25 ms against 0.1 ms), so CloseNow is the same promise made without the library's handshake behaviour in the way.
func TestCloseAndCloseNowReturnWithAFullSendBuffer(t *testing.T) {
	for _, closeNow := range []bool{false, true} {
		hub := newHub(t, SessionConfig{})
		proxy := newFlakyProxy(t, strings.TrimPrefix(hub.Server.URL, "http://"))
		cs, err := Dial(context.Background(), "ws://"+proxy.Addr(), testToken, ClientOptions{
			SessionConfig: SessionConfig{}, Handler: &LocalHandler{BaseURL: "http://127.0.0.1:1", AllowPath: allowAll}, AllowInsecure: true,
		})
		require.NoError(t, err)
		t.Cleanup(func() { cs.Close() })
		s := hub.next(t)
		proxy.Blackhole(true)
		st, err := s.ys.OpenStream()
		require.NoError(t, err)
		go func() {
			buf := make([]byte, 64<<10)
			for {
				if _, err := st.Write(buf); err != nil {
					return
				}
			}
		}()
		time.Sleep(time.Second) // the peer reads nothing: the buffers fill and a write is stuck
		select {
		case <-s.Done():
			t.Fatal("the session ended by itself before the close")
		default:
		}
		start := time.Now()
		if closeNow {
			require.NoError(t, s.CloseNow())
		} else {
			_ = s.Close()
		}
		assert.Less(t, time.Since(start), 500*time.Millisecond, "closeNow=%v", closeNow)
		select {
		case <-s.Done():
		case <-time.After(time.Second):
			t.Fatalf("Done did not fire (closeNow=%v)", closeNow)
		}
	}
}

// Security's #6819 LOW: "every stream ends" is pinned: a stream open on the session returns an error once CloseNow has returned, and the session accepts no new one.
func TestCloseNowEndsOpenStreams(t *testing.T) {
	s, _ := blackholedSession(t)
	st, err := s.ys.OpenStream()
	require.NoError(t, err)
	require.NoError(t, s.CloseNow())
	_, werr := st.Write([]byte("after"))
	assert.Error(t, werr, "a write on an open stream fails once the session is closed")
	_, rerr := st.Read(make([]byte, 1))
	assert.Error(t, rerr, "so does a read")
	_, oerr := s.ys.OpenStream()
	assert.Error(t, oerr, "and a new stream cannot be opened")
}

// #16261 (v2.0.68 gate 3: TestCloseNowIsSafeAndIdempotent took 5.0 s on a loaded runner). The WebSocket library's Close waits up to 5 s for the peer's close frame, and its CloseNow, when a Close is
// already running, does not end that wait: it waits behind it. So a CloseNow that came second left the first Close stuck for the full 5 s, as often as the Close won the start. The session's connection
// now stops waiting when CloseNow says so. A connection whose Close never returns on its own (the peer is gone) stands for the library's.
type stuckCloseConn struct {
	net.Conn
	release chan struct{}
}

func (c *stuckCloseConn) Close() error { <-c.release; return nil }

func TestACloseStuckOnThePeerIsReleasedByCloseNowAtOnce(t *testing.T) {
	inner := &stuckCloseConn{release: make(chan struct{})}
	t.Cleanup(func() { close(inner.release) })
	hard := make(chan struct{})
	c := &releasableConn{Conn: inner, hard: hard}
	returned := make(chan struct{})
	go func() { _ = c.Close(); close(returned) }()
	select {
	case <-returned:
		t.Fatal("Close returned while the peer's close was still awaited and nothing released it")
	case <-time.After(100 * time.Millisecond):
	}
	start := time.Now()
	close(hard)
	select {
	case <-returned:
	case <-time.After(time.Second):
		t.Fatal("a closed hard channel did not release the stuck Close")
	}
	assert.Less(t, time.Since(start), 500*time.Millisecond)
}
