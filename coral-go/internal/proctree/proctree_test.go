package proctree

import (
	"context"
	"os"
	"os/exec"
	"runtime"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const sample = `    1     0 /sbin/launchd
  100     1 /usr/bin/tmux new -s agent
  200   100 claude --model x
  300   200 bash -c cd coral-go && go test ./...
  310   300 go test ./...
  320   310 /tmp/go-build/pkg.test -test.v
  400   100 other-agent
  410   400 go test ./...
   garbage line
`

func TestOnlyWhatIsBelowTheRootIsListedWithItsFullCommandLine(t *testing.T) {
	procs := Parse(sample)
	assert.Len(t, procs, 8, "the garbage line is skipped")
	got := Below(procs, 200)
	assert.ElementsMatch(t, []string{"bash -c cd coral-go && go test ./...", "go test ./...", "/tmp/go-build/pkg.test -test.v"}, got, "another agent's tree and the root itself are not in it")
	assert.Empty(t, Below(procs, 999))
	assert.Empty(t, Below(procs, 320))
}

func TestARealChildIsFoundBelowThisProcess(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("ps")
	}
	cmd := exec.Command("sleep", "30")
	require.NoError(t, cmd.Start())
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		cmds, ok := CommandsBelow(context.Background(), os.Getpid())
		require.True(t, ok)
		for _, c := range cmds {
			if c == "sleep 30" {
				return
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("the child process was not found below this one")
}

func TestWhereItCannotBeKnownItSaysSo(t *testing.T) {
	_, ok := CommandsBelow(context.Background(), 1)
	assert.False(t, ok, "pid 1 and below is not asked")
	_, ok = CommandsBelow(context.Background(), 0)
	assert.False(t, ok)
}
