package releasediff

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const cloudV1 = "GET /api/a view\nPOST /api/b interact\nGET /api/c never\nPOST /api/d launch\n"
const ownerV1 = "POST /api/b interact owner-only\n"
const cloudV2 = "GET /api/a view\nPOST /api/b launch\nGET /api/c view\nPOST /api/e interact\nGET /api/f never\n"
const ownerV2 = "POST /api/b launch owner-only\nPOST /api/e interact owner-only-hub\n"

func TestRoutesAreTheirTierAndWhoMayUseThem(t *testing.T) {
	r, err := ParseRoutes([]byte(cloudV1), []byte(ownerV1))
	require.NoError(t, err)
	assert.Equal(t, Entries{"GET /api/a": "view", "POST /api/b": "interact owner-only", "GET /api/c": "never", "POST /api/d": "launch"}, r)
}

func TestARouteRowWithTheWrongShapeIsRefusedWithItsLine(t *testing.T) {
	_, err := ParseRoutes([]byte("GET /api/a view\nPOST /api/b\n"), nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "line 2")
	_, err = ParseRoutes([]byte(cloudV1), []byte("POST /api/b owner-only\n"))
	require.Error(t, err, "an owner row has four fields")
}

func TestCompareSaysAddedRemovedAndChanged(t *testing.T) {
	a, _ := ParseRoutes([]byte(cloudV1), []byte(ownerV1))
	b, _ := ParseRoutes([]byte(cloudV2), []byte(ownerV2))
	d := Compare(a, b)
	assert.Equal(t, []Change{{Key: "GET /api/f", New: "never"}, {Key: "POST /api/e", New: "interact owner-only-hub"}}, d.Added)
	assert.Equal(t, []Change{{Key: "POST /api/d", Old: "launch"}}, d.Removed)
	assert.Equal(t, []Change{{Key: "GET /api/c", Old: "never", New: "view"}, {Key: "POST /api/b", Old: "interact owner-only", New: "launch owner-only"}}, d.Changed)
	assert.True(t, Compare(a, a).Empty())
}

func TestTheRouteReportKeepsWhatTheHubCanSeeApartFromNever(t *testing.T) {
	a, _ := ParseRoutes([]byte(cloudV1), []byte(ownerV1))
	b, _ := ParseRoutes([]byte(cloudV2), []byte(ownerV2))
	var sb strings.Builder
	WriteRoutes(&sb, Compare(a, b), "v1", "v2")
	out := sb.String()
	assert.Contains(t, out, "### Tunnel routes, v1 to v2")
	assert.Contains(t, out, "Added, reachable through the tunnel (1)\n\n- `POST /api/e`: interact, owner-only-hub")
	assert.Contains(t, out, "Removed, was reachable through the tunnel (1)\n\n- `POST /api/d`: was launch")
	assert.Contains(t, out, "- `GET /api/c`: never to view", "a route that enters the tunnel is a change of exposure, not an add")
	assert.Contains(t, out, "- `POST /api/b`: interact owner-only to launch owner-only")
	assert.Contains(t, out, "Added, never reachable (the Hub has nothing to do) (1)\n\n- `GET /api/f`: never")
	sb.Reset()
	WriteRoutes(&sb, Compare(a, a), "v1", "v1")
	assert.Contains(t, sb.String(), "No route was added, removed or changed.")
}

const settingsV1 = `package board

type Inner struct {
	On  bool ` + "`json:\"on\"`" + `
	Min int  ` + "`json:\"min\"`" + `
}
type Item struct {
	ID string ` + "`json:\"id\"`" + `
}
type BoardSettings struct {
	A       bool    ` + "`json:\"a\"`" + `
	Servers []string ` + "`json:\"servers\"`" + `
	In      Inner   ` + "`json:\"in\"`" + `
	Items   []Item  ` + "`json:\"items\"`" + `
	Stored  bool    ` + "`json:\"-\"`" + `
	NoTag   bool
	Ptr     *Inner  ` + "`json:\"ptr,omitempty\"`" + `
}
// not a settings type: its keys are not keys of BoardSettings
type Update struct {
	Z *bool ` + "`json:\"z\"`" + `
}
`

func TestSettingsKeysAreFlattenedByTheirJSONTags(t *testing.T) {
	s, err := ParseSettings(map[string][]byte{"coral-go/internal/board/x.go": []byte(settingsV1)})
	require.NoError(t, err)
	assert.Equal(t, Entries{
		"a": "bool", "servers": "[]string",
		"in": "object Inner", "in.on": "bool", "in.min": "int",
		"items[]": "object Item", "items[].id": "string",
		"ptr": "object Inner", "ptr.on": "bool", "ptr.min": "int",
	}, s, "json:\"-\", an untagged field and another type's keys are not keys; a pointer or a list of a struct is walked")
}

func TestASettingsTypeThatContainsItselfDoesNotLoop(t *testing.T) {
	src := "package board\ntype BoardSettings struct { Next *BoardSettings `json:\"next\"`; N int `json:\"n\"` }\n"
	s, err := ParseSettings(map[string][]byte{"a.go": []byte(src)})
	require.NoError(t, err)
	assert.Equal(t, Entries{"next": "*BoardSettings", "n": "int"}, s)
}

func TestNoBoardSettingsTypeIsOneClearError(t *testing.T) {
	_, err := ParseSettings(map[string][]byte{"a.go": []byte("package board\n")})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "no type BoardSettings")
}

func TestTheSettingsReportNamesTypesAndChanges(t *testing.T) {
	a, _ := ParseSettings(map[string][]byte{"a.go": []byte(settingsV1)})
	b, _ := ParseSettings(map[string][]byte{"a.go": []byte(strings.Replace(strings.Replace(settingsV1, "Min int ", "Min int64 ", 1), "Servers []string", "Extra bool `json:\"extra\"`\n\tServers []string", 1))})
	var sb strings.Builder
	WriteSettings(&sb, Compare(a, b), "v1", "v2")
	out := sb.String()
	assert.Contains(t, out, "Added (1)\n\n- `extra`: bool")
	assert.Contains(t, out, "- `in.min`: int to int64")
	assert.NotContains(t, out, "Removed")
}

// git builds a repository with two commits that differ in the two route goldens and the settings source, tagged old and new.
func TestTheReaderReadsTwoRefsOfARealRepository(t *testing.T) {
	repo := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"}, args...)...)
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, string(out))
	}
	put := func(path, body string) {
		t.Helper()
		require.NoError(t, os.MkdirAll(filepath.Dir(filepath.Join(repo, path)), 0o755))
		require.NoError(t, os.WriteFile(filepath.Join(repo, path), []byte(body), 0o644))
	}
	run("init", "-q")
	put(CloudRoutesPath, cloudV1)
	put(OwnerRoutesPath, ownerV1)
	put(BoardDir+"settings.go", settingsV1)
	put(BoardDir+"settings_test.go", "package board\ntype BoardSettings struct{ Bogus int `json:\"bogus\"` }\n") // a test file is not read
	run("add", "-A")
	run("commit", "-q", "-m", "old")
	run("tag", "old")
	put(CloudRoutesPath, cloudV2)
	put(OwnerRoutesPath, ownerV2)
	run("commit", "-qam", "new")
	run("tag", "new")

	o, n := Reader{Repo: repo, Ref: "old"}, Reader{Repo: repo, Ref: "new"}
	or, err := o.Routes()
	require.NoError(t, err)
	nr, err := n.Routes()
	require.NoError(t, err)
	assert.Equal(t, "interact owner-only", or["POST /api/b"])
	assert.Equal(t, "launch owner-only", nr["POST /api/b"])
	s, err := o.Settings()
	require.NoError(t, err)
	assert.NotContains(t, s, "bogus")
	assert.Contains(t, s, "in.on")

	// the default -repo is "." and the tool is run from coral-go: a directory inside the repository reads the same (ls-tree paths are relative to the directory unless asked for from the root)
	sub := filepath.Join(repo, "coral-go")
	for _, ref := range []string{"old", "new"} {
		in, err := Reader{Repo: sub, Ref: ref}.Settings()
		require.NoError(t, err, "from a subdirectory, "+ref)
		root, err := Reader{Repo: repo, Ref: ref}.Settings()
		require.NoError(t, err)
		assert.Equal(t, root, in, ref)
		inR, err := Reader{Repo: sub, Ref: ref}.Routes()
		require.NoError(t, err)
		rootR, _ := Reader{Repo: repo, Ref: ref}.Routes()
		assert.Equal(t, rootR, inR, ref)
	}

	_, err = Resolve(repo, "old")
	assert.NoError(t, err)
	_, err = Resolve(repo, "no-such-tag")
	require.Error(t, err)
	assert.Contains(t, err.Error(), `"no-such-tag" is not a commit`)
	_, err = Reader{Repo: repo, Ref: "old"}.File("coral-go/nothing")
	assert.Error(t, err)
}

// A ref that starts with a dash is refused before git is run: git would read it as an option. A git that records its calls proves it is never started.
func TestARefThatStartsWithADashNeverReachesGit(t *testing.T) {
	bin, log := t.TempDir(), filepath.Join(t.TempDir(), "calls")
	require.NoError(t, os.WriteFile(filepath.Join(bin, "git"), []byte("#!/bin/sh\necho \"$@\" >> "+log+"\nexit 1\n"), 0o755))
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	for _, bad := range []string{"--output=x", "-h", "--upload-pack=x"} {
		_, err := Resolve(t.TempDir(), bad)
		require.Error(t, err, bad)
		assert.Contains(t, err.Error(), "is not a commit", bad)
	}
	_, err := os.Stat(log)
	assert.True(t, os.IsNotExist(err), "git was started for a ref that is an option")
	_, err = Resolve(t.TempDir(), "v1") // an ordinary ref does go to git (the stub), so the stub is a real probe
	assert.Error(t, err)
	_, err = os.Stat(log)
	assert.NoError(t, err)
}
