package tracking

import (
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #10004: the new-user funnel events carry closed vocabularies and one bounded integer, nothing else; each is a one-time milestone of the install; none is sent with analytics off.

func TestFunnelEventsCarryOnlyTheirClosedVocabularies(t *testing.T) {
	typed, ok := sanitizeProps(EventEULAAccepted, map[string]string{"source": "hub", "email": "a@b.c", "path": "/home/x"})
	require.True(t, ok)
	assert.Equal(t, map[string]any{"source": "hub"}, typed, "an unknown key is dropped")
	for _, bad := range []string{"", "browser", "Dialog", "dialog "} {
		typed, _ = sanitizeProps(EventEULAAccepted, map[string]string{"source": bad})
		assert.Empty(t, typed, "source %q", bad)
	}
	for _, v := range []string{"app", "link", "key", "password"} {
		typed, _ = sanitizeProps(EventDashboardSignedIn, map[string]string{"via": v})
		assert.Equal(t, map[string]any{"via": v}, typed)
	}
	typed, _ = sanitizeProps(EventDashboardSignedIn, map[string]string{"via": "cli"})
	assert.Empty(t, typed)
	for _, v := range []string{"composer_http", "composer_ws", "terminal", "launch_prompt"} {
		typed, _ = sanitizeProps(EventFirstMessageSent, map[string]string{"via": v})
		assert.Equal(t, map[string]any{"via": v}, typed)
	}
	typed, _ = sanitizeProps(EventFirstMessageSent, map[string]string{"via": "hello, please fix my code", "prompt": "hello"})
	assert.Empty(t, typed, "a message is never a property")
	typed, _ = sanitizeProps(EventFirstAgentReply, map[string]string{"provider": "claude", "seconds_to_reply": "42", "outcome": "ok", "reply": "text"})
	assert.Equal(t, map[string]any{"provider": "claude", "seconds_to_reply": 42, "outcome": "ok"}, typed)
	for _, bad := range []string{"-1", "3601", "1e3", "12.5", "x", ""} {
		typed, _ = sanitizeProps(EventFirstAgentReply, map[string]string{"seconds_to_reply": bad})
		assert.Empty(t, typed, "seconds_to_reply %q", bad)
	}
	typed, _ = sanitizeProps(EventFirstAgentReply, map[string]string{"seconds_to_reply": "3600"})
	assert.Equal(t, map[string]any{"seconds_to_reply": 3600}, typed, "an hour is the most that is measured")
	typed, _ = sanitizeProps(EventFirstAgentReply, map[string]string{"provider": "agy", "outcome": "reset"})
	assert.Empty(t, typed, "only the closed provider and outcome sets")
}

func TestFunnelEventsAreServerOnly(t *testing.T) {
	for _, e := range []string{EventEULAAccepted, EventDashboardSignedIn, EventFirstMessageSent, EventFirstAgentReply} {
		assert.False(t, BrowserEvents[e], "%s is emitted by the server, never accepted from POST /api/tracking/event", e)
	}
}

func TestEULAAcceptedAndSignedInAndMessageAreOneTimeMilestones(t *testing.T) {
	rec, _ := newTestTracking(t)
	for _, call := range []func(){
		func() { TrackEULAAccepted(EULASourceDialog) },
		func() { TrackEULAAccepted(EULASourceHub) },
		func() { TrackDashboardSignedIn(SignInLink) },
		func() { TrackDashboardSignedIn(SignInKey) },
		func() { TrackFirstMessageSent(MessageViaComposerHTTP) },
		func() { TrackFirstMessageSent(MessageViaTerminal) },
	} {
		call()
		waitForAsync() // each in turn: the first is the one that is kept
	}
	for _, name := range []string{EventEULAAccepted, EventDashboardSignedIn, EventFirstMessageSent} {
		assert.Equal(t, 1, rec.count(name), "%s once: %v", name, rec.names())
	}
	for _, e := range rec.all() {
		switch e.Event {
		case EventEULAAccepted:
			assert.Equal(t, "dialog", e.Properties["source"], "the first one is kept")
		case EventDashboardSignedIn:
			assert.Equal(t, "link", e.Properties["via"])
		case EventFirstMessageSent:
			assert.Equal(t, "composer_http", e.Properties["via"])
		}
		assert.EqualValues(t, SchemaVersion, e.Properties["schema_version"])
	}
}

func TestFirstAgentReplyIsOnceForAnOkEndAndOnceForAnErrorEnd(t *testing.T) {
	rec, _ := newTestTracking(t)
	require.True(t, FirstReplyWanted())
	TrackFirstAgentReply("claude", 7*time.Second+900*time.Millisecond, ReplyError) // the first turn failed (a rate limit): that is not "a reply that worked"
	waitForAsync()
	assert.True(t, FirstReplyWanted(), "an error end does not use up the ok one")
	TrackFirstAgentReply("claude", 12*time.Second, ReplyOK)
	waitForAsync()                                         // each in turn: the deliveries are goroutines, and the first one to run is the one that is kept
	TrackFirstAgentReply("codex", 30*time.Second, ReplyOK) // a later reply is not the first
	waitForAsync()
	TrackFirstAgentReply("claude", time.Second, ReplyError)
	waitForAsync()
	assert.False(t, FirstReplyWanted(), "the ok reply was delivered")
	require.Equal(t, 2, rec.count(EventFirstAgentReply), rec.names())
	byOutcome := map[string]capturedEvent{}
	for _, e := range rec.all() {
		if e.Event == EventFirstAgentReply {
			byOutcome[e.Properties["outcome"].(string)] = e
		}
	}
	assert.EqualValues(t, 7, byOutcome["error"].Properties["seconds_to_reply"], "whole seconds, rounded down")
	assert.EqualValues(t, 12, byOutcome["ok"].Properties["seconds_to_reply"])
	assert.Equal(t, "claude", byOutcome["ok"].Properties["provider"])
}

func TestFirstAgentReplyMeasuresAtMostAnHourAndOnlyTheClosedProviders(t *testing.T) {
	rec, _ := newTestTracking(t)
	TrackFirstAgentReply("claude", time.Hour+time.Second, ReplyOK)
	TrackFirstAgentReply("claude", -time.Second, ReplyOK)
	waitForAsync()
	assert.Zero(t, rec.count(EventFirstAgentReply), "a wait past an hour, or a clock that went back, sends nothing")
	TrackFirstAgentReply("my-own-agent", time.Hour, "who knows")
	waitForAsync()
	require.Equal(t, 1, rec.count(EventFirstAgentReply))
	e := rec.all()[len(rec.all())-1]
	assert.Equal(t, "other", e.Properties["provider"], "an unknown provider is other")
	assert.Equal(t, "ok", e.Properties["outcome"], "an unknown outcome is ok only when it is not the error end")
	assert.EqualValues(t, 3600, e.Properties["seconds_to_reply"])
}

func TestFunnelEventsSendNothingWithAnalyticsOff(t *testing.T) {
	rec, _ := newTestTracking(t)
	SetTelemetryEnabled(false)
	t.Cleanup(func() { SetTelemetryEnabled(true) })
	TrackEULAAccepted(EULASourceDialog)
	TrackDashboardSignedIn(SignInApp)
	TrackFirstMessageSent(MessageViaLaunchPrompt)
	TrackFirstAgentReply("claude", time.Second, ReplyOK)
	waitForAsync()
	assert.Empty(t, rec.all(), "opted out: nothing leaves")
	assert.False(t, FirstReplyWanted(), "and the server is not asked to track anything for it")
	// ... and switching analytics back on later does not replay what happened while they were off.
	SetTelemetryEnabled(true)
	waitForAsync()
	assert.Empty(t, rec.all())
}

// No funnel property is free text: every property of the four events is an enum or the one bounded integer.
func TestFunnelEventsHaveNoFreeTextProperty(t *testing.T) {
	for _, e := range []string{EventEULAAccepted, EventDashboardSignedIn, EventFirstMessageSent, EventFirstAgentReply} {
		for name, p := range eventSpecs[e] {
			assert.Contains(t, []propKind{kindEnum, kindInt}, p.kind, "%s.%s", e, name)
			if p.kind == kindInt {
				assert.LessOrEqual(t, p.max-p.min, 3600, "%s.%s is bounded", e, name)
			}
			assert.False(t, strings.Contains(strings.ToLower(name), "text") || strings.Contains(strings.ToLower(name), "message") || strings.Contains(strings.ToLower(name), "prompt"), name)
		}
	}
}

// first_message_sent is asked about on every message a person sends: once it is delivered the answer is a map lookup, not a goroutine and a read of the milestone file, and it is remembered per
// data folder (a new folder is a new install and starts again).
func TestADeliveredMilestoneIsNotAskedAgainOnEveryMessage(t *testing.T) {
	rec, _ := newTestTracking(t)
	_, cached := firedHere.Load(firedHereKey(EventFirstMessageSent))
	assert.False(t, cached)
	TrackFirstMessageSent(MessageViaComposerHTTP)
	waitForAsync()
	_, cached = firedHere.Load(firedHereKey(EventFirstMessageSent))
	assert.True(t, cached, "delivered: remembered")
	for i := 0; i < 500; i++ {
		TrackFirstMessageSent(MessageViaComposerWS)
	}
	waitForAsync()
	assert.Equal(t, 1, rec.count(EventFirstMessageSent))

	rec2, _ := newTestTracking(t) // another data folder: another install
	_, cached = firedHere.Load(firedHereKey(EventFirstMessageSent))
	assert.False(t, cached)
	TrackFirstMessageSent(MessageViaTerminal)
	waitForAsync()
	assert.Equal(t, 1, rec2.count(EventFirstMessageSent))
}

// #10106: an acceptance reached while analytics were off is never announced later; one whose delivery failed is retried.
func TestAnAcceptanceReachedWhileAnalyticsWereOffIsNeverSentLater(t *testing.T) {
	rec, _ := newTestTracking(t)
	SetTelemetryEnabled(false)
	TrackEULAAccepted(EULASourceDialog)
	waitForAsync()
	assert.Empty(t, rec.all(), "off: nothing leaves")
	SetTelemetryEnabled(true)
	t.Cleanup(func() { SetTelemetryEnabled(true) })
	TrackEULAAccepted(EULASourceDialog)
	waitForAsync()
	assert.Zero(t, rec.count(EventEULAAccepted), "turning analytics on afterwards does not announce what happened while they were off")
}

func TestAnAcceptanceWhoseDeliveryFailedIsRetried(t *testing.T) {
	rec, _ := newTestTracking(t)
	rec.mu.Lock()
	rec.status = 500
	rec.mu.Unlock()
	TrackEULAAccepted(EULASourceHub)
	waitForAsync()
	rec.mu.Lock()
	rec.status = 200
	rec.mu.Unlock()
	TrackEULAAccepted(EULASourceHub)
	waitForAsync()
	var accepted int
	for _, e := range rec.all() {
		if e.Event == EventEULAAccepted && e.Properties["source"] == "hub" {
			accepted++
		}
	}
	assert.GreaterOrEqual(t, accepted, 1, "the failed delivery was retried on the next start")
	assert.True(t, rec.count(EventEULAAccepted) >= 1)
}

func TestIsFirstRunUntilAnOpenIsTracked(t *testing.T) {
	newTestTracking(t)
	assert.True(t, IsFirstRun(), "no tracked open yet")
	recordFirstOpen()
	assert.False(t, IsFirstRun(), "an open was tracked: an install from before")
}
