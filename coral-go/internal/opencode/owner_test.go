package opencode

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTheSystemToolsAnswersAreParsed(t *testing.T) {
	assert.Equal(t, []int{123, 456}, parseLsof([]byte("p123\nf3\np456\nf10\np123\n")), "one pid per process, each once")
	assert.Empty(t, parseLsof([]byte("")))
	assert.Empty(t, parseLsof([]byte("pabc\np-5\np0\n")), "a line that is not a pid is not one")
	assert.Equal(t, []int{4242}, parseSS([]byte(`LISTEN 0 512 127.0.0.1:4096 0.0.0.0:* users:(("opencode",pid=4242,fd=19))`+"\n")))
	assert.Equal(t, []int{11, 12}, parseSS([]byte(`LISTEN 0 1 127.0.0.1:1 0.0.0.0:* users:(("a",pid=11,fd=3),("b",pid=12,fd=4))`)))
	netstat := "  TCP    127.0.0.1:4096     0.0.0.0:0      LISTENING       7777\n  TCP    127.0.0.1:4097     0.0.0.0:0      LISTENING       8888\n  TCP    127.0.0.1:4096     127.0.0.1:5000 ESTABLISHED     9999\n"
	assert.Equal(t, []int{7777}, parseNetstat([]byte(netstat), 4096), "the port's listener only: not another port, not a connection")
}

// With a REAL process listening, the system tool names it: the test process (an in-process listener), and a stand-in child (another process).
func TestTheOwnerOfAListeningPortIsTheProcessThatHoldsIt(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer l.Close()
	port := l.Addr().(*net.TCPAddr).Port
	pids, err := listenerPIDs(context.Background(), port)
	if err != nil {
		t.Skipf("no tool to ask who listens (%v)", err)
	}
	assert.Equal(t, []int{os.Getpid()}, pids, "this process holds it")
	owned, err := listenerIsChild(context.Background(), port, os.Getpid())
	require.NoError(t, err)
	assert.True(t, owned, "the owner is the child that was named")
	owned, err = listenerIsChild(context.Background(), port, os.Getpid()+100000)
	require.NoError(t, err)
	assert.False(t, owned, "a listener that is not the child (or its descendant) is refused")

	free, _ := freeLoopbackPort()
	none, err := listenerIsChild(context.Background(), free, os.Getpid())
	require.NoError(t, err)
	assert.False(t, none, "nobody listening is not 'ours'")
	_, err = listenerPIDs(context.Background(), 0)
	assert.Error(t, err)
}

// A stranger holds the chosen port and answers 401 to a wrong password and 200 to anything else, while the real child stays ALIVE on another port (a build that moved): the real password must never be sent to
// the stranger, and the start fails closed with nothing left running (Security's point 2 on #138214).
func TestAStrangerThatRefusesAWrongPasswordIsNeverSentTheRealOneWhileTheChildLivesElsewhere(t *testing.T) {
	if _, err := listenerPIDs(context.Background(), 1); err != nil && strings.Contains(err.Error(), "no tool") {
		t.Skip("no tool to ask who listens")
	}
	t.Setenv("STANDIN_BIND_OTHER", "1")
	cfg, envFile := stubConfig(t)
	cfg.Ready = 5 * time.Second
	var mu sync.Mutex
	var seen []string
	stranger := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, pw, _ := r.BasicAuth()
		mu.Lock()
		seen = append(seen, pw)
		mu.Unlock()
		if strings.HasPrefix(pw, "not-") {
			http.Error(w, "no", http.StatusUnauthorized) // asks for a password, like the real server
			return
		}
		fmt.Fprint(w, `{"data":[]}`) // and takes the real one
	}))
	defer stranger.Close()
	port, _ := strconv.Atoi(stranger.Listener.Addr().String()[strings.LastIndex(stranger.Listener.Addr().String(), ":")+1:])
	cfg.pickPort = func() (int, error) { return port, nil }

	_, err := Start(context.Background(), cfg, "agent-1")
	require.Error(t, err, "the listener is not the child: refused")
	assert.Contains(t, err.Error(), "not the server that was started")
	mu.Lock()
	defer mu.Unlock()
	require.NotEmpty(t, seen, "the stranger was probed with the wrong password")
	for _, pw := range seen {
		assert.True(t, strings.HasPrefix(pw, "not-"), "the real password was sent to the stranger: %q", pw)
	}
	raw, rerr := os.ReadFile(envFile + ".pids")
	require.NoError(t, rerr)
	for _, f := range strings.Fields(string(raw)) {
		pid, _ := strconv.Atoi(f)
		require.Positive(t, pid)
		assert.Eventually(t, func() bool { return !processAlive(pid) }, 5*time.Second, 20*time.Millisecond, "process %d is still running", pid)
	}
}

func processAlive(pid int) bool {
	p, err := os.FindProcess(pid)
	return err == nil && p.Signal(syscall.Signal(0)) == nil
}

func TestAMachineWithoutTheSystemToolsGetsAnErrorThatNamesThem(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	_, err := listenerPIDs(context.Background(), 8451)
	require.Error(t, err)
	assert.ErrorIs(t, err, errNoOwnerTool)
	if runtime.GOOS == "windows" {
		assert.Contains(t, err.Error(), "netstat")
		return
	}
	assert.Contains(t, err.Error(), "neither lsof nor ss is installed", "the two tools it asks")
	assert.Contains(t, err.Error(), "netstat on Windows")
	assert.Contains(t, err.Error(), "install lsof or ss", "and what to do")
	_, err = listenerIsChild(context.Background(), 8451, os.Getpid())
	require.Error(t, err, "the check fails closed: the password is not sent")
}
