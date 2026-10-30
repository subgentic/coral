//go:build windows

package ptymanager

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/sys/windows"
)

// The handoff script's folder is compared with its 8.3 short names expanded: a short-name spelling of the folder is the same script.
func TestSameScriptPathExpandsAShortFolderName(t *testing.T) {
	long := filepath.Join(t.TempDir(), "a folder with a long name")
	require.NoError(t, os.MkdirAll(long, 0o700))
	in, err := windows.UTF16PtrFromString(long)
	require.NoError(t, err)
	buf := make([]uint16, 1024)
	n, err := windows.GetShortPathName(in, &buf[0], uint32(len(buf)))
	if err != nil || n == 0 || int(n) > len(buf) {
		t.Skip("this volume gives no short names")
	}
	short := windows.UTF16ToString(buf[:n])
	if short == long {
		t.Skip("this volume gives no short names")
	}
	script := "coral-command-1.ps1"
	assert.True(t, sameScriptPath(filepath.Join(short, script), filepath.Join(long, script)), "the short spelling of the folder")
	assert.False(t, sameScriptPath(filepath.Join(short, "coral-command-2.ps1"), filepath.Join(long, script)), "another file in it")
}
