package mcpview

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11109 (Pi parity row 14): the MCP servers a Pi agent has, from Pi 1.4.0's own files: ~/.pi/agent/mcp.json (user) and <folder>/.pi/mcp.json (project), each {"mcpServers": {name: entry}}. Name,
// transport and scope only, never a command, argument, environment, header, URL or token; a server Pi is told not to connect (enabled: false) is not listed.
func TestPiUserAndProjectServers(t *testing.T) {
	home, folder := t.TempDir(), t.TempDir()
	write(t, filepath.Join(home, ".pi", "agent", "mcp.json"), `{"mcpServers": {
	  "filesystem": {"command": "npx", "args": ["-y", "server-filesystem", "--token", "`+secret+`"], "env": {"API_KEY": "`+secret+`"}, "cwd": "~/work"},
	  "docs": {"url": "https://example.com/mcp?key=`+secret+`", "headers": {"Authorization": "Bearer `+secret+`"}, "description": "Search the docs"},
	  "typed": {"type": "streamable-http", "url": "https://t.example/mcp"},
	  "off": {"command": "x", "enabled": false},
	  "overridden": {"command": "y"},
	  "bad\u202ename\u001b[31m": {"command": "z"}}}`)
	write(t, filepath.Join(folder, ".pi", "mcp.json"), `{"mcpServers": {
	  "overridden": {"enabled": false},
	  "docs": {"exposure": "lazy"},
	  "project-tools": {"command": "uvx", "args": ["tools-mcp"], "env": {"K": "`+secret+`"}}}}`)

	res := List(Env{Home: home}, "pi", folder)
	require.True(t, res.Supported, res.Reason)
	got := map[string]Server{}
	for _, s := range res.Servers {
		got[s.Name] = s
	}
	assert.Equal(t, Server{"filesystem", "stdio", ScopeUser}, got["filesystem"])
	assert.Equal(t, Server{"docs", "http", ScopeUser}, got["docs"], "a project entry with no command or url only changes the user server's settings")
	assert.Equal(t, Server{"typed", "http", ScopeUser}, got["typed"])
	assert.Equal(t, Server{"project-tools", "stdio", ScopeProject}, got["project-tools"])
	assert.NotContains(t, got, "off", "enabled: false is not connected")
	assert.NotContains(t, got, "overridden", "the project turned the user's server off")
	assert.Contains(t, got, "badname[31m", "a name is cleaned of control and format characters")
	assert.Len(t, res.Servers, 5)

	b, _ := json.Marshal(res)
	for _, never := range []string{secret, "npx", "uvx", "example.com", "Authorization", "API_KEY", "~/work", "Search the docs"} {
		assert.NotContains(t, string(b), never, "no command, argument, environment, header, URL or description in the answer")
	}
}

func TestPiDirFollowsPiCodingAgentDirAndMissingFilesAreNothing(t *testing.T) {
	home, other := t.TempDir(), t.TempDir()
	res := List(Env{Home: home}, "pi", "")
	require.True(t, res.Supported)
	assert.Empty(t, res.Servers, "no file: nothing configured, not an error")

	write(t, filepath.Join(other, "mcp.json"), `{"mcpServers": {"moved": {"command": "m"}}}`)
	write(t, filepath.Join(home, ".pi", "agent", "mcp.json"), `{"mcpServers": {"home-one": {"command": "h"}}}`)
	res = List(Env{Home: home, PiDir: other}, "pi", "")
	require.Len(t, res.Servers, 1)
	assert.Equal(t, "moved", res.Servers[0].Name, "PI_CODING_AGENT_DIR moves Pi's folder")

	write(t, filepath.Join(other, "mcp.json"), `{not json`)
	assert.Empty(t, List(Env{Home: home, PiDir: other}, "pi", "").Servers, "an unreadable file is nothing here")
}
