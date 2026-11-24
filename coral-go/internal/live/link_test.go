package live

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// Slice 3 (#21014, design v4 section 14): the link state, the re-confirm clock, the approved snapshot, the pusher's check and the messages for the Hub.

const hubA = "11111111-2222-3333-4444-555555555555"

type fakeClock struct{ t time.Time }

func (c *fakeClock) Now() time.Time      { return c.t }
func (c *fakeClock) add(d time.Duration) { c.t = c.t.Add(d) }

type mutSource struct{ rows []AgentRow }

func (s *mutSource) Agents(context.Context) ([]AgentRow, error) { return s.rows, nil }
func (s *mutSource) Posts(context.Context, int) ([]PostRow, error) {
	return []PostRow{{Author: "Backend Dev", Text: "hello there", At: time.Unix(1700000001, 0)}}, nil
}

// testVia is the id of this computer's own Hub link the tests push through; hubLinkUp is whether it is active.
const testVia = "lnk-aaaaaaaa"

var hubLinkUp = true

func linkActive(id string) bool { return hubLinkUp && id == testVia }

func newMgr(t *testing.T, st Store, src *mutSource, clk *fakeClock) *Manager {
	t.Helper()
	hubLinkUp = true
	m, err := NewManager(Config{Clock: clk, Store: st, LinkActive: linkActive, Source: func(string) LiveSource { return src }, Redactor: hubScan(),
		ChatAvailable: func(a AgentRow) bool { return true }, NewID: func() string { return "L1" }})
	require.NoError(t, err)
	return m
}

func fixture(t *testing.T) (*Manager, *mutSource, *fakeClock, *MemStore) {
	src := &mutSource{rows: []AgentRow{
		{Key: "backend", Generation: "s1@t1", Name: "Backend Dev", Role: "backend", Working: true, TaskTitle: "Fix login"},
		{Key: "qa", Generation: "s2@t1", Name: "QA Engineer", Role: "qa"},
	}}
	clk := &fakeClock{t: time.Unix(1700000000, 0)}
	st := &MemStore{}
	return newMgr(t, st, src, clk), src, clk, st
}

func goLive(t *testing.T, m *Manager) Link {
	t.Helper()
	ctx := context.Background()
	_, err := m.Create(hubA, "team", "Operator", testVia)
	require.NoError(t, err)
	p, err := m.Preview(ctx, "L1")
	require.NoError(t, err)
	l, err := m.GoLive(ctx, "L1", p.Hash, true)
	require.NoError(t, err)
	return l
}

func TestCreateRefusesABadOrRepeatedHubLinkAndKeepsNoURL(t *testing.T) {
	m, _, _, _ := fixture(t)
	for _, bad := range []string{"", "not-a-uuid", "https://hub.example/live#abc", hubA + "x"} {
		_, err := m.Create(bad, "team", "Operator", testVia)
		require.ErrorIs(t, err, ErrBadHubLink, bad)
	}
	l, err := m.Create(strings.ToUpper(hubA), "team", "Operator", testVia)
	require.NoError(t, err)
	require.Equal(t, hubA, l.HubLink)
	require.Equal(t, StateDraft, l.State)
	_, err = m.Create(hubA, "team", "Operator", testVia)
	require.ErrorIs(t, err, ErrBadHubLink, "one Hub link, one link here")
	raw, _ := json.Marshal(l)
	require.NotContains(t, string(raw), "http", "no URL is ever held")
}

func TestGoLiveNeedsTheReadFlagAndTheCurrentHash(t *testing.T) {
	m, _, _, _ := fixture(t)
	ctx := context.Background()
	_, _ = m.Create(hubA, "team", "Operator", testVia)
	p, _ := m.Preview(ctx, "L1")
	_, err := m.GoLive(ctx, "L1", p.Hash, false)
	require.ErrorIs(t, err, ErrNotRead)
	_, err = m.GoLive(ctx, "L1", "", true)
	require.ErrorIs(t, err, ErrBadHash)
	_, err = m.GoLive(ctx, "L1", "deadbeef", true)
	require.ErrorIs(t, err, ErrBadHash)
	// a changed setting voids the preview that was read
	_, err = m.SetViews(ctx, "L1", Views{PeriodDays: 30, ExpiresIn: "7d", DelayS: 60})
	require.NoError(t, err)
	_, err = m.GoLive(ctx, "L1", p.Hash, true)
	require.ErrorIs(t, err, ErrBadHash, "the old hash is void after a change")
	p2, _ := m.Preview(ctx, "L1")
	require.NotEqual(t, p.Hash, p2.Hash)
	l, err := m.GoLive(ctx, "L1", p2.Hash, true)
	require.NoError(t, err)
	require.Equal(t, StateLive, l.State)
	_, err = m.GoLive(ctx, "L1", p2.Hash, true)
	require.ErrorIs(t, err, ErrState, "only a draft goes live")
}

func TestOnlyTheApprovedSnapshotIsPushed(t *testing.T) { // MUST A
	m, src, _, _ := fixture(t)
	ctx := context.Background()
	goLive(t, m)
	f, err := m.Frame(ctx, "L1", 1)
	require.NoError(t, err)
	require.Len(t, f.Agents, 2)
	// an agent that joins later is not shown, and editing the draft changes nothing pushed
	src.rows = append(src.rows, AgentRow{Key: "newbie", Generation: "s3@t1", Name: "New Nina", Role: "ux", TaskTitle: "Secret plan"})
	_, err = m.SetViews(ctx, "L1", Views{PeriodDays: 10, ExpiresIn: "24h", DelayS: 300})
	require.NoError(t, err)
	f, err = m.Frame(ctx, "L1", 2)
	require.NoError(t, err)
	require.Len(t, f.Agents, 2, "the new agent is absent until a new go-live")
	raw, _ := json.Marshal(f)
	require.NotContains(t, string(raw), "Secret plan")
	l, _ := m.Get("L1")
	require.Equal(t, "none", l.Approved.ExpiresIn, "the snapshot did not follow the draft")
	require.Equal(t, 30, l.Approved.DelayS)
}

func TestTheClockChatSevenDaysWithADayOfGraceElseTheOwnersPeriodWithFourteen(t *testing.T) {
	l := Link{ConfirmedAt: time.Unix(1700000000, 0), Approved: &Approved{ChatKey: "backend", PeriodDays: 90}}
	due, pause := Deadlines(l)
	require.Equal(t, l.ConfirmedAt.Add(7*24*time.Hour), due)
	require.Equal(t, due.Add(24*time.Hour), pause)
	l.Approved = &Approved{PeriodDays: 90}
	due, pause = Deadlines(l)
	require.Equal(t, l.ConfirmedAt.Add(90*24*time.Hour), due)
	require.Equal(t, due.Add(14*24*time.Hour), pause)
	l.Approved = &Approved{PeriodDays: 20}
	due, _ = Deadlines(l)
	require.Equal(t, l.ConfirmedAt.Add(20*24*time.Hour), due)
	require.Equal(t, due.Add(-2*24*time.Hour), NoticeAt(l), "a short period gets a tenth as its notice")
	l.Approved = &Approved{PeriodDays: 90}
	require.Equal(t, l.ConfirmedAt.Add(83*24*time.Hour), NoticeAt(l))
	l.Approved = &Approved{ChatKey: "x"}
	require.Equal(t, l.ConfirmedAt.Add(6*24*time.Hour), NoticeAt(l), "24 h before a 7-day expiry")
}

func TestTheWholeLinkPausesAtTheEndOfGraceAndTheHubIsToldTheSameInstant(t *testing.T) {
	m, _, clk, _ := fixture(t)
	ctx := context.Background()
	l := goLive(t, m)
	msgs := m.Drain()
	require.Len(t, msgs, 1)
	_, pauseAt := Deadlines(l)
	require.Equal(t, pauseAt.Unix(), msgs[0].ReconfirmDue, "the Hub's reconfirm_due is the end of grace, always set")
	require.False(t, msgs[0].Chat)
	require.Zero(t, msgs[0].ChatSince, "chat false sends 0")

	clk.add(104*24*time.Hour - time.Second)
	require.NoError(t, m.Tick(ctx))
	require.NoError(t, m.CanPush("L1", hubA), "still inside the grace")
	l, _ = m.Get("L1")
	require.Equal(t, StateLive, l.State)
	clk.add(time.Second)
	require.ErrorIs(t, m.CanPush("L1", hubA), ErrState, "the pusher sends nothing at the instant, before Tick has run")
	require.NoError(t, m.Tick(ctx))
	l, _ = m.Get("L1")
	require.Equal(t, StatePaused, l.State)
	require.Equal(t, ReasonNotReconfirmed, l.PausedReason)
	msgs = m.Drain()
	require.Equal(t, []Message{{Kind: "paused", HubLink: hubA, Reason: ReasonNotReconfirmed}}, msgs)
	_, err := m.Reconfirm("L1")
	require.ErrorIs(t, err, ErrState, "a paused link is resumed, not re-confirmed")
}

func TestReconfirmMovesTheDeadlineAndSendsAConfirm(t *testing.T) {
	m, _, clk, _ := fixture(t)
	goLive(t, m)
	m.Drain()
	clk.add(80 * 24 * time.Hour)
	l, err := m.Reconfirm("L1")
	require.NoError(t, err)
	require.Equal(t, clk.Now(), l.ConfirmedAt)
	msgs := m.Drain()
	require.Len(t, msgs, 1)
	require.Equal(t, "confirm", msgs[0].Kind)
	_, pause := Deadlines(l)
	require.Equal(t, pause.Unix(), msgs[0].ReconfirmDue)
	// inside the grace it still works; after it, no
	clk.add(91*24*time.Hour + 14*24*time.Hour)
	_, err = m.Reconfirm("L1")
	require.ErrorIs(t, err, ErrState)
}

func TestAClockSetBackCannotExtendALink(t *testing.T) {
	m, _, clk, _ := fixture(t)
	goLive(t, m)
	clk.add(-time.Hour)
	require.ErrorIs(t, m.CanPush("L1", hubA), ErrState)
	require.NoError(t, m.Tick(context.Background()))
	l, _ := m.Get("L1")
	require.Equal(t, StatePaused, l.State)
}

func TestThePusherChecksTheHubLinkEveryFrame(t *testing.T) { // MUST D
	m, _, _, _ := fixture(t)
	require.ErrorIs(t, m.CanPush("L1", hubA), ErrNotFound)
	goLive(t, m)
	require.NoError(t, m.CanPush("L1", hubA))
	for _, bad := range []string{"", "22222222-2222-3333-4444-555555555555", "https://x/y"} {
		require.ErrorIs(t, m.CanPush("L1", bad), ErrBadHubLink, bad)
	}
	_, err := m.Pause("L1")
	require.NoError(t, err)
	require.ErrorIs(t, m.CanPush("L1", hubA), ErrState, "a paused link pushes nothing")
}

func TestExpiryStopsTheLink(t *testing.T) {
	m, _, clk, _ := fixture(t)
	ctx := context.Background()
	_, _ = m.Create(hubA, "team", "Operator", testVia)
	_, err := m.SetViews(ctx, "L1", Views{PeriodDays: 90, ExpiresIn: "24h", DelayS: 30})
	require.NoError(t, err)
	p, _ := m.Preview(ctx, "L1")
	_, err = m.GoLive(ctx, "L1", p.Hash, true)
	require.NoError(t, err)
	clk.add(24*time.Hour - time.Second)
	require.NoError(t, m.CanPush("L1", hubA))
	clk.add(time.Second)
	require.ErrorIs(t, m.CanPush("L1", hubA), ErrState)
	require.NoError(t, m.Tick(ctx))
	l, _ := m.Get("L1")
	require.Equal(t, StateStopped, l.State)
}

func TestPauseResumeStopAndTheHubOnlyTurnsThingsOff(t *testing.T) {
	m, _, _, _ := fixture(t)
	ctx := context.Background()
	goLive(t, m)
	m.Drain()
	age := int64(120)
	m.HubReply("L1", false, false, &age)
	l, _ := m.Get("L1")
	require.EqualValues(t, 120, *l.LastViewedS)
	huge := int64(40 * 24 * 3600)
	m.HubReply("L1", false, false, &huge)
	l, _ = m.Get("L1")
	require.EqualValues(t, 120, *l.LastViewedS, "an out-of-range age is dropped")
	m.HubReply("L1", false, true, nil)
	l, _ = m.Get("L1")
	require.Equal(t, StatePaused, l.State)
	require.Equal(t, ReasonHub, l.PausedReason)
	require.Equal(t, 1, l.HubStops)
	require.Empty(t, m.Drain(), "a pause the Hub asked for is not told back to it")
	// no reply resumes it
	m.HubReply("L1", false, false, nil)
	l, _ = m.Get("L1")
	require.Equal(t, StatePaused, l.State)
	// a person resumes with the current hash
	_, err := m.Resume(ctx, "L1", "stale")
	require.ErrorIs(t, err, ErrBadHash)
	p, _ := m.Preview(ctx, "L1")
	l, err = m.Resume(ctx, "L1", p.Hash)
	require.NoError(t, err)
	require.Equal(t, StateLive, l.State)
	require.Equal(t, "confirm", m.Drain()[0].Kind, "resume is a confirm")
	m.HubReply("L1", true, false, nil)
	l, _ = m.Get("L1")
	require.Equal(t, StateStopped, l.State)
	_, err = m.Resume(ctx, "L1", p.Hash)
	require.ErrorIs(t, err, ErrState, "a stopped link does not resume")
	m.HubReply("L1", false, false, nil)
}

func TestOwnerPauseSendsTheOwnerReason(t *testing.T) {
	m, _, _, _ := fixture(t)
	goLive(t, m)
	m.Drain()
	_, err := m.Pause("L1")
	require.NoError(t, err)
	require.Equal(t, []Message{{Kind: "paused", HubLink: hubA, Reason: ReasonOwner}}, m.Drain())
	_, err = m.Stop("L1")
	require.NoError(t, err)
	require.Empty(t, m.Drain(), "stop tells the Hub nothing")
}

func TestChatNeedsAnAvailableAgentAndIsBoundToItsGeneration(t *testing.T) { // MUST B
	m, src, clk, _ := fixture(t)
	ctx := context.Background()
	_, _ = m.Create(hubA, "team", "Operator", testVia)
	for _, bad := range []string{"nobody", "ghost"} {
		_, err := m.SetViews(ctx, "L1", Views{ChatKey: bad})
		require.ErrorIs(t, err, ErrChatUnavailable)
	}
	src.rows[1].Generation = ""
	_, err := m.SetViews(ctx, "L1", Views{ChatKey: "qa"})
	require.ErrorIs(t, err, ErrChatUnavailable, "an agent with no generation has no chat")
	src.rows[1].Generation = "s2@t1"
	_, err = m.SetViews(ctx, "L1", Views{ChatKey: "backend"})
	require.NoError(t, err)
	p, _ := m.Preview(ctx, "L1")
	l, err := m.GoLive(ctx, "L1", p.Hash, true)
	require.NoError(t, err)
	require.Equal(t, "s1@t1", l.Approved.ChatGen)
	msgs := m.Drain()
	require.True(t, msgs[0].Chat)
	require.Equal(t, clk.Now().Unix(), msgs[0].ChatSince, "chat true carries a chat_since that is not in the future")
	_, pause := Deadlines(l)
	require.Equal(t, clk.Now().Add(8*24*time.Hour).Unix(), pause.Unix())

	// a restart changes the generation: chat goes off, the link stays live, the deadline moves to the no-chat one
	src.rows[0].Generation = "s1@t2"
	require.NoError(t, m.Tick(ctx))
	l, _ = m.Get("L1")
	require.Equal(t, StateLive, l.State)
	require.Empty(t, l.Approved.ChatKey)
	require.Empty(t, l.Views.ChatKey)
	require.Equal(t, "the agent restarted", l.ChatOffWhy)
	f, _ := m.Frame(ctx, "L1", 1)
	for _, a := range f.Agents {
		require.Empty(t, a.Chat)
	}
}

func TestChatDoesNotFollowARoleOrAReusedName(t *testing.T) { // MUST B: key plus generation, never the role
	m, src, _, _ := fixture(t)
	ctx := context.Background()
	_, _ = m.Create(hubA, "team", "Operator", testVia)
	_, _ = m.SetViews(ctx, "L1", Views{ChatKey: "backend"})
	p, _ := m.Preview(ctx, "L1")
	_, err := m.GoLive(ctx, "L1", p.Hash, true)
	require.NoError(t, err)
	// the agent is replaced by another session under the same key and the same role
	src.rows[0] = AgentRow{Key: "backend", Generation: "other@t9", Name: "Backend Dev", Role: "backend"}
	require.NoError(t, m.Tick(ctx))
	l, _ := m.Get("L1")
	require.Empty(t, l.Approved.ChatKey)
	// the agent is gone altogether
	_, _ = m.Pause("L1")
	_ = l
}

func TestARestartBringsALinkWithChatBackPausedAndTellsTheHub(t *testing.T) {
	m, src, clk, st := fixture(t)
	ctx := context.Background()
	_, _ = m.Create(hubA, "team", "Operator", testVia)
	_, _ = m.SetViews(ctx, "L1", Views{ChatKey: "backend"})
	p, _ := m.Preview(ctx, "L1")
	_, err := m.GoLive(ctx, "L1", p.Hash, true)
	require.NoError(t, err)

	m2 := newMgr(t, st, src, clk)
	l, err := m2.Get("L1")
	require.NoError(t, err)
	require.Equal(t, StatePaused, l.State)
	require.Equal(t, ReasonRestart, l.PausedReason)
	require.Equal(t, []Message{{Kind: "paused", HubLink: hubA, Reason: ReasonRestart}}, m2.Drain())
	require.ErrorIs(t, m2.CanPush("L1", hubA), ErrState)
}

func TestARestartKeepsALinkWithoutChatAsItWas(t *testing.T) {
	m, src, clk, st := fixture(t)
	goLive(t, m)
	m2 := newMgr(t, st, src, clk)
	l, _ := m2.Get("L1")
	require.Equal(t, StateLive, l.State)
	require.Empty(t, m2.Drain())
	require.NoError(t, m2.CanPush("L1", hubA))
}

func TestALinkFromAnotherComputerComesBackPausedEvenWithoutChat(t *testing.T) {
	src := &mutSource{rows: []AgentRow{{Key: "backend", Generation: "s1@t1", Name: "Backend Dev", Role: "backend"}}}
	clk := &fakeClock{t: time.Unix(1700000000, 0)}
	st := &MemStore{}
	mk := func(computer string) *Manager {
		m, err := NewManager(Config{Clock: clk, Store: st, LinkActive: linkActive, Computer: computer, Source: func(string) LiveSource { return src }, Redactor: hubScan(),
			NewID: func() string { return "L1" }})
		require.NoError(t, err)
		return m
	}
	m := mk("compA")
	goLive(t, m)
	same := mk("compA")
	l, _ := same.Get("L1")
	require.Equal(t, StateLive, l.State)

	other := mk("compB") // a different computer, or a copied data folder
	l, _ = other.Get("L1")
	require.Equal(t, StatePaused, l.State)
	require.Equal(t, ReasonRestart, l.PausedReason)
	require.Equal(t, []Message{{Kind: "paused", HubLink: hubA, Reason: ReasonRestart}}, other.Drain())
	require.ErrorIs(t, other.CanPush("L1", hubA), ErrState)
}

func TestALinkStoredWithNoComputerComesBackPausedOnAComputerThatHasOne(t *testing.T) {
	src := &mutSource{rows: []AgentRow{{Key: "backend", Generation: "s1@t1", Name: "Backend Dev", Role: "backend"}}}
	clk := &fakeClock{t: time.Unix(1700000000, 0)}
	st := &MemStore{}
	mk := func(computer string) *Manager {
		m, err := NewManager(Config{Clock: clk, Store: st, LinkActive: linkActive, Computer: computer, Source: func(string) LiveSource { return src }, Redactor: hubScan(),
			NewID: func() string { return "L1" }})
		require.NoError(t, err)
		return m
	}
	goLive(t, mk("")) // a link made before links carried an identity
	l, _ := mk("compA").Get("L1")
	require.Equal(t, StatePaused, l.State)
	require.Equal(t, ReasonRestart, l.PausedReason)
}

// Condition 6: a link pushes through one of this computer's own active Hub links, checked at create and before every frame.
func TestACreateNeedsAnActiveHubLinkOfThisComputer(t *testing.T) {
	m, _, _, _ := fixture(t)
	for _, via := range []string{"", "lnk-bbbbbbbb"} {
		_, err := m.Create(hubA, "team", "Operator", via)
		require.ErrorIs(t, err, ErrBadVia, "via %q", via)
	}
	hubLinkUp = false
	_, err := m.Create(hubA, "team", "Operator", testVia)
	require.ErrorIs(t, err, ErrBadVia, "a link that is not active now")
}

func TestNoFrameWhileTheHubLinkIsPausedRemovingOrGone(t *testing.T) {
	m, _, _, _ := fixture(t)
	goLive(t, m)
	require.NoError(t, m.CanPush("L1", hubA))
	hubLinkUp = false
	require.ErrorIs(t, m.CanPush("L1", hubA), ErrViaDown)
	hubLinkUp = true
	require.NoError(t, m.CanPush("L1", hubA), "it goes on when the Hub link is active again")
}

// SHOULD 8: an agent that is archived or has left is never in the approved set, and one archived later drops out of the frame.
func TestAnArchivedAgentIsNotShownAndOneArchivedLaterDropsOut(t *testing.T) {
	m, src, _, _ := fixture(t)
	src.rows = append(src.rows, AgentRow{Key: "gone", Generation: "s3@t1", Name: "Gone Gus", Role: "ux", Archived: true})
	l := goLive(t, m)
	require.NotContains(t, l.Approved.AgentKeys, "gone")
	f, err := m.Frame(context.Background(), "L1", 1)
	require.NoError(t, err)
	require.Len(t, f.Agents, 2)
	src.rows[1].Archived = true // qa leaves after go-live
	f, err = m.Frame(context.Background(), "L1", 2)
	require.NoError(t, err)
	require.Len(t, f.Agents, 1)
}

// INFO: when Tick drops chat (the agent restarted) the Hub is told with a confirm that has chat off.
func TestTickDroppingChatTellsTheHubWithAChatOffConfirm(t *testing.T) {
	m, src, _, _ := fixture(t)
	ctx := context.Background()
	_, _ = m.Create(hubA, "team", "Operator", testVia)
	_, _ = m.SetViews(ctx, "L1", Views{ChatKey: "backend"})
	p, _ := m.Preview(ctx, "L1")
	_, err := m.GoLive(ctx, "L1", p.Hash, true)
	require.NoError(t, err)
	m.Drain()
	src.rows[0].Generation = "s1@t2" // restarted
	require.NoError(t, m.Tick(ctx))
	out := m.Drain()
	require.Len(t, out, 1)
	require.Equal(t, "confirm", out[0].Kind)
	require.False(t, out[0].Chat)
	require.Zero(t, out[0].ChatSince)
	require.NotZero(t, out[0].ReconfirmDue)
}
