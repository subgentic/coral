package cloud

import (
	"github.com/subgentic/coral/internal/devicekey"
)

// NewDeviceVerifier is the one place a production devicekey.Verifier is built (#19669 slice 7): Refuse is this manager's pending-clear mark (while a clear is pending every message is refused with list_unavailable), HubOrigin is the Hub this computer is enrolled with (never an address from a message), Computer is this computer's own fingerprint, and Audit writes a removal's kids and mode to the log (no label). It is nil when there is no computer key, so nothing is ever checked against no computer.
func (m *Manager) NewDeviceVerifier(st devicekey.Store) *devicekey.Verifier {
	if m.o.ComputerKey == nil || st == nil {
		return nil
	}
	return &devicekey.Verifier{
		Store:     st,
		Computer:  m.o.ComputerKey.Computer(),
		HubOrigin: m.o.HubURL,
		Refuse:    m.DeviceClearPending,
		Audit:     devicekey.AuditLine(m.o.Logger),
	}
}
