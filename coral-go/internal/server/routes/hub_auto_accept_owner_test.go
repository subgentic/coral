package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #5840 (the Operator's decision): "Coral Hub can turn on auto-accept" is ON unless the owner turned it off; Coral Hub's owner may turn it on or off through POST /api/hub-auto-accept
// {"allow": bool} (owner-only, Launch tier, the Hub only), and the change is recorded: who, when, in the Operator-actions log.

func TestHubAutoAcceptDefaultsOnAndAnExplicitOffStaysOff(t *testing.T) {
	assert.True(t, HubAutoAcceptAllowed(map[string]string{}), "a fresh install: on")
	assert.False(t, HubAutoAcceptAllowed(map[string]string{AllowHubAutoAcceptSetting: "false"}), "the owner turned it off: it stays off")
	assert.True(t, HubAutoAcceptAllowed(map[string]string{AllowHubAutoAcceptSetting: "true"}), "turned on")
	assert.Contains(t, hubAutoAcceptOff, "Settings > Coral Hub and remote access", "the refusal says where the switch is")
	assert.Contains(t, hubAutoAcceptOff, `"Coral Hub can turn on auto-accept"`)
}

type hubAutoAcceptEnv struct {
	t  *testing.T
	h  *CloudHandler
	ss *store.SessionStore
}

func newHubAutoAcceptEnv(t *testing.T) *hubAutoAcceptEnv {
	t.Helper()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "c.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	ss := store.NewSessionStore(db)
	h := NewCloudHandler(ss, t.TempDir())
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	h.SetBoardStore(bs)
	withLabel(t, ownerLabel, nil)
	return &hubAutoAcceptEnv{t: t, h: h, ss: ss}
}

func (e *hubAutoAcceptEnv) post(body string, hdr map[string]string) *httptest.ResponseRecorder {
	e.t.Helper()
	return e.postTo("/api/hub-auto-accept", body, hdr)
}

func (e *hubAutoAcceptEnv) postTo(path, body string, hdr map[string]string) *httptest.ResponseRecorder {
	e.t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	e.h.HubOwnerSetAutoAccept(rec, req)
	return rec
}

func (e *hubAutoAcceptEnv) allowed() bool {
	e.t.Helper()
	s, err := e.ss.GetSettings(context.Background())
	require.NoError(e.t, err)
	return HubAutoAcceptAllowed(s)
}

func TestHubOwnerTurnsTheAutoAcceptSwitchOnAndOff(t *testing.T) {
	e := newHubAutoAcceptEnv(t)
	ctx := context.Background()
	require.True(t, e.allowed(), "on by default")
	owner := ownerHeaders(ownerLabel)

	// A hub auto-accept and a local one are running; turning the switch off ends the hub's only.
	for src, sid := range map[string]string{"hub": "11111111-2222-3333-4444-555555555555", "local": "22222222-2222-3333-4444-555555555555"} {
		require.NoError(t, e.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: src, WorkingDir: t.TempDir()}))
		_, err := e.ss.EnableAutoAccept(ctx, sid, src, 0)
		require.NoError(t, err)
	}

	rec := e.post(`{"allow":false}`, owner)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	var out struct {
		OK        bool                `json:"ok"`
		Allow     bool                `json:"allow_hub_auto_accept"`
		Ended     int                 `json:"auto_accepts_ended"`
		ChangedBy hubAutoAcceptChange `json:"changed_by"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	assert.True(t, out.OK)
	assert.False(t, out.Allow)
	assert.Equal(t, 1, out.Ended, "the hub's auto-accept ended, the local one not")
	assert.False(t, e.allowed(), "the switch is off")
	hubState, err := e.ss.GetAutoAcceptState(ctx, "11111111-2222-3333-4444-555555555555")
	require.NoError(t, err)
	assert.False(t, hubState.Enabled)
	localState, err := e.ss.GetAutoAcceptState(ctx, "22222222-2222-3333-4444-555555555555")
	require.NoError(t, err)
	assert.True(t, localState.Enabled)

	// Who and when are recorded, shown by the status beside the switch, and the Operator-actions log has the row.
	assert.Equal(t, hubAutoAcceptChange{By: "hub", User: ownerLabel, At: out.ChangedBy.At}, out.ChangedBy)
	assert.NotEmpty(t, out.ChangedBy.At)
	st := e.h.status()
	assert.False(t, st.AllowHubAutoAccept)
	var shown hubAutoAcceptChange
	require.NoError(t, json.Unmarshal(st.AllowHubAutoAcceptChanged, &shown))
	assert.Equal(t, out.ChangedBy, shown)
	actions, err := e.h.bs.RecentHubOperatorActions(ctx, 10)
	require.NoError(t, err)
	require.Len(t, actions, 1)
	assert.Equal(t, ownerLabel, actions[0].HubUser)
	assert.Contains(t, actions[0].Path, "/api/hub-auto-accept")
	assert.Contains(t, actions[0].Path, "allow=false")

	rec = e.post(`{"allow":true}`, owner)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	assert.True(t, e.allowed(), "turned on again")
	assert.Equal(t, 2, func() int { a, _ := e.h.bs.RecentHubOperatorActions(ctx, 10); return len(a) }(), "every change is a row")
}

// Only the owner, only through Coral Hub: anyone else is refused with 403 owner_only and nothing changes.
func TestOnlyCoralHubsOwnerTurnsTheAutoAcceptSwitch(t *testing.T) {
	e := newHubAutoAcceptEnv(t)
	forged := ownerHeaders(ownerLabel)
	forged[tunnel.ViaHeader] = "forged"
	noMarker := ownerHeaders(ownerLabel)
	delete(noMarker, tunnel.HubRoleHeader)
	otherUser := ownerHeaders("hub-user-9999ffff")
	for name, hdr := range map[string]map[string]string{
		"a grantee, even at Launch":      granteeHeaders(),
		"the owner marker without stamp": forged,
		"no owner marker":                noMarker,
		"another hub user with marker":   otherUser,
		"this computer (no hub)":         nil,
	} {
		rec := e.post(`{"allow":false}`, hdr)
		assert.Equal(t, http.StatusForbidden, rec.Code, "%s: %s", name, rec.Body.String())
		assert.Equal(t, "owner_only", codeOf(t, rec), name)
		assert.True(t, e.allowed(), "%s: nothing changed", name)
	}
	// A machine whose enrolment recorded no owner label refuses even the owner, until it is linked again.
	withLabel(t, "", nil)
	assert.Equal(t, http.StatusForbidden, e.post(`{"allow":false}`, ownerHeaders(ownerLabel)).Code)
	assert.True(t, e.allowed())
}

// The body is closed: exactly {"allow": true|false}, small, no query.
func TestHubAutoAcceptRouteTakesOnlyAClosedBody(t *testing.T) {
	e := newHubAutoAcceptEnv(t)
	owner := ownerHeaders(ownerLabel)
	for name, body := range map[string]string{
		"empty":           "",
		"an empty object": `{}`,
		"a string":        `{"allow":"false"}`,
		"null":            `{"allow":null}`,
		"an extra field":  `{"allow":false,"x":1}`,
		"two documents":   `{"allow":false}{"allow":true}`,
		"not json":        `allow=false`,
		"too big":         `{"allow":false,"pad":"` + strings.Repeat("x", 80) + `"}`,
		"an array":        `[{"allow":false}]`,
	} {
		rec := e.post(body, owner)
		assert.Equal(t, http.StatusBadRequest, rec.Code, "%s: %s", name, rec.Body.String())
		assert.True(t, e.allowed(), "%s: nothing changed", name)
	}
	assert.Equal(t, http.StatusBadRequest, e.postTo("/api/hub-auto-accept?x=1", `{"allow":false}`, owner).Code, "no other query")
	assert.True(t, e.allowed())
	assert.Equal(t, 200, e.post(`{"allow":false}`, owner).Code, "the closed body itself")
}

// #20882: a relayed request signs ?allow=true|false. The handler takes exactly that query (compared as the raw text), with the body still required and saying the same; anything else is 400 and changes nothing.
func TestHubAutoAcceptQueryMustBeExactlyTheBodysValue(t *testing.T) {
	owner := ownerHeaders(ownerLabel)
	for _, c := range []struct {
		name, query, body string
		code              int
		allowed           bool // the setting afterwards, starting from on
	}{
		{"off, the query says the same", "allow=false", `{"allow":false}`, 200, false},
		{"on, the query says the same", "allow=true", `{"allow":true}`, 200, true},
		{"no query, as before", "", `{"allow":false}`, 200, false},
		{"the query disagrees with the body (off)", "allow=true", `{"allow":false}`, 400, true},
		{"the query disagrees with the body (on)", "allow=false", `{"allow":true}`, 400, true},
		{"no body", "allow=false", ``, 400, true},
		{"a look-alike value", "allow=False", `{"allow":false}`, 400, true},
		{"a trailing space", "allow=false%20", `{"allow":false}`, 400, true},
		{"an encoded value", "allow=%66alse", `{"allow":false}`, 400, true},
		{"an extra key", "allow=false&x=1", `{"allow":false}`, 400, true},
		{"a repeated key", "allow=false&allow=false", `{"allow":false}`, 400, true},
		{"another key", "x=1", `{"allow":false}`, 400, true},
		{"an empty value", "allow=", `{"allow":false}`, 400, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			e := newHubAutoAcceptEnv(t)
			require.True(t, e.allowed())
			target := "/api/hub-auto-accept"
			if c.query != "" {
				target += "?" + c.query
			}
			rec := e.postTo(target, c.body, owner)
			require.Equal(t, c.code, rec.Code, rec.Body.String())
			assert.Equal(t, c.allowed, e.allowed())
			rows, err := e.h.bs.RecentHubOperatorActions(context.Background(), 10)
			require.NoError(t, err)
			if c.code == 200 {
				require.Len(t, rows, 1, "a change is recorded (who, when, the Operator-actions log)")
				assert.Contains(t, rows[0].Path, "allow="+map[bool]string{true: "true", false: "false"}[c.allowed])
			} else {
				assert.Empty(t, rows, "a refused request records nothing")
			}
		})
	}
}

// The owner check comes before the query is read: a person who is not the owner gets 403 owner_only with a valid query, and nothing changes.
func TestHubAutoAcceptQueryDoesNotMakeANonOwnerAnOwner(t *testing.T) {
	e := newHubAutoAcceptEnv(t)
	rec := e.postTo("/api/hub-auto-accept?allow=false", `{"allow":false}`, granteeHeaders())
	assert.Equal(t, 403, rec.Code, rec.Body.String())
	assert.True(t, e.allowed())
	rec = e.postTo("/api/hub-auto-accept?allow=false", `{"allow":false}`, nil)
	assert.Equal(t, 403, rec.Code, "not through Coral Hub")
	assert.True(t, e.allowed())
}
