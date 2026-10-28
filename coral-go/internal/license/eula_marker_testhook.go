package license

import "testing"

// SetMarkerPathForTest points the acceptance marker at path until the returned function is called: the tests of another package (a start that takes its terms from the Hub, #9936) cannot reach
// eulaMarkerPath. It refuses to run outside a test binary.
func SetMarkerPathForTest(path string) (restore func()) {
	if !testing.Testing() {
		panic("license.SetMarkerPathForTest outside a test")
	}
	old := eulaMarkerPath
	eulaMarkerPath = func() string { return path }
	return func() { eulaMarkerPath = old }
}
