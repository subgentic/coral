package stage

import "time"

// The wait after a failure for a version (#5292, Security's section 9: never a loop that downloads the package more than once an hour):
// a network failure retries in 5 minutes, then 15, then an hour; a verification failure or a package that does not match waits an hour and doubles
// to a day. A newer version starts again.
const (
	KindNetwork   = "network"
	KindVerify    = "verify"
	KindRateLimit = "rate_limit" // GitHub's limit on anonymous requests (#9704): the wait is the time it says it is over, not a doubling
)

// rateLimitWait is how long to wait after a rate-limit answer that is over at retryAt: until then (and a few seconds more), at least a floor and at most a day; an answer that did not say when waits an hour.
// The floor is a minute for the first rate limit in a row and doubles with each one after it (capped at a day), so a clock that is ahead of GitHub's, which sees every reset as already past, asks 1, 2, 4, 8
// minutes and so on and not every minute for good. Never a loop that asks again while the limit is still on.
func rateLimitWait(now, retryAt time.Time, inARow int) time.Duration {
	const slack, base, most, unknown = 10 * time.Second, time.Minute, 24 * time.Hour, time.Hour
	if retryAt.IsZero() {
		return unknown
	}
	floor := base
	for i := 1; i < inARow && floor < most; i++ {
		floor *= 2
	}
	return min(max(retryAt.Sub(now)+slack, floor), most)
}
func backoff(kind string, attempts int) time.Duration {
	if attempts < 1 {
		attempts = 1
	}
	if kind == KindNetwork {
		switch attempts {
		case 1:
			return 5 * time.Minute
		case 2:
			return 15 * time.Minute
		}
		return time.Hour
	}
	d := time.Hour
	for i := 1; i < attempts && d < 24*time.Hour; i++ {
		d *= 2
	}
	return min(d, 24*time.Hour)
}
