package store

import "testing"

// SetNonceCapForTest lowers the nonce count cap for one test.
func SetNonceCapForTest(t *testing.T, n int) {
	t.Helper()
	old := deviceNonceCap
	deviceNonceCap = n
	t.Cleanup(func() { deviceNonceCap = old })
}
