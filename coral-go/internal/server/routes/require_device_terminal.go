package routes

import (
	"context"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/store"
)

// #21883: a terminal socket opened through Coral Hub cannot carry a signature on each frame, so with "Require a trusted device for Hub actions" on, the frames that act (typing, a composer
// message, a resize) are refused with device_required and the socket stays open for reading. Typing from a Hub terminal waits for a signed stream grant. A person at this computer is not through the
// Hub and is not affected.

// requireDeviceFrameText is the fixed sentence of that refusal: never the Hub's or the frame's words.
const requireDeviceFrameText = "This computer only accepts actions signed by a trusted device, and typing into a terminal through the Hub cannot be signed yet. Use this computer, or turn off \"Require a trusted device\" in its Settings."

// SetRequireDevice sets how a terminal frame learns the switch (nil: off). The server wires it to the stored setting.
func (h *SessionsHandler) SetRequireDevice(f func() bool) { h.requireDevice = f }

// refuseTerminalFrame is whether a frame through the Hub must be refused for the switch.
func (h *SessionsHandler) refuseTerminalFrame(viaHub bool, msgType string) bool {
	if !viaHub || h.requireDevice == nil {
		return false
	}
	switch msgType {
	case "terminal_input", "composer_send", "terminal_resize":
		return h.requireDevice()
	}
	return false
}

// RequireTrustedDeviceFromSettings reads the switch for each frame from the settings at most a second old; an unreadable store falls back to the environment, as the request guard does.
func RequireTrustedDeviceFromSettings(ss *store.SessionStore) func() bool {
	var mu sync.Mutex
	var at time.Time
	on := false
	return func() bool {
		mu.Lock()
		defer mu.Unlock()
		if time.Since(at) < time.Second {
			return on
		}
		s, err := ss.GetSettings(context.Background())
		if err != nil {
			s = nil
		}
		on, at = HubRequireTrustedDevice(s), time.Now()
		return on
	}
}
