package operatortouch

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/terminalinput"
)

type row struct{ Team, Agent, Kind, Source string }

type fakeStore struct {
	mu   sync.Mutex
	rows []row
}

func (f *fakeStore) RecordOperatorTouch(_ context.Context, team, agent, kind, source string, _ time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.rows = append(f.rows, row{team, agent, kind, source})
	return nil
}
func (f *fakeStore) kinds() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, r := range f.rows {
		out = append(out, r.Kind)
	}
	return out
}

const sid1 = "11111111-2222-3333-4444-555555555555"

func rec(t *testing.T) (*Recorder, *fakeStore, *time.Time) {
	st := &fakeStore{}
	now := time.Date(2026, 10, 30, 8, 0, 0, 0, time.UTC)
	r := New(st, func(_ context.Context, id string) (string, string, bool) {
		if id == sid1 {
			return "team", "Dev", true
		}
		return "", "", false // a plain terminal, or an agent on no board
	})
	r.SetClock(func() time.Time { return now })
	return r, st, &now
}

// Typed input is coalesced into bursts, and any other touch starts one: an answer's own keystroke, or the Escape of a stop, is not also a typed touch.
func TestTypedInputIsOneTouchPerBurstAndOtherTouchesStartOne(t *testing.T) {
	r, st, now := rec(t)
	for i := 0; i < 50; i++ { // fifty keystrokes in ten seconds
		*now = now.Add(200 * time.Millisecond)
		r.Typed(sid1)
	}
	assert.Equal(t, []string{board.TouchTyped}, st.kinds(), "one burst, one touch")
	*now = now.Add(board.TouchBurst + time.Second)
	r.TypedTo("claude-" + sid1)
	assert.Equal(t, []string{board.TouchTyped, board.TouchTyped}, st.kinds(), "the next burst")

	*now = now.Add(time.Minute)
	r.Touch(context.Background(), sid1, board.TouchAnswer, board.TouchLocal)
	r.Typed(sid1) // the answer's own keystroke
	*now = now.Add(2 * time.Second)
	r.Touch(context.Background(), sid1, board.TouchStop, board.TouchLocal)
	r.Typed(sid1)
	assert.Equal(t, []string{board.TouchTyped, board.TouchTyped, board.TouchAnswer, board.TouchStop}, st.kinds())

	// Wake, restart and approve are one touch each, every time.
	r.Touch(context.Background(), sid1, board.TouchWake, board.TouchLocal)
	r.Touch(context.Background(), sid1, board.TouchWake, board.TouchLocal)
	r.TouchAgent(context.Background(), "team", "Dev", board.TouchApprove, board.TouchLocal)
	assert.Equal(t, []string{board.TouchTyped, board.TouchTyped, board.TouchAnswer, board.TouchStop, board.TouchWake, board.TouchWake, board.TouchApprove}, st.kinds())
}

func TestASessionOnNoBoardOrANonSessionTargetIsNotRecorded(t *testing.T) {
	r, st, _ := rec(t)
	r.Typed("99999999-2222-3333-4444-555555555555") // on no board
	r.TypedTo("a-plain-terminal")                   // not a session's name
	r.TypedTo("")
	r.Touch(context.Background(), "", board.TouchWake, board.TouchLocal)
	var nilRecorder *Recorder
	nilRecorder.Typed(sid1) // not recording at all: harmless
	nilRecorder.Touch(context.Background(), sid1, board.TouchStop, board.TouchLocal)
	nilRecorder.TouchAgent(context.Background(), "t", "a", board.TouchApprove, board.TouchLocal)
	nilRecorder.NoteSource(sid1, board.TouchHub)
	assert.Empty(t, st.kinds())
}

// The person path as it runs: terminalinput.Record is told the target of a person's input and nothing else, and what was typed (a password, a long paste) is not in what is recorded.
func TestWhatAPersonTypedNeverReachesTheRecording(t *testing.T) {
	r, st, _ := rec(t)
	terminalinput.SetPersonSink(r.TypedTo)
	t.Cleanup(func() { terminalinput.SetPersonSink(func(string) {}) })
	secret := "hunter2 " + strings.Repeat("A", 5000)
	terminalinput.Record(terminalinput.Person, "claude-"+sid1, terminalinput.Text, secret)
	terminalinput.Record(terminalinput.Coral, "claude-"+sid1, terminalinput.Text, "a nudge") // Coral's own text is no touch
	assert.Equal(t, []string{board.TouchTyped}, st.kinds())
	dump, _ := json.Marshal(st.rows)
	assert.NotContains(t, string(dump), "hunter2")
	assert.Less(t, len(dump), 100, "what is kept does not grow with what was typed")
}

// QA's #11225 MUST: on the tmux backend a terminal's target is the pane, claude-<uuid>:0.0, and the typed touch was never recorded because that did not parse. The pane form, the session name of the
// pty backend and a pane of another window all name the session.
func TestTypedTouchesAreRecordedOnTheTmuxPaneFormAndThePtyName(t *testing.T) {
	for _, target := range []string{"claude-" + sid1 + ":0.0", "claude-" + sid1, "claude-" + sid1 + ":1.2", "claude-" + sid1 + ":"} {
		r, st, _ := rec(t)
		r.TypedTo(target)
		assert.Equal(t, []string{board.TouchTyped}, st.kinds(), target)
	}
	r, st, _ := rec(t)
	for _, target := range []string{"plain-terminal:0.0", ":0.0", "claude-not-a-uuid:0.0"} {
		r.TypedTo(target)
	}
	assert.Empty(t, st.kinds(), "a target that names no session is still ignored")
	terminalinput.SetPersonSink(r.TypedTo)
	t.Cleanup(func() { terminalinput.SetPersonSink(func(string) {}) })
	terminalinput.Record(terminalinput.Person, "claude-"+sid1+":0.0", terminalinput.Text, "typed on tmux")
	assert.Equal(t, []string{board.TouchTyped}, st.kinds(), "through the person path, as the tmux backend calls it")
}

// Security's #11225 SHOULD 2: the typing a route is about to write is recorded as from where the route said (local or a Hub caller); with no word, or an old one, it is the person at this computer's.
func TestTypedTouchesCarryWhereTheRouteSaidTheyCameFrom(t *testing.T) {
	r, st, now := rec(t)
	r.NoteSource(sid1, board.TouchHub)
	r.TypedTo("claude-" + sid1 + ":0.0")
	*now = now.Add(time.Minute)
	r.TypedTo("claude-" + sid1) // the word is a minute old: the person here
	r.Touch(context.Background(), sid1, board.TouchWake, board.TouchHub)
	r.NoteSource(sid1, "not a source")
	*now = now.Add(time.Minute)
	r.TypedTo("claude-" + sid1)
	st.mu.Lock()
	defer st.mu.Unlock()
	var got []string
	for _, x := range st.rows {
		got = append(got, x.Kind+"/"+x.Source)
	}
	assert.Equal(t, []string{"typed/hub", "typed/local", "wake/hub", "typed/local"}, got)
}
