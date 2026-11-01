package foldertrust

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/pelletier/go-toml/v2"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11889: launching a team in a folder counts as trusting it for the team's agents, under Security's conditions: only a folder Coral made in this launch, or one the person ticked by name; never the home
// folder or a parent of it, a direct child of it (unless Coral made it), a root or a hidden folder under home; writes that change one entry and nothing else, through a private temp file, never over a link.

type rig struct{ home, work string }

func newRig(t *testing.T) rig {
	t.Helper()
	home, err := filepath.EvalSymlinks(t.TempDir())
	require.NoError(t, err)
	work := filepath.Join(home, "Coral", "team-one")
	require.NoError(t, os.MkdirAll(work, 0o700))
	return rig{home: home, work: work}
}

func TestCheckAcceptsACoralMadeFolderAndATickedOneButNotTheRest(t *testing.T) {
	r := newRig(t)
	got, err := Check(r.work, r.home, Made)
	require.NoError(t, err)
	assert.Equal(t, r.work, got)

	// an existing folder needs the person's tick
	existing := filepath.Join(r.home, "Code", "app")
	require.NoError(t, os.MkdirAll(existing, 0o755))
	_, err = Check(existing, r.home, Existing)
	assert.ErrorIs(t, err, ErrNotTicked)
	got, err = Check(existing, r.home, Ticked)
	require.NoError(t, err)
	assert.Equal(t, existing, got)

	// never: home itself, a parent of home, the root, a direct child of home (unless Coral made it), a hidden folder under home, a missing folder, a relative path, a file
	child := filepath.Join(r.home, "Documents")
	require.NoError(t, os.MkdirAll(child, 0o755))
	hidden := filepath.Join(r.home, ".claude", "projects")
	require.NoError(t, os.MkdirAll(hidden, 0o755))
	file := filepath.Join(r.home, "Code", "a.txt")
	require.NoError(t, os.WriteFile(file, []byte("x"), 0o600))
	for name, p := range map[string]string{
		"home": r.home, "parent of home": filepath.Dir(r.home), "root": string(filepath.Separator), "hidden": hidden,
		"missing": filepath.Join(r.home, "Code", "nope"), "relative": "Code/app", "file": file, "empty": "", "newline": existing + "\nx",
	} {
		for _, how := range []Basis{Made, Ticked} {
			_, err := Check(p, r.home, how)
			assert.Error(t, err, "%s (%v)", name, how)
		}
	}
	// a direct child of home covers every repo the person puts under it: refused unless Coral made it in this launch
	for _, how := range []Basis{Existing, Ticked} {
		_, err := Check(child, r.home, how)
		assert.Error(t, err, "direct child of home (%v)", how)
	}
	got, err = Check(child, r.home, Made)
	require.NoError(t, err)
	assert.Equal(t, child, got)
}

func TestCheckTrustsTheResolvedPathAndRefusesALinkToHome(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("links")
	}
	r := newRig(t)
	link := filepath.Join(r.home, "Coral", "homelink")
	require.NoError(t, os.Symlink(r.home, link))
	_, err := Check(link, r.home, Made)
	assert.Error(t, err, "a link to home is home")
	// a link to a good folder is checked and returned as the folder it points at
	real := filepath.Join(r.home, "Code", "real")
	require.NoError(t, os.MkdirAll(real, 0o755))
	good := filepath.Join(r.home, "Coral", "reallink")
	require.NoError(t, os.Symlink(real, good))
	got, err := Check(good, r.home, Ticked)
	require.NoError(t, err)
	assert.Equal(t, real, got)
	// home given as a link is resolved too
	linkedHome := filepath.Join(t.TempDir(), "h")
	require.NoError(t, os.Symlink(r.home, linkedHome))
	_, err = Check(r.home, linkedHome, Ticked)
	assert.Error(t, err, "the same folder under another spelling of home is still home")
}

func writeJSON(t *testing.T, p string, v string) {
	t.Helper()
	require.NoError(t, os.WriteFile(p, []byte(v), 0o600))
}

func readMap(t *testing.T, p string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(p)
	require.NoError(t, err)
	var m map[string]any
	require.NoError(t, json.Unmarshal(b, &m))
	return m
}

func TestTrustClaudeSetsTheOneEntryAndChangesNothingElse(t *testing.T) {
	r := newRig(t)
	cfg := filepath.Join(r.home, ".claude.json")
	writeJSON(t, cfg, `{"userID":"abc","numStartups":12345678901234567,"oauthAccount":{"emailAddress":"a@b.c","note":"<tag> & more"},"projects":{"/other":{"hasTrustDialogAccepted":false,"allowedTools":["Bash"]},"`+r.work+`":{"lastCost":1.5}}}`)
	if runtime.GOOS != "windows" {
		require.NoError(t, os.Chmod(cfg, 0o640))
	}
	changed, err := TrustClaude(cfg, r.work)
	require.NoError(t, err)
	assert.True(t, changed)
	b, _ := os.ReadFile(cfg)
	assert.Contains(t, string(b), "12345678901234567", "a number is kept to the digit")
	assert.Contains(t, string(b), "<tag> & more", "text is not re-escaped")
	m := readMap(t, cfg)
	assert.Equal(t, "abc", m["userID"])
	proj := m["projects"].(map[string]any)
	assert.Equal(t, map[string]any{"hasTrustDialogAccepted": false, "allowedTools": []any{"Bash"}}, proj["/other"], "another project is as it was")
	assert.Equal(t, map[string]any{"lastCost": 1.5, "hasTrustDialogAccepted": true}, proj[r.work], "the entry gains the one key")
	if runtime.GOOS != "windows" {
		fi, _ := os.Stat(cfg)
		assert.Equal(t, os.FileMode(0o640), fi.Mode().Perm(), "the file's own mode")
	}
	again, err := TrustClaude(cfg, r.work)
	require.NoError(t, err)
	assert.False(t, again, "already trusted: nothing written")
	entries, _ := os.ReadDir(r.home)
	for _, e := range entries {
		assert.False(t, strings.HasPrefix(e.Name(), ".claude.json.") || strings.HasPrefix(e.Name(), ".foldertrust"), "no temp file is left: %s", e.Name())
	}
}

func TestTrustClaudeCreatesTheEntryWhereThereIsNoProjectsAndLeavesADecisionAlone(t *testing.T) {
	r := newRig(t)
	cfg := filepath.Join(r.home, ".claude.json")
	writeJSON(t, cfg, `{"userID":"abc"}`)
	changed, err := TrustClaude(cfg, r.work)
	require.NoError(t, err)
	assert.True(t, changed)
	assert.Equal(t, map[string]any{r.work: map[string]any{"hasTrustDialogAccepted": true}}, readMap(t, cfg)["projects"])

	// a path the person turned trust down for stays turned down
	writeJSON(t, cfg, `{"projects":{"`+r.work+`":{"hasTrustDialogAccepted":false}}}`)
	before, _ := os.ReadFile(cfg)
	changed, err = TrustClaude(cfg, r.work)
	assert.ErrorIs(t, err, ErrDeclined)
	assert.False(t, changed)
	after, _ := os.ReadFile(cfg)
	assert.Equal(t, string(before), string(after))
}

func TestTrustClaudeRefusesWhatItCannotChangeSafely(t *testing.T) {
	r := newRig(t)
	cfg := filepath.Join(r.home, ".claude.json")
	_, err := TrustClaude(cfg, r.work)
	assert.ErrorIs(t, err, ErrNoConfig, "an absent file is not made: Claude makes it, and the card stays")
	_, statErr := os.Stat(cfg)
	assert.True(t, os.IsNotExist(statErr))
	for name, body := range map[string]string{"not json": "{", "an array": "[]", "projects a string": `{"projects":"x"}`, "entry a string": `{"projects":{"` + r.work + `":"x"}}`, "flag a string": `{"projects":{"` + r.work + `":{"hasTrustDialogAccepted":"yes"}}}`} {
		writeJSON(t, cfg, body)
		_, err := TrustClaude(cfg, r.work)
		assert.Error(t, err, name)
		got, _ := os.ReadFile(cfg)
		assert.Equal(t, body, string(got), name+": untouched")
	}
	if runtime.GOOS != "windows" {
		real := filepath.Join(t.TempDir(), "real.json")
		writeJSON(t, real, `{"userID":"abc"}`)
		link := filepath.Join(r.home, "linked.json")
		require.NoError(t, os.Symlink(real, link))
		_, err = TrustClaude(link, r.work)
		assert.ErrorIs(t, err, ErrLinked, "a dotfile manager's link is never renamed over")
		got, _ := os.ReadFile(real)
		assert.Equal(t, `{"userID":"abc"}`, string(got))
	}
	// over the size cap
	writeJSON(t, cfg, `{"x":"`+strings.Repeat("a", maxConfigBytes)+`"}`)
	_, err = TrustClaude(cfg, r.work)
	assert.Error(t, err)
}

func TestTrustCodexAppendsOneTableAndNeverOverridesOrBreaksTheFile(t *testing.T) {
	r := newRig(t)
	cfg := filepath.Join(r.home, "config.toml")
	orig := "model = \"gpt-5\"\n# my notes\n[history]\npersistence = \"save-all\"\n"
	require.NoError(t, os.WriteFile(cfg, []byte(orig), 0o600))
	changed, err := TrustCodex(cfg, r.work)
	require.NoError(t, err)
	assert.True(t, changed)
	b, _ := os.ReadFile(cfg)
	assert.True(t, strings.HasPrefix(string(b), orig), "everything that was there is as it was, byte for byte")
	var parsed map[string]any
	require.NoError(t, toml.Unmarshal(b, &parsed))
	assert.Equal(t, map[string]any{"trust_level": "trusted"}, parsed["projects"].(map[string]any)[r.work])
	again, err := TrustCodex(cfg, r.work)
	require.NoError(t, err)
	assert.False(t, again)

	// a file that is not there is made, with the one table
	fresh := filepath.Join(r.home, "fresh.toml")
	changed, err = TrustCodex(fresh, r.work)
	require.NoError(t, err)
	assert.True(t, changed)

	// an explicit untrusted stays
	require.NoError(t, os.WriteFile(cfg, []byte("[projects.\""+r.work+"\"]\ntrust_level = \"untrusted\"\n"), 0o600))
	before, _ := os.ReadFile(cfg)
	_, err = TrustCodex(cfg, r.work)
	assert.ErrorIs(t, err, ErrDeclined)
	after, _ := os.ReadFile(cfg)
	assert.Equal(t, string(before), string(after))
}

func TestTrustCodexLeavesTheCardWhenAppendingWouldBreakTheFileOrTheNameIsUnsafe(t *testing.T) {
	r := newRig(t)
	cfg := filepath.Join(r.home, "config.toml")
	// projects as an inline table: a [projects."x"] table after it is invalid TOML
	for name, body := range map[string]string{
		"inline projects":  "projects = { \"/other\" = { trust_level = \"trusted\" } }\n",
		"projects a value": "projects = 3\n",
		"not toml":         "this is = = not toml\n",
	} {
		require.NoError(t, os.WriteFile(cfg, []byte(body), 0o600))
		_, err := TrustCodex(cfg, r.work)
		assert.Error(t, err, name)
		got, _ := os.ReadFile(cfg)
		assert.Equal(t, body, string(got), name+": untouched")
	}
	for _, bad := range []string{`/a"b`, `/a\b`, "/a\tb", "/a\nb", "/a\x7fb"} {
		require.NoError(t, os.WriteFile(cfg, []byte("model = \"x\"\n"), 0o600))
		_, err := TrustCodex(cfg, bad)
		assert.Error(t, err, "%q", bad)
		got, _ := os.ReadFile(cfg)
		assert.Equal(t, "model = \"x\"\n", string(got))
	}
	// the same path written another way (a trailing slash) is already there: not added twice
	require.NoError(t, os.WriteFile(cfg, []byte("[projects.\""+r.work+"/\"]\ntrust_level = \"trusted\"\n"), 0o600))
	changed, err := TrustCodex(cfg, r.work)
	require.NoError(t, err)
	assert.False(t, changed)
	if runtime.GOOS != "windows" {
		real := filepath.Join(t.TempDir(), "real.toml")
		require.NoError(t, os.WriteFile(real, []byte("model = \"x\"\n"), 0o600))
		link := filepath.Join(r.home, "link.toml")
		require.NoError(t, os.Symlink(real, link))
		_, err = TrustCodex(link, r.work)
		assert.ErrorIs(t, err, ErrLinked)
	}
}

// Security's SHOULD on #11889: a folder outside home that others can write into is not trusted: a ticked /tmp/proj, /srv/proj or /Volumes/Backup would let anyone on the computer plant the settings, hooks and tools
// that then run with no card. Shared roots and folders shallower than three components are refused outside home, and so is an outside folder that group or other can write.
func TestASharedOrShallowFolderOutsideHomeIsRefused(t *testing.T) {
	for _, bad := range []string{
		"/tmp", "/tmp/proj", "/private/tmp/proj", "/private/tmp/a/b", "/var/tmp/x", "/private/var/tmp/x", "/srv/proj", "/opt/proj", "/mnt/proj", "/media/proj", "/Volumes/Backup", "/Users/Shared", "/Users/Shared/proj",
		"/Users", "/home", "/usr/local", "/var", "/etc",
	} {
		assert.NotEmpty(t, sharedOrShallow(bad), bad)
	}
	for _, ok := range []string{"/Volumes/Backup/proj", "/srv/team/proj", "/opt/work/proj", "/data/projects/app", "/mnt/disk/proj"} {
		assert.Empty(t, sharedOrShallow(ok), ok)
	}
	if runtime.GOOS == "windows" {
		t.Skip("Unix paths")
	}
	// through Check: a real folder in /tmp is refused whatever it is made of
	if fi, err := os.Stat("/tmp"); err == nil && fi.IsDir() {
		dir, err := os.MkdirTemp("/tmp", "foldertrust-test-")
		if err == nil {
			t.Cleanup(func() { os.RemoveAll(dir) })
			home, _ := filepath.EvalSymlinks(t.TempDir())
			_, err := Check(dir, home, Ticked)
			assert.Error(t, err, "a ticked folder in /tmp")
		}
	}
}

func TestAnOutsideFolderThatOthersCanWriteIsRefused(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("modes")
	}
	r := newRig(t)
	outside := outsideBase(t)
	mine := filepath.Join(outside, "a", "b", "proj")
	require.NoError(t, os.MkdirAll(mine, 0o755))
	got, err := Check(mine, r.home, Ticked)
	require.NoError(t, err, "a folder outside home that only its owner can write")
	assert.Equal(t, mine, got)
	for _, mode := range []os.FileMode{0o775, 0o757, 0o777} {
		require.NoError(t, os.Chmod(mine, mode))
		_, err := Check(mine, r.home, Ticked)
		assert.Error(t, err, "mode %o: group or other can plant files in it", mode)
	}
}

// outsideBase is a folder outside the rig's home that is not itself under a shared root, whatever TMPDIR is (a Linux runner's temp is /tmp, which Check refuses): the temp folder, else the package's own folder, else
// the user's cache folder; the test is skipped when every one of them is a shared place.
func outsideBase(t *testing.T) string {
	t.Helper()
	var candidates []string
	candidates = append(candidates, t.TempDir())
	if wd, err := os.Getwd(); err == nil {
		candidates = append(candidates, wd)
	}
	if c, err := os.UserCacheDir(); err == nil {
		candidates = append(candidates, c)
	}
	for _, c := range candidates {
		real, err := filepath.EvalSymlinks(c)
		if err != nil || sharedOrShallow(real) != "" {
			continue
		}
		dir, err := os.MkdirTemp(real, "foldertrust-outside-")
		if err != nil {
			continue
		}
		t.Cleanup(func() { os.RemoveAll(dir) })
		return dir
	}
	t.Skip("every place a test folder can be made is a shared place on this machine")
	return ""
}
