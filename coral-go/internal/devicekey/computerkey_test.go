package devicekey_test

import (
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/devicekey"
)

func TestComputerKeyIsMadeOnceAndKept(t *testing.T) {
	dir := t.TempDir()
	a, err := devicekey.LoadOrCreateComputerKey(dir)
	require.NoError(t, err)
	assert.Len(t, a.Pub(), 32)
	assert.Equal(t, devicekey.ComputerFingerprint(a.Pub()), a.Computer())
	b, err := devicekey.LoadOrCreateComputerKey(dir)
	require.NoError(t, err)
	assert.Equal(t, a.Pub(), b.Pub(), "the same key after a restart")
	other, err := devicekey.LoadOrCreateComputerKey(t.TempDir())
	require.NoError(t, err)
	assert.NotEqual(t, a.Pub(), other.Pub())
}

func TestComputerKeyFileIsOwnerOnly(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX mode bits")
	}
	dir := t.TempDir()
	_, err := devicekey.LoadOrCreateComputerKey(dir)
	require.NoError(t, err)
	fi, err := os.Stat(filepath.Join(dir, devicekey.ComputerKeyFile))
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o600), fi.Mode().Perm())
	require.NoError(t, os.Chmod(filepath.Join(dir, devicekey.ComputerKeyFile), 0o644))
	_, err = devicekey.LoadOrCreateComputerKey(dir)
	assert.ErrorIs(t, err, devicekey.ErrComputerKeyFile, "a key file others can read is refused, not used")
}

func TestComputerKeyRefusesALinkOrAWrongFile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks")
	}
	dir := t.TempDir()
	target := filepath.Join(t.TempDir(), "elsewhere")
	require.NoError(t, os.WriteFile(target, []byte(strings.Repeat("A", 43)+"\n"), 0o600))
	require.NoError(t, os.Symlink(target, filepath.Join(dir, devicekey.ComputerKeyFile)))
	_, err := devicekey.LoadOrCreateComputerKey(dir)
	assert.ErrorIs(t, err, devicekey.ErrComputerKeyFile)

	dir2 := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir2, devicekey.ComputerKeyFile), []byte("not a key"), 0o600))
	_, err = devicekey.LoadOrCreateComputerKey(dir2)
	assert.ErrorIs(t, err, devicekey.ErrComputerKeyFile, "a damaged file is never silently replaced: that would change the computer's identity")
	assert.NotContains(t, err.Error(), "not a key")
}

// Lead Q2: only the key package touches the key file. A scan of every other non-test source file for its name.
func TestOnlyTheKeyPackageNamesTheKeyFile(t *testing.T) {
	var hits []string
	root := filepath.Join("..", "..")
	require.NoError(t, filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") {
			return err
		}
		if strings.Contains(filepath.ToSlash(p), "internal/devicekey/") {
			return nil
		}
		b, _ := os.ReadFile(p)
		if strings.Contains(string(b), devicekey.ComputerKeyFile) || strings.Contains(string(b), "ComputerKeyFile") {
			hits = append(hits, p)
		}
		return nil
	}))
	assert.Empty(t, hits)
}

// coral-hub Security on #19689 (3): nothing copies the data folder, so nothing copies device-computer.key. A guard for the future: a source file that copies or archives a tree (archive/zip, archive/tar, os.CopyFS, a walk) AND names Coral's data folder must be on the list below, each checked by hand to walk only a sub-folder, fix permissions, or archive something that is not the data folder. A new one fails here until someone reads it and either excludes the key or adds it to the list. (Checked on 2026-11-18: no support bundle, export or whole-folder backup exists; the database backups, `VACUUM INTO` of one named database file and `coral db compact`'s backup of sessions.db, copy one database each.)
func TestNothingThatCopiesTheDataFolderCanTakeTheKeyFile(t *testing.T) {
	allowed := map[string]string{
		"internal/background/workflow_runner.go":        "removes workflow run folders",
		"internal/background/token_poller.go":           "walks the Pi sessions sub-folder",
		"internal/config/datadir_secure_windows.go":     "fixes permissions",
		"internal/server/data_perms.go":                 "fixes permissions of named sub-trees",
		"internal/server/routes/artifacts_store.go":     "walks the artifacts sub-folder",
		"internal/server/routes/artifact_prune_scan.go": "walks the artifacts sub-folder",
		"internal/server/routes/skills_publish.go":      "walks a skill's own folder",
		"internal/updater/apply/linux.go":               "walks the unpacked update",
		"internal/agent/pi.go":                          "reads the Pi sessions sub-folder",
		"internal/jsonl/parse_pi.go":                    "reads the Pi sessions sub-folder",
		"internal/sshprov/install.go":                   "archives Coral's binaries to install them elsewhere",
	}
	copier := regexp.MustCompile(`archive/(zip|tar)|os\.CopyFS|filepath\.Walk(Dir)?\(|fs\.WalkDir\(`)
	names := regexp.MustCompile(`CoralDir\(\)|CORAL_DATA_DIR|dataDir|DataDir`)
	var unknown []string
	root := filepath.Join("..", "..")
	require.NoError(t, filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") {
			return err
		}
		b, _ := os.ReadFile(p)
		if copier.Match(b) && names.Match(b) {
			rel := filepath.ToSlash(strings.TrimPrefix(p, root+string(filepath.Separator)))
			if _, ok := allowed[rel]; !ok {
				unknown = append(unknown, rel)
			}
		}
		return nil
	}))
	assert.Empty(t, unknown, "a file that copies a tree and names the data folder: read it, keep device-computer.key out of what it copies, then list it")
}
