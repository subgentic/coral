//go:build windows

package installrestart

import (
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/sys/windows"

	"github.com/subgentic/coral/internal/linktest"
)

var linkNow = time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)

func junction(t *testing.T, link, target string) {
	t.Helper()
	out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput()
	require.NoError(t, err, "mklink /J: %s", out)
}

func entries(t *testing.T, dir string) []string {
	t.Helper()
	es, err := os.ReadDir(dir)
	require.NoError(t, err)
	var names []string
	for _, e := range es {
		names = append(names, e.Name())
	}
	return names
}

// The elevated helper must not write, read or remove through a link in the place of the folder (Security's #5051, on #155): a junction, a symbolic
// link to a folder or a link to a file where the folder should be is refused, and nothing in what it points at changes. Real links, no mocks.
func TestAFolderThatIsALinkIsNeverUsed(t *testing.T) {
	check := func(t *testing.T, dir, target string) {
		t.Helper()
		before := entries(t, target)
		err := Mark(linkNow)
		assert.Error(t, err, "Mark refuses a folder that is a link")
		assert.Equal(t, before, entries(t, target), "nothing was created in what the link points at")
		assert.NoError(t, os.WriteFile(filepath.Join(target, fileName), []byte(linkNow.Format(time.RFC3339)+"\n"), 0o600), "a mark planted in the target")
		assert.False(t, Take(linkNow), "Take starts nothing through a link")
		_, statErr := os.Stat(filepath.Join(target, fileName))
		assert.NoError(t, statErr, "and does not remove the target's file")
		_ = Discard()
		_, statErr = os.Stat(filepath.Join(target, fileName))
		assert.NoError(t, statErr, "Discard does not remove the target's file either")
	}

	t.Run("a junction", func(t *testing.T) {
		dir := inTemp(t)
		target := t.TempDir()
		junction(t, dir, target)
		check(t, dir, target)
	})
	t.Run("a symbolic link to a folder", func(t *testing.T) {
		dir := inTemp(t)
		target := t.TempDir()
		linktest.Symlink(t, target, dir)
		check(t, dir, target)
	})
}

// A link anywhere above the folder is a link too: the folder is reached through it, so its final path is not the path it was asked for.
func TestAFolderReachedThroughALinkIsNeverUsed(t *testing.T) {
	real := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(real, "Coral"), 0o700))
	via := filepath.Join(t.TempDir(), "Local")
	junction(t, via, real)
	old := folder
	folder = func() (string, error) { return filepath.Join(via, "Coral"), nil }
	t.Cleanup(func() { folder = old })

	// Some Windows builds refuse to walk the junction at all (before our check); the others reach it and ErrNotPlainFolder refuses. Either way: refused, nothing changed.
	assert.Error(t, Mark(linkNow))
	assert.Empty(t, entries(t, filepath.Join(real, "Coral")), "nothing was created behind the link")
	require.NoError(t, os.WriteFile(filepath.Join(real, "Coral", fileName), []byte(linkNow.Format(time.RFC3339)+"\n"), 0o600))
	assert.False(t, Take(linkNow))
	assert.Equal(t, []string{fileName}, entries(t, filepath.Join(real, "Coral")), "and nothing was removed there")
}

// The ancestor check compares the handle's final path with the path asked for: a different folder (a link above) is not the same, case is.
func TestSameFolderComparesTheFinalPathWithTheAskedOne(t *testing.T) {
	assert.True(t, sameFolder(`\\?\C:\Users\u\AppData\Local\Coral`, `C:\Users\u\AppData\Local\Coral`))
	assert.True(t, sameFolder(`\\?\c:\users\U\appdata\local\CORAL`, `C:\Users\u\AppData\Local\Coral`), "case is not a difference")
	assert.False(t, sameFolder(`\\?\D:\scratch\target\Coral`, `C:\Users\u\AppData\Local\Coral`), "an ancestor junction: the folder really is elsewhere")
	assert.False(t, sameFolder(`\\?\C:\Users\u\AppData\Local\Coral2`, `C:\Users\u\AppData\Local\Coral`))
	assert.False(t, sameFolder(`\\?\C:\Users\u\AppData\Local\Coral\sub`, `C:\Users\u\AppData\Local\Coral`))
}

// What has the mark's name inside the folder is a link too (a junction, a symbolic link, a hard link): it is removed as itself, the mark is
// created new, and the target is not touched. Take and Discard do the same.
func TestALinkWithTheMarksNameIsRemovedAsItself(t *testing.T) {
	dir := inTemp(t)
	require.NoError(t, os.MkdirAll(dir, 0o700))
	name := filepath.Join(dir, fileName)

	linktest.Each(t, name, func(t *testing.T, p linktest.Planted) {
		require.NoError(t, Mark(linkNow))
		b, err := os.ReadFile(name)
		require.NoError(t, err)
		assert.Equal(t, linkNow.Format(time.RFC3339)+"\n", string(b), "the mark is a new file")
		require.NoError(t, os.Remove(name))
	})
	linktest.Each(t, name, func(t *testing.T, p linktest.Planted) {
		assert.False(t, Take(linkNow), "a link is not a mark")
		_, err := os.Lstat(name)
		assert.True(t, os.IsNotExist(err), "the link itself is gone")
	})
	linktest.Each(t, name, func(t *testing.T, p linktest.Planted) {
		require.NoError(t, Discard())
		_, err := os.Lstat(name)
		assert.True(t, os.IsNotExist(err), "the link itself is gone")
	})
}

// The swap: once Mark has the folder open, the user cannot rename it or remove it to put a junction in its place (the handle holds it, with no
// delete sharing), so the create goes into the folder that was checked. The hook tries both from inside Mark.
func TestTheFolderCannotBeSwappedWhileTheMarkIsWritten(t *testing.T) {
	dir := inTemp(t)
	target := t.TempDir()
	var renameErr, removeErr error
	afterFolderOpen = func() {
		renameErr = os.Rename(dir, dir+"-moved")
		removeErr = os.Remove(dir)
		if renameErr == nil { // it should not get this far; if it did, put the junction where the folder was
			junction(t, dir, target)
		}
	}
	t.Cleanup(func() { afterFolderOpen = func() {} })

	require.NoError(t, Mark(linkNow))
	assert.Error(t, renameErr, "the folder cannot be renamed while it is held")
	assert.Error(t, removeErr, "nor removed")
	assert.Empty(t, entries(t, target), "nothing reached the junction's target")
	b, err := os.ReadFile(filepath.Join(dir, fileName))
	require.NoError(t, err)
	assert.Equal(t, linkNow.Format(time.RFC3339)+"\n", string(b), "the mark is in the folder that was checked")
	assert.True(t, Take(linkNow))
}

// openPlainFolder itself, with no MkdirAll in front of it (some Windows builds make os.MkdirAll fail on a junction first, which would hide a missing check): a junction in the
// folder's place is opened as the junction and refused by its own reparse flag; a plain folder is opened and held.
func TestOpenPlainFolderRefusesAJunctionByItsReparseFlag(t *testing.T) {
	target := t.TempDir()
	link := filepath.Join(t.TempDir(), "Coral")
	junction(t, link, target)
	d, err := openPlainFolder(link)
	if err == nil {
		d.Close()
	}
	assert.ErrorIs(t, err, ErrNotPlainFolder)

	plain := filepath.Join(t.TempDir(), "Coral")
	require.NoError(t, os.MkdirAll(plain, 0o700))
	d, err = openPlainFolder(plain)
	require.NoError(t, err)
	d.Close()

	_, err = openPlainFolder(filepath.Join(t.TempDir(), "missing"))
	assert.Error(t, err)
	assert.True(t, notFound(err), "a missing folder is 'not found', not 'not plain'")
}

// The ancestor check is used: when the opened folder's final path is not the path asked for (what an ancestor link makes it), openPlainFolder refuses, and Mark/Take touch nothing.
func TestAFinalPathThatIsNotTheAskedOneIsRefused(t *testing.T) {
	dir := inTemp(t)
	require.NoError(t, os.MkdirAll(dir, 0o700))
	old := finalPathOf
	finalPathOf = func(windows.Handle) (string, error) { return `\\?\D:\somewhere\else\Coral`, nil }
	t.Cleanup(func() { finalPathOf = old })

	assert.ErrorIs(t, Mark(linkNow), ErrNotPlainFolder)
	assert.Empty(t, entries(t, dir), "nothing was written")
	require.NoError(t, os.WriteFile(filepath.Join(dir, fileName), []byte(linkNow.Format(time.RFC3339)+"\n"), 0o600))
	assert.False(t, Take(linkNow))
	assert.Equal(t, []string{fileName}, entries(t, dir), "and nothing was removed")
}

// (c) The mark's folder follows the product the program is installed as: the tray and the installer's helper of one install compute the same folder, and the
// rehearsal's ("Coral Rehearsal") is not the live Coral's.
func TestTheMarksFolderFollowsTheProductAndTheTrayAndTheHelperAgree(t *testing.T) {
	live := `C:\Program Files\Coral`
	rehearsal := `C:\Program Files\Coral Rehearsal`
	for exe, want := range map[string]string{
		live + `\coral-tray.exe`:                   "Coral",
		live + `\coral-msi-helper.exe`:             "Coral",
		rehearsal + `\coral-tray.exe`:              "Coral Rehearsal",
		rehearsal + `\coral-msi-helper.exe`:        "Coral Rehearsal",
		`D:\build\coral-go\coral.exe`:              "Coral", // a build or a portable copy is not a product install
		`C:\Users\u\Downloads\coral-tray.exe`:      "Coral",
		`C:\Program Files\Coral ..\coral-tray.exe`: "Coral",
		`C:\Program Files\Coral Re hearsal\x.exe`:  "Coral",
	} {
		assert.Equal(t, want, productFolderName(exe), exe)
	}
	local := `C:\Users\u\AppData\Local`
	assert.Equal(t, folderUnder(local, live+`\coral-tray.exe`), folderUnder(local, live+`\coral-msi-helper.exe`), "the live tray and helper agree")
	assert.Equal(t, folderUnder(local, rehearsal+`\coral-tray.exe`), folderUnder(local, rehearsal+`\coral-msi-helper.exe`), "the rehearsal's tray and helper agree")
	assert.NotEqual(t, folderUnder(local, live+`\coral-tray.exe`), folderUnder(local, rehearsal+`\coral-tray.exe`))
}

// The rehearsal never touches the live Coral's folder, nor its mark: its helper marks, the live tray takes nothing, and the live folder gets no file.
func TestACoralRehearsalNeverTouchesCoral(t *testing.T) {
	local := t.TempDir()
	liveDir := filepath.Join(local, "Coral")
	require.NoError(t, os.MkdirAll(liveDir, 0o700))
	as := func(exe string) {
		old := folder
		folder = func() (string, error) { return folderUnder(local, exe), nil }
		t.Cleanup(func() { folder = old })
	}
	as(`C:\Program Files\Coral Rehearsal\coral-msi-helper.exe`)
	require.NoError(t, Mark(linkNow))
	assert.Empty(t, entries(t, liveDir), "the rehearsal's mark is not in the live Coral's folder")
	assert.FileExists(t, filepath.Join(local, "Coral Rehearsal", fileName))

	as(`C:\Program Files\Coral\coral-tray.exe`)
	assert.False(t, Take(linkNow), "the live Coral's tray finds no mark: the rehearsal's is not its own")
	require.NoError(t, Discard())
	assert.FileExists(t, filepath.Join(local, "Coral Rehearsal", fileName), "and the live Coral's Discard does not remove the rehearsal's")

	as(`C:\Program Files\Coral Rehearsal\coral-tray.exe`)
	assert.True(t, Take(linkNow), "the rehearsal's own tray takes it")
}

// (d) An elevated program's log is created new in the opened, plain mark folder, never in TEMP, and never through a link.
func TestTheElevatedLogIsCreatedNewInThePlainFolder(t *testing.T) {
	dir := inTemp(t)
	a, err := CreateLog("coral-msi-helper")
	require.NoError(t, err)
	_, err = a.WriteString("one\n")
	require.NoError(t, err)
	require.NoError(t, a.Close())
	b, err := CreateLog("coral-msi-helper")
	require.NoError(t, err)
	require.NoError(t, b.Close())
	names := entries(t, dir)
	require.Len(t, names, 2, "each log is a new file")
	assert.Regexp(t, `^coral-msi-helper-[0-9a-f]{16}\.log$`, names[0])
	got, err := os.ReadFile(filepath.Join(dir, a.Name()))
	require.NoError(t, err)
	assert.Equal(t, "one\n", string(got))

	// a junction in the folder's place: refused, nothing created in its target
	dir2 := inTemp(t)
	target := t.TempDir()
	junction(t, dir2, target)
	f, err := CreateLog("coral-msi-helper")
	if f != nil {
		f.Close()
	}
	assert.Error(t, err)
	assert.Empty(t, entries(t, target), "nothing was created through the junction")
	f, err = nil, nil
	_ = f
	// and the same through openPlainFolder directly (some builds fail MkdirAll first)
	_, err = openPlainFolder(dir2)
	assert.ErrorIs(t, err, ErrNotPlainFolder)
}

// A real junction is refused by its reparse flag ALONE: with the final-path check stubbed to agree (it returns the path that was asked for), the junction's own handle still
// says reparse point, so the second check is not what saves it.
func TestAJunctionIsRefusedByTheReparseFlagAlone(t *testing.T) {
	target := t.TempDir()
	link := filepath.Join(t.TempDir(), "Coral")
	junction(t, link, target)
	old := finalPathOf
	finalPathOf = func(windows.Handle) (string, error) { return `\\?\` + link, nil } // agrees with the asked path
	t.Cleanup(func() { finalPathOf = old })
	d, err := openPlainFolder(link)
	if err == nil {
		d.Close()
	}
	assert.ErrorIs(t, err, ErrNotPlainFolder)
}

// (4a) The folder is made through the handle code, not os.MkdirAll: missing levels are created one at a time, each below a parent opened as a plain folder, so an elevated
// helper cannot create an empty folder behind a link; an existing plain folder is left as it is.
func TestTheFolderIsMadeThroughTheHandleCode(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "a", "b", "Coral")
	require.NoError(t, makeFolder(dir))
	fi, err := os.Stat(dir)
	require.NoError(t, err)
	assert.True(t, fi.IsDir())
	require.NoError(t, makeFolder(dir), "an existing plain folder is fine")

	old := folder
	folder = func() (string, error) { return filepath.Join(root, "x", "y", "Coral"), nil }
	t.Cleanup(func() { folder = old })
	require.NoError(t, Mark(linkNow), "a missing profile chain is made")
	assert.FileExists(t, filepath.Join(root, "x", "y", "Coral", fileName))

	// behind a junction: nothing is created in the target, whatever this build does with the junction
	real := t.TempDir()
	via := filepath.Join(t.TempDir(), "Local")
	junction(t, via, real)
	assert.Error(t, makeFolder(filepath.Join(via, "Coral")))
	assert.Empty(t, entries(t, real), "nothing was created behind the junction")

	// a file where a folder level should be, and a junction as the folder itself, are refused, not "made"
	file := filepath.Join(root, "afile")
	require.NoError(t, os.WriteFile(file, []byte("x"), 0o600))
	assert.Error(t, makeFolder(filepath.Join(file, "Coral")))
	asJunction := filepath.Join(t.TempDir(), "Coral")
	target := t.TempDir()
	junction(t, asJunction, target)
	assert.ErrorIs(t, makeFolder(asJunction), ErrNotPlainFolder)
	assert.Empty(t, entries(t, target))
}

// (4b) A refusal says why in one line, so "Coral did not restart after the install" can be explained from the helper's log.
func TestARefusedFolderSaysWhyInTheLog(t *testing.T) {
	var logs strings.Builder
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })

	target := t.TempDir()
	link := filepath.Join(t.TempDir(), "Coral")
	junction(t, link, target)
	_, err := openPlainFolder(link)
	assert.ErrorIs(t, err, ErrNotPlainFolder)
	assert.Contains(t, logs.String(), "is a link or not a folder")

	logs.Reset()
	plain := filepath.Join(t.TempDir(), "Coral")
	require.NoError(t, os.MkdirAll(plain, 0o700))
	old := finalPathOf
	finalPathOf = func(windows.Handle) (string, error) { return `\\?\D:\OneDrive\Local\Coral`, nil }
	t.Cleanup(func() { finalPathOf = old })
	_, err = openPlainFolder(plain)
	assert.ErrorIs(t, err, ErrNotPlainFolder)
	assert.Contains(t, logs.String(), "is really")
	assert.Contains(t, logs.String(), `D:\OneDrive\Local\Coral`)
	assert.Contains(t, logs.String(), "OneDrive")
}

// #230's launch-pending mark has the same rules (the helper may write it elevated): never through a link in the folder's place or at its name, in the opened folder,
// and fresh once.
func TestTheLaunchPendingMarkNeverGoesThroughALink(t *testing.T) {
	dir := inTemp(t)
	target := t.TempDir()
	junction(t, dir, target)
	assert.Error(t, MarkLaunchPending(linkNow), "a junction where the folder should be")
	assert.Empty(t, entries(t, target), "nothing was created in its target")
	require.NoError(t, os.Remove(dir))

	require.NoError(t, os.MkdirAll(dir, 0o700))
	name := filepath.Join(dir, launchPendingName)
	linktest.Each(t, name, func(t *testing.T, p linktest.Planted) {
		require.NoError(t, MarkLaunchPending(linkNow))
		b, err := os.ReadFile(name)
		require.NoError(t, err)
		assert.Equal(t, linkNow.Format(time.RFC3339)+"\n", string(b), "a new file, the link was removed as itself")
		assert.True(t, TakeLaunchPending(linkNow.Add(time.Minute)), "fresh within two minutes, once")
		assert.False(t, TakeLaunchPending(linkNow.Add(time.Minute)))
	})
}
