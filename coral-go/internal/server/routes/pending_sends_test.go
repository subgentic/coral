package routes

import (
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #10467: the live row lists a person's messages typed into the agent in the last 90 seconds (pending_sends), so a second screen can show a message its transcript does not have yet.
func TestPendingSendsAreListedBrieflyAndBounded(t *testing.T) {
	h := &SessionsHandler{}
	assert.Nil(t, h.pendingSendsOf("s1"), "nothing typed: a null")
	h.sends.note("s1", "first")
	h.sends.note("s1", strings.Repeat("é", 1500))
	h.sends.note("s2", "another agent's")
	list, _ := h.pendingSendsOf("s1").([]map[string]any)
	require.Len(t, list, 2)
	assert.Equal(t, "first", list[0]["text"], "oldest first")
	assert.Equal(t, strings.Repeat("é", pendingSendsRunes), list[1]["text"], "a long message is cut to its first words")
	assert.NotEqual(t, list[0]["id"], list[1]["id"])
	_, err := time.Parse(time.RFC3339Nano, list[0]["at"].(string))
	assert.NoError(t, err)

	for i := 0; i < 8; i++ {
		h.sends.note("s1", "m")
	}
	list, _ = h.pendingSendsOf("s1").([]map[string]any)
	assert.Len(t, list, pendingSendsMax, "at most five per agent")

	h.sends.mu.Lock()
	for i := range h.sends.m["s2"] {
		h.sends.m["s2"][i].at = time.Now().Add(-pendingSendsFor - time.Second)
	}
	h.sends.mu.Unlock()
	assert.Nil(t, h.pendingSendsOf("s2"), "a message older than the list's life is not offered")
	h.sends.note("s3", "x")
	h.sends.mu.Lock()
	_, kept := h.sends.m["s2"]
	h.sends.mu.Unlock()
	assert.False(t, kept, "a new message drops the expired ones of every agent")
	h.sends.note("", "ignored")
	h.sends.note("s4", "")
	assert.Nil(t, h.pendingSendsOf("s4"))
}

// #10467: a message a person sends is on the agent's row once it is typed, whether it was typed at once or held behind a box and released; one that is only held, or refused, is not.
func TestAPersonsSendIsOnTheRowOnceTyped(t *testing.T) {
	r := newHoldRig(t, true)
	assert.Nil(t, r.h.pendingSendsOf(r.sid))
	rec := r.send("hello there")
	require.Equal(t, 200, rec.Code, rec.Body.String())
	list, _ := r.h.pendingSendsOf(r.sid).([]map[string]any)
	require.Len(t, list, 1)
	assert.Equal(t, "hello there", list[0]["text"])

	r.box("permission")
	rec = r.send("deploy to staging")
	require.Equal(t, 202, rec.Code, rec.Body.String())
	list, _ = r.h.pendingSendsOf(r.sid).([]map[string]any)
	assert.Len(t, list, 1, "a message that is only held is the queue's, not a sent one")
	r.answered()
	r.waitTyped(2, 3*time.Second)
	require.Eventually(t, func() bool { l, _ := r.h.pendingSendsOf(r.sid).([]map[string]any); return len(l) == 2 }, 3*time.Second, 20*time.Millisecond, "typed after the box: listed")
}
