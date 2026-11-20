//go:build hubproxy_testhooks

package hubproxy

import "time"

// This file is in a build only when the tag hubproxy_testhooks is set. A release build never sets it, so the function below is not in the binary at all: nothing
// can change the 30 s header limit there (#20055, coral-hub #253584). A test suite that waits out the real limit builds with -tags hubproxy_testhooks.

// SetHeaderTimeoutForTest sets how long a machine has to start its reply, for the rest of the test or until the returned function is called. It can only shorten the limit:
// a value under 100 ms or over the production 30 s is held to that range, the same range Options.UploadStallTimeout keeps. The caller restores it
// (defer SetHeaderTimeoutForTest(...)()); it is a package variable, so a test that sets it does not run in parallel with another that does.
//
// The upload stall limit needs no hook: Options.UploadStallTimeout sets it (shorter only), and is already in a release build.
func SetHeaderTimeoutForTest(d time.Duration) (restore func()) {
	prev := headerTimeout
	headerTimeout = min(max(d, minUploadStallTimeout), defaultHeaderTimeout)
	return func() { headerTimeout = prev }
}
