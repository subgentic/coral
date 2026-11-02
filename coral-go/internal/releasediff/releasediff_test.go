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

func TestNumstatIsReadByItsNULRecords(t *testing.T) {
	in := "3\t1\tcoral-go/pkg/tunnel/routes.go\x00-\t-\tcoral-go/pkg/redact/logo.png\x0010\t0\tcoral-go/pkg/hubproxy/a b.go\x00"
	fs, err := ParseNumstat([]byte(in))
	require.NoError(t, err)
	assert.Equal(t, []FileChange{
		{Path: "coral-go/pkg/hubproxy/a b.go", Added: 10},
		{Path: "coral-go/pkg/redact/logo.png", Binary: true},
		{Path: "coral-go/pkg/tunnel/routes.go", Added: 3, Deleted: 1},
	}, fs, "a path with a space is whole, a binary file has no counts, the files are in path order")
	_, err = ParseNumstat([]byte("3\t1\x00"))
	assert.Error(t, err)
	_, err = ParseNumstat([]byte("x\ty\tp\x00"))
	assert.Error(t, err)
}

func TestFilesBelongToTheHubPackageThatHoldsThem(t *testing.T) {
	pcs := GroupByPackage([]FileChange{
		{Path: "coral-go/pkg/tunnel/routes.go", Added: 1},
		{Path: "coral-go/pkg/tunnel/testdata/view_redaction.golden", Added: 1},
		{Path: "coral-go/pkg/tunnelish/x.go", Added: 1}, // another package whose name starts the same
		{Path: "coral-go/agent_docs/auth.md", Added: 1},
		{Path: "coral-go/agent_docs/sub/deep.md", Added: 1}, // the docs are the files of that directory itself
		{Path: "coral-go/agent_docs/notes.txt", Added: 1},   // and only the .md ones
		{Path: "coral-go/pkg/frontend/static/nav.js", Added: 2},
		{Path: "coral-go/internal/board/x.go", Added: 1},
	})
	require.Len(t, pcs, len(HubPaths))
	want := map[string]int{"coral-go/pkg/tunnel": 2, "coral-go/agent_docs": 1, "coral-go/pkg/frontend": 1}
	for _, pc := range pcs {
		assert.Len(t, pc.Files, want[pc.Package], pc.Package)
	}
	assert.NotContains(t, func() []string {
		var n []string
		for _, h := range HubPaths {
			n = append(n, h.Path)
		}
		return n
	}(), "coral-go/pkg/secretbox", "no other Hub package imports secretbox (coral-hub's rule for keeping it)")
}

func TestThePackagesReportSplitsCodeTestsAndTheRest(t *testing.T) {
	var sb strings.Builder
	WritePackages(&sb, GroupByPackage([]FileChange{
		{Path: "coral-go/pkg/hubproxy/handler.go", Added: 6, Deleted: 5},
		{Path: "coral-go/pkg/hubproxy/handler_test.go", Added: 40},
		{Path: "coral-go/pkg/hubproxy/testdata/x.golden", Added: 2, Deleted: 1},
		{Path: "coral-go/pkg/frontend/static/nav.js", Added: 7, Deleted: 1},
		{Path: "coral-go/pkg/frontend/static/css/nav.css", Added: 3},
		{Path: "coral-go/pkg/frontend/frontend_test.go", Added: 9},
		{Path: "coral-go/agent_docs/auth.md", Added: 4, Deleted: 4},
	}), "v1", "v2")
	out := sb.String()
	assert.Contains(t, out, "### What Coral Hub compiles in or embeds, v1 to v2")
	assert.Contains(t, out, "`pkg/hubproxy`: 1 file of Go code changed (+6, -5)")
	assert.Contains(t, out, "- `coral-go/pkg/hubproxy/handler.go`: +6, -5")
	assert.Contains(t, out, "- test files, not compiled by the Hub: 1 file (+40, -0)")
	assert.Contains(t, out, "- other files (data, docs), not compiled by the Hub: 1 file (+2, -1)")
	assert.NotContains(t, out, "handler_test.go", "test files are counted, not listed")
	assert.Contains(t, out, "`pkg/frontend`: 2 files the Hub embeds changed (+10, -1)", "an embedded path lists every non-test file, the css too")
	assert.Contains(t, out, "- `coral-go/pkg/frontend/static/css/nav.css`: +3, -0")
	assert.Contains(t, out, "`agent_docs`: 1 file the Hub embeds changed (+4, -4)")
	assert.Contains(t, out, "Unchanged: `pkg/hubowner`, `pkg/redact`, `pkg/tunnel`.")
	sb.Reset()
	WritePackages(&sb, GroupByPackage(nil), "v1", "v1")
	assert.Contains(t, sb.String(), "No file changed in any of them")
}

// PackageChanges reads two tagged commits of a real repository, from its root and from a directory inside it.
func TestPackageChangesReadsARealRepositoryFromAnyDirectory(t *testing.T) {
	repo := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		out, err := exec.Command("git", append([]string{"-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"}, args...)...).CombinedOutput()
		require.NoError(t, err, string(out))
	}
	put := func(path, body string) {
		t.Helper()
		require.NoError(t, os.MkdirAll(filepath.Dir(filepath.Join(repo, path)), 0o755))
		require.NoError(t, os.WriteFile(filepath.Join(repo, path), []byte(body), 0o644))
	}
	run("init", "-q")
	put("coral-go/pkg/hubproxy/handler.go", "package hubproxy\n")
	put("coral-go/pkg/redact/redact.go", "package redact\n")
	put("coral-go/agent_docs/auth.md", "a\n")
	put("coral-go/agent_docs/sub/deep.md", "a\n")
	put("coral-go/pkg/frontend/static/nav.js", "a\n")
	put("coral-go/internal/board/x.go", "package board\n")
	run("add", "-A")
	run("commit", "-q", "-m", "old")
	run("tag", "old")
	put("coral-go/pkg/hubproxy/handler.go", "package hubproxy\n\nconst UploadStallTimeout = 1\n")
	put("coral-go/pkg/hubproxy/handler_test.go", "package hubproxy\n")
	put("coral-go/agent_docs/auth.md", "b\n")
	put("coral-go/agent_docs/sub/deep.md", "b\n") // below the docs' directory: not one of the Hub's docs
	put("coral-go/pkg/frontend/static/nav.js", "b\n")
	put("coral-go/internal/board/x.go", "package board\n\nvar X = 1\n") // not a Hub path
	run("add", "-A")
	run("commit", "-q", "-m", "new")
	run("tag", "new")

	for _, dir := range []string{repo, filepath.Join(repo, "coral-go")} {
		pcs, err := PackageChanges(dir, "old", "new")
		require.NoError(t, err, dir)
		var got []string
		for _, pc := range pcs {
			for _, f := range pc.Files {
				got = append(got, f.Path)
			}
		}
		assert.Equal(t, []string{"coral-go/pkg/hubproxy/handler.go", "coral-go/pkg/hubproxy/handler_test.go", "coral-go/pkg/frontend/static/nav.js", "coral-go/agent_docs/auth.md"}, got, "from "+dir+" (in the order of HubPaths): a Hub path's files only (the docs of the directory itself), with paths from the root")
	}
	_, err := PackageChanges(repo, "old", "no-such-tag")
	assert.Error(t, err)
}
