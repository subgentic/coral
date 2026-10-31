package opencode

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The per-test tripwires of stubConfig are the second line behind binaryMode against a fork bomb like #11377's. They must not go vacuous: the pid check reads what the stand-in itself writes, so a change to the
// stand-in that stopped it recording its pid would make the check pass for ever (Security's INFO on 7b782feff). These tests pin the helpers and the stand-in's recording.
func TestTheStubTripwiresFireAtTheirLimits(t *testing.T) {
	assert.False(t, tooManyStubConfigs(maxStubConfigsPerTest), "the limit itself is allowed")
	assert.True(t, tooManyStubConfigs(maxStubConfigsPerTest+1), "one more fails the test")

	_, envFile := stubConfig(t)
	assert.Zero(t, standInProcs(envFile), "no stand-in yet")
	require.NoError(t, os.WriteFile(envFile+".pids", []byte(strings.Repeat("123\n", maxStandInProcsPerTest)), 0o600))
	assert.Equal(t, maxStandInProcsPerTest, standInProcs(envFile))
	assert.LessOrEqual(t, standInProcs(envFile), maxStandInProcsPerTest, "the limit itself is allowed")
	require.NoError(t, os.WriteFile(envFile+".pids", []byte(strings.Repeat("123\n", maxStandInProcsPerTest+1)), 0o600))
	assert.Greater(t, standInProcs(envFile), maxStandInProcsPerTest, "one more is over")
	require.NoError(t, os.Remove(envFile+".pids")) // so this test's own end check sees none
}

func TestTheStandInRecordsItsPidSoThePidCheckCanNeverBeVacuous(t *testing.T) {
	cfg, envFile := stubConfig(t)
	assert.Zero(t, standInProcs(envFile))
	s, err := Start(context.Background(), cfg, "agent-1")
	require.NoError(t, err)
	defer s.Stop()
	assert.Equal(t, 1, standInProcs(envFile), "a real stand-in wrote its pid: if this is 0 the pid check counts nothing")
	s2cfg := cfg
	s2, err := Start(context.Background(), s2cfg, "agent-2")
	require.NoError(t, err)
	defer s2.Stop()
	assert.Equal(t, 2, standInProcs(envFile), "each stand-in adds one")
}
