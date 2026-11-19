package cloud

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/devicekey"
	"github.com/subgentic/coral/internal/store"
)

// NewDeviceVerifier is the one place a production devicekey.Verifier is built (#19669 slice 7): Refuse is this manager's pending-clear mark (while a clear is pending every message is refused with list_unavailable), HubOrigin is the Hub address this computer is configured with (its HubURL, never an address from a message) (never an address from a message), Computer is this computer's own fingerprint, and Audit writes a removal's kids and mode to the log (no label). It is nil when there is no computer key, so nothing is ever checked against no computer.
func (m *Manager) NewDeviceVerifier(st devicekey.Store) *devicekey.Verifier {
	if m.o.ComputerKey == nil || st == nil {
		return nil
	}
	// One verifier per manager: its mutex is what serializes the nonce check and the apply, so a second one would race the first.
	m.devVerMu.Lock()
	defer m.devVerMu.Unlock()
	if m.devVer != nil {
		return m.devVer
	}
	v := &devicekey.Verifier{
		Store:     st,
		Computer:  m.o.ComputerKey.Computer(),
		HubOrigin: m.o.HubURL,
		Refuse:    m.DeviceClearPending,
		Audit:     devicekey.AuditLine(m.o.Logger),
		AuditCert: devicekey.AuditCertLine(m.o.Logger),
	}
	// The nonce store is probed once, when the verifier is built (the first message after start): if it cannot be read, a message whose ts is before now plus the window is refused with before_start, so no replay of an older message gets through a store that forgot it (design page v4 section 4).
	if err := st.NonceSeen(context.Background(), "startup-probe", time.Now()); err != nil && !errors.Is(err, store.ErrNonceRepeat) {
		v.RefuseBefore = time.Now().Add(24 * time.Hour)
		if m.o.Logger != nil {
			m.o.Logger.Warn("cloud: the device-key nonce store could not be read: signed messages dated before now are refused for the longest window", "err", err)
		}
	}
	m.devVer = v
	return m.devVer
}

type deviceVerifierState struct {
	devVerMu sync.Mutex
	devVer   *devicekey.Verifier
}
