//go:build windows

package winuser

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/sys/windows"
)

func TestCurrentSIDIsTheTokenUserAndACopy(t *testing.T) {
	sid, err := CurrentSID()
	require.NoError(t, err)
	require.NotNil(t, sid)
	assert.True(t, sid.IsValid())
	assert.Contains(t, sid.String(), "S-1-5-", "a user SID")
	tu, err := windows.GetCurrentProcessToken().GetTokenUser()
	require.NoError(t, err)
	assert.True(t, sid.Equals(tu.User.Sid), "it is the token's user, not its default owner")
	other, err := CurrentSID()
	require.NoError(t, err)
	assert.True(t, sid.Equals(other))
	assert.NotSame(t, sid, other, "each call returns its own copy")
}
