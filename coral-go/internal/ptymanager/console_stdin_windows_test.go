//go:build windows

package ptymanager

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/sys/windows"

	"github.com/subgentic/coral/internal/consoletest"
)

// The classifier on handles this test makes: a pipe, a file and the NUL device are not the console; the console's input (CONIN$, when this process has a console) is.
func TestTheStandardInputClassifierTellsTheConsoleFromAPipeAFileAndNul(t *testing.T) {
	var r, w windows.Handle
	require.NoError(t, windows.CreatePipe(&r, &w, nil, 0))
	defer windows.CloseHandle(r)
	defer windows.CloseHandle(w)
	assert.Equal(t, stdinNotConsole, classifyStdin(r), "a pipe")

	f, err := os.Create(filepath.Join(t.TempDir(), "in.txt"))
	require.NoError(t, err)
	defer f.Close()
	assert.Equal(t, stdinNotConsole, classifyStdin(windows.Handle(f.Fd())), "a file")

	nul, err := os.Open(os.DevNull)
	require.NoError(t, err)
	defer nul.Close()
	assert.Equal(t, stdinNotConsole, classifyStdin(windows.Handle(nul.Fd())), "the NUL device")

	assert.Equal(t, stdinUnreadable, classifyStdin(windows.InvalidHandle), "a handle that cannot be asked counts as a reader")

	in, err := windows.CreateFile(windows.StringToUTF16Ptr("CONIN$"), windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		t.Skipf("this test process has no console to open (%v): the console case is checked live", err)
	}
	defer windows.CloseHandle(in)
	assert.Equal(t, stdinConsole, classifyStdin(in), "the console's input")
}

// A child's standard input read from the child itself: a pipe, or NUL (Go gives a child NUL when it is given no input), is not the console; a process that is not there cannot be read.
func TestAChildsStandardInputIsReadFromTheChild(t *testing.T) {
	for name, withPipe := range map[string]bool{"a pipe": true, "NUL": false} {
		t.Run(name, func(t *testing.T) {
			cmd := consoletest.HiddenCommand("cmd.exe", "/c", "ping -n 30 127.0.0.1 >nul")
			if withPipe {
				cmd.Stdin = bytes.NewReader(nil)
			}
			require.NoError(t, cmd.Start())
			t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
			var got stdinKind
			assert.Eventually(t, func() bool { got = probeStdin(cmd.Process.Pid); return got == stdinNotConsole }, 5*time.Second, 50*time.Millisecond, "got %v", got)
		})
	}
	assert.Equal(t, stdinUnreadable, probeStdin(0), "no such process")
}
