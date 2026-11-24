package devicekey

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #20966: three relayed kinds for a second Hub's join (design #20901 v8). AllowLink and MakeLinkKey sign the browser's one-time public key in the query (box_pk=, exactly 43 base64url characters, nothing else);
// RevokeLinkKey signs no query.

func TestTheLinkKindsSignTheirOwnRoutesAndTheBoxKeyQuery(t *testing.T) {
	pk := strings.Repeat("A", 43)
	cases := []struct {
		k      Kind
		method string
		target string
		ok     bool
		why    string
	}{
		{AllowLink, "POST", "/api/cloud/link-requests/lr-1/allow?box_pk=" + pk, true, "allow with the key"},
		{AllowLink, "POST", "/api/cloud/link-requests/lr-1/allow", false, "allow without a key signs nothing the computer accepts"},
		{AllowLink, "POST", "/api/cloud/link-requests/lr-1/allow?box_pk=" + pk + "&x=1", false, "a second parameter"},
		{AllowLink, "POST", "/api/cloud/link-requests/lr-1/allow?box_pk=" + pk[:42], false, "a short key"},
		{AllowLink, "POST", "/api/cloud/link-requests/lr-1/allow?box_pk=" + pk + "&box_pk=" + pk, false, "a repeated key"},
		{AllowLink, "POST", "/api/cloud/link-requests/lr-1/deny?box_pk=" + pk, false, "another route"},
		{MakeLinkKey, "POST", "/api/cloud/link-keys?box_pk=" + pk, true, "make with the key"},
		{MakeLinkKey, "POST", "/api/cloud/link-keys", false, "make without a key"},
		{MakeLinkKey, "GET", "/api/cloud/link-keys?box_pk=" + pk, false, "the list is never relayed"},
		{RevokeLinkKey, "DELETE", "/api/cloud/link-keys/lk-aaaa1111", true, "revoke"},
		{RevokeLinkKey, "DELETE", "/api/cloud/link-keys/lk-aaaa1111?box_pk=" + pk, false, "revoke takes no query"},
		{RevokeLinkKey, "POST", "/api/cloud/link-keys/lk-aaaa1111", false, "wrong method"},
	}
	for _, c := range cases {
		_, ok := MatchRoute(c.k, c.method, c.target)
		assert.Equal(t, c.ok, ok, c.why)
	}
	for _, k := range []Kind{AllowLink, MakeLinkKey, RevokeLinkKey} {
		assert.True(t, relayedKnown(k), string(k))
	}
	k, ok := KindOfRoute("POST", "/api/cloud/link-keys?x=1")
	assert.True(t, ok)
	assert.Equal(t, MakeLinkKey, k, "a kind's route with another query is still that kind's, and is then refused")
}
