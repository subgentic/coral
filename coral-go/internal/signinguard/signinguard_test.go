package signinguard

import (
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/internal/auth"
)

func TestParamIsTheSignInLinksOwn(t *testing.T) {
	assert.Equal(t, auth.LoginTokenParam, Param)
}

func TestContainsFindsTheTokenParameterOnly(t *testing.T) {
	for _, s := range []string{"http://127.0.0.1:8471/?login_token=abc", "LOGIN_TOKEN=abc", "Login_Token=", "next=%2F%3Flogin_token%3Dabc", `{"content":"x login_token=y"}`} {
		assert.True(t, Contains(s), s)
	}
	for _, s := range []string{"", "the login_token parameter", "login_token: abc", "login token=abc", "login_tokens", "logintoken=abc"} {
		assert.False(t, Contains(s), s)
	}
}

func TestRefusalSaysWhyAndHowToTalkAboutIt(t *testing.T) {
	msg := Refusal("a message", "Post only the result lines.").Error()
	assert.Contains(t, msg, "refusing a message that contains a sign-in link (login_token=)")
	assert.Contains(t, msg, "Nothing was sent. Post only the result lines.")
	assert.Contains(t, msg, "To talk about the parameter, write it without '='.")
}
