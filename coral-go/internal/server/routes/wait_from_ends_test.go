package routes

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #21704: a "wait --from X" ends when X posts a message that names the waiter, or posts on the waiter's task, with or without --reply-to. A post that is for someone else, on no task of the waiter's, leaves it.
func TestAWaitFromEndsOnAPostThatNamesTheWaiterOrIsOnTheWaitersTask(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		name, body string
		ends       bool
		onOwn      bool // the task_id in the body is the waiter's task (else another member's)
	}{
		{"names the waiter", `{"subscriber_id":"Lead","content":"@Worker go ahead"}`, true, false},
		{"names the waiter and someone else", `{"subscriber_id":"Lead","content":"@Other @Worker go ahead"}`, true, false},
		{"no tag at all", `{"subscriber_id":"Lead","content":"here you go"}`, true, false},
		{"names only someone else", `{"subscriber_id":"Lead","content":"@Other please look"}`, false, false},
		{"on the waiter's task, names only someone else", `{"subscriber_id":"Lead","content":"@Other fyi","task_id":%d}`, true, true},
		{"on a task that is not the waiter's, names only someone else", `{"subscriber_id":"Lead","content":"@Other fyi","task_id":%d}`, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := newWaitRig(t)
			own, err := w.h.bs.CreateTask(ctx, "team", "Worker's task", "", "medium", "Lead", "Worker")
			require.NoError(t, err)
			others, err := w.h.bs.CreateTask(ctx, "team", "Other's task", "", "medium", "Lead", "Other")
			require.NoError(t, err)
			w.wait("Worker", "Lead")
			body := tc.body
			if strings.Contains(body, "%d") {
				id := others.ID
				if tc.onOwn {
					id = own.ID
				}
				body = fmt.Sprintf(body, id)
			}
			require.Equal(t, 200, w.do("POST", "/api/board/team/messages", body, "token:Lead"))
			w.h.WaitBackground()
			assert.Equal(t, !tc.ends, w.parked("Worker"))
		})
	}
}
