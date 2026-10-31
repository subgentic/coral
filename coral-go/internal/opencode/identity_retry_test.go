package opencode

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// QA's SHOULD on #11411: a new server whose start time and image cannot be read at once is read once more before Coral gives up on vouching for it later. identityOf takes the reader and the wait, so nothing global
// is assigned.
func TestTheNewServersIdentityIsReadAgainOnceWhenTheFirstReadFoundNothing(t *testing.T) {
	full := func() (string, string) { return "12345", "C:\\x\\opencode.exe" } // complete on every platform

	calls := 0
	s, img := identityOf(1, func(int) (string, string) {
		calls++
		if calls == 1 {
			return "", ""
		}
		return full()
	}, time.Millisecond)
	assert.Equal(t, 2, calls, "read again once")
	assert.Equal(t, "12345", s)
	assert.NotEmpty(t, img)

	calls = 0
	identityOf(1, func(int) (string, string) { calls++; return full() }, time.Millisecond)
	assert.Equal(t, 1, calls, "a first read that found it is not repeated")

	calls = 0
	s, img = identityOf(1, func(int) (string, string) { calls++; return "", "" }, time.Millisecond)
	assert.Equal(t, 2, calls, "only once more, never a loop")
	assert.Empty(t, s)
	assert.Empty(t, img)
}

// Start reads the new server's identity through the Config's reader and keeps it for the pid record and for Stop.
func TestStartKeepsTheIdentityTheConfigsReaderGave(t *testing.T) {
	cfg, _ := stubConfig(t)
	calls := 0
	cfg.readIdentity = func(int) (string, string) {
		calls++
		if calls == 1 {
			return "", ""
		}
		return "777", "C:\\x\\opencode.exe"
	}
	cfg.identityRetry = time.Millisecond
	s, err := Start(context.Background(), cfg, "agent-1")
	require.NoError(t, err)
	defer s.Stop()
	assert.Equal(t, 2, calls, "read once more after the first found nothing")
	assert.Equal(t, "777", s.started)
	assert.Equal(t, "C:\\x\\opencode.exe", s.image)
}
