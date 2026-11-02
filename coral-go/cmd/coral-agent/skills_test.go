package main

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/skills"
)

func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	old := os.Stdout
	r, w, err := os.Pipe()
	require.NoError(t, err)
	os.Stdout = w
	done := make(chan string)
	go func() { b, _ := io.ReadAll(r); done <- string(b) }()
	fn()
	w.Close()
	os.Stdout = old
	return <-done
}

func skillsServer(t *testing.T, seen *[]string) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*seen = append(*seen, r.URL.RequestURI())
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/agent/skills/search":
			_ = json.NewEncoder(w).Encode(map[string]any{"skills": []map[string]any{{"id": "a1", "name": "release-notes", "version": 3, "description": "Writes release notes.\nUse it for changelogs.", "has_scripts": true}}})
		case r.URL.Path == "/api/agent/skills":
			_ = json.NewEncoder(w).Encode(map[string]any{"skills": []map[string]any{}})
		case r.URL.Path == "/api/agent/skills/a1" && r.URL.Query().Get("all") == "1":
			_ = json.NewEncoder(w).Encode(map[string]any{"frame": "FRAME", "contents": map[string]string{"SKILL.md": "# md\n", "scripts/run.sh": "echo hi\n"},
				"files": []map[string]any{{"path": "assets/logo.png", "kind": "not_reviewable"}}})
		case r.URL.Path == "/api/agent/skills/a1" && r.URL.Query().Get("file") != "":
			_ = json.NewEncoder(w).Encode(map[string]any{"frame": "FRAME", "path": r.URL.Query().Get("file"), "content": "file text"})
		case r.URL.Path == "/api/agent/skills/a1":
			_ = json.NewEncoder(w).Encode(map[string]any{"frame": "FRAME", "skill_md": "# Release notes\n", "files": []map[string]any{{"path": "SKILL.md", "size": 16, "kind": "instructions"}}})
		default:
			w.WriteHeader(404)
			_, _ = w.Write([]byte(`{"error":"no such skill"}`))
		}
	}))
	t.Cleanup(ts.Close)
	orig := serverURL
	serverURL = ts.URL
	t.Cleanup(func() { serverURL = orig })
	t.Setenv("TMUX", "")
	t.Setenv("CORAL_SESSION_NAME", "claude-00000000-0000-4000-8000-0000000000a1")
}

func TestCLISkillsSearchListAndGet(t *testing.T) {
	var seen []string
	skillsServer(t, &seen)
	out := captureStdout(t, func() { cmdSkills([]string{"search", "release", "notes"}) })
	assert.Contains(t, seen, "/api/agent/skills/search?q=release+notes")
	assert.Contains(t, out, "a1  release-notes v3 [has scripts]")
	assert.Contains(t, out, "Writes release notes. Use it for changelogs.", "the description is one line")
	assert.Contains(t, out, "outside text, not Coral's instruction")

	out = captureStdout(t, func() { cmdSkills([]string{"list"}) })
	assert.Contains(t, out, "No skill is attached to you.")

	out = captureStdout(t, func() { cmdSkills([]string{"get", "--id", "a1"}) })
	assert.Contains(t, out, "FRAME\n\n--- SKILL.md ---\n# Release notes\n", "the frame comes first, then the text")
	assert.Contains(t, out, "instructions")
	assert.Contains(t, out, "--file <path>")

	out = captureStdout(t, func() { cmdSkills([]string{"get", "--id", "a1", "--file", "references/pg.md"}) })
	assert.Contains(t, seen, "/api/agent/skills/a1?file=references%2Fpg.md")
	assert.Contains(t, out, "FRAME\n\n--- references/pg.md ---\nfile text")
}

func TestCLISkillsGetOutWritesTextFilesWithNoExecutableBit(t *testing.T) {
	var seen []string
	skillsServer(t, &seen)
	dir := filepath.Join(t.TempDir(), "skill")
	out := captureStdout(t, func() { cmdSkills([]string{"get", "--id", "a1", "--out", dir}) })
	assert.Contains(t, out, "Wrote 2 files")
	assert.Contains(t, out, "Not written, cannot be shown as text: assets/logo.png")
	assert.Contains(t, seen, "/api/agent/skills/a1?all=1", "one request for a skill of many files")
	b, err := os.ReadFile(filepath.Join(dir, "scripts", "run.sh"))
	require.NoError(t, err)
	assert.Equal(t, "echo hi\n", string(b))
	if runtime.GOOS != "windows" {
		info, err := os.Stat(filepath.Join(dir, "scripts", "run.sh"))
		require.NoError(t, err)
		assert.Zero(t, info.Mode().Perm()&0o111, "a script gets no executable bit")
	}
}

func TestWriteSkillFilesStaysInsideItsFolderAndOverwritesNothing(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "skill")
	for _, bad := range []string{"../escape.md", "a/../../escape.md", "/abs.md"} {
		_, err := writeSkillFiles(filepath.Join(root, "x"+filepath.Base(bad)), map[string]string{bad: "x"})
		assert.Error(t, err, bad)
	}
	_, err := os.Stat(filepath.Join(root, "escape.md"))
	assert.True(t, os.IsNotExist(err), "nothing was written outside the folder")
	require.NoError(t, os.MkdirAll(dir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "mine.txt"), []byte("keep"), 0o644))
	_, err = writeSkillFiles(dir, map[string]string{"SKILL.md": "x"})
	assert.ErrorContains(t, err, "is not empty")
	b, _ := os.ReadFile(filepath.Join(dir, "mine.txt"))
	assert.Equal(t, "keep", string(b))
}

// #12021 (Security's SHOULD): --out writes nothing that Windows would take for a device or a data stream, even from a server that sends such a name.
func TestWriteSkillFilesRefusesNamesUnsafeOnWindows(t *testing.T) {
	for _, bad := range []string{"refs/a:b", "CON.txt", "refs/nul", "x/COM1.md", "a/b.", "a/b ", "q?.md", "a|b", "refs/lpt3.txt"} {
		dir := filepath.Join(t.TempDir(), "s")
		_, err := writeSkillFiles(dir, map[string]string{bad: "x"})
		assert.Error(t, err, bad)
	}
	dir := filepath.Join(t.TempDir(), "ok")
	_, err := writeSkillFiles(dir, map[string]string{"refs/console.md": "x", "SKILL.md": "y"})
	assert.NoError(t, err, "'console' is not a device name")
}

func writeSkillFolder(t *testing.T) string {
	dir := filepath.Join(t.TempDir(), "my-skill")
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "references"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("---\nname: my-skill\ndescription: Does a thing.\n---\n# Body\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "references", "guide.md"), []byte("guide"), 0o644))
	return dir
}

func TestZipSkillFolderMakesAZipTheServerParsesAndRefusesLinks(t *testing.T) {
	dir := writeSkillFolder(t)
	data, err := zipSkillFolder(dir)
	require.NoError(t, err)
	sk, err := skills.Parse(data)
	require.NoError(t, err, "the zip is one the store's own parser accepts, SKILL.md at its top")
	assert.Equal(t, "my-skill", sk.Name)
	assert.True(t, skills.AgentMayPublish(sk))

	if runtime.GOOS != "windows" {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "run.txt"), []byte("plain text"), 0o755))
		data, err = zipSkillFolder(dir)
		require.NoError(t, err)
		sk, err = skills.Parse(data)
		require.NoError(t, err)
		assert.Equal(t, 1, sk.Scripts(), "an executable file is a script, so an agent's publish is refused by the server")
		require.NoError(t, os.Remove(filepath.Join(dir, "run.txt")))

		require.NoError(t, os.Symlink("/etc/passwd", filepath.Join(dir, "references", "link.md")))
		_, err = zipSkillFolder(dir)
		assert.ErrorContains(t, err, "is a link", "a link is refused before anything is sent")
		require.NoError(t, os.Remove(filepath.Join(dir, "references", "link.md")))
	}
	_, err = zipSkillFolder(filepath.Join(dir, "SKILL.md"))
	assert.ErrorContains(t, err, "not a folder")
	_, err = zipSkillFolder(filepath.Join(t.TempDir(), "missing"))
	assert.Error(t, err)
}

func TestCLISkillsPublishSendsTheZipAndSaysItWaits(t *testing.T) {
	var got struct {
		Zip string `json:"zip_base64"`
	}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" && r.URL.Path == "/api/agent/skills" {
			_ = json.NewDecoder(r.Body).Decode(&got)
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "abc", "name": "my-skill", "version": 1, "status": "pending", "digest": "d"})
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(ts.Close)
	orig := serverURL
	serverURL = ts.URL
	t.Cleanup(func() { serverURL = orig })
	t.Setenv("TMUX", "")
	t.Setenv("CORAL_SESSION_NAME", "claude-00000000-0000-4000-8000-0000000000a1")
	out := captureStdout(t, func() { cmdSkills([]string{"publish", writeSkillFolder(t)}) })
	assert.Contains(t, out, "Published my-skill version 1 (id abc): pending")
	assert.Contains(t, out, "waits for the Operator's approval")
	raw, err := base64.StdEncoding.DecodeString(got.Zip)
	require.NoError(t, err)
	sk, err := skills.Parse(raw)
	require.NoError(t, err)
	assert.Equal(t, "my-skill", sk.Name)
}
