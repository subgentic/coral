package routes

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
)

func TestCreateSuggestedDirMakesOnlyTheSuggestedShape(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	coral := filepath.Join(home, "Coral")

	if msg := createSuggestedDir(filepath.Join(coral, "first"), false); msg != "" {
		t.Fatalf("no create_dir is not an error: %q", msg)
	}
	if _, err := os.Stat(coral); err == nil {
		t.Fatal("without create_dir nothing is made")
	}
	if msg := createSuggestedDir(filepath.Join(coral, "first"), true); msg != "" {
		t.Fatalf("the suggested folder is made: %q", msg)
	}
	if fi, err := os.Stat(filepath.Join(coral, "first")); err != nil || !fi.IsDir() {
		t.Fatalf("folder missing: %v", err)
	}
	if msg := createSuggestedDir(filepath.Join(coral, "first"), true); msg != "" {
		t.Fatalf("an existing suggested folder is fine: %q", msg)
	}

	for _, bad := range []string{
		filepath.Join(coral, "a", "b"),       // nested
		filepath.Join(home, "elsewhere"),     // not under Coral
		filepath.Join(home, "Coral"),         // the root itself
		filepath.Join(coral, "..", "escape"), // cleans to home/escape
		filepath.Join(coral, ".hidden"),      // leading dot
		filepath.Join(coral, "has space"),    // space
		filepath.Join(coral, strings.Repeat("x", 65)),
		filepath.Join(filepath.Dir(home), "Coral", "outside"), // another home
		"relative/Coral/x",
		filepath.Join(coral, "CON"), filepath.Join(coral, "nul.txt"), filepath.Join(coral, "COM1"), filepath.Join(coral, "lpt9"),
		filepath.Join(coral, "dot."),
	} {
		if msg := createSuggestedDir(bad, true); msg == "" {
			t.Errorf("%q must be refused", bad)
		}
	}
	if _, err := os.Stat(filepath.Join(home, "escape")); err == nil {
		t.Error("escape was made")
	}
	if _, err := os.Stat(filepath.Join(home, "elsewhere")); err == nil {
		t.Error("elsewhere was made")
	}
}

func TestCreateSuggestedDirRefusesALinkedCoralFolder(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	target := t.TempDir()
	if err := os.Symlink(target, filepath.Join(home, "Coral")); err != nil {
		t.Fatal(err)
	}
	if msg := createSuggestedDir(filepath.Join(home, "Coral", "first"), true); msg == "" {
		t.Fatal("a linked Coral folder must be refused")
	}
	if _, err := os.Stat(filepath.Join(target, "first")); err == nil {
		t.Fatal("made through the link")
	}
}

func TestCreateSuggestedDirAcceptsTheConfiguredRoot(t *testing.T) {
	root := t.TempDir()
	t.Setenv("HOME", t.TempDir())
	if msg := createSuggestedDir(filepath.Join(root, "Coral", "team-1"), true, root); msg != "" {
		t.Fatalf("CORAL_ROOT is a base too: %q", msg)
	}
}

func TestLaunchCreateDirMakesTheSuggestedFolderAndNoOther(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	server, _, _, _ := setupSessionsTestServerWithConfig(t, config.Load(t.TempDir()))
	post := func(dir string, create bool) (int, map[string]any) {
		body := `{"agent_type":"claude","working_dir":` + jsonString(dir) + `,"create_dir":` + map[bool]string{true: "true", false: "false"}[create] + `}`
		resp, err := http.Post(server.URL+"/api/sessions/launch", "application/json", strings.NewReader(body))
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}

	// Without the flag a missing folder is still the caller's mistake, and nothing is made.
	suggested := filepath.Join(home, "Coral", "first")
	code, out := post(suggested, false)
	assert.Equal(t, http.StatusBadRequest, code)
	assert.Equal(t, "working_dir", out["field"])
	_, err := os.Stat(suggested)
	assert.True(t, os.IsNotExist(err), "no create_dir, no folder")

	// Any other folder with the flag is refused and not made.
	other := filepath.Join(home, "elsewhere", "deep")
	code, out = post(other, true)
	assert.Equal(t, http.StatusBadRequest, code)
	assert.Equal(t, "working_dir", out["field"])
	_, err = os.Stat(filepath.Join(home, "elsewhere"))
	assert.True(t, os.IsNotExist(err), "create_dir makes only <home>/Coral/<name>")

	// The suggested folder is made; the launch then goes on past the folder check.
	_, out = post(suggested, true)
	fi, err := os.Stat(suggested)
	require.NoError(t, err)
	assert.True(t, fi.IsDir())
	assert.NotEqual(t, "working_dir", out["field"])
}

func TestCreateSuggestedDirMakesBothFoldersPrivate(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows has no mode bits")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	if msg := createSuggestedDir(filepath.Join(home, "Coral", "first"), true); msg != "" {
		t.Fatal(msg)
	}
	for _, d := range []string{filepath.Join(home, "Coral"), filepath.Join(home, "Coral", "first")} {
		fi, err := os.Stat(d)
		require.NoError(t, err)
		assert.Zero(t, fi.Mode().Perm()&0o077, "%s is private to the person: %v", d, fi.Mode().Perm())
	}
}

func TestCreateSuggestedDirRefusesANameThatIsALink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	require.NoError(t, os.Mkdir(filepath.Join(home, "Coral"), 0o700))
	require.NoError(t, os.Symlink(t.TempDir(), filepath.Join(home, "Coral", "first")))
	if msg := createSuggestedDir(filepath.Join(home, "Coral", "first"), true); msg == "" {
		t.Fatal("a name that is a link is refused")
	}
}

// #12833 (the first-time user's report): step 1 of the New team wizard accepted a folder that did not exist and Launch refused it ("Folder not found"). A person who chose a new folder inside one that exists
// has it made, and only that.
func TestCreateChosenFolderMakesOneNewFolderInsideAnExistingOne(t *testing.T) {
	parent := t.TempDir()
	dir := filepath.Join(parent, "planner-shop")
	msg, made := createChosenFolder(dir)
	require.Empty(t, msg)
	assert.True(t, made)
	fi, err := os.Stat(dir)
	require.NoError(t, err)
	assert.True(t, fi.IsDir())
	if runtime.GOOS != "windows" {
		assert.Equal(t, os.FileMode(0o700), fi.Mode().Perm(), "only its owner")
	}
	msg, made = createChosenFolder(dir)
	assert.Empty(t, msg, "a folder that is already there is not an error")
	assert.False(t, made, "and it is not one this call made")
	msg, made = createChosenFolder("")
	assert.Empty(t, msg)
	assert.False(t, made)
}

func TestCreateChosenFolderRefusesEverythingButOnePlainNameInAnExistingParent(t *testing.T) {
	parent := t.TempDir()
	other := t.TempDir()
	for name, bad := range map[string]string{
		"relative":           "planner-shop",
		"dot dot":            parent + string(filepath.Separator) + "a" + string(filepath.Separator) + ".." + string(filepath.Separator) + "escape",
		"dot dot at the end": parent + string(filepath.Separator) + "..",
		"missing parent":     filepath.Join(parent, "no-such", "deep"),
		"two levels":         filepath.Join(parent, "x", "y"),
		"leading dot":        filepath.Join(parent, ".hidden"),
		"a space":            filepath.Join(parent, "has space"),
		"too long":           filepath.Join(parent, strings.Repeat("x", 65)),
		"reserved":           filepath.Join(parent, "CON"),
		"dot ending":         filepath.Join(parent, "dot."),
		"doubled separator":  parent + string(filepath.Separator) + string(filepath.Separator) + "twice",
	} {
		msg, made := createChosenFolder(bad)
		assert.NotEmpty(t, msg, name)
		assert.False(t, made, name)
	}
	entries, err := os.ReadDir(parent)
	require.NoError(t, err)
	assert.Empty(t, entries, "nothing was made by a refused request")
	// the parent is a file, not a folder
	file := filepath.Join(other, "afile")
	require.NoError(t, os.WriteFile(file, []byte("x"), 0o600))
	msg, _ := createChosenFolder(filepath.Join(file, "child"))
	assert.Contains(t, msg, "not a folder that exists", "a file is no parent")
	msg, _ = createChosenFolder(filepath.Join(parent, "no-such", "deep"))
	assert.Contains(t, msg, "not a folder that exists", "no parent is made for it")
}

func TestCreateChosenFolderNeverFollowsOrReplacesALink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("links need privileges on Windows")
	}
	parent, target := t.TempDir(), t.TempDir()
	link := filepath.Join(parent, "pointer")
	require.NoError(t, os.Symlink(target, link))
	msg, made := createChosenFolder(link)
	assert.Empty(t, msg, "a name that is already there (a link) is left as it is: the launch checks it as before")
	assert.False(t, made)
	fi, err := os.Lstat(link)
	require.NoError(t, err)
	assert.NotZero(t, fi.Mode()&os.ModeSymlink, "the link is still a link")
	entries, _ := os.ReadDir(target)
	assert.Empty(t, entries, "nothing was made through it")
	// a new folder inside a parent reached through a link is the person's own folder, made once
	viaLink := filepath.Join(link, "inside")
	msg, made = createChosenFolder(viaLink)
	assert.Empty(t, msg)
	assert.True(t, made)
	_, err = os.Stat(filepath.Join(target, "inside"))
	assert.NoError(t, err)
}
