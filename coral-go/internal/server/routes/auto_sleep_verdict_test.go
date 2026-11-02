package routes

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func quietAgent(now time.Time) autoSleepInput {
	return autoSleepInput{Now: now, On: true, IdleFor: 60 * time.Minute, LastActive: now.Add(-61 * time.Minute)}
}

// An agent idle past the Operator's minutes, with nothing in the way, is put to sleep; each thing in the way is its own reason, and the order of the reasons is the order of the cases.
func TestAutoSleepVerdictEachRuleAlone(t *testing.T) {
	now := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)
	assert.Equal(t, "", autoSleepVerdict(quietAgent(now)), "idle 61 minutes, nothing in the way: asleep")
	cases := map[string]func(*autoSleepInput){
		skipOff:            func(i *autoSleepInput) { i.On = false },
		skipArchived:       func(i *autoSleepInput) { i.Archived = true },
		skipAsleep:         func(i *autoSleepInput) { i.Asleep = true },
		skipTerminal:       func(i *autoSleepInput) { i.Terminal = true },
		skipJob:            func(i *autoSleepInput) { i.Job = true },
		skipOrchestrator:   func(i *autoSleepInput) { i.Orch = true },
		skipChief:          func(i *autoSleepInput) { i.Chief = true },
		skipOptOut:         func(i *autoSleepInput) { i.OptedOut = true },
		skipNeedsPerson:    func(i *autoSleepInput) { i.NeedsInput = true },
		skipInTurn:         func(i *autoSleepInput) { i.InTurn = true },
		skipNotIdleLong:    func(i *autoSleepInput) { i.LastActive = now.Add(-59 * time.Minute) },
		skipClaimedTask:    func(i *autoSleepInput) { i.ClaimedTask = true },
		skipReview:         func(i *autoSleepInput) { i.ReviewOwed = true },
		skipOperatorAsk:    func(i *autoSleepInput) { i.OperatorAsk = true },
		skipDialog:         func(i *autoSleepInput) { i.Dialog = true },
		skipBackground:     func(i *autoSleepInput) { i.Background = true },
		skipDraft:          func(i *autoSleepInput) { i.Draft = true },
		skipProcessBusy:    func(i *autoSleepInput) { i.ProcBusy = true },
		skipProcessUnknown: func(i *autoSleepInput) { i.ProcUnknown = true },
		skipThrash: func(i *autoSleepInput) {
			i.SleptAt, i.WokenAt = now.Add(-100*time.Minute), now.Add(-95*time.Minute) // woken 5 minutes after the sleep, 95 minutes ago
		},
	}
	for want, mutate := range cases {
		in := quietAgent(now)
		mutate(&in)
		assert.Equal(t, want, autoSleepVerdict(in), want)
	}
	// no activity ever recorded and no launch time: never "idle long enough"
	in := quietAgent(now)
	in.LastActive = time.Time{}
	assert.Equal(t, skipNotIdleLong, autoSleepVerdict(in))
}

// The thrash guard: woken within 10 minutes of the sleep, left awake 2 hours from the wake; a later wake, or one long after the sleep, is not a thrash.
func TestAutoSleepThrashGuard(t *testing.T) {
	now := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)
	slept := now.Add(-3 * time.Hour)
	for name, tc := range map[string]struct {
		woken time.Time
		want  bool
	}{
		"woken 9 minutes after the sleep, 121 minutes ago: guard over": {slept.Add(9 * time.Minute), false},
		"woken 5 minutes after, 119 minutes ago: still guarded":        {now.Add(-119 * time.Minute), true},
		"woken 11 minutes after the sleep: not a thrash":               {slept.Add(11 * time.Minute), false},
		"never woken": {time.Time{}, false},
	} {
		in := quietAgent(now)
		in.SleptAt, in.WokenAt = slept, tc.woken
		if name == "woken 5 minutes after, 119 minutes ago: still guarded" {
			in.SleptAt = tc.woken.Add(-5 * time.Minute)
		}
		assert.Equal(t, tc.want, autoSleepThrashing(in), name)
	}
}
