package live

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

type sent struct {
	path string
	body string
}

type fakeHub struct {
	got   []sent
	reply func(path string, n int) ([]byte, error)
}

func (h *fakeHub) send(_ context.Context, path string, body []byte) ([]byte, error) {
	h.got = append(h.got, sent{path, string(body)})
	if h.reply != nil {
		return h.reply(path, len(h.got))
	}
	return []byte(`{"ok":true}`), nil
}

func (h *fakeHub) only(path string) []sent {
	var out []sent
	for _, s := range h.got {
		if s.path == path {
			out = append(out, s)
		}
	}
	return out
}

func pushFixture(t *testing.T) (*Pusher, *Manager, *fakeHub, *fakeClock, *mutSource) {
	m, src, clk, _ := fixture(t)
	h := &fakeHub{}
	return NewPusher(m, h.send), m, h, clk, src
}

// step runs the pusher n times, a second apart.
func step(p *Pusher, clk *fakeClock, n int) {
	for i := 0; i < n; i++ {
		p.Step(context.Background())
		clk.add(time.Second)
	}
}

func TestGoLiveSendsOneConfirmThenFramesAfterTheDelay(t *testing.T) {
	p, m, h, clk, _ := pushFixture(t)
	goLive(t, m)
	step(p, clk, 1)
	conf := h.only(PathConfirm)
	require.Len(t, conf, 1)
	var cb map[string]any
	require.NoError(t, json.Unmarshal([]byte(conf[0].body), &cb))
	require.Len(t, cb, 4)
	require.Equal(t, hubA, cb["link"])
	require.Equal(t, false, cb["chat"])
	require.Empty(t, h.only(PathFrame), "nothing goes out before the delay")

	step(p, clk, 30) // 30 s delay
	fr := h.only(PathFrame)
	require.NotEmpty(t, fr)
	var fb map[string]json.RawMessage
	require.NoError(t, json.Unmarshal([]byte(fr[0].body), &fb))
	require.Len(t, fb, 2, "link and frame, nothing else")
	require.JSONEq(t, `"`+hubA+`"`, string(fb["link"]))
	var f Frame
	require.NoError(t, json.Unmarshal(fb["frame"], &f))
	require.Equal(t, uint64(1), f.Seq)
	require.Len(t, f.Agents, 2)
	require.Len(t, h.only(PathConfirm), 1, "a confirm is never sent on a timer or with a frame")
}

func TestAnUnchangedPictureIsNotResentEverySecondButKeptAlive(t *testing.T) {
	p, m, h, clk, _ := pushFixture(t)
	goLive(t, m)
	step(p, clk, 40)
	require.Len(t, h.only(PathFrame), 1)
	step(p, clk, 30)
	require.Len(t, h.only(PathFrame), 1)
	step(p, clk, 40) // past the 60 s keep-alive
	require.Len(t, h.only(PathFrame), 2)
}

func TestAChangeIsShownOnlyAfterTheDelayAndNoFasterThanOneEveryTwoSeconds(t *testing.T) {
	p, m, h, clk, src := pushFixture(t)
	goLive(t, m)
	step(p, clk, 35)
	base := len(h.only(PathFrame))
	src.rows[0].TaskTitle = "Fix signup"
	step(p, clk, 20)
	require.Len(t, h.only(PathFrame), base, "the new task title waits out the delay")
	step(p, clk, 15)
	fr := h.only(PathFrame)
	require.Len(t, fr, base+1)
	require.Contains(t, fr[base].body, "Fix signup")
}

func TestAConfirmIsRetriedAfterATransportFailureAndGivenUpAfterTenMinutes(t *testing.T) {
	p, m, h, clk, _ := pushFixture(t)
	h.reply = func(path string, n int) ([]byte, error) { return nil, errors.New("no tunnel") }
	goLive(t, m)
	step(p, clk, 5)
	first := len(h.only(PathConfirm))
	require.GreaterOrEqual(t, first, 2, "retried")
	require.Less(t, first, 5, "with backoff, not every second")
	step(p, clk, 700)
	n := len(h.only(PathConfirm))
	step(p, clk, 120)
	require.Equal(t, n, len(h.only(PathConfirm)), "given up after ten minutes")
}

func TestAPauseSendsTheReasonOnceAndCancelsAQueuedConfirm(t *testing.T) {
	p, m, h, clk, _ := pushFixture(t)
	h.reply = func(path string, n int) ([]byte, error) { return nil, errors.New("down") }
	goLive(t, m)
	step(p, clk, 1) // confirm queued, failing
	_, err := m.Pause("L1")
	require.NoError(t, err)
	h.reply = nil
	h.got = nil
	step(p, clk, 3)
	require.Empty(t, h.only(PathConfirm), "the paused message replaced it")
	pa := h.only(PathPaused)
	require.Len(t, pa, 1)
	require.JSONEq(t, `{"link":"`+hubA+`","reason":"owner"}`, pa[0].body)
	require.Empty(t, h.only(PathFrame))
}

func TestAFrameDueAfterTheDeadlineIsNotSentAndTheHubIsToldNotReconfirmed(t *testing.T) {
	p, m, h, clk, _ := pushFixture(t)
	goLive(t, m)
	step(p, clk, 35)
	frames := len(h.only(PathFrame))
	clk.add(110 * 24 * time.Hour) // past the 90-day period and the 14 days of grace
	step(p, clk, 2)
	require.Equal(t, frames, len(h.only(PathFrame)))
	pa := h.only(PathPaused)
	require.Len(t, pa, 1)
	require.Contains(t, pa[0].body, `"not_reconfirmed"`)
	l, _ := m.Get("L1")
	require.Equal(t, StatePaused, l.State)
}

func TestNoFrameWhileTheHubLinkIsDown(t *testing.T) {
	p, m, h, clk, _ := pushFixture(t)
	goLive(t, m)
	hubLinkUp = false
	step(p, clk, 40)
	require.Empty(t, h.only(PathFrame))
	hubLinkUp = true
	step(p, clk, 40)
	require.NotEmpty(t, h.only(PathFrame))
}

func TestAHubStopOrPauseReplyTurnsTheLinkOffAndWipesWhatWasHeld(t *testing.T) {
	for _, c := range []struct {
		reply string
		state State
	}{{`{"stop":true}`, StateStopped}, {`{"pause":true}`, StatePaused}} {
		p, m, h, clk, _ := pushFixture(t)
		h.reply = func(path string, n int) ([]byte, error) {
			if path == PathFrame {
				return []byte(c.reply), nil
			}
			return []byte(`{"ok":true}`), nil
		}
		goLive(t, m)
		step(p, clk, 40)
		l, _ := m.Get("L1")
		require.Equal(t, c.state, l.State, c.reply)
		require.Empty(t, p.st, "the held picture is wiped")
		n := len(h.only(PathFrame))
		step(p, clk, 40)
		require.Equal(t, n, len(h.only(PathFrame)))
	}
}

func TestNotLiveStopsFramesUntilAPersonConfirmsAgain(t *testing.T) {
	p, m, h, clk, _ := pushFixture(t)
	h.reply = func(path string, n int) ([]byte, error) {
		if path == PathFrame {
			return []byte(`{"outcome":"not_live"}`), nil
		}
		return []byte(`{"ok":true}`), nil
	}
	goLive(t, m)
	step(p, clk, 40)
	require.Len(t, h.only(PathFrame), 1)
	step(p, clk, 90)
	require.Len(t, h.only(PathFrame), 1, "no more frames")
	h.reply = nil
	_, err := m.Reconfirm("L1")
	require.NoError(t, err)
	step(p, clk, 40)
	require.NotEmpty(t, h.only(PathFrame)[1:], "a person's confirm starts it again")
}

func TestAReplyOutsideTheSetBlocksTheLinkUntilAConfirm(t *testing.T) {
	p, m, h, clk, _ := pushFixture(t)
	h.reply = func(path string, n int) ([]byte, error) {
		if path == PathFrame {
			return []byte(`{"ok":true,"viewers":3}`), nil
		}
		return []byte(`{"ok":true}`), nil
	}
	goLive(t, m)
	step(p, clk, 40)
	require.Equal(t, 1, p.Counts.Protocol)
	step(p, clk, 120)
	require.Len(t, h.only(PathFrame), 1)
	l, _ := m.Get("L1")
	require.Equal(t, StateLive, l.State, "a bad reply changes nothing here but the pushing")
}

func TestTheLastViewedAgeIsKeptAsTheHubReportsIt(t *testing.T) {
	p, m, h, clk, _ := pushFixture(t)
	h.reply = func(path string, n int) ([]byte, error) {
		if path == PathFrame {
			return []byte(`{"ok":true,"last_viewed_age_s":120}`), nil
		}
		return []byte(`{"ok":true}`), nil
	}
	goLive(t, m)
	step(p, clk, 40)
	l, _ := m.Get("L1")
	require.NotNil(t, l.LastViewedS)
	require.Equal(t, int64(120), *l.LastViewedS)
}

func TestARateLimitedReplyBacksOffAndTheFrameIsSentAgainLater(t *testing.T) {
	p, m, h, clk, _ := pushFixture(t)
	limited := true
	h.reply = func(path string, n int) ([]byte, error) {
		if path == PathFrame && limited {
			return []byte(`{"error":"rate_limited"}`), nil
		}
		return []byte(`{"ok":true}`), nil
	}
	goLive(t, m)
	step(p, clk, 40)
	require.GreaterOrEqual(t, p.Counts.RateLimited, 1)
	require.Less(t, p.Counts.RateLimited, 8, "it backs off, it does not retry every second")
	limited = false
	step(p, clk, 10)
	require.GreaterOrEqual(t, len(h.only(PathFrame)), 2)
}

func TestAChatOffConfirmIsSentWhenTheAgentRestarts(t *testing.T) {
	p, m, h, clk, src := pushFixture(t)
	ctx := context.Background()
	_, _ = m.Create(hubA, "team", "Operator", testVia)
	_, _ = m.SetViews(ctx, "L1", Views{ChatKey: "backend"})
	pr, _ := m.Preview(ctx, "L1")
	_, err := m.GoLive(ctx, "L1", pr.Hash, true)
	require.NoError(t, err)
	step(p, clk, 2)
	src.rows[0].Generation = "s1@t2"
	step(p, clk, 2)
	conf := h.only(PathConfirm)
	require.Len(t, conf, 2)
	require.Contains(t, conf[1].body, `"chat":false`)
	require.Contains(t, conf[1].body, `"chat_since":0`)
}
