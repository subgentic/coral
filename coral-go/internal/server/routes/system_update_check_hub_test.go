package routes

import (
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13258: POST /api/system/update/check-hub, Coral Hub's owner asking this computer to check for and stage an update. Each gate of the relaunch applies, with the person's switch the last word; nothing the Hub names is taken.
func (e *relaunchEnv) checkHub(query, body string, hdr map[string]string) (int, map[string]any) {
	e.t.Helper()
	return e.do(e.h.CheckHub, "POST", "/api/system/update/check-hub"+query, body, hdr)
}

func (e *relaunchEnv) checksRun() int {
	e.up.mu.Lock()
	defer e.up.mu.Unlock()
	return e.up.checks
}

func TestCheckHubIsTheOwnersAloneAndOnlyWithThePersonsSwitch(t *testing.T) {
	e := newRelaunchEnv(t)
	owner := hubHdr(ownerA)

	code, _ := e.checkHub("", "", nil)
	assert.Equal(t, http.StatusForbidden, code, "no owner marker")
	code, out := e.checkHub("", "", hubHdr("someone-else"))
	assert.Equal(t, http.StatusForbidden, code, "a Hub user who is not the enrolled owner")
	assert.Equal(t, "owner_only", out["code"])

	e.settings[HubRelaunchSetting] = "false"
	code, out = e.checkHub("", "", owner)
	assert.Equal(t, http.StatusForbidden, code, "the switch off: nothing happens")
	assert.Equal(t, "hub_relaunch_off", out["code"])
	e.settings[HubRelaunchSetting] = "true"
	e.settings[MaxModeSetting] = "view"
	code, out = e.checkHub("", "", owner)
	assert.Equal(t, http.StatusForbidden, code)
	assert.Equal(t, "max_mode", out["code"], "under the cap")
	e.settings[MaxModeSetting] = "launch"
	e.settings["hub_operator_disabled"] = "true"
	code, _ = e.checkHub("", "", owner)
	assert.Equal(t, http.StatusForbidden, code, "the Operator opt-out")
	delete(e.settings, "hub_operator_disabled")
	assert.Zero(t, e.checksRun(), "none of those started a check")

	e.label = ""
	code, out = e.checkHub("", "", owner)
	assert.Equal(t, http.StatusForbidden, code, "a computer linked before it recorded its owner")
	assert.Equal(t, "relink_needed", out["code"], "is told to link again, not that the caller is not the owner")
	e.label = ownerA

	e.on = false
	code, _ = e.checkHub("", "", owner)
	assert.Equal(t, http.StatusNotFound, code, "and with the feature off the route is not there")
	e.on = true
}

func TestCheckHubTakesNothingFromTheHub(t *testing.T) {
	e := newRelaunchEnv(t)
	owner := hubHdr(ownerA)
	for name, c := range map[string]struct{ query, body string }{
		"a version in the query": {"?version=9.9.9", ""},
		"a url in the query":     {"?url=http://evil.example/x", ""},
		"a channel in the query": {"?channel=beta", ""},
		"an empty-valued key":    {"?x", ""},
		"a json body":            {"", `{"version":"9.9.9"}`},
		"a body of one space":    {"", " "},
	} {
		code, out := e.checkHub(c.query, c.body, owner)
		assert.Equal(t, http.StatusBadRequest, code, name)
		assert.Equal(t, "no_arguments", out["code"], name)
	}
	assert.Zero(t, e.checksRun(), "no check ran for any of them")
}

func TestCheckHubStartsOneCheckAMinuteAndAuditsTheHubUser(t *testing.T) {
	e := newRelaunchEnv(t)
	e.up.rec.Enabled, e.up.rec.Supported = true, true
	owner := hubHdr(ownerA)
	code, out := e.checkHub("", "", owner)
	require.Equal(t, http.StatusAccepted, code)
	assert.Equal(t, "checking", out["state"])
	assert.Equal(t, true, out["ok"])
	require.Eventually(t, func() bool { return e.checksRun() == 1 }, 2*time.Second, 10*time.Millisecond, "the updater's own check ran, once")

	code, out = e.checkHub("", "", owner)
	assert.Equal(t, http.StatusTooManyRequests, code, "a second ask inside the minute")
	assert.Equal(t, "too_soon", out["code"])
	e.now = e.now.Add(manualCheckSpacing + time.Second)
	e.h.checking.Store(false)
	code, _ = e.checkHub("", "", owner)
	assert.Equal(t, http.StatusAccepted, code, "after the minute")

	e.up.mu.Lock()
	audits := append([]RelaunchAudit(nil), e.up.audits...)
	e.up.mu.Unlock()
	started := 0
	for _, a := range audits {
		if a.Code == "check_started" {
			started++
			assert.Equal(t, "hub", a.Source)
			assert.NotEmpty(t, a.By, "the Hub user's pseudonym is on the row")
		}
	}
	assert.Equal(t, 2, started, "each accepted call is an audit row")
}

func TestCheckHubDoesNotCheckAnInstallTheUpdaterDoesNotUpdate(t *testing.T) {
	e := newRelaunchEnv(t)
	e.up.rec.Supported = false
	code, out := e.checkHub("", "", hubHdr(ownerA))
	assert.Equal(t, http.StatusConflict, code)
	assert.NotEmpty(t, out["code"])
	assert.Zero(t, e.checksRun())
}
