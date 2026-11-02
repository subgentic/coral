package dataowner

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// rig is a data folder and an in-memory "database": the id row, the number of live sessions and whether the board has messages.
type rig struct {
	t        *testing.T
	dir      string
	row      string
	sessions int
	messages bool
	settings bool // sessions.db has a user_settings row
	oldLive  bool // a live session is more than a day old
	rowErr   error
}

func newRig(t *testing.T) *rig { return &rig{t: t, dir: t.TempDir()} }

func (r *rig) probe() Probe {
	return Probe{
		Dir:              r.dir,
		Marker:           func(context.Context) (string, error) { return r.row, r.rowErr },
		SetMarker:        func(_ context.Context, id string) error { r.row = id; return nil },
		LiveSessions:     func(context.Context) (int, error) { return r.sessions, nil },
		BoardHasMessages: func(context.Context) (bool, error) { return r.messages, nil },
		HasSettings:      func(context.Context) (bool, error) { return r.settings, nil },
		OldLiveSession:   func(context.Context, time.Time) (bool, error) { return r.oldLive, nil },
		Now:              time.Now,
	}
}

func (r *rig) verify() Verdict { return Verify(context.Background(), r.probe()) }

func (r *rig) put(name, body string) string {
	r.t.Helper()
	p := filepath.Join(r.dir, name)
	require.NoError(r.t, os.WriteFile(p, []byte(body), 0o600))
	return p
}

// establish makes the folder look like an old install: messages, an api_key older than a minute, and more than the databases and tokens.
func (r *rig) establish() {
	r.t.Helper()
	r.messages = true
	r.put("sessions.db", "x")
	key := r.put("api_key", "k")
	old := time.Now().Add(-2 * time.Hour)
	require.NoError(r.t, os.Chtimes(key, old, old))
	r.put("app.log", "log")
}

func TestAFirstStartMakesTheIdInBothPlacesAndVerifiesAfterwards(t *testing.T) {
	r := newRig(t)
	v := r.verify()
	assert.False(t, v.Foreign)
	assert.True(t, v.Made)
	assert.Len(t, r.row, 32)
	id, _, err := readFile(r.dir)
	require.NoError(t, err)
	assert.Equal(t, r.row, id)
	again := r.verify()
	assert.False(t, again.Foreign)
	assert.False(t, again.Made, "nothing to make the second time")
}

func TestADatabaseCopiedAloneIsForeign(t *testing.T) {
	origin := newRig(t)
	require.False(t, origin.verify().Foreign)
	copyOf := newRig(t) // an empty folder that gets the origin's database
	copyOf.row, copyOf.sessions = origin.row, 3
	v := copyOf.verify()
	assert.True(t, v.Foreign)
	assert.Equal(t, ReasonRowOnly, v.Reason)
	_, err := os.Stat(filepath.Join(copyOf.dir, FileName))
	assert.True(t, os.IsNotExist(err), "a foreign start writes no id file")
}

func TestAnOldDatabaseDroppedInABareFolderIsForeign(t *testing.T) {
	r := newRig(t)
	r.sessions = 5 // the incident: only sessions.db copied, no marker in it yet
	r.put("sessions.db", "x")
	v := r.verify()
	assert.True(t, v.Foreign)
	assert.Equal(t, ReasonBare, v.Reason)
	assert.Empty(t, r.row, "nothing is written")
}

func TestAnOldInstallUpgradingInPlaceAdoptsOnlyWhenEveryConditionHolds(t *testing.T) {
	// all conditions: adopted
	r := newRig(t)
	r.sessions = 5
	r.establish()
	v := r.verify()
	assert.False(t, v.Foreign)
	assert.True(t, v.Made)

	for name, break1 := range map[string]func(*rig){
		"no sign of earlier use in the database": func(r *rig) { r.messages = false },
		"api_key younger than a minute":          func(r *rig) { now := time.Now(); _ = os.Chtimes(filepath.Join(r.dir, "api_key"), now, now) },
		"no api_key":                             func(r *rig) { _ = os.Remove(filepath.Join(r.dir, "api_key")) },
		"nothing else in the folder":             func(r *rig) { _ = os.Remove(filepath.Join(r.dir, "app.log")) },
		"api_key is a directory, not a file": func(r *rig) {
			_ = os.Remove(filepath.Join(r.dir, "api_key"))
			_ = os.Mkdir(filepath.Join(r.dir, "api_key"), 0o755)
		},
	} {
		r := newRig(t)
		r.sessions = 5
		r.establish()
		break1(r)
		v := r.verify()
		assert.True(t, v.Foreign, name)
		assert.Equal(t, ReasonBare, v.Reason, name)
		assert.Empty(t, r.row, name)
	}
}

func TestTheFileAndTheRowMustAgree(t *testing.T) {
	r := newRig(t)
	require.False(t, r.verify().Foreign)
	r.row = strings.Repeat("a", 32)
	v := r.verify()
	assert.True(t, v.Foreign)
	assert.Equal(t, ReasonDiffer, v.Reason)

	r2 := newRig(t)
	require.False(t, r2.verify().Foreign)
	r2.row = "" // the database came without a row (a database of another install made later)
	v = r2.verify()
	assert.True(t, v.Foreign)
	assert.Equal(t, ReasonFileOnly, v.Reason)

	r3 := newRig(t)
	require.False(t, r3.verify().Foreign)
	require.NoError(t, os.Remove(filepath.Join(r3.dir, FileName))) // deleted by accident
	v = r3.verify()
	assert.True(t, v.Foreign)
	assert.Equal(t, ReasonRowOnly, v.Reason)
}

func TestAnUnreadableIdIsForeignAndNeverFatal(t *testing.T) {
	for name, body := range map[string]string{
		"garbage":       "hello",
		"too long":      strings.Repeat("a", 33) + "\n" + strings.Repeat("x", 400),
		"upper case":    strings.ToUpper(strings.Repeat("ab", 16)),
		"empty":         "",
		"with a prefix": "id " + strings.Repeat("a", 29),
	} {
		r := newRig(t)
		r.row = strings.Repeat("a", 32)
		r.put(FileName, body)
		v := r.verify()
		assert.True(t, v.Foreign, name)
		assert.Equal(t, ReasonUnreadable, v.Reason, name)
	}
	r := newRig(t)
	require.NoError(t, os.Mkdir(filepath.Join(r.dir, FileName), 0o755)) // a directory where the file should be
	assert.True(t, r.verify().Foreign)
	r2 := newRig(t)
	r2.rowErr = os.ErrPermission
	assert.True(t, r2.verify().Foreign, "the database row cannot be read")
}

func TestAWholeFolderCopyNextToTheOriginalIsForeignButAMoveOrARestoreIsNot(t *testing.T) {
	orig := newRig(t)
	require.False(t, orig.verify().Foreign)

	// a copy of the whole folder (both markers) made while the original stays
	cp := newRig(t)
	cp.row = orig.row
	data, err := os.ReadFile(filepath.Join(orig.dir, FileName))
	require.NoError(t, err)
	cp.put(FileName, string(data))
	v := cp.verify()
	assert.True(t, v.Foreign)
	assert.Equal(t, ReasonCopy, v.Reason)
	assert.Contains(t, v.Detail, filepath.Base(orig.dir), "the log line names the other folder")

	// the original is gone: a move or a restore
	require.NoError(t, os.RemoveAll(orig.dir))
	v = cp.verify()
	assert.False(t, v.Foreign)
	assert.True(t, v.Made, "the path in the file is rewritten")
	_, at, err := readFile(cp.dir)
	require.NoError(t, err)
	assert.True(t, sameFolder(at, cp.dir))
	assert.False(t, cp.verify().Foreign)
	assert.False(t, cp.verify().Made)
}

func TestACopyIsForeignWhenTheOtherFolderCannotBeRead(t *testing.T) {
	// the stored path exists but holds a different id: not a copy of this one (verified); a path that exists as a plain file cannot hold an id file, so it is also not a copy
	cp := newRig(t)
	require.False(t, cp.verify().Foreign)
	other := filepath.Join(t.TempDir(), "other")
	require.NoError(t, os.Mkdir(other, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(other, FileName), []byte(strings.Repeat("b", 32)+"\n"), 0o600))
	require.NoError(t, writeFile(cp.dir, cp.row))
	b, _ := os.ReadFile(filepath.Join(cp.dir, FileName))
	require.NoError(t, os.WriteFile(filepath.Join(cp.dir, FileName), []byte(strings.Split(string(b), "\n")[0]+"\nmade at "+other+"\n"), 0o600))
	assert.False(t, cp.verify().Foreign, "the other folder holds another id: this is not its copy")
}

func TestTheMadeAtTextIsCleanedAndCappedBeforeItIsShown(t *testing.T) {
	shown := clean("C:\\a\u202eb\x07c" + strings.Repeat("x", 300))
	assert.NotContains(t, shown, "\u202e")
	assert.NotContains(t, shown, "\x07")
	assert.LessOrEqual(t, len([]rune(shown)), 123)
	assert.Contains(t, LogLine(Verdict{Foreign: true, Reason: ReasonCopy, Detail: "D:\\x"}), "D:\\x")
}

func TestAdoptMakesTheNextStartOwnedAndWakesNothing(t *testing.T) {
	r := newRig(t)
	r.row = strings.Repeat("c", 32) // a foreign database
	r.sessions = 4
	require.True(t, r.verify().Foreign)
	require.NoError(t, Adopt(context.Background(), r.probe()))
	v := r.verify()
	assert.False(t, v.Foreign)
	assert.False(t, v.Made)
}

// Security's INFO c: the id file is read as the writer writes it, without following a link.
func TestALinkWhereTheIdFileShouldBeIsRefused(t *testing.T) {
	r := newRig(t)
	r.row = strings.Repeat("a", 32)
	target := filepath.Join(t.TempDir(), "elsewhere")
	require.NoError(t, os.WriteFile(target, []byte(r.row+"\n"), 0o600)) // a valid id, behind a link
	if err := os.Symlink(target, filepath.Join(r.dir, FileName)); err != nil {
		t.Skipf("cannot create symbolic links here: %v", err)
	}
	v := r.verify()
	assert.True(t, v.Foreign)
	assert.Equal(t, ReasonUnreadable, v.Reason)
}

// An install with agents but no board message is not mistaken for a copy after the upgrade: a user_settings row, or a live session older than a day, is a second proof of earlier use.
func TestAnInstallWithAgentsButNoBoardMessagesIsOwnedWhenItShowsEarlierUseElsewhere(t *testing.T) {
	for name, set := range map[string]func(*rig){
		"a user_settings row":             func(r *rig) { r.settings = true },
		"a live session older than a day": func(r *rig) { r.oldLive = true },
		"both":                            func(r *rig) { r.settings, r.oldLive = true, true },
	} {
		r := newRig(t)
		r.sessions = 5
		r.establish()
		r.messages = false
		set(r)
		v := r.verify()
		assert.False(t, v.Foreign, name)
		assert.True(t, v.Made, name)
	}

	none := newRig(t)
	none.sessions = 5
	none.establish()
	none.messages = false
	v := none.verify()
	assert.True(t, v.Foreign, "no board message, no setting, no old session")
	assert.Equal(t, ReasonBare, v.Reason)

	// the folder rules still apply: a database that shows earlier use, copied into a bare folder, is foreign
	bare := newRig(t)
	bare.sessions, bare.settings, bare.oldLive, bare.messages = 5, true, true, true
	bare.put("sessions.db", "x")
	assert.True(t, bare.verify().Foreign)
}

func TestTheOldSessionIsAskedForWithACutoffOneDayBack(t *testing.T) {
	r := newRig(t)
	r.sessions = 1
	r.establish()
	r.messages = false
	var cutoff time.Time
	p := r.probe()
	p.OldLiveSession = func(_ context.Context, t time.Time) (bool, error) { cutoff = t; return true, nil }
	now := time.Now()
	require.False(t, Verify(context.Background(), p).Foreign)
	assert.WithinDuration(t, now.Add(-24*time.Hour), cutoff, time.Minute)
}

// A made-at path that is not local is not read: no stat, no link resolution, no open (a network path would make Windows connect out).
func TestAMadeAtPathThatIsNotLocalIsNotRead(t *testing.T) {
	bad := []string{
		`\\127.0.0.1\x\y`,
		`\\?\C:\x`,
		`\\?\UNC\127.0.0.1\x\y`,
		`\\.\pipe\x`,
		`//127.0.0.1/x/y`,
		`file:///C:/x`,
		`https://127.0.0.1/x`,
		`C:x`,
		`\x\y`,
		`relative\folder`,
	}
	if runtime.GOOS == "windows" {
		bad = append(bad, `C:\x:stream`)
	}
	var touched []string
	oldStat, oldLstat, oldEval := statPath, lstatPath, evalLinks
	t.Cleanup(func() { statPath, lstatPath, evalLinks = oldStat, oldLstat, oldEval })
	statPath = func(p string) (os.FileInfo, error) { touched = append(touched, p); return oldStat(p) }
	lstatPath = func(p string) (os.FileInfo, error) { touched = append(touched, p); return oldLstat(p) }
	evalLinks = func(p string) (string, error) { touched = append(touched, p); return oldEval(p) }

	for _, path := range bad {
		touched = nil
		r := newRig(t)
		require.False(t, r.verify().Foreign) // makes the id in both places
		require.NoError(t, os.WriteFile(filepath.Join(r.dir, FileName), []byte(r.row+"\nmade at "+path+"\n"), 0o600))
		touched = nil
		v := r.verify()
		assert.True(t, v.Foreign, path)
		assert.Equal(t, ReasonNotLocal, v.Reason, path)
		for _, got := range touched {
			assert.NotContains(t, got, "127.0.0.1", "%s: the path in the id file was looked up", path)
			assert.NotEqual(t, path, got, "%s: the path in the id file was looked up", path)
		}
	}
}

func TestWhichPathsAreLocalAndAbsolute(t *testing.T) {
	assert.False(t, isLocalAbsolute(""))
	assert.False(t, isLocalAbsolute("relative"))
	assert.False(t, isLocalAbsolute("/x\u0007y"))
	assert.False(t, isLocalAbsolute(`\\127.0.0.1\x\y`))
	assert.False(t, isLocalAbsolute("//host/share"))
	assert.False(t, isLocalAbsolute("file:///x"))
	if runtime.GOOS == "windows" {
		assert.True(t, isLocalAbsolute(`C:\Users\x`))
		assert.True(t, isLocalAbsolute(`d:/coral`))
		assert.False(t, isLocalAbsolute(`\Users\x`))
		assert.False(t, isLocalAbsolute(`C:Users`))
		assert.False(t, isLocalAbsolute(`\\?\C:\x`))
	} else {
		assert.True(t, isLocalAbsolute("/home/x"))
	}
}

// A data folder given as a network path still recognises its own id file: the comparison with the folder Coral started with is text only.
func TestAFolderRecognisesItsOwnPathWithoutLookingItUp(t *testing.T) {
	dir := t.TempDir()
	assert.True(t, sameText(dir, dir))
	assert.True(t, sameText(dir+string(filepath.Separator), dir))
	assert.False(t, sameText(dir, filepath.Join(dir, "other")))
}
