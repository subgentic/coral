package main

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeCoralAgent is a coral-agent that records how it was called and keeps the file it was given.
func fakeCoralAgent(t *testing.T) (record, kept string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the fake tool is a shell script")
	}
	dir := t.TempDir()
	record, kept = filepath.Join(dir, "args"), filepath.Join(dir, "kept")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > '" + record + "'\ncp \"$3\" '" + kept + "'\n"
	tool := filepath.Join(dir, "coral-agent")
	require.NoError(t, os.WriteFile(tool, []byte(script), 0o755))
	t.Setenv("MOCK_AGENT_CORAL_AGENT", tool)
	return record, kept
}

// #10739: MOCK_SHARE_FILE <name> makes the stand-in upload a small generated file as an artifact, through coral-agent like a real agent: a text name gives text, a .png name a real PNG, and the line
// it is typed as is a control (no turn of its own).
func TestMockShareFileUploadsAGeneratedFile(t *testing.T) {
	record, kept := fakeCoralAgent(t)

	handled, waiting := applyControl(&inputBox{}, "MOCK_SHARE_FILE notes.txt")
	assert.True(t, handled)
	assert.False(t, waiting)
	args, err := os.ReadFile(record)
	require.NoError(t, err)
	got := strings.Fields(string(args))
	require.Len(t, got, 7)
	assert.Equal(t, []string{"artifact", "upload"}, got[:2])
	assert.Equal(t, []string{"--name", "notes.txt", "--media-type", "text/plain"}, got[3:])
	text, err := os.ReadFile(kept)
	require.NoError(t, err)
	assert.Contains(t, string(text), "Shared by mock-agent")

	_ = os.Remove(record)
	assert.Equal(t, "[mock-agent] shared picture.png", shareFile("picture.png"))
	args, err = os.ReadFile(record)
	require.NoError(t, err)
	assert.Contains(t, string(args), "image/png")
	img, err := os.ReadFile(kept)
	require.NoError(t, err)
	assert.True(t, bytes.HasPrefix(img, []byte("\x89PNG\r\n\x1a\n")), "a .png name is a real PNG")

	assert.Equal(t, "[mock-agent] shared mock-share.txt", shareFile(""), "no name: a default one")
}

func TestMockShareFileRefusesABadNameAndSaysWhenThereIsNoTool(t *testing.T) {
	fakeCoralAgent(t)
	for _, bad := range []string{"../escape.txt", "a/b.txt", "-flag", strings.Repeat("x", 80)} {
		assert.Contains(t, shareFile(bad), "takes a plain file name", bad)
	}
	t.Setenv("MOCK_AGENT_CORAL_AGENT", "")
	exe, _ := os.Executable()
	if _, err := os.Stat(filepath.Join(filepath.Dir(exe), "coral-agent")); err != nil {
		assert.Contains(t, shareFile("a.txt"), "no coral-agent")
	}
}
