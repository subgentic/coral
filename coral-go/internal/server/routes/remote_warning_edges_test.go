package routes

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// #9681 (security check on #9679 slice 1): the warning the Servers page shows beside a server's name is the server record's `warning`, and the record has one exactly when its URL is plain http at an
// address that is not this computer (remoteURLWarning). The cases remote_https_test.go does not have: hostnames made to look like this computer, other spellings of the scheme and the host, a login in
// the URL, other address families. A warning that is missing for a URL that sends the key across a network is the dangerous mistake; one that is shown for a spelling of this computer is a nuisance.
func TestRemoteURLWarningEdgeCases(t *testing.T) {
	for raw, warn := range map[string]bool{
		// a name that only begins like this computer is a network host: warn
		"http://127.0.0.1.evil.example:8420":   true,
		"http://localhost.evil.example:8420":   true,
		"http://notlocalhost:8420":             true,
		"http://127.0.0.1@evil.example:8420":   true, // the "host" before the @ is a login, the host is evil.example
		"http://localhost@10.0.0.2:8420":       true,
		"http://127.0.0.1:8420@10.0.0.2:8420/": true,
		"http://user:secret@10.0.0.2:8420":     true,
		// spellings of the scheme and the host
		"HTTP://10.0.0.2:8420":               true,
		"Http://Remote.Example:8420":         true,
		"http://10.0.0.2:8420/path?x=1#frag": true,
		"http://[fe80::1]:8420":              true,
		"http://[2001:db8::1]:8420":          true,
		"http://0.0.0.0:8420":                true,
		"http://169.254.1.1:8420":            true,
		"http://224.0.0.1:8420":              true,
		// this computer, every way url.Parse and net.ParseIP read it: no warning
		"http://127.0.0.1":                  false,
		"http://127.255.255.254:8420":       false,
		"http://[::ffff:127.0.0.1]:8420":    false,
		"http://localhost":                  false,
		"http://LocalHost:8420":             false,
		"http://localhost:8420/path":        false,
		"http://user:secret@localhost:8420": false,
		"http://[::1]":                      false,
		"http://[0:0:0:0:0:0:0:1]:8420":     false,
		// not http: the key is not sent in the clear by the scheme (https, and the rest are not servers)
		"https://10.0.0.2:8420": false,
		"HTTPS://10.0.0.2:8420": false,
		"ftp://10.0.0.2":        false,
		"":                      false,
	} {
		w := remoteURLWarning(raw)
		if warn {
			assert.Equal(t, remoteHTTPWarning, w, "%q is plain http to another address: it warns", raw)
		} else {
			assert.Empty(t, w, "%q: no warning", raw)
		}
	}
}

// A spelling of this computer that net.ParseIP and url.Parse do not read as one (a trailing dot, a decimal or shortened address) is not exempted: the warning stays, which is the safe side of the rule.
func TestRemoteURLWarningDoesNotExemptUnusualSpellingsOfThisComputer(t *testing.T) {
	for _, raw := range []string{"http://localhost.:8420", "http://2130706433:8420", "http://127.1:8420", "http://0x7f.0.0.1:8420", "http://[::ffff:7f00:1]:8420x"} {
		_ = remoteURLWarning(raw) // never a panic
	}
	for _, raw := range []string{"http://localhost.:8420", "http://2130706433:8420", "http://127.1:8420", "http://0x7f.0.0.1:8420"} {
		assert.Equal(t, remoteHTTPWarning, remoteURLWarning(raw), "%q is not read as this computer: it warns", raw)
	}
}
