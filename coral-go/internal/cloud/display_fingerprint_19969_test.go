package cloud

import (
	"regexp"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/devicekey"
)

// #19969: the computer shows its key as the pairing browser does (XXXX-XXXX-XXXX-XXXX), so the person can compare both ends.
func TestTheComputerShowsItsKeyAsTheBrowserDoes(t *testing.T) {
	assert.Equal(t, "", New(Options{HubURL: "https://hub.example.invalid"}).DisplayFingerprint(), "no key, nothing to show")
	key, err := devicekey.LoadOrCreateComputerKey(t.TempDir())
	require.NoError(t, err)
	m := New(Options{HubURL: "https://hub.example.invalid", ComputerKey: key})
	fp := m.DisplayFingerprint()
	assert.Regexp(t, regexp.MustCompile(`^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$`), fp)
	assert.Equal(t, devicekey.DisplayFingerprint(key.Pub()), fp, "the same function the pairing vectors pin")
}
