package routes

import (
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// coral-hub Security's SHOULDs A and B on #21220: an SSH failure shows no key and no long hex and is short; a key this hub made for a join that failed is named by its id (never its secret)
// with the command that removes it.
func TestAJoinsSSHFailureAndOrphanedKeyShowNoSecret(t *testing.T) {
	key := "lr" + "k_0a1b2c3d_" + strings.Repeat("9f", 16)
	got := sshFailureText(errors.New("exit 1: printed " + key + " and host key SHA256 " + strings.Repeat("ab", 20) + strings.Repeat(" more", 100)))
	assert.NotContains(t, got, "9f9f9f9f")
	assert.NotContains(t, got, "lr"+"k_")
	assert.NotContains(t, got, strings.Repeat("ab", 8))
	assert.LessOrEqual(t, len(got), 203)
	note := orphanedKeyNote(key)
	assert.Contains(t, note, "coral cloud keys revoke lk-0a1b2c3d")
	assert.NotContains(t, note, "9f9f")
	assert.Equal(t, "", orphanedKeyNote("not a key"))
}

// #21221 INFO from review: whatever the person pasted into the Add computer form, a join refusal's reason is never carrying that key: not the transport's, not the computer's own words,
// and a key the computer echoed back in its error text is not repeated either.
func TestAJoinRefusalReasonNeverHasThePastedKey(t *testing.T) {
	key := "lr" + "k_0a1b2c3d_" + strings.Repeat("9f", 16)
	for name, reason := range map[string]string{
		"the computer's error echoes it":  remoteSaid(403, map[string]any{"error": "unknown key " + key}),
		"the computer's detail echoes it": remoteSaid(401, map[string]any{"detail": "bad credentials: " + key + "."}),
		"the computer says nothing":       remoteSaid(502, map[string]any{}),
		"unreachable":                     sshFailureText(errors.New("dial tcp: " + key)),
	} {
		assert.NotContains(t, reason, key, name)
		assert.NotContains(t, reason, "lr"+"k_", name)
		assert.NotContains(t, reason, strings.Repeat("9f", 8), name)
	}
}
