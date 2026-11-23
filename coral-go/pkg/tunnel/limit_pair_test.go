package tunnel

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// #20838, the pair rule: a tunnel (one per link) has its own limiter, so a Hub person who holds the same label on two Hubs uses the share of each Hub separately. Filling person u's share on link A
// leaves u's share on link B untouched.
func TestTheSamePersonOnTwoLinksHasASeparateShareOnEach(t *testing.T) {
	lim := HubLimits{}
	a, b := newLimiter(lim), newLimiter(lim)
	var held []func()
	for {
		rel, perUser, ok := a.acquire(classGeneral, userA, lim)
		if !ok {
			assert.True(t, perUser, "link A stops the person at their own share")
			break
		}
		held = append(held, rel)
	}
	assert.NotEmpty(t, held)
	rel, _, ok := b.acquire(classGeneral, userA, lim)
	assert.True(t, ok, "the same person on link B is not counted against link A's share")
	if ok {
		rel()
	}
	for _, r := range held {
		r()
	}
}
