package psquote

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestNativeArg(t *testing.T) {
	for s, want := range map[string]string{
		"":                                   "",
		"plain":                              "plain",
		"a b":                                "a b", // 5.1 adds the quotes
		`a"b`:                                `a\"b`,
		`a "b c" d`:                          `a \"b c\" d`,
		`C:\dir with space\`:                 `C:\dir with space\\`, // 5.1's closing quote stays a quote
		`C:\nospace\`:                        `C:\nospace\`,         // no quotes added: nothing to double
		`a\"b`:                               `a\\\"b`,
		`a\\"b`:                              `a\\\\\"b`,
		`x y\\`:                              `x y\\\\`,
		`(x86)`:                              `(x86)`,
		`"`:                                  `\"`,
		`\`:                                  `\`,
		"tab\there":                          "tab\there",
		`a"b c`:                              `"a""b c"`, // 5.1 wouldn't quote it: quoted here
		`ab"c d"`:                            `"ab""c d"""`,
		`x=\"C:/Program Files (x86)/a.exe\"`: `"x=\\""C:/Program Files (x86)/a.exe\\"""`,
		`"a b\"`:                             `"""a b\\"""`,
		// Codex's hook value, the operator's report (#12): each \" in the TOML becomes \\\".
		`hooks.SessionStart=[{hooks=[{type="command",command="\"C:/Program Files (x86)/Coral/coral-hook-agentic-state.exe\""}]}]`: `hooks.SessionStart=[{hooks=[{type=\"command\",command=\"\\\"C:/Program Files (x86)/Coral/coral-hook-agentic-state.exe\\\"\"}]}]`,
	} {
		assert.Equal(t, want, NativeArg(s), "%s", s)
	}
}

// A .cmd or .bat reads its arguments through cmd.exe twice (#16207): one with < > & | or ^ in it is wrapped in double quotes, which are plain text in both readings; one that cannot be wrapped safely is left alone.
func TestCmdArg(t *testing.T) {
	for _, c := range []struct {
		in, want string
		ok       bool
	}{
		{`hooks.state={'C:\<session-flags>\config.toml:session_start:0:0'={trusted_hash='sha256:ab'}}`, `"hooks.state={'C:\<session-flags>\config.toml:session_start:0:0'={trusted_hash='sha256:ab'}}"`, true},
		{"a&b", `"a&b"`, true},
		{"a|b", `"a|b"`, true},
		{"a^b", `"a^b"`, true},
		{"plain", "plain", false},
		{"--flag=value", "--flag=value", false},
		{`a"<b`, `a"<b`, false},   // cmd counts every quote
		{"50%<x", "50%<x", false}, // cmd expands % inside quotes
		{`a<b\`, `a<b\`, false},   // a trailing backslash would escape the closing quote
		{"a<\nb", "a<\nb", false},
	} {
		got, ok := CmdArg(c.in)
		if got != c.want || ok != c.ok {
			t.Errorf("CmdArg(%q) = %q, %v; want %q, %v", c.in, got, ok, c.want, c.ok)
		}
	}
}

// A path with a % or a " and also a & < > | or ^ cannot be quoted for cmd.exe (#16224): CmdUnsafe says so, and the launch refuses it.
func TestCmdUnsafe(t *testing.T) {
	for in, want := range map[string]bool{
		`C:\Users\A&B%x`:         true,
		`C:\Users\A&B"x`:         true,
		`C:\Users\A&B\`:          true,
		`C:\Users\A&B`:           false, // wrapped by CmdArg
		`C:\Users\A%x`:           false, // no metacharacter: cmd leaves it as it is
		"plain":                  false,
		`hooks.state={'C:\<s>'}`: false,
	} {
		if got := CmdUnsafe(in); got != want {
			t.Errorf("CmdUnsafe(%q) = %v, want %v", in, got, want)
		}
	}
}
