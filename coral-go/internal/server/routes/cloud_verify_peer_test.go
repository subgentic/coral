package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cliauth"
	"github.com/subgentic/coral/internal/cloud"
)

// #409 (the coral-go-team Security's SHOULD on #254): VerifyCLI checks a command-line signature only from Coral's own user. A correctly
// signed request on a connection whose user could not be told yet is NOT marked verified, nor one from another user; the same request
// from Coral's own user is.
func TestVerifyCLIAcceptsASignatureOnlyFromCoralsOwnUser(t *testing.T) {
	h := NewCloudHandler(nil, t.TempDir())
	require.NotEmpty(t, h.cliToken, "the command-line token was written")
	signed := func() *http.Request {
		t.Helper()
		h.setPeerAnswer(func(*http.Request) peerAnswer { return peerSame }) // the hello itself, as Coral's user
		cn, err := cloud.NewCLINonce()
		require.NoError(t, err)
		req := httptest.NewRequest("POST", cloud.CLIHelloPath, strings.NewReader(`{"nonce":"`+cn+`"}`))
		req.RemoteAddr, req.Host = "127.0.0.1:50000", "127.0.0.1:8420"
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		h.CLIHello(rec, req)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var hello struct {
			Nonce string `json:"nonce"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &hello))
		const body = `{"check":true}`
		sig, err := cloud.SignCLIRequest(h.cliToken, cn, hello.Nonce, "POST", "/api/cloud/redeem", "", []byte(body), "")
		require.NoError(t, err)
		r := httptest.NewRequest("POST", "/api/cloud/redeem", strings.NewReader(body))
		r.RemoteAddr, r.Host = "127.0.0.1:50001", "127.0.0.1:8420"
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set(cloud.CLIAuthHeader, sig)
		return r
	}
	for _, tc := range []struct {
		name string
		peer peerAnswer
		want bool
	}{
		{"Coral's own user", peerSame, true},
		{"a connection whose user isn't told yet", peerUndecided, false},
		{"another user", peerOther, false},
	} {
		r := signed()
		h.setPeerAnswer(func(*http.Request) peerAnswer { return tc.peer })
		out, ok := h.VerifyCLI(r)
		assert.Equal(t, tc.want, ok, tc.name)
		assert.Equal(t, tc.want, cliauth.Verified(out), "%s: marked verified", tc.name)
	}
}
