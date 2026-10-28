package auth

import (
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #10004: the sign-in funnel event says which kind of sign-in it was, from a closed set, never anything about the credential.
func TestSignInViaIsTheKindOfSignInOnly(t *testing.T) {
	link := httptest.NewRequest("GET", "/?"+LoginTokenParam+"=secrettoken", nil)
	app := httptest.NewRequest("GET", "/?"+LoginTokenParam+"=secrettoken&"+AppClientParam+"="+AppClientApp, nil)
	other := httptest.NewRequest("GET", "/?"+LoginTokenParam+"=secrettoken&"+AppClientParam+"=somebody", nil)
	assert.Equal(t, "link", signInVia(link, SessionByLink))
	assert.Equal(t, "app", signInVia(app, SessionByLink))
	assert.Equal(t, "link", signInVia(other, SessionByLink), "only the app's own marker makes it the app")
	assert.Equal(t, "key", signInVia(link, SessionByKey))
	assert.Equal(t, "password", signInVia(link, SessionByPassword))
	assert.Equal(t, "", signInVia(link, "something-new"), "a method with no word sends nothing")
}
