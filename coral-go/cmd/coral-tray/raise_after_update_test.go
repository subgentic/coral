package main

import (
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

// #15772: the window that opens after an update the person clicked is brought forward once; any other start leaves it where it is.
func TestTheWindowIsBroughtForwardOnlyAfterThePersonsOwnUpdateAndOnce(t *testing.T) {
	calls := 0
	raise := func() bool { calls++; return true }
	assert.False(t, afterWindowShown(true, false, raise), "a start nobody asked for (a login item, an automatic install, the Hub's): left alone")
	assert.False(t, afterWindowShown(false, true, raise), "no window opened: nothing to bring forward")
	assert.Zero(t, calls)
	assert.True(t, afterWindowShown(true, true, raise), "the person's click, the window opened: brought forward")
	assert.Equal(t, 1, calls)
}

func TestRaiseTriesUntilTheWindowProcessIsThereAndNoLonger(t *testing.T) {
	tries, slept := 0, 0
	sleep := func(time.Duration) { slept++ }
	assert.True(t, raiseOnce(func() error {
		tries++
		if tries < 3 {
			return errors.New("not up yet")
		}
		return nil
	}, 10, time.Second, sleep))
	assert.Equal(t, 3, tries, "stops at the first success")
	assert.Equal(t, 2, slept)
	tries, slept = 0, 0
	assert.False(t, raiseOnce(func() error { tries++; return errors.New("never") }, 4, time.Second, sleep))
	assert.Equal(t, 4, tries)
	assert.Equal(t, 3, slept, "no wait after the last try")
}
