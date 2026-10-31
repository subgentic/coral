package testtemp

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

// profile makes a folder that os.UserHomeDir reports as the profile (HOME on Unix, USERPROFILE on Windows) for the test.
func profile(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	return home
}

// #413, Security's 3a-3e (#6584): CORAL_TEST_ROOT is used only when it is a folder directly in the profile with the tool's own last name, a real folder owned by this user with an
// owner-only access list; anything else is ignored with a reason.
func TestRootEnvIsUsedOnlyWhenItPassesSecuritysConditions(t *testing.T) {
	home := profile(t)
	good := filepath.Join(home, rootName)

	cases := []struct {
		name   string
		root   string
		reason string // "" = accepted
	}{
		{"unset", "", ""},
		{"relative", "ct", "not an absolute path"},
		{"network path", `\\server\share\` + rootName, "network path"},
		{"drive or file system root", filepath.VolumeName(home) + string(filepath.Separator), "root"},
		{"the profile itself", home, "profile folder itself"},
		{"not directly in the profile", filepath.Join(home, "deeper", rootName), "not directly in the profile"},
		{"another account's folder", filepath.Join(filepath.Dir(home), "elsewhere", rootName), "not directly in the profile"},
		{"a caller-picked last name", filepath.Join(home, "mine"), "last name is not"},
		{"the right place", good, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Setenv(RootEnv, c.root)
			got := rootFromEnv()
			clean, reason := "", ""
			if c.root != "" {
				clean, reason = checkRoot(c.root)
			}
			switch {
			case c.root == "":
				if got != "" {
					t.Errorf("unset: %q", got)
				}
			case c.reason == "":
				if reason != "" || got != clean || got != good {
					t.Errorf("accepted: got %q reason %q", got, reason)
				}
				if fi, err := os.Lstat(good); err != nil || !fi.IsDir() {
					t.Errorf("made when missing: %v", err)
				}
			default:
				if got != "" || !strings.Contains(reason, c.reason) {
					t.Errorf("want ignored for %q, got %q reason %q", c.reason, got, reason)
				}
			}
		})
	}
}

func TestRootEnvRefusesALinkAndAFileAndAnOpenFolder(t *testing.T) {
	home := profile(t)
	root := filepath.Join(home, rootName)

	// a file with the right name
	if err := os.WriteFile(root, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, reason := checkRoot(root); !strings.Contains(reason, "not a real folder") {
		t.Errorf("a file: %q", reason)
	}
	os.Remove(root)

	// a link with the right name (skipped where links cannot be made)
	target := t.TempDir()
	if err := os.Symlink(target, root); err == nil {
		if _, reason := checkRoot(root); !strings.Contains(reason, "not a real folder") {
			t.Errorf("a link: %q", reason)
		}
		os.Remove(root)
	}

	// an existing folder open to others (Unix modes; on Windows the access list is the inherited one and is checked by ownerOnlyAcl)
	if runtime.GOOS != "windows" {
		if err := os.Mkdir(root, 0o777); err != nil {
			t.Fatal(err)
		}
		os.Chmod(root, 0o777)
		if _, reason := checkRoot(root); !strings.Contains(reason, "access list") {
			t.Errorf("an open folder: %q", reason)
		}
		os.Chmod(root, 0o700)
		if clean, reason := checkRoot(root); reason != "" || clean != root {
			t.Errorf("the same folder closed: %q %q", clean, reason)
		}
	}
}

// The private folder made under that root is removed by the same cleanup.
func TestPrivateFolderUnderTheRootIsMadeAndRemoved(t *testing.T) {
	home := profile(t)
	root := filepath.Join(home, rootName)
	t.Setenv(RootEnv, root)
	// setupIn points the process's temp, home and data variables at the private folder (and removes the agent folder pointers testguard sandboxed): t.Setenv to their current values
	// restores every one when this test ends.
	for _, k := range []string{"TMPDIR", "TMP", "TEMP", "GOTMPDIR", "CORAL_DATA_DIR", Marker,
		"CODEX_HOME", "CLAUDE_CONFIG_DIR", "PI_CODING_AGENT_DIR", "GEMINI_CLI_HOME", "GEMINI_TMP_DIR", "ANTIGRAVITY_DATA_DIR"} {
		t.Setenv(k, os.Getenv(k))
	}
	base := privateBase()
	if base != root {
		t.Fatalf("privateBase follows the root: %q", base)
	}
	cleanup := setupIn(base, os.Stderr)
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 1 || !privateName.MatchString(entries[0].Name()) {
		t.Fatalf("one private folder under the root: %v %v", entries, err)
	}
	cleanup()
	if entries, _ := os.ReadDir(root); len(entries) != 0 {
		t.Errorf("removed by the cleanup: %v", entries)
	}
}

// Parallel test binaries all see the root missing at the same moment: the ones that lose the Mkdir must still accept the folder the winner made, not fall back to the temp folder.
func TestRootEnvIsAcceptedByEveryCallerWhenTheyRaceToMakeIt(t *testing.T) {
	home := profile(t)
	root := filepath.Join(home, rootName)
	const callers = 24
	start := make(chan struct{})
	reasons := make([]string, callers)
	cleans := make([]string, callers)
	var wg sync.WaitGroup
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			cleans[i], reasons[i] = checkRoot(root)
		}(i)
	}
	close(start)
	wg.Wait()
	for i := range reasons {
		if reasons[i] != "" || cleans[i] != root {
			t.Errorf("caller %d: %q %q", i, cleans[i], reasons[i])
		}
	}
}
