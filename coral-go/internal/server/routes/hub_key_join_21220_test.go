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
	key := "lrk_0a1b2c3d_" + strings.Repeat("9f", 16)
	got := sshFailureText(errors.New("exit 1: printed " + key + " and host key SHA256 " + strings.Repeat("ab", 20) + strings.Repeat(" more", 100)))
	assert.NotContains(t, got, "9f9f9f9f")
	assert.NotContains(t, got, "lrk_")
	assert.NotContains(t, got, strings.Repeat("ab", 8))
	assert.LessOrEqual(t, len(got), 203)
	note := orphanedKeyNote(key)
	assert.Contains(t, note, "coral cloud keys revoke lk-0a1b2c3d")
	assert.NotContains(t, note, "9f9f")
	assert.Equal(t, "", orphanedKeyNote("not a key"))
}
