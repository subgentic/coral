package auth

import (
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestProxiedRequest(t *testing.T) {
	for name, tc := range map[string]struct {
		host    string
		headers map[string]string
		want    bool
	}{
		"direct local":          {"127.0.0.1:8420", nil, false},
		"localhost":             {"localhost:8420", nil, false},
		"ipv6 loopback":         {"[::1]:8420", nil, false},
		"forwarded for":         {"127.0.0.1:8420", map[string]string{"X-Forwarded-For": "203.0.113.9"}, true},
		"forwarded host":        {"127.0.0.1:8420", map[string]string{"X-Forwarded-Host": "coral.example.com"}, true},
		"forwarded (rfc 7239)":  {"127.0.0.1:8420", map[string]string{"Forwarded": "for=203.0.113.9"}, true},
		"via":                   {"127.0.0.1:8420", map[string]string{"Via": "1.1 proxy"}, true},
		"public name":           {"coral.example.com", nil, true},
		"public name with port": {"coral.example.com:443", nil, true},
		"lan address":           {"192.168.1.5:8420", nil, true},
	} {
		r := httptest.NewRequest("GET", "/", nil)
		r.Host = tc.host
		for k, v := range tc.headers {
			r.Header.Set(k, v)
		}
		assert.Equal(t, tc.want, ProxiedRequest(r), name)
	}
}

// Red when no password stands in front of it and a direct local client is trusted; amber otherwise (#21527).
func TestProxyWarningSeverity(t *testing.T) {
	t.Cleanup(func() { SetRequireAuthOnLoopback(false) })
	SetRequireAuthOnLoopback(false)
	assert.True(t, ProxyWarningRed(false, true), "no password, loopback trusted: red")
	assert.False(t, ProxyWarningRed(true, true), "a password is set and local requests need a credential: not red")
	assert.True(t, ProxyWarningRed(true, false), "a password but strict local auth off: a header-less proxy gets in with no credential, red (#21526)")
	SetRequireAuthOnLoopback(true)
	assert.False(t, ProxyWarningRed(false, false), "require_auth_on_loopback on: not red")
}

func TestNoteProxiedRemembersAndNeverRefuses(t *testing.T) {
	ResetProxySeenForTest()
	t.Cleanup(ResetProxySeenForTest)
	assert.False(t, ProxySeen())
	NoteProxied(func() bool { return false }, true)
	assert.True(t, ProxySeen())
}
