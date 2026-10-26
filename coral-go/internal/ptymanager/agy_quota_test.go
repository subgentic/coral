package ptymanager

import (
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// agyQuotaScreen is the screen of an Antigravity v1.4.2 CLI that had used up its quota (#5229): a peek of the live agent, rendered text without its styling. The
// Error ID is zeroed; nothing else was changed. The survey takes the input box's place.
const agyQuotaScreen = `● Ran 62 commands (+60 · coral-board read --id 1 2>&1 || true) (ctrl+o to expand)

⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in
103h13m54s.
Error ID: 00000000-0000-0000-0000-000000000000-0000

 How's the CLI experience so far? Help us improve:
 [1] Good  [2] Fine  [3] Bad  [0] Skip

? for shortcuts                                                           Gemini 3.8 Flash · high
`

func TestAgyQuotaOnTheLiveScreen(t *testing.T) {
	resets, ok := AgyQuotaOnScreen(agyQuotaScreen)
	require.True(t, ok, "the ⚠ line is the quota notice")
	assert.Equal(t, 103*time.Hour+13*time.Minute+54*time.Second, resets, "the reset time wrapped onto the next line")

	// The same notice on one line, and with the survey gone.
	one := strings.Replace(agyQuotaScreen, "Resets in\n103h13m54s.", "Resets in 2h5m.", 1)
	resets, ok = AgyQuotaOnScreen(one)
	assert.True(t, ok)
	assert.Equal(t, 2*time.Hour+5*time.Minute, resets)

	// A notice with no time still counts, with an unknown time.
	resets, ok = AgyQuotaOnScreen("⚠ Individual quota reached. Please upgrade.\n\n> \n")
	assert.True(t, ok)
	assert.Zero(t, resets)

	// Not the notice: the words inside a sentence, an agent quoting them far above, an ordinary screen.
	for name, s := range map[string]string{
		"in prose":   "The agent said the individual quota reached its limit earlier, so I retried.\n\n> \n",
		"scrolled":   "⚠ Individual quota reached. Resets in 1h.\n" + strings.Repeat("work\n", agyQuotaLines+2) + "> \n",
		"idle":       "● Done.\n\n> \n? for shortcuts      Gemini 3.8 Flash · high\n",
		"empty":      "",
		"bad number": "⚠ Quota exceeded. Resets in soon.\n",
	} {
		_, ok := AgyQuotaOnScreen(s)
		if name == "bad number" {
			assert.True(t, ok, name+": a notice, time unknown")
			continue
		}
		assert.False(t, ok, name)
	}
}
