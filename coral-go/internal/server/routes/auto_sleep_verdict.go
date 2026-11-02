package routes

import "time"

// Auto-sleep (#12111, goal #194): an agent idle for the Operator's minutes is put to sleep, and any delivery from Coral wakes it. This file is the decision, apart from the reading of the
// world it needs (auto_sleep.go): one pure function over what was read, so every rule can be tested alone and the order of the rules is one list.

// The reasons an agent is not put to sleep, in the order they are checked. They are counters in the log, never text from the agent.
const (
	skipOff            = "setting_off"
	skipAsleep         = "asleep"
	skipArchived       = "archived"
	skipTerminal       = "terminal"
	skipJob            = "job"
	skipOrchestrator   = "orchestrator"
	skipChief          = "chief"
	skipOptOut         = "opted_out"
	skipThrash         = "thrash_guard"
	skipNeedsPerson    = "needs_the_person"
	skipInTurn         = "in_turn"
	skipNotIdleLong    = "not_idle_long_enough"
	skipClaimedTask    = "claimed_task"
	skipReview         = "review_assigned"
	skipOperatorAsk    = "operator_ask"
	skipDialog         = "dialog_open"
	skipBackground     = "background_running"
	skipDraft          = "draft_or_unreadable_screen"
	skipProcessBusy    = "process_busy"
	skipProcessUnknown = "process_unknown"
)

const (
	autoSleepThrashWindow = 10 * time.Minute // woken this soon after an auto-sleep is a thrash
	autoSleepThrashHold   = 2 * time.Hour    // and then it is left awake this long
)

// autoSleepInput is everything the decision reads about one agent.
type autoSleepInput struct {
	Now         time.Time
	On          bool
	IdleFor     time.Duration // the Operator's minutes
	Asleep      bool
	Archived    bool
	Terminal    bool // a plain terminal, no agent
	Job         bool
	Orch, Chief bool
	OptedOut    bool
	SleptAt     time.Time // the last auto-sleep, zero if none
	WokenAt     time.Time // the wake that followed it, zero if none
	InTurn      bool
	NeedsInput  bool
	LastActive  time.Time // the latest event or end of turn; the launch time when there is none
	ClaimedTask bool
	ReviewOwed  bool
	OperatorAsk bool
	Dialog      bool
	Background  bool // a background shell or monitor the footer names
	Draft       bool // a draft in the input box, or a screen that could not be read
	ProcBusy    bool // the agent's process tree used CPU since the last look
	ProcUnknown bool // its process tree could not be read, or is over the bound: never quiet
}

// autoSleepVerdict is "" when the agent may be put to sleep now, else the first reason it may not.
func autoSleepVerdict(in autoSleepInput) string {
	switch {
	case !in.On:
		return skipOff
	case in.Archived:
		return skipArchived
	case in.Asleep:
		return skipAsleep
	case in.Terminal:
		return skipTerminal
	case in.Job:
		return skipJob
	case in.Orch:
		return skipOrchestrator
	case in.Chief:
		return skipChief
	case in.OptedOut:
		return skipOptOut
	case autoSleepThrashing(in):
		return skipThrash
	case in.NeedsInput:
		return skipNeedsPerson
	case in.InTurn:
		return skipInTurn
	case in.LastActive.IsZero() || in.Now.Sub(in.LastActive) < in.IdleFor:
		return skipNotIdleLong
	case in.ClaimedTask:
		return skipClaimedTask
	case in.ReviewOwed:
		return skipReview
	case in.OperatorAsk:
		return skipOperatorAsk
	case in.Dialog:
		return skipDialog
	case in.Background:
		return skipBackground
	case in.Draft:
		return skipDraft
	case in.ProcUnknown:
		return skipProcessUnknown
	case in.ProcBusy:
		return skipProcessBusy
	}
	return ""
}

// autoSleepThrashing: an agent that was woken within ten minutes of its auto-sleep is left awake for two hours from that wake.
func autoSleepThrashing(in autoSleepInput) bool {
	if in.SleptAt.IsZero() || in.WokenAt.IsZero() || in.WokenAt.Before(in.SleptAt) {
		return false
	}
	return in.WokenAt.Sub(in.SleptAt) <= autoSleepThrashWindow && in.Now.Sub(in.WokenAt) < autoSleepThrashHold
}
