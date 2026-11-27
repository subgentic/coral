package routes

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #21931: an unreadable settings store never turns require-signing off.
func TestRequireTrustedDeviceReaderFailsClosed(t *testing.T) {
	t.Setenv(HubRequireTrustedDeviceEnv, "")
	var vals map[string]string
	var failure error
	read := RequireTrustedDeviceReader(func(context.Context) (map[string]string, error) { return vals, failure })
	ctx := context.Background()

	// No value read yet and the store fails: on.
	failure = errors.New("database is locked")
	assert.True(t, read(ctx), "nothing read yet and the store fails: refuse unsigned")

	// A good read of "off" is kept when the store later fails (the last known value).
	failure, vals = nil, map[string]string{}
	assert.False(t, read(ctx))
	failure = errors.New("disk I/O error")
	assert.False(t, read(ctx), "the last read said off: kept")

	// A good read of "on" is kept, and a good read after the failure takes over again.
	failure, vals = nil, map[string]string{HubRequireTrustedDeviceSetting: "true"}
	assert.True(t, read(ctx))
	failure = errors.New("disk I/O error")
	assert.True(t, read(ctx), "the last read said on: kept")
	failure, vals = nil, map[string]string{}
	assert.False(t, read(ctx), "a good read replaces the kept value")

	// The environment switch holds through a failure, even after a read of off.
	t.Setenv(HubRequireTrustedDeviceEnv, "1")
	failure = errors.New("disk I/O error")
	assert.True(t, read(ctx))
}
