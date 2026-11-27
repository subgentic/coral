package cloud

import "time"

// EnrollmentQRPNG returns a visual copy of this computer's pending enrollment
// capability, never the secret as text. The route must admit only a local human.
func (m *Manager) EnrollmentQRPNG() []byte {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.st.State != StateEnrolling || m.st.UserCode == "" {
		return nil
	}
	now := m.o.Now()
	if !now.Before(m.st.ExpiresAt) {
		return nil
	}
	m.pair.mu.Lock()
	defer m.pair.mu.Unlock()
	return m.pair.hold.PairingQRPNG(safeVerificationURL(m.o.HubURL, m.st.VerificationURL), now)
}

// enrollmentQRExpiryLocked is called while m.mu is held. A nonsecret deadline
// lets the page remove an image even if the Hub's user code lives longer.
func (m *Manager) enrollmentQRExpiryLocked() time.Time {
	if m.st.State != StateEnrolling || m.st.UserCode == "" {
		return time.Time{}
	}
	now := m.o.Now()
	if !now.Before(m.st.ExpiresAt) {
		return time.Time{}
	}
	m.pair.mu.Lock()
	defer m.pair.mu.Unlock()
	until := m.pair.hold.QRExpiresAt(now)
	if !until.IsZero() && m.st.ExpiresAt.Before(until) {
		return m.st.ExpiresAt
	}
	return until
}
