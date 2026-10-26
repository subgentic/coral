package background

import (
	"context"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/ptymanager"
	"testing"
)

func TestBoardNudge8031SkippedDialogRetriesOnceWithoutNewMessage(t *testing.T) {
	for kind, screen := range map[string]string{"dialog": menuScreen, "draft": "› the person is composing a reply\n", "unreadable": ""} {
		t.Run(kind, func(t *testing.T) {
			n, bs, rt, name := staleSetup(t)
			ctx := context.Background()
			rt.setScreen(screen)
			require.NoError(t, n.RunOnce(ctx))
			require.Empty(t, rt.typed(), "an automated nudge must not answer the dialog")
			skip, ok := ptymanager.SkippedOf(name)
			require.True(t, ok)
			require.Equal(t, "board nudge", skip.What)
			n.notifiedMu.Lock()
			_, recorded := n.notified[name]
			n.notifiedMu.Unlock()
			require.False(t, recorded, "nothing typed must not consume the unread-batch notification")
			// No new board message and no reminder-window advance: the next pass must retry.
			rt.setScreen("working on the approved command\n")
			require.NoError(t, n.RunOnce(ctx))
			require.Len(t, rt.typed(), 1)
			require.Contains(t, rt.typed()[0], "1 unread message")
			require.NoError(t, n.RunOnce(ctx))
			require.Len(t, rt.typed(), 1, "successful delivery is recorded and deduplicated")
			unread, err := bs.CheckUnread(ctx, "board-X", "Worker")
			require.NoError(t, err)
			require.Equal(t, 1, unread, "delivery never marks board content read")
		})
	}
}

func TestBoardNudge8031ReadWhileSkippedIsNotDeliveredLater(t *testing.T) {
	n, bs, rt, _ := staleSetup(t)
	ctx := context.Background()
	rt.setScreen(menuScreen)
	require.NoError(t, n.RunOnce(ctx))
	require.Empty(t, rt.typed())
	_, err := bs.ReadMessages(ctx, "board-X", "Worker", 50)
	require.NoError(t, err)
	rt.setScreen("working\n")
	require.NoError(t, n.RunOnce(ctx))
	require.Empty(t, rt.typed(), "a retry recounts unread instead of replaying stored text")
}
