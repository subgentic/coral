package store

import "testing"

// SetNonceCapForTest lowers the nonce count cap for one test.
func SetNonceCapForTest(t *testing.T, n int) {
	t.Helper()
	old := deviceNonceCap
	deviceNonceCap = n
	t.Cleanup(func() { deviceNonceCap = old })
}

// SetNonceKidShareForTest lowers one kid's share of the nonce cap for one test.
func SetNonceKidShareForTest(t *testing.T, n int) {
	t.Helper()
	old := deviceNonceKidShare
	deviceNonceKidShare = n
	t.Cleanup(func() { deviceNonceKidShare = old })
}
