package devicekey

import (
	"errors"
	"time"
)

// Check is the first half of Complete (#21880, pairing a browser to a connected computer): it verifies the browser's answer against this hold's secret with the same rules and the same strikes (a failed MAC counts; the third ends the hold) and
// returns the browser's key, but adds nothing and does not use the hold up: the caller keeps it until the person at this computer has answered. The reason is never more than the closed Pairing errors.
func (h *SecretHold) Check(userCode, label string, a PairingAnswer, now time.Time) ([]byte, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.aliveLocked(now) {
		return nil, ErrPairingNoSecret
	}
	if !LabelOK(label) {
		return nil, ErrPairingMAC
	}
	pk, err := CheckPairing(h.secret, userCode, label, a)
	if errors.Is(err, ErrPairingMAC) {
		if h.fails++; h.fails >= 3 {
			h.die()
		}
	}
	return pk, err
}

// Reply is this computer's answer MAC for a key Check passed, made while the secret is still held.
func (h *SecretHold) Reply(userCode string, pk, computerPub []byte, now time.Time) ([]byte, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.aliveLocked(now) {
		return nil, ErrPairingNoSecret
	}
	return ReplyMAC(h.secret, userCode, pk, computerPub), nil
}
