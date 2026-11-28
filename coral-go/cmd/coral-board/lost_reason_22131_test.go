package main

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// #22131: a run stopped for a lost slot says why and when the hold ended, from the refused renew's answer; an answer without it keeps the old words.
func TestALostSlotSaysWhyAndWhenItsHoldEnded(t *testing.T) {
	assert.Equal(t, "released: gone at 2026-11-28T04:20:40Z", lostReason([]byte(`{"code":"not_holder","ended":"released","ended_why":"gone","ended_at":"2026-11-28T04:20:40Z"}`)))
	assert.Equal(t, "expired: lease at 2026-11-28T00:58:59Z", lostReason([]byte(`{"ended":"expired","ended_why":"lease","ended_at":"2026-11-28T00:58:59Z"}`)))
	assert.Equal(t, "kicked at 2026-11-28T01:00:00Z", lostReason([]byte(`{"ended":"kicked","ended_why":"kicked","ended_at":"2026-11-28T01:00:00Z"}`)))
	assert.Equal(t, "", lostReason([]byte(`{"code":"not_holder"}`)), "a server that does not know: the caller's old words")
	assert.Equal(t, "", lostReason([]byte(`not json`)))
}
