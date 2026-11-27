package cloud

import (
	"context"
	"encoding/base64"
	"errors"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/devicekey"
	"github.com/subgentic/coral/internal/store"
)

var b64u = base64.RawURLEncoding

// DeviceKeys is the part of the device list the manager writes: the pairing, the bootstrap row and the clearing when the link changes.
type DeviceKeys interface {
	devicekey.PairingStore
	// SetOwnerAnchor and OwnerAnchorRow are sign once (#21889): the anchor passkey a pairing offered, listed only by the person's Allow.
	SetOwnerAnchor(ctx context.Context, pk []byte, cred string, replace bool, now time.Time) (bool, error)
	OwnerAnchorRow(ctx context.Context) (store.OwnerAnchor, bool, error)
	RemoveAllDeviceKeys(ctx context.Context, now time.Time) (int, error)
	// SetDeviceClearPending and DeviceClearPending keep "a clear is pending" in the store, so a restart cannot end it.
	SetDeviceClearPending(ctx context.Context, pending bool) error
	DeviceClearPending(ctx context.Context) bool
}

// pairingState is what the manager keeps between the link and the poll: the secret, in memory only, and what the last pairing said.
type pairingState struct {
	mu   sync.Mutex
	hold *devicekey.SecretHold
	note string
	// clearPending: the last clear of the device list failed and none has worked since.
	clearPending bool
}

// SetPairingSecret hands the manager the secret the person's `#p=` link carries (22 characters of base64url). It is kept in memory for at most ten minutes, never stored, shown or logged. A secret that is not well formed is dropped: the pairing then has none, and says so.
func (m *Manager) SetPairingSecret(s string) {
	raw, ok := devicekey.ParsePairingSecret(s)
	m.pair.mu.Lock()
	defer m.pair.mu.Unlock()
	if m.pair.hold != nil {
		m.pair.hold.Wipe()
		m.pair.hold = nil
	}
	if ok {
		m.pair.hold = devicekey.NewSecretHold(raw, m.o.Now())
	}
}

// DisplayFingerprint is this computer's key as the pairing browser shows it (XXXX-XXXX-XXXX-XXXX, #19969), so the person can compare both ends; empty when this computer has no key yet. It is a hash of a public key the Hub is sent anyway.
func (m *Manager) DisplayFingerprint() string {
	if m.o.ComputerKey == nil {
		return ""
	}
	return devicekey.DisplayFingerprint(m.o.ComputerKey.Pub())
}

// ComputerID is this computer's own key id, the 43-character base64url value every signed message names as "computer" and the pairing browser pins (#21331); empty when this computer has no key yet. It is a hash of a public key the Hub is sent anyway.
func (m *Manager) ComputerID() string {
	if m.o.ComputerKey == nil {
		return ""
	}
	return m.o.ComputerKey.Computer()
}

// PairingSecretHeld reports whether a live secret is held (tests and the start of a pairing; it says nothing of the value).
func (m *Manager) PairingSecretHeld() bool {
	m.pair.mu.Lock()
	h := m.pair.hold
	m.pair.mu.Unlock()
	return h != nil && h.Alive(m.o.Now())
}

func (m *Manager) takeHold() *devicekey.SecretHold {
	m.pair.mu.Lock()
	defer m.pair.mu.Unlock()
	h := m.pair.hold
	m.pair.hold = nil
	return h
}

func (m *Manager) wipePairing() {
	m.pair.mu.Lock()
	if m.pair.hold != nil {
		m.pair.hold.Wipe()
		m.pair.hold = nil
	}
	m.pair.mu.Unlock()
}

func (m *Manager) setPairNote(s string) {
	m.pair.mu.Lock()
	m.pair.note = s
	m.pair.mu.Unlock()
}

func (m *Manager) pairNote() string {
	m.pair.mu.Lock()
	defer m.pair.mu.Unlock()
	return m.pair.note
}

// clearDeviceKeys makes every device key removed: a new enrollment, or a link lost, is a new account's list (Lead Q1). It reports whether the list is clear. A failure fails closed: nothing new is written beside the old keys (the callers stop), the failure is remembered, and every later call tries again.
func (m *Manager) clearDeviceKeys(ctx context.Context) bool {
	if m.o.Devices == nil {
		return true
	}
	// Written BEFORE the clear and ended only when a clear worked: a failure, a crash or a restart in between leaves it set.
	if err := m.o.Devices.SetDeviceClearPending(ctx, true); err != nil {
		m.o.Logger.Warn("cloud: could not record that the device keys are being cleared")
		m.setClearPending(true)
		return false
	}
	if _, err := m.o.Devices.RemoveAllDeviceKeys(ctx, m.o.Now()); err != nil {
		m.o.Logger.Warn("cloud: could not clear the device keys")
		m.setClearPending(true)
		return false
	}
	if err := m.o.Devices.SetDeviceClearPending(ctx, false); err != nil {
		m.o.Logger.Warn("cloud: the device keys were cleared but the pending mark could not be ended")
		m.setClearPending(true)
		return false
	}
	m.setClearPending(false)
	return true
}

func (m *Manager) setClearPending(v bool) {
	m.pair.mu.Lock()
	m.pair.clearPending = v
	m.pair.mu.Unlock()
}

// DeviceClearPending is the Verifier.Refuse of this computer: true while a clear of the device list is pending: the last one failed (this process) or the store says so (any earlier process: it survives a restart). A store that cannot be read says true.
func (m *Manager) DeviceClearPending() bool {
	if m.deviceClearPending() {
		return true
	}
	return m.o.Devices != nil && m.o.Devices.DeviceClearPending(context.Background())
}

// deviceClearPending is whether this process saw a clear fail and none has worked since.
func (m *Manager) deviceClearPending() bool {
	m.pair.mu.Lock()
	defer m.pair.mu.Unlock()
	return m.pair.clearPending
}

// recordBootstrapDevice writes the device key a credential redeemed with as a `bootstrap` row at the lowest mode: it never approves or raises anything. The key is public.
func (m *Manager) recordBootstrapDevice(ctx context.Context, pkB64 string) {
	if m.o.Devices == nil {
		return
	}
	raw, err := b64u.DecodeString(pkB64)
	if err != nil || len(raw) != 65 {
		return
	}
	_, err = m.o.Devices.AddDeviceKey(ctx, store.DeviceKey{KID: devicekey.KIDOf(raw), PK: raw, Label: "Bootstrap device", Mode: "view", Origin: store.DeviceOriginBootstrap, Kind: store.DeviceKindDevice, Link: store.PairOwner, HubUser: store.PairOwner}, m.o.Now())
	if err != nil {
		m.o.Logger.Warn("cloud: could not list the bootstrap device key")
	}
}

const (
	pairNoteAdded     = "added"
	pairNoteRefused   = "This device was not added: "
	pairWhyNoSecret   = "Coral does not hold the pairing secret for this code (it was not started from this computer's link, or it timed out). Pair the browser again from the link `coral cloud connect` prints."
	pairWhyNoKey      = "Coral Hub did not send the browser's key and this computer has no key of its own yet. Update Coral Hub or pair again."
	pairWhyMAC        = "the browser's proof did not match. Pair again from the link `coral cloud connect` prints."
	pairWhyOther      = "it could not be listed here. Pair again."
	pairWhyNoReplyKey = "this computer's device key is not available, so Coral could not answer the browser."
	pairWhyClear      = "this computer could not clear its old device list, so it added nothing. Pair again."
)

// finishDevicePairing runs after a token is stored. The old list is cleared first (a new enrollment); then, only when the Hub's answer carries a pairing, the check, the listing and the one reply. Nothing is written before the check passes, and the reply is sent once.
func (m *Manager) finishDevicePairing(ctx context.Context, dc *DeviceCode, en *Enrolled) {
	cleared := m.clearDeviceKeys(ctx)
	hold := m.takeHold()
	if hold != nil {
		defer hold.Wipe()
	}
	m.setPairNote("")
	if !cleared {
		// Fail closed: a pairing is never added beside an earlier account's keys. Only a pairing says so; a plain enrollment has nothing to report.
		if en.Pairing != nil {
			m.setPairNote(pairNoteRefused + pairWhyClear)
		}
		return
	}
	if en.Pairing == nil || m.o.Devices == nil {
		return
	}
	if en.Pairing.PK == "" && m.o.ComputerKey != nil {
		return // step 1: no browser key to check; nothing is said and nothing is kept
	}
	if m.o.ComputerKey == nil {
		why := pairWhyNoReplyKey
		if en.Pairing.PK == "" {
			why = pairWhyNoKey
		}
		m.setPairNote(pairNoteRefused + why)
		return
	}
	if hold == nil {
		m.setPairNote(pairNoteRefused + pairWhyNoSecret)
		return
	}
	mode := "view" // no function: the lowest mode, never launch
	if m.o.PairedDeviceMode != nil {
		mode = m.o.PairedDeviceMode()
	}
	kid, mac, err := hold.Complete(ctx, m.o.Devices, dc.UserCode, en.Label, *en.Pairing, mode, m.o.ComputerKey.Pub(), m.o.Now())
	if err != nil {
		why := pairWhyOther
		switch {
		case errors.Is(err, devicekey.ErrPairingMAC):
			why = pairWhyMAC
		case errors.Is(err, devicekey.ErrPairingNoSecret):
			why = pairWhyNoSecret
		case errors.Is(err, devicekey.ErrPairingNoKey):
			why = pairWhyNoKey
		}
		m.setPairNote(pairNoteRefused + why)
		m.o.Logger.Info("cloud: a device pairing was refused", "reason", err.Error())
		return
	}
	m.setPairNote(pairNoteAdded)
	// The audit line (coral-hub condition d): who was added and what it may do. The kid is a public hash; the label is a stranger's text and stays out.
	m.o.Logger.Info("cloud: device paired", "kid", kid, "mode", mode, "origin", store.DeviceOriginPairing)
	// Once, no retry, nothing logged of it. A failure leaves the device listed: the browser can pair again.
	if err := SendEnrollReply(ctx, m.hc, m.o.HubURL, dc.DeviceCode, b64u.EncodeToString(m.o.ComputerKey.Pub()), b64u.EncodeToString(mac)); err != nil {
		m.o.Logger.Info("cloud: the pairing reply was not delivered")
	}
}
