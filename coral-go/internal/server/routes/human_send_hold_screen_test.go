package routes

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14357 (Security's INFO on #14345): a person's chat message gets the same last look at the screen that an automated send has. A prompt open on the screen means hold, even when the agent's own
// signals say nothing is open (they can be late, or absent).

const permissionMenuScreen = " Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again\n   3. No\n\n Esc to cancel · Tab to amend\n"

// screenTerm is the rig's terminal with a screen the test sets.
type screenTerm struct {
	*agentTerm
	mu     sync.Mutex
	screen string
	err    error
}

func (s *screenTerm) set(screen string, err error) { s.mu.Lock(); s.screen, s.err = screen, err; s.mu.Unlock() }
func (s *screenTerm) AgentScreen(context.Context, string, string, string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.screen, s.err
}

func screenRig(t *testing.T, withSignals bool, screen string) (*holdRig, *screenTerm) {
	r := newHoldRig(t, withSignals)
	st := &screenTerm{agentTerm: r.term}
	st.set(screen, nil)
	r.h.terminal = st
	return r, st
}

func TestAPersonMessageIsHeldWhileAPromptIsOpenOnTheScreenWhateverTheSignalsSay(t *testing.T) {
	for name, withSignals := range map[string]bool{"signals say idle": true, "no signals at all": false} {
		t.Run(name, func(t *testing.T) {
			r, st := screenRig(t, withSignals, permissionMenuScreen)
			rec := r.send("deploy to staging")
			assert.Equal(t, http.StatusAccepted, rec.Code, rec.Body.String())
			time.Sleep(4 * personHoldSettle.Load())
			assert.Empty(t, r.typed(), "nothing is typed into a prompt that is on the screen")
			st.set("> \n", nil) // the person answered it: no prompt left
			r.waitTyped(1, 3*time.Second)
			assert.Equal(t, []string{"deploy to staging"}, r.typed(), "typed once, after the prompt was gone")
		})
	}
}

func TestAPersonMessageIsTypedAtOnceWhenTheScreenShowsNoPromptOrCannotBeRead(t *testing.T) {
	r, st := screenRig(t, true, "> \n")
	rec := r.send("hello")
	assert.NotEqual(t, http.StatusAccepted, rec.Code, rec.Body.String())
	assert.Equal(t, []string{"hello"}, r.typed(), "no prompt on the screen: as before")
	st.set("", errors.New("no screen"))
	rec = r.send("again")
	assert.NotEqual(t, http.StatusAccepted, rec.Code, rec.Body.String())
	assert.Equal(t, []string{"hello", "again"}, r.typed(), "a screen that cannot be read holds nothing: a person's send goes on unless a prompt is seen")
}

func TestAHeldPersonMessageWaitsAgainWhenAPromptOpensOnTheScreenBeforeItIsTyped(t *testing.T) {
	r, st := screenRig(t, true, "> \n")
	r.box("permission") // held by the signals first
	rec := r.send("deploy")
	require.Equal(t, http.StatusAccepted, rec.Code)
	st.set(permissionMenuScreen, nil) // the signals clear (answered), but another menu is on the screen now
	r.answered()
	time.Sleep(4 * personHoldSettle.Load())
	assert.Empty(t, r.typed(), "the last look at the screen holds it")
	st.set("> \n", nil)
	r.waitTyped(1, 3*time.Second)
	assert.Equal(t, []string{"deploy"}, r.typed())
}
