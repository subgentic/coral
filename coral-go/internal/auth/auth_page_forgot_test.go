package auth

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// "Forgot password?" is for someone who has a password (walk 53, #17169): the first-run dialog, where none exists yet, does not offer it; the sign-in form does.
func TestForgotPasswordIsOfferedOnlyWhereAPasswordExists(t *testing.T) {
	for name, st := range map[string]PageState{"first run on this computer": {Local: true}, "first run from another computer": {}} {
		assert.NotContains(t, AuthPage(st), "Forgot password", name)
	}
	for name, st := range map[string]PageState{"sign-in on this computer": {PasswordSet: true, Local: true}, "sign-in from another computer": {PasswordSet: true}} {
		assert.Contains(t, AuthPage(st), "Forgot password?", name)
	}
}
