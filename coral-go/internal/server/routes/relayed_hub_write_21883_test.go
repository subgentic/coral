package routes

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/devicekey"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #21883 commit 2: with the switch on, every write the Hub carries is signed (a named kind, or the generic hub-write), except the few the Hub itself sends with no person, each admitted by its own authority.

var goldenLine = regexp.MustCompile(`^([A-Z]+) (\S+) (\S+)$`)

// goldenRoutes reads cloud_routes.golden: method, pattern, tier.
func goldenRoutes(t *testing.T) (out [][3]string) {
	t.Helper()
	f, err := os.Open("../testdata/cloud_routes.golden")
	require.NoError(t, err)
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if m := goldenLine.FindStringSubmatch(sc.Text()); m != nil {
			out = append(out, [3]string{m[1], m[2], m[3]})
		}
	}
	require.NoError(t, sc.Err())
	require.Greater(t, len(out), 400, "the golden was read")
	return out
}

func concretePattern(p string) string {
	return regexp.MustCompile(`\{[^}]+\}`).ReplaceAllString(p, "x1")
}

func isWrite(m string) bool { return m != "GET" && m != "HEAD" && m != "OPTIONS" }

func TestWithTheSwitchOnEveryWriteInTheGoldenIsSignedOrExemptByName(t *testing.T) {
	n, exempt := 0, 0
	for _, g := range goldenRoutes(t) {
		method, pattern, tier := g[0], g[1], g[2]
		if !isWrite(method) || tier == "never" {
			continue
		}
		target := concretePattern(pattern)
		if devicekey.HubWriteExempt(method, target) {
			exempt++
			continue
		}
		n++
		rec, reached := guardRunFor(true, method, target, nil)
		assert.False(t, reached, "%s %s must not reach the handler unsigned", method, pattern)
		assert.Equal(t, http.StatusForbidden, rec.Code, "%s %s: %s", method, pattern, rec.Body.String())
		assert.Contains(t, rec.Body.String(), "device_required", "%s %s", method, pattern)
	}
	assert.Greater(t, n, 100, "the golden's writes were read")
	assert.GreaterOrEqual(t, exempt, 4, "the exempt routes the golden lists below never were seen (guide-revoked is the service table's, never for a person)")
}

func TestWithTheSwitchOffEveryWriteInTheGoldenIsUntouched(t *testing.T) {
	for _, g := range goldenRoutes(t) {
		method, pattern := g[0], g[1]
		if _, named := devicekey.KindOfRoute(method, concretePattern(pattern)); !isWrite(method) || (named && relayedRequiredFor(method, concretePattern(pattern))) {
			continue
		}
		_, reached := guardRunFor(false, method, concretePattern(pattern), nil)
		assert.True(t, reached, "%s %s is not touched while the switch is off", method, pattern)
	}
}

func TestEveryGoldenWriteIsANamedKindExemptOrHubWrite(t *testing.T) {
	for _, g := range goldenRoutes(t) {
		method, pattern, tier := g[0], g[1], g[2]
		if !isWrite(method) || tier == "never" {
			continue
		}
		target := concretePattern(pattern)
		_, named := devicekey.KindOfRoute(method, target)
		kinds := 0
		for _, ok := range []bool{named, devicekey.HubWriteExempt(method, target), devicekey.IsHubWrite(method, target)} {
			if ok {
				kinds++
			}
		}
		assert.Equal(t, 1, kinds, "%s %s is exactly one of: a named kind, exempt, hub-write", method, pattern)
	}
}

func TestHubWriteExemptRoutesNeedTheirOwnAuthority(t *testing.T) {
	for _, tc := range []struct {
		name, method, target string
		headers              map[string]string
		hubUser              string
		reached              bool
	}{
		{"device-keys message: its own signature is the authority", "POST", "/api/device-keys/message", nil, rlOwner, true},
		{"device-keys certificate", "POST", "/api/device-keys/certificate", nil, rlOwner, true},
		{"device-keys pair: the MAC and the local hold are its authority", "POST", "/api/device-keys/pair", nil, rlOwner, true},
		{"device-keys pair with no Hub person", "POST", "/api/device-keys/pair", nil, "", true},
		{"guide-revoked on the service stream", "POST", "/api/cloud/guide-revoked", map[string]string{tunnel.HubServiceHeader: "1", tunnel.HubAskBoardHeader: "team1", tunnel.HubAskServerHeader: "srv1"}, "", true},
		{"guide-revoked from a person", "POST", "/api/cloud/guide-revoked", nil, rlOwner, false},
		{"guide-revoked on the service stream but with a person", "POST", "/api/cloud/guide-revoked", map[string]string{tunnel.HubServiceHeader: "1", tunnel.HubAskBoardHeader: "team1"}, rlOwner, false},
		{"relay with a source server and no person", "POST", "/api/board/team1/external-messages", map[string]string{tunnel.HubServerHeader: "srv1"}, "", true},
		{"external-artifacts relay", "POST", "/api/board/team1/external-artifacts", map[string]string{tunnel.HubServerHeader: "srv1"}, "", true},
		{"the same relay with a Hub person is a person's write", "POST", "/api/board/team1/external-messages", map[string]string{tunnel.HubServerHeader: "srv1"}, rlOwner, false},
		{"external-messages with no source server", "POST", "/api/board/team1/external-messages", nil, "", false},
		{"hub-notice with the notice header", "POST", "/api/board/team1/hub-notice", map[string]string{tunnel.HubNoticeHeader: "x"}, "", true},
		{"hub-notice without it", "POST", "/api/board/team1/hub-notice", nil, "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			g := RelayedGuard(nil, nil, func(context.Context) bool { return true })
			r := httptest.NewRequest(tc.method, tc.target, strings.NewReader("{}"))
			stamp(r)
			for k, v := range tc.headers {
				r.Header.Set(k, v)
			}
			r = r.WithContext(cloud.WithVia(r.Context(), cloud.Via{LinkID: rlLink, HubUser: tc.hubUser}))
			rec, reached := httptest.NewRecorder(), false
			g(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached = true })).ServeHTTP(rec, r)
			assert.Equal(t, tc.reached, reached, rec.Body.String())
			if !tc.reached {
				assert.Equal(t, http.StatusForbidden, rec.Code)
				assert.Contains(t, rec.Body.String(), "device_required")
			}
		})
	}
}

func TestAnUploadUnsignedIsRefusedWithTheSwitchOn(t *testing.T) {
	for _, target := range []string{"/api/upload"} {
		rec, reached := guardRunFor(true, "POST", target, nil)
		assert.False(t, reached, target)
		assert.Contains(t, rec.Body.String(), "device_required", target)
	}
}

// The GETs the golden lists below "never" are read-only: a closed census, so a new GET route fails here until someone has read it and added it (and a GET that changes state is made a POST). A GET is not signed, so
// the switch cannot protect one that acts.
func TestEveryGetInTheGoldenIsReviewedReadOnly(t *testing.T) {
	reviewed := map[string]bool{}
	b, err := os.ReadFile("testdata/get_routes_read_only_21883.txt")
	require.NoError(t, err)
	for _, l := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		reviewed[l] = true
	}
	var missing []string
	for _, g := range goldenRoutes(t) {
		if g[0] != "GET" || g[2] == "never" {
			continue
		}
		line := g[0] + " " + g[1] + " " + g[2]
		if !reviewed[line] {
			missing = append(missing, line)
		}
		delete(reviewed, line)
	}
	sort.Strings(missing)
	assert.Empty(t, missing, "a GET route no one has reviewed as read-only (add it to testdata/get_routes_read_only_21883.txt after reading its handler)")
	assert.Empty(t, reviewed, "a reviewed GET that is no longer in the golden: remove it from the list")
}

// relayedRequiredFor is whether the route's kind is one of the five that are always required (their unsigned request is refused bad_form with the switch off too).
func relayedRequiredFor(method, target string) bool {
	k, ok := devicekey.KindOfRoute(method, target)
	return ok && relayedRequired[k]
}

func TestThePairAnswerIsExemptAndNeverAHubWrite(t *testing.T) {
	assert.True(t, devicekey.HubWriteExempt("POST", "/api/device-keys/pair"))
	assert.False(t, devicekey.IsHubWrite("POST", "/api/device-keys/pair"), "it is not signed as hub-write")
	rec, reached := guardRunFor(true, "POST", "/api/device-keys/pair", nil)
	assert.True(t, reached, "the switch does not refuse it device_required: %s", rec.Body.String())
}
