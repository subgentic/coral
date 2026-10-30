//go:build windows

package main

import (
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/sys/windows"

	"github.com/subgentic/coral/internal/installrestart"
)

// A tray is a coral-tray whose command line could be read and is not its server child's (--server-child, in either flag form); a process
// whose command line can't be read is never taken for a tray, so it is never ended.
func TestATrayIsACoralTrayThatIsNotAServerChild(t *testing.T) {
	cases := map[string]struct {
		p    proc
		tray bool
	}{
		"the tray":                       {proc{image: `C:\Program Files\Coral\coral-tray.exe`, cmdline: `"C:\Program Files\Coral\coral-tray.exe" --foreground --port 8450`}, true},
		"the tray as the Start Menu ran": {proc{image: `C:\Program Files\Coral\coral-tray.exe`, cmdline: `"C:\Program Files\Coral\coral-tray.exe" --backend pty`}, true},
		"upper case image":               {proc{image: `C:\Program Files (x86)\Coral\CORAL-TRAY.EXE`, cmdline: `coral-tray.exe --foreground`}, true},
		"its server child":               {proc{image: `C:\Program Files\Coral\coral-tray.exe`, cmdline: `"C:\Program Files\Coral\coral-tray.exe" --server-child --port 8450`}, false},
		"a server child, one dash":       {proc{image: `C:\Program Files\Coral\coral-tray.exe`, cmdline: `coral-tray.exe -server-child`}, false},
		"a server child, =true":          {proc{image: `C:\Program Files\Coral\coral-tray.exe`, cmdline: `coral-tray.exe --server-child=true`}, false},
		"command line unreadable":        {proc{image: `C:\Program Files\Coral\coral-tray.exe`}, false},
		"the window":                     {proc{image: `C:\Program Files\Coral\coral-app.exe`, cmdline: `coral-app.exe --url x`}, false},
		"an agent's coral-board":         {proc{image: `C:\Program Files\Coral\coral-board.exe`, cmdline: `coral-board read`}, false},
	}
	for name, c := range cases {
		assert.Equal(t, c.tray, c.p.isTray(), name)
	}
}

// Only programs inside a Coral folder count, compared as Windows compares paths; a folder whose name only starts the same doesn't.
func TestOnlyProgramsInsideTheCoralFoldersCount(t *testing.T) {
	folders := []string{`C:\Program Files\Coral`, `C:\Program Files (x86)\Coral\`}
	assert.True(t, under(`C:\Program Files\Coral\coral-tray.exe`, folders))
	assert.True(t, under(`c:\program files\coral\coral-hook-agentic-state.exe`, folders))
	assert.True(t, under(`C:\Program Files (x86)\Coral\coral.exe`, folders))
	assert.False(t, under(`C:\Program Files\Coral Rehearsal\coral-tray.exe`, folders), "another folder with the same start")
	assert.False(t, under(`C:\Program Files\Coral`, folders), "the folder itself is not a program in it")
	assert.False(t, under(`C:\Users\me\AppData\Local\Temp\coral-tray.exe`, folders))
}

// The folders come only as absolute paths, resolved as Windows resolves them (a trailing "." from the MSI goes).
func TestAFolderMustBeAbsoluteAndIsResolved(t *testing.T) {
	var m multiFlag
	assert.Error(t, m.Set(`Coral`))
	dir := t.TempDir()
	require.NoError(t, m.Set(dir+`\.`))
	want, err := filepath.EvalSymlinks(dir)
	require.NoError(t, err)
	assert.True(t, len(m) == 1 && (m[0] == want || m[0] == dir), "got %v", m)
	require.NoError(t, m.Set(`C:\No Such Folder\Coral`))
	assert.Equal(t, `C:\No Such Folder\Coral`, m[1], "a folder that doesn't exist stays as given")
}

// This process, inspected through its own handle, is this user in this session, with its program and its command line.
func TestAProcessIsReadFromItsHandle(t *testing.T) {
	me, err := currentIdentity()
	require.NoError(t, err)
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(os.Getpid()))
	require.NoError(t, err)
	defer windows.CloseHandle(h)
	p, ok := inspect(h, uint32(os.Getpid()), 0)
	require.True(t, ok)
	assert.True(t, p.who.is(me), "this user, this session")
	exe, _ := os.Executable()
	assert.True(t, filepath.Base(p.image) == filepath.Base(exe))
	assert.Contains(t, p.cmdline, "-test.", "the command line the test binary was given")
	other := identity{user: me.user, session: me.session + 1}
	assert.False(t, p.who.is(other), "another session of the same user is not this one")
}

// The log reaches its file with no standard error: Windows Installer starts the GUI helper without one, and a write to it fails (Security
// on #155: a MultiWriter with stderr stopped there, and every helper log stayed empty).
func TestTheLogReachesItsFileWithNoStandardError(t *testing.T) {
	notElevated(t) // this path is the unelevated run's: TEMP. A CI runner is an administrator, so the token is not left to chance.
	dir := t.TempDir()
	t.Setenv("TMP", dir)
	t.Setenv("TEMP", dir)
	stderr := os.Stderr
	closed, err := os.CreateTemp(t.TempDir(), "stderr")
	require.NoError(t, err)
	require.NoError(t, closed.Close())
	os.Stderr = closed
	t.Cleanup(func() { os.Stderr = stderr; log.SetOutput(stderr) })

	closeLog := openLog()
	log.Printf("a later line")
	closeLog()

	logs, err := filepath.Glob(filepath.Join(dir, "coral-msi-helper-*.log"))
	require.NoError(t, err)
	require.Len(t, logs, 1)
	b, err := os.ReadFile(logs[0])
	require.NoError(t, err)
	assert.Contains(t, string(b), "(elevated: ")
	assert.Contains(t, string(b), "a later line")
}

// notElevated makes this run's token read as not elevated for the test.
func notElevated(t *testing.T) { elevated(t, false) }

func elevated(t *testing.T, is bool) {
	t.Helper()
	old := processElevated
	processElevated = func() bool { return is }
	t.Cleanup(func() { processElevated = old })
}

// An ELEVATED run never logs into TEMP (the user's, where a link can be planted): its log is created new in the opened, plain mark folder, and TEMP stays empty (Security
// on #155). With no usable folder there is no log, never a fallback to TEMP.
func TestAnElevatedRunLogsInTheMarkFolderNeverInTemp(t *testing.T) {
	elevated(t, true)
	temp := t.TempDir()
	t.Setenv("TMP", temp)
	t.Setenv("TEMP", temp)
	mark := filepath.Join(t.TempDir(), "Coral")
	logIn(t, mark)
	stderr := os.Stderr
	t.Cleanup(func() { log.SetOutput(stderr) })

	closeLog := openLog()
	log.Printf("an elevated line")
	closeLog()

	logs, err := filepath.Glob(filepath.Join(mark, "coral-msi-helper-*.log"))
	require.NoError(t, err)
	require.Len(t, logs, 1, "the log is in the mark folder")
	b, err := os.ReadFile(logs[0])
	require.NoError(t, err)
	assert.Contains(t, string(b), "(elevated: true)")
	assert.Contains(t, string(b), "an elevated line")
	inTemp, _ := filepath.Glob(filepath.Join(temp, "coral-msi-helper-*.log"))
	assert.Empty(t, inTemp, "and nothing is written to TEMP")

	// a mark folder that is a junction: no log at all, and still nothing in TEMP
	target := t.TempDir()
	link := filepath.Join(t.TempDir(), "Coral")
	out, cerr := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput()
	require.NoError(t, cerr, "mklink /J: %s", out)
	logIn(t, link)
	closeLog = openLog()
	log.Printf("not logged")
	closeLog()
	assert.Empty(t, mustGlob(t, filepath.Join(target, "*")), "nothing was created through the junction")
	assert.Empty(t, mustGlob(t, filepath.Join(temp, "coral-msi-helper-*.log")), "no fallback to TEMP")
}

// logIn points the elevated log at dir for the test.
func logIn(t *testing.T, dir string) {
	old := createLog
	createLog = func(prefix string) (*os.File, error) { return installrestart.CreateLogIn(dir, prefix) }
	t.Cleanup(func() { createLog = old })
}

func mustGlob(t *testing.T, pattern string) []string {
	t.Helper()
	m, err := filepath.Glob(pattern)
	require.NoError(t, err)
	return m
}
