//go:build windows

package main

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestTheProductComesFromOneValidArgument(t *testing.T) {
	cases := []struct {
		args []string
		want string
	}{
		{[]string{"stop", "--product", "Coral Rehearsal", "--folder", `C:\x`}, "Coral Rehearsal"},
		{[]string{"start", "--product", "Coral"}, "Coral"},
		{[]string{"eula", "--product", "Coral"}, "Coral"},
		{[]string{"start"}, ""},
		{nil, ""},
		{[]string{"start", "--product"}, ""},
		{[]string{"start", "--product", "coral"}, ""},
		{[]string{"start", "--product", `Coral\..\x`}, ""},
		{[]string{"start", "--product", "Coral Rehearsal Beta"}, ""},
		{[]string{"start", "--product", "Coral", "--product", "Coral Rehearsal"}, ""},
		{[]string{"start", "--product", "Coral", "--product", "Coral"}, ""},
	}
	for _, c := range cases {
		assert.Equal(t, c.want, productArg(c.args), "%v", c.args)
	}
}

// With no valid product the helper writes, takes and removes no mark (it never falls back to "Coral", the live product's folder); with one it
// uses that product's folder, and no other.
func TestTheHelperTouchesAMarkOnlyInTheProductItWasTold(t *testing.T) {
	var calls []string
	oldM, oldT, oldD := markFor, takeFor, discardFor
	markFor = func(p string, _ time.Time) error { calls = append(calls, "mark "+p); return nil }
	takeFor = func(p string, _ time.Time) bool { calls = append(calls, "take "+p); return true }
	discardFor = func(p string) error { calls = append(calls, "discard "+p); return nil }
	t.Cleanup(func() { markFor, takeFor, discardFor = oldM, oldT, oldD })

	markRestart("")
	discardRestart("")
	assert.False(t, takeRestart(""))
	assert.Empty(t, calls, "no product: no mark touched")

	markRestart("Coral Rehearsal")
	discardRestart("Coral Rehearsal")
	assert.True(t, takeRestart("Coral Rehearsal"))
	assert.Equal(t, []string{"mark Coral Rehearsal", "discard Coral Rehearsal", "take Coral Rehearsal"}, calls)
}
