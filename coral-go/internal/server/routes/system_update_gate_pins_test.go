package routes

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
)

// QA Reviewer 2's pins on #13258's gate (the review's SHOULD a and b): the gate fails CLOSED when the settings cannot be read, and hub_state says the switch's words first.

// A Settings read that fails must refuse the Hub's relaunch and check as hub_relaunch_off: a gate that fails open on a read error would let Coral Hub update a computer whose switch nobody could read.
func TestTheHubUpdateGateFailsClosedWhenTheSettingsCannotBeRead(t *testing.T) {
	owner := callerIdentity{owner: true}
	failing := &UpdateRelaunchHandler{Settings: func(context.Context) (map[string]string, error) { return nil, errors.New("settings unreadable") }}
	reason, code := failing.gate(context.Background(), owner)
	assert.Equal(t, "hub_relaunch_off", code, "an unreadable switch is off")
	assert.Equal(t, reasonSwitchOff, reason)

	// the same owner with readable settings that turn everything on passes: the refusal above is the read error's, not the gate's habit
	on := &UpdateRelaunchHandler{Settings: func(context.Context) (map[string]string, error) {
		return map[string]string{HubRelaunchSetting: "true", MaxModeSetting: "launch"}, nil
	}}
	reason, code = on.gate(context.Background(), owner)
	assert.Equal(t, "", code, "a readable, switched-on, Launch-cap owner passes: %q", reason)
	// and a person at this computer is not about the Hub's switch at all
	_, code = failing.gate(context.Background(), callerIdentity{local: true})
	assert.Equal(t, "", code)
}

// hub_state is one closed word and the switch's words come first: a computer that does not let the Hub update it says so whatever else is true (a check running, a failed update, a staged version, a past check).
func TestHubStateSaysTheSwitchFirst(t *testing.T) {
	staged := relaunchView{hubAllowed: false, version: "9.9.9"}
	h := &UpdateRelaunchHandler{}
	h.checking.Store(true)
	for name, state := range map[string]any{"failed": updFailed, "none": nil, "staged": "staged"} {
		assert.Equal(t, hubStateRelaunchOff, h.hubState(staged, state), "switch off, a check running, state %s: the switch's word wins", name)
	}
	// with the switch on the other words come back, in their own order
	on := relaunchView{hubAllowed: true, version: "9.9.9"}
	assert.Equal(t, hubStateChecking, h.hubState(on, nil), "switch on, a check running: checking")
	h.checking.Store(false)
	assert.Equal(t, hubStateFailed, h.hubState(on, updFailed))
	assert.Equal(t, hubStateStaged, h.hubState(on, nil))
}
