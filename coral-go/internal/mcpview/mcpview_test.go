package mcpview

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9769: the MCP servers an agent CLI has configured: name, transport and scope, from the CLI's own files in a temporary home, and never a command, argument, environment value, header or URL.

const secret = "SECRET-TOKEN-9f3a"

func write(t *testing.T, path, text string) {
	t.Helper()
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
	require.NoError(t, os.WriteFile(path, []byte(text), 0o600))
}

func TestClaudeUserLocalAndProjectServers(t *testing.T) {
	home, folder := t.TempDir(), t.TempDir()
	write(t, filepath.Join(home, ".claude.json"), `{
	  "mcpServers": {"github": {"type": "http", "url": "https://api.example.com/mcp?key=`+secret+`", "headers": {"Authorization": "Bearer `+secret+`"}},
	                 "files": {"command": "/usr/bin/mcp-files", "args": ["--token", "`+secret+`"], "env": {"API_KEY": "`+secret+`"}}},
	  "projects": {
	    "`+filepath.ToSlash(folder)+`": {"mcpServers": {"private-db": {"type": "stdio", "command": "db-mcp"}}},
	    "/some/other/folder": {"mcpServers": {"not-mine": {"command": "x"}}}
	  }}`)
	write(t, filepath.Join(folder, ".mcp.json"), `{"mcpServers": {"shared-sse": {"type": "sse", "url": "https://x.example/sse"}, "plain": {"command": "p"}}}`)
	res := List(Env{Home: home}, "claude", folder)
	require.True(t, res.Supported)
	got := map[string]Server{}
	for _, s := range res.Servers {
		got[s.Name] = s
	}
	assert.Equal(t, Server{"github", "http", ScopeUser}, got["github"])
	assert.Equal(t, Server{"files", "stdio", ScopeUser}, got["files"])
	assert.Equal(t, Server{"private-db", "stdio", ScopeLocal}, got["private-db"], "this folder's private entry")
	assert.Equal(t, Server{"shared-sse", "sse", ScopeProject}, got["shared-sse"])
	assert.Equal(t, Server{"plain", "stdio", ScopeProject}, got["plain"], "a command with no type is stdio")
	assert.NotContains(t, got, "not-mine", "another folder's entry is not this agent's")
	assert.Len(t, res.Servers, 5)
	raw, _ := json.Marshal(res)
	for _, leaked := range []string{secret, "api.example.com", "mcp-files", "--token", "API_KEY", "Authorization", "db-mcp", "x.example"} {
		assert.NotContains(t, string(raw), leaked, "the result never carries a command, argument, environment, header or URL")
	}
	// the user scope first, then the folder's
	assert.Equal(t, ScopeUser, res.Servers[0].Scope)
}

func TestCodexServersFromTheUserAndTheFolder(t *testing.T) {
	home, folder := t.TempDir(), t.TempDir()
	write(t, filepath.Join(home, ".codex", "config.toml"), `model = "gpt"
[mcp_servers.docs]
url = "https://docs.example/mcp"
bearer_token_env_var = "`+secret+`"

[mcp_servers.fs]
command = "npx"
args = ["-y", "server", "`+secret+`"]
[mcp_servers.fs.env]
KEY = "`+secret+`"
`)
	write(t, filepath.Join(folder, ".codex", "config.toml"), "[mcp_servers.local-tool]\ncommand = \"tool\"\n")
	res := List(Env{Home: home}, "codex", folder)
	got := map[string]Server{}
	for _, s := range res.Servers {
		got[s.Name] = s
	}
	assert.Equal(t, Server{"docs", "http", ScopeUser}, got["docs"])
	assert.Equal(t, Server{"fs", "stdio", ScopeUser}, got["fs"])
	assert.Equal(t, Server{"local-tool", "stdio", ScopeProject}, got["local-tool"])
	raw, _ := json.Marshal(res)
	assert.NotContains(t, string(raw), secret)
	assert.NotContains(t, string(raw), "docs.example")

	// CODEX_HOME replaces ~/.codex
	other := t.TempDir()
	write(t, filepath.Join(other, "config.toml"), "[mcp_servers.elsewhere]\ncommand = \"e\"\n")
	res = List(Env{Home: home, CodexHome: other}, "codex", "")
	require.Len(t, res.Servers, 1)
	assert.Equal(t, "elsewhere", res.Servers[0].Name)
}

func TestGeminiServers(t *testing.T) {
	home, folder := t.TempDir(), t.TempDir()
	write(t, filepath.Join(home, ".gemini", "settings.json"), `{"theme": "x", "mcpServers": {"a": {"command": "c", "env": {"K": "`+secret+`"}}, "b": {"url": "https://sse.example"}, "c": {"httpUrl": "https://http.example"}, "d": {}}}`)
	write(t, filepath.Join(folder, ".gemini", "settings.json"), `{"mcpServers": {"proj": {"type": "http", "url": "u"}}}`)
	res := List(Env{Home: home}, "gemini", folder)
	got := map[string]Server{}
	for _, s := range res.Servers {
		got[s.Name] = s
	}
	assert.Equal(t, "stdio", got["a"].Transport)
	assert.Equal(t, "sse", got["b"].Transport, "Gemini's url is its SSE endpoint")
	assert.Equal(t, "http", got["c"].Transport)
	assert.Equal(t, "unknown", got["d"].Transport)
	assert.Equal(t, Server{"proj", "http", ScopeProject}, got["proj"])
	raw, _ := json.Marshal(res)
	assert.NotContains(t, string(raw), secret)
}

func TestNothingConfiguredAndUnreadableFilesAreEmptyNotErrors(t *testing.T) {
	home := t.TempDir()
	for _, cli := range []string{"claude", "codex", "gemini"} {
		res := List(Env{Home: home}, cli, t.TempDir())
		assert.True(t, res.Supported, cli)
		assert.NotNil(t, res.Servers, cli+": an empty list, not null")
		assert.Empty(t, res.Servers, cli)
	}
	write(t, filepath.Join(home, ".claude.json"), "not json {")
	write(t, filepath.Join(home, ".codex", "config.toml"), "= = not toml")
	write(t, filepath.Join(home, ".gemini", "settings.json"), "[1,2")
	for _, cli := range []string{"claude", "codex", "gemini"} {
		assert.Empty(t, List(Env{Home: home}, cli, "").Servers, cli+": a broken file is nothing configured")
	}
	// a folder where a file should be, and a missing home
	require.NoError(t, os.MkdirAll(filepath.Join(home, "d", ".mcp.json"), 0o755))
	assert.Empty(t, List(Env{Home: home}, "claude", filepath.Join(home, "d")).Servers)
	assert.Empty(t, List(Env{Home: filepath.Join(home, "none")}, "claude", "").Servers)
}

func TestOtherCLIsAreNotReadAndSaySo(t *testing.T) {
	for _, cli := range []string{"agy", "antigravity", "pi", "terminal", ""} {
		res := List(Env{Home: t.TempDir()}, cli, "")
		assert.False(t, res.Supported, cli)
		assert.NotEmpty(t, res.Reason, cli)
		assert.Empty(t, res.Servers, cli)
	}
}

func TestNamesAreCleanedAndTheListIsBounded(t *testing.T) {
	home := t.TempDir()
	var b strings.Builder
	b.WriteString(`{"mcpServers": {"evil\u001b[31m\u202e name": {"command":"c"}, "` + strings.Repeat("n", 500) + `": {"command":"c"}, "": {"command":"c"}`)
	for i := 0; i < 150; i++ {
		b.WriteString(`, "s` + strings.Repeat("0", 3-len(itoa(i))) + itoa(i) + `": {"command":"c"}`)
	}
	b.WriteString("}}")
	write(t, filepath.Join(home, ".claude.json"), b.String())
	res := List(Env{Home: home}, "claude", "")
	assert.True(t, res.Truncated)
	assert.Len(t, res.Servers, MaxServers)
	for _, s := range res.Servers {
		assert.LessOrEqual(t, len([]rune(s.Name)), maxNameRunes)
		assert.NotContains(t, s.Name, "\x1b")
		assert.NotContains(t, s.Name, "\u202e")
		assert.NotEmpty(t, s.Name, "a nameless entry is dropped")
	}
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

func TestAFileOverTheBoundIsNotRead(t *testing.T) {
	home := t.TempDir()
	big := `{"mcpServers": {"a": {"command": "c"}}, "pad": "` + strings.Repeat("x", maxFileBytes) + `"}`
	write(t, filepath.Join(home, ".claude.json"), big)
	assert.Empty(t, List(Env{Home: home}, "claude", "").Servers, "over 32 MiB: ignored, never read whole")
}
