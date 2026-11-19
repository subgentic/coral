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
		if m.devRefusing && time.Since(m.devProbeAt) >= m.devProbeEvery() {
			m.devProbeAt = time.Now()
			if m.probeNonceStore(st) == nil {
				// Not the zero time: a message signed before the outage could replay if the store came back without its older nonce records (a restored file), so what is dated before the recovery stays refused; a browser signs a fresh one at once.
				m.devVer.SetRefuseBefore(time.Now())
				m.devRefusing = false
				if m.o.Logger != nil {
					m.o.Logger.Info("cloud: the device-key nonce store reads again: signed messages are accepted")
				}
			}
		}
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
	// The nonce store is probed when the verifier is built (the first message after start), with retries so one transient error does not decide: if it still cannot be read, a message whose ts is before now plus the window is refused with before_start, so no replay of an older message gets through a store that forgot it (design page v4 section 4). The probe is repeated later (below) and moves the refusal up to the recovery time once the store reads again.
	m.devProbeAt = time.Now()
	if err := m.probeNonceStore(st); err != nil {
		v.RefuseBefore = time.Now().Add(24 * time.Hour)
		m.devRefusing = true
		if m.o.Logger != nil {
			m.o.Logger.Warn("cloud: the device-key nonce store could not be read: signed messages dated before now are refused for the longest window", "err", err)
		}
	}
	m.devVer = v
	return m.devVer
}

// probeNonceStore reads the nonce store up to three times (devProbeWait apart) and reports the last error when none read.
func (m *Manager) probeNonceStore(st devicekey.Store) error {
	var err error
	for i := 0; i < 3; i++ {
		if i > 0 {
			time.Sleep(m.devProbeRetryWait())
		}
		if err = st.NonceSeen(context.Background(), "startup-probe", time.Now()); err == nil || errors.Is(err, store.ErrNonceRepeat) {
			return nil
		}
	}
	return err
}

func (m *Manager) devProbeEvery() time.Duration {
	if m.devProbeEveryD > 0 {
		return m.devProbeEveryD
	}
	return 30 * time.Second
}

func (m *Manager) devProbeRetryWait() time.Duration {
	if m.devProbeWaitD > 0 {
		return m.devProbeWaitD
	}
	return 50 * time.Millisecond
}

type deviceVerifierState struct {
	devVerMu       sync.Mutex
	devVer         *devicekey.Verifier
	devRefusing    bool          // RefuseBefore is set because the nonce store could not be read
	devProbeAt     time.Time     // the last probe
	devProbeEveryD time.Duration // test knob: how long before a re-probe (30 s when zero)
	devProbeWaitD  time.Duration // test knob: the wait between retries (50 ms when zero)
}
