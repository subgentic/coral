package server

import (
	"encoding/json"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/hubowner"
)

const (
	kls1Hub1 = "hub-aaaaaaaa"
	kls1Hub2 = "hub-bbbbbbbb"
)

var (
	kls1Sec1 = strings.Repeat("1a", 32)
	kls1Sec2 = strings.Repeat("2b", 32)
)

const klsRoute = "/api/sessions/live/no-such-agent/answer-prompt"

// joinAs is w.join for a Hub that says which hub id it is ("" says none: a Hub or a Coral from before #21261).
func (w *keyLinkWorld) joinAs(t *testing.T, hub, hubID string) (key string) {
	t.Helper()
	keyID, key := makeKeyForTest(t, w.h, strings.TrimPrefix(hub, "https://"))
	_ = keyID
	kj := map[string]string{"Content-Type": "application/json", linkKeyHeader: key}
	body := `{"hub":"` + hub + `","cap":"interact"`
	if hubID != "" {
		body += `,"hub_id":"` + hubID + `"`
	}
	rec := call(w.h, "POST", "/api/cloud/link-requests", body+`}`, kj)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	var made map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &made))
	id, _ := made["request_id"].(string)
	secret, _ := made["poll_secret"].(string)
	al := call(w.h, "POST", "/api/cloud/link-requests/"+id+"/allow", `{"cap":"interact"}`, map[string]string{"Content-Type": "application/json"})
	require.Equal(t, 200, al.Code, al.Body.String())
	code := regexp.MustCompile(`"code":"(\d{8})"`).FindStringSubmatch(al.Body.String())
	require.Len(t, code, 2)
	fin := call(w.h, "POST", "/api/cloud/link-requests/"+id+"/finish", `{"poll_secret":"`+secret+`","code":"`+code[1]+`","link":"key"}`, kj)
	require.Equal(t, 200, fin.Code, fin.Body.String())
	return key
}

// stampedAs sends the person's act through a key link, signed with secret as remote "mac", and says the hub it claims to be in the header a Hub sends beside a stamp.
func (w *keyLinkWorld) stampedAs(t *testing.T, key, secret, claims string, at time.Time) (int, string) {
	t.Helper()
	s, err := hubowner.Sign(secret, "mac", "POST", klsRoute, []byte(`{"answer":"1"}`), at)
	require.NoError(t, err)
	return w.sendStamp(t, key, s, claims)
}

// sendStamp sends one already signed stamp (the same string twice is a replay).
func (w *keyLinkWorld) sendStamp(t *testing.T, key, s, claims string) (int, string) {
	t.Helper()
	const body = `{"answer":"1"}`
	h := map[string]string{"Content-Type": "application/json", hubowner.Header: s}
	if claims != "" {
		h[hubowner.LinkHeader] = claims
	}
	return w.sendBody(t, "POST", klsRoute, key, body, h)
}

func (w *keyLinkWorld) installHubs(t *testing.T) {
	t.Helper()
	require.NoError(t, hubowner.Install(w.r.cfg.CoralDir(), hubowner.Link{Hub: kls1Hub1, Name: "Hub one", Remote: "mac", Secret: kls1Sec1}, time.Now()))
	require.NoError(t, hubowner.Install(w.r.cfg.CoralDir(), hubowner.Link{Hub: kls1Hub2, Name: "Hub two", Remote: "mac", Secret: kls1Sec2}, time.Now()))
}

// refusedAsAKeyLinkOrStamp is whether the answer is one of the two refusals this step is about.
func refusedAsAKeyLinkOrStamp(body string) bool {
	return strings.Contains(body, "key_link_person_act") || strings.Contains(body, "hub_owner_stamp_refused")
}

// #21261 (Security MUST 2 on #21220, design B): on a key link a Hub's owner stamp makes its signed-in person only when it verifies against the secret held under the hub id that link recorded at its join. Another
// link's secret is refused, a stamp with no link of its own is refused, and no stamp is automation at the cap, as before.
func TestAStampOnAKeyLinkIsThatHubsPersonAndNoOthers(t *testing.T) {
	w := newKeyLinkWorld(t)
	w.installHubs(t)
	key1 := w.joinAs(t, "https://hub-one.example.com", kls1Hub1)
	key2 := w.joinAs(t, "https://hub-two.example.com", kls1Hub2)
	require.Eventually(t, func() bool { c, _ := w.send(t, "GET", "/api/health", key2, nil); return c == 200 }, 5*time.Second, 20*time.Millisecond)
	require.Eventually(t, func() bool { c, _ := w.send(t, "GET", "/api/health", key1, nil); return c == 200 }, 5*time.Second, 20*time.Millisecond)

	// no stamp: automation at the cap, never the person
	code, body := w.sendBody(t, "POST", klsRoute, key1, `{"answer":"1"}`, map[string]string{"Content-Type": "application/json"})
	assert.Equal(t, 403, code, body)
	assert.Contains(t, body, "key_link_person_act")

	// Hub one's own stamp on Hub one's key: its person (the route itself then answers for the agent that is not there)
	code, body = w.stampedAs(t, key1, kls1Sec1, kls1Hub1, time.Now())
	assert.False(t, refusedAsAKeyLinkOrStamp(body), "Hub one's own stamp on its own key link is its person: %d %s", code, body)
	// and so is Hub two's on Hub two's, whatever hub id the header says (it is the link's, not the Hub's word)
	code, body = w.stampedAs(t, key2, kls1Sec2, kls1Hub1, time.Now())
	assert.False(t, refusedAsAKeyLinkOrStamp(body), "Hub two's own stamp on its own key link: %d %s", code, body)

	// Hub one's stamp on Hub two's key, in any hub id it names: refused
	for _, claims := range []string{kls1Hub1, kls1Hub2, ""} {
		code, body = w.stampedAs(t, key2, kls1Sec1, claims, time.Now())
		assert.Equal(t, 403, code, "claims %q: %s", claims, body)
		assert.Contains(t, body, "hub_owner_stamp_refused", claims)
		assert.Contains(t, body, hubowner.ReasonWrongSecret, claims)
	}

	// a replay of a stamp already used on its own link is refused
	used, err := hubowner.Sign(kls1Sec1, "mac", "POST", klsRoute, []byte(`{"answer":"1"}`), time.Now())
	require.NoError(t, err)
	code, body = w.sendStamp(t, key1, used, "")
	require.False(t, refusedAsAKeyLinkOrStamp(body), body)
	code, body = w.sendStamp(t, key1, used, "")
	assert.Equal(t, 403, code, body)
	assert.Contains(t, body, hubowner.ReasonReplay)
}

// A key link made without a hub id (a Hub or a Coral from before this step) is bound to no secret: any stamp on it is refused, even one made with a secret this computer holds.
func TestAStampOnAKeyLinkThatRecordedNoHubIsRefused(t *testing.T) {
	w := newKeyLinkWorld(t)
	w.installHubs(t)
	key := w.joinAs(t, "https://hub-old.example.com", "")
	require.Eventually(t, func() bool { c, _ := w.send(t, "GET", "/api/health", key, nil); return c == 200 }, 5*time.Second, 20*time.Millisecond)
	for _, sec := range []string{kls1Sec1, kls1Sec2} {
		code, body := w.stampedAs(t, key, sec, kls1Hub1, time.Now())
		assert.Equal(t, 403, code, body)
		assert.Contains(t, body, "hub_owner_stamp_refused")
		assert.Contains(t, body, hubowner.ReasonUnknownLink)
	}
}

// The single file of an older hub's install is no fallback for a key link: a key link bound to a hub id this computer holds no secret under is refused, though the single file's secret would verify the stamp
// for a Hub that never said its id.
func TestTheSingleFileSecretIsNoFallbackForAKeyLink(t *testing.T) {
	w := newKeyLinkWorld(t)
	require.NoError(t, hubowner.WriteFile(w.r.cfg.CoralDir(), "mac", kls1Sec1))
	key := w.joinAs(t, "https://hub-three.example.com", kls1Hub2)
	require.Eventually(t, func() bool { c, _ := w.send(t, "GET", "/api/health", key, nil); return c == 200 }, 5*time.Second, 20*time.Millisecond)
	code, body := w.stampedAs(t, key, kls1Sec1, "", time.Now())
	assert.Equal(t, 403, code, body)
	assert.Contains(t, body, "hub_owner_stamp_refused")
}

// A hub id that is not one, or sent by a request that is not a request key's, is refused or not kept.
func TestALinkRequestsHubIDIsCheckedAndOnlyAKeysIsKept(t *testing.T) {
	w := newKeyLinkWorld(t)
	_, key := makeKeyForTest(t, w.h, "k")
	kj := map[string]string{"Content-Type": "application/json", linkKeyHeader: key}
	rec := call(w.h, "POST", "/api/cloud/link-requests", `{"hub":"https://hub-bad.example.com","cap":"view","hub_id":"Not A Hub!"}`, kj)
	assert.Equal(t, 400, rec.Code, rec.Body.String())
}

// #21318 (Security INFO 6): a stamp that is genuine (this link's own Hub, fresh, the right body) on a route that is NOT on the owner-stamp allowlist is refused, never taken as the person. The allowlist
// check runs inside the verify, before the stamp can make the request the person's.
func TestAGenuineStampOnAKeyLinkForARouteOffTheAllowlistIsRefused(t *testing.T) {
	w := newKeyLinkWorld(t)
	w.installHubs(t)
	key1 := w.joinAs(t, "https://hub-one.example.com", kls1Hub1)
	require.Eventually(t, func() bool { c, _ := w.send(t, "GET", "/api/health", key1, nil); return c == 200 }, 5*time.Second, 20*time.Millisecond)

	const off = "/api/sessions/live/no-such-agent/keys" // within an Interact link's cap, so the stamp (not the cap) is what answers
	require.False(t, hubowner.Allowed("POST", off), "the route this test uses must stay off the allowlist")
	body := `{"keys":"x"}`
	s, err := hubowner.Sign(kls1Sec1, "mac", "POST", off, []byte(body), time.Now())
	require.NoError(t, err)
	code, got := w.sendBody(t, "POST", off, key1, body, map[string]string{"Content-Type": "application/json", hubowner.Header: s})
	assert.Equal(t, 403, code, got)
	assert.Contains(t, got, "hub_owner_stamp_refused", "a genuine stamp off the allowlist is refused as a stamp, not run as the person")
	assert.Contains(t, got, hubowner.ReasonMalformed)

	// the same Hub's stamp on an allowlisted route is its person (the control: the refusal above is the route's)
	_, ok := w.stampedAs(t, key1, kls1Sec1, "", time.Now())
	assert.False(t, refusedAsAKeyLinkOrStamp(ok), ok)
}
