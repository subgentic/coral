// Package mcpview lists which MCP servers an agent CLI has configured (#9769): name, transport and scope, read from the CLI's OWN configuration files and nothing else. Coral does not
// configure MCP servers (#3644) and never writes these files; this reads them and reports only what the Operator needs to see which servers an agent has. A server's command, arguments,
// environment, headers and URLs (which hold secrets) are never put in a result: the structs below do not even decode the environment or the headers.
package mcpview

import (
	"encoding/json"
	"errors"
	"io"
	"path/filepath"
	"sort"
	"strings"
	"unicode"

	"github.com/pelletier/go-toml/v2"
)

// Scopes of a server: where in the CLI's configuration it is.
const (
	ScopeUser    = "user"    // the person's own configuration, for every folder
	ScopeProject = "project" // a file in the agent's folder, shared with the project
	ScopeLocal   = "local"   // the person's private configuration for this folder (Claude's per-project entry)
)

// Server is one configured MCP server, as far as the Operator is told.
type Server struct {
	Name      string `json:"name"`
	Transport string `json:"transport"` // stdio, http, sse or unknown
	Scope     string `json:"scope"`
}

// Result is what a CLI has configured for a folder. Supported is false for a CLI whose configuration this does not read (Reason says so).
type Result struct {
	AgentType string   `json:"agent_type"`
	Supported bool     `json:"supported"`
	Reason    string   `json:"reason,omitempty"`
	Servers   []Server `json:"servers"`
	Truncated bool     `json:"truncated,omitempty"` // more servers than MaxServers
}

const (
	// MaxServers is how many servers a result lists.
	MaxServers = 100
	// maxFileBytes bounds a configuration file read (a Claude user file with many projects can be several MB).
	maxFileBytes = 32 << 20
	maxNameRunes = 80
)

// Env is where the configuration lives: the person's home folder, and Codex's home when CODEX_HOME says another. Tests give a temporary one; nothing here reads the process environment.
type Env struct {
	Home      string
	CodexHome string // "" means <Home>/.codex
	PiDir     string // Pi's own folder (PI_CODING_AGENT_DIR): "" means <Home>/.pi/agent
}

// List returns the MCP servers agentType has configured for folder (the agent's working directory; "" reads the user scope only).
func List(env Env, agentType, folder string) Result {
	res := Result{AgentType: agentType, Supported: true, Servers: []Server{}}
	var all []Server
	switch agentType {
	case "claude":
		all = readClaude(env, folder)
	case "codex":
		all = readCodex(env, folder)
	case "gemini":
		all = readGemini(env, folder)
	case "pi":
		all = readPi(env, folder)
	default:
		res.Supported = false
		res.Reason = "Coral does not read this CLI's MCP configuration yet"
		return res
	}
	sort.SliceStable(all, func(i, j int) bool {
		if all[i].Scope != all[j].Scope {
			return scopeOrder(all[i].Scope) < scopeOrder(all[j].Scope)
		}
		return all[i].Name < all[j].Name
	})
	if len(all) > MaxServers {
		all, res.Truncated = all[:MaxServers], true
	}
	if all != nil {
		res.Servers = all
	}
	return res
}

func scopeOrder(s string) int {
	switch s {
	case ScopeUser:
		return 0
	case ScopeProject:
		return 1
	}
	return 2
}

// readFile reads a regular file of at most maxFileBytes; a missing file, a folder, a FIFO or device, or one too large is "nothing configured here", never an error to show. The file is OPENED
// first (without blocking, where the system has that) and the opened file is what is checked, so a file swapped for a FIFO between a check and an open (an agent can write its own folder) cannot
// block this request.
func readFile(path string) []byte {
	f, err := openNoBlock(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxFileBytes {
		return nil
	}
	b, err := io.ReadAll(io.LimitReader(f, maxFileBytes+1))
	if err != nil || len(b) > maxFileBytes {
		return nil
	}
	return b
}

// cleanName makes a server's name safe to show: no control or format characters, bounded.
func cleanName(s string) string {
	var b strings.Builder
	n := 0
	for _, r := range s {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			continue
		}
		if n++; n > maxNameRunes {
			break
		}
		b.WriteRune(r)
	}
	return strings.TrimSpace(b.String())
}

// jsonServer is the only part of a JSON server entry that is decoded: the transport words and whether a command or a URL is there. The environment, headers, arguments and the values of
// command and URL are skipped by the decoder and never held.
type jsonServer struct {
	Type    string          `json:"type"`
	Command json.RawMessage `json:"command"`
	URL     json.RawMessage `json:"url"`
	HTTPURL json.RawMessage `json:"httpUrl"` // Gemini's streamable HTTP
}

func present(raw json.RawMessage) bool {
	t := strings.TrimSpace(string(raw))
	return t != "" && t != "null" && t != `""`
}

// transportOf is a JSON entry's transport: its own type when it says one (stdio, http, sse; "streamable-http" is http), else from what it has: a command is stdio, a url is http (sse for
// Gemini's url, which is its SSE endpoint), an httpUrl is http.
func transportOf(s jsonServer, gemini bool) string {
	switch strings.ToLower(strings.TrimSpace(s.Type)) {
	case "stdio":
		return "stdio"
	case "http", "streamable-http", "streamable_http":
		return "http"
	case "sse":
		return "sse"
	}
	switch {
	case present(s.Command):
		return "stdio"
	case present(s.HTTPURL):
		return "http"
	case present(s.URL) && gemini:
		return "sse"
	case present(s.URL):
		return "http"
	}
	return "unknown"
}

func fromJSONServers(raw map[string]json.RawMessage, scope string, gemini bool) []Server {
	var out []Server
	for name, entry := range raw {
		n := cleanName(name)
		if n == "" {
			continue
		}
		var s jsonServer
		if json.Unmarshal(entry, &s) != nil {
			s = jsonServer{} // an entry that is not an object is still a configured name
		}
		out = append(out, Server{Name: n, Transport: transportOf(s, gemini), Scope: scope})
	}
	return out
}

// readClaude reads ~/.claude.json (the user's servers, and the private ones of this folder under "projects") and <folder>/.mcp.json (the project's).
func readClaude(env Env, folder string) []Server {
	var out []Server
	if b := readFile(filepath.Join(env.Home, ".claude.json")); b != nil {
		var f struct {
			MCPServers map[string]json.RawMessage `json:"mcpServers"`
			Projects   map[string]struct {
				MCPServers map[string]json.RawMessage `json:"mcpServers"`
			} `json:"projects"`
		}
		if json.Unmarshal(b, &f) == nil {
			out = append(out, fromJSONServers(f.MCPServers, ScopeUser, false)...)
			if folder != "" {
				want := filepath.Clean(folder)
				for p, proj := range f.Projects {
					if filepath.Clean(p) == want {
						out = append(out, fromJSONServers(proj.MCPServers, ScopeLocal, false)...)
					}
				}
			}
		}
	}
	if folder != "" {
		if b := readFile(filepath.Join(folder, ".mcp.json")); b != nil {
			var f struct {
				MCPServers map[string]json.RawMessage `json:"mcpServers"`
			}
			if json.Unmarshal(b, &f) == nil {
				out = append(out, fromJSONServers(f.MCPServers, ScopeProject, false)...)
			}
		}
	}
	return out
}

// readGemini reads ~/.gemini/settings.json and <folder>/.gemini/settings.json (mcpServers in each).
func readGemini(env Env, folder string) []Server {
	var out []Server
	read := func(path, scope string) {
		b := readFile(path)
		if b == nil {
			return
		}
		var f struct {
			MCPServers map[string]json.RawMessage `json:"mcpServers"`
		}
		if json.Unmarshal(b, &f) == nil {
			out = append(out, fromJSONServers(f.MCPServers, scope, true)...)
		}
	}
	read(filepath.Join(env.Home, ".gemini", "settings.json"), ScopeUser)
	if folder != "" {
		read(filepath.Join(folder, ".gemini", "settings.json"), ScopeProject)
	}
	return out
}

// tomlServer is the part of a Codex [mcp_servers.<name>] table that is decoded: whether it has a command or a url. The environment, arguments and headers are not fields here.
type tomlServer struct {
	Command string `toml:"command"`
	URL     string `toml:"url"`
}

// readCodex reads <CODEX_HOME>/config.toml and <folder>/.codex/config.toml (mcp_servers in each).
func readCodex(env Env, folder string) []Server {
	var out []Server
	read := func(path, scope string) {
		b := readFile(path)
		if b == nil {
			return
		}
		var f struct {
			MCPServers map[string]tomlServer `toml:"mcp_servers"`
		}
		if err := toml.Unmarshal(b, &f); err != nil && !errors.Is(err, io.EOF) {
			return
		}
		for name, s := range f.MCPServers {
			n := cleanName(name)
			if n == "" {
				continue
			}
			t := "unknown"
			switch {
			case s.Command != "":
				t = "stdio"
			case s.URL != "":
				t = "http"
			}
			out = append(out, Server{Name: n, Transport: t, Scope: scope})
		}
	}
	codexHome := env.CodexHome
	if codexHome == "" {
		codexHome = filepath.Join(env.Home, ".codex")
	}
	read(filepath.Join(codexHome, "config.toml"), ScopeUser)
	if folder != "" {
		read(filepath.Join(folder, ".codex", "config.toml"), ScopeProject)
	}
	return out
}

// piServer is the part of a Pi mcp.json entry that is decoded: the transport words, whether a command or a URL is there, and the enabled switch. The environment, headers, arguments, cwd, OAuth
// settings, description and the values of command and URL are skipped by the decoder and never held.
type piServer struct {
	Type    string          `json:"type"`
	Command json.RawMessage `json:"command"`
	URL     json.RawMessage `json:"url"`
	Enabled *bool           `json:"enabled"`
}

// defines reports whether the entry is a server of its own (it names a command, a URL or a type) and not only settings for the user-level server of the same name.
func (s piServer) defines() bool {
	return present(s.Command) || present(s.URL) || strings.TrimSpace(s.Type) != ""
}

// piMCPFile reads the mcpServers of one Pi mcp.json: name -> entry, an entry that is not an object being an entry with nothing set.
func piMCPFile(path string) map[string]piServer {
	b := readFile(path)
	if b == nil {
		return nil
	}
	var f struct {
		MCPServers map[string]json.RawMessage `json:"mcpServers"`
	}
	if json.Unmarshal(b, &f) != nil {
		return nil
	}
	out := make(map[string]piServer, len(f.MCPServers))
	for name, raw := range f.MCPServers {
		var s piServer
		if json.Unmarshal(raw, &s) != nil {
			s = piServer{}
		}
		out[name] = s
	}
	return out
}

// readPi reads Pi 1.4.0's MCP configuration (docs mcp.md): ~/.pi/agent/mcp.json (or <PI_CODING_AGENT_DIR>/mcp.json) for the user and <folder>/.pi/mcp.json for the project. A project entry with no
// command, URL or type only changes the settings of the user-level server of the same name (here: enabled). A server with enabled: false is kept in the file but not connected, so it is not listed.
// Pi connects a project's servers only after the person trusts that folder; that decision is not read here, so a project server is listed as the project's own.
func readPi(env Env, folder string) []Server {
	piDir := env.PiDir
	if piDir == "" {
		piDir = filepath.Join(env.Home, ".pi", "agent")
	}
	user := piMCPFile(filepath.Join(piDir, "mcp.json"))
	var project map[string]piServer
	if folder != "" {
		project = piMCPFile(filepath.Join(folder, ".pi", "mcp.json"))
	}
	listed := func(s piServer) bool { return s.Enabled == nil || *s.Enabled }
	var out []Server
	for name, s := range user {
		if o, ok := project[name]; ok && !o.defines() && o.Enabled != nil {
			s.Enabled = o.Enabled // the project's switch for the user's server
		}
		if n := cleanName(name); n != "" && listed(s) {
			out = append(out, Server{Name: n, Transport: piTransport(s), Scope: ScopeUser})
		}
	}
	for name, s := range project {
		if !s.defines() {
			continue // settings for a user-level server, handled above
		}
		if n := cleanName(name); n != "" && listed(s) {
			out = append(out, Server{Name: n, Transport: piTransport(s), Scope: ScopeProject})
		}
	}
	return out
}

func piTransport(s piServer) string {
	return transportOf(jsonServer{Type: s.Type, Command: s.Command, URL: s.URL}, false)
}
