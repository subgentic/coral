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
