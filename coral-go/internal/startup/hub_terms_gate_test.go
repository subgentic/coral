package startup

import (
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/config"
)

// #9936: a headless first start (a cloud machine with a Coral Hub credential and nobody at a terminal) takes its Terms from the Hub: the start goes on only when the bootstrap ended with
// the terms recorded as accepted; any other end stops it, non-zero, with the bootstrap's own code.
func TestHubTermsGate(t *testing.T) {
	for _, tc := range []struct {
		name     string
		status   string
		accepted bool
		code     int
		stop     bool
	}{
		{"enrolled and recorded", cloud.BootstrapEnrolled, true, 0, false},
		{"enrolled but nothing recorded", cloud.BootstrapEnrolled, false, 3, true},
		{"no credential after all", cloud.BootstrapNone, false, 3, true},
		{"unsafe file", cloud.BootstrapUnsafeFile, false, 2, true},
		{"credential refused", cloud.BootstrapInvalid, false, 2, true},
		{"no hub configured", cloud.BootstrapNoHub, false, 2, true},
		{"terms need a new consent", cloud.BootstrapTermsReconsent, false, 3, true},
		{"hub unreachable", cloud.BootstrapRetryLater, false, 4, true},
		{"already enrolled, no local acceptance", cloud.BootstrapIgnoredIdentity, false, 5, true},
		{"the hub's answer could not be used (another terms version)", cloud.BootstrapRefused, false, 1, true},
		{"already accepted by the time it ends", cloud.BootstrapRetryLater, true, 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			code, stop := hubTermsGate(cloud.BootstrapResult{Status: tc.status}, tc.accepted)
			assert.Equal(t, tc.stop, stop)
			assert.Equal(t, tc.code, code)
		})
	}
}

func TestEnforceHubTermsExitsOnlyWhenTheHubDidNotConfirm(t *testing.T) {
	oldExit, oldAccepted := exitProcess, eulaAcceptedHere
	t.Cleanup(func() { exitProcess, eulaAcceptedHere = oldExit, oldAccepted })
	var exits []int
	exitProcess = func(code int) { exits = append(exits, code) }

	// A start that took its Terms locally never exits here, whatever the bootstrap did.
	eulaAcceptedHere = func() bool { return false }
	enforceHubTerms(&config.Config{}, cloud.BootstrapResult{Status: cloud.BootstrapRetryLater})
	assert.Empty(t, exits)

	// A start that left its Terms to the Hub: confirmed (the marker is written), it goes on.
	cfg := &config.Config{TermsViaHub: true}
	eulaAcceptedHere = func() bool { return true }
	enforceHubTerms(cfg, cloud.BootstrapResult{Status: cloud.BootstrapEnrolled})
	assert.Empty(t, exits)

	// Not confirmed: it ends, with the code of what happened.
	eulaAcceptedHere = func() bool { return false }
	enforceHubTerms(cfg, cloud.BootstrapResult{Status: cloud.BootstrapRetryLater})
	enforceHubTerms(cfg, cloud.BootstrapResult{Status: cloud.BootstrapRefused})
	enforceHubTerms(cfg, cloud.BootstrapResult{Status: cloud.BootstrapNoHub})
	assert.Equal(t, []int{4, 1, 2}, exits)
}
