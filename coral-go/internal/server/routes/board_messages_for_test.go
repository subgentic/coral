package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"testing"

	"github.com/stretchr/testify/require"
)

// ?for_subscriber= on the board's message list holds what that member's read would deliver plus its own posts (#8484): the ids are a peek's joined with the member's own, a member and the orchestrator, a bare array or the dashboard's
// page, and its pages by id are slices of the same set. The selection itself is pinned in internal/board (TestTheDocksListIsWhatReadDelivers).
func TestListAllMessagesForASubscriberIsWhatReadDelivers(t *testing.T) {
	server, handler := setupBoardTestServer(t)
	ctx := context.Background()
	for name, spec := range map[string][2]string{"Worker": {"Backend", "all"}, "Lead": {"Orchestrator", "all"}, "Poster": {"Developer", "all"}} {
		_, err := handler.bs.Subscribe(ctx, "forsub", name, spec[0], "", nil, spec[1])
		require.NoError(t, err)
	}
	for i := 0; i < 8; i++ {
		for _, text := range []string{fmt.Sprintf("untagged %d", i), fmt.Sprintf("@Worker task %d", i), fmt.Sprintf("@all hello %d", i)} {
			_, err := handler.bs.PostMessage(ctx, "forsub", "Poster", text, nil)
			require.NoError(t, err)
		}
	}
	_, err := handler.bs.PostMessage(ctx, "forsub", "Worker", "@Poster my reply", nil)
	require.NoError(t, err)
	base := server.URL + "/api/board/forsub/messages/all"

	for _, who := range []string{"Worker", "Lead", "Poster"} {
		peek, err := handler.bs.PeekMessages(ctx, "forsub", who, 500)
		require.NoError(t, err)
		set := map[int64]bool{}
		for _, m := range peek {
			set[m.ID] = true
		}
		everything, err := handler.bs.ListMessages(ctx, "forsub", 500, 0, 0)
		require.NoError(t, err)
		for _, m := range everything {
			if m.SubscriberID == who {
				set[m.ID] = true
			}
		}
		var want []int64
		for _, m := range everything { // in id order
			if set[m.ID] {
				want = append(want, m.ID)
			}
		}
		require.NotEmpty(t, want, who)

		page := getDashboardPage(t, base+"?format=dashboard&limit=500&for_subscriber="+url.QueryEscape(who))
		require.Equal(t, want, page.ids(), who+": the dashboard's list is a peek's set and the member's own posts")
		require.Equal(t, len(want), page.Total, who)
		require.Equal(t, 25, page.BoardTotal, who+": the whole board's count comes beside it")
		require.Equal(t, "keyset", page.Paging)
		require.Equal(t, 0, *page.BeforeCount)

		resp, err := http.Get(base + "?limit=500&for_subscriber=" + url.QueryEscape(who))
		require.NoError(t, err)
		var bare []struct {
			ID int64 `json:"id"`
		}
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&bare))
		resp.Body.Close()
		var bareIDs []int64
		for _, m := range bare {
			bareIDs = append(bareIDs, m.ID)
		}
		require.Equal(t, want, bareIDs, who+": and so is the bare array")

		if len(want) >= 6 {
			latest := getDashboardPage(t, base+"?format=dashboard&limit=3&for_subscriber="+who)
			require.Equal(t, want[len(want)-3:], latest.ids())
			require.Equal(t, len(want)-3, *latest.BeforeCount)
			earlier := getDashboardPage(t, base+fmt.Sprintf("?format=dashboard&limit=3&for_subscriber=%s&before_id=%d", who, latest.ids()[0]))
			require.Equal(t, want[len(want)-6:len(want)-3], earlier.ids())
			newer := getDashboardPage(t, base+fmt.Sprintf("?format=dashboard&limit=3&for_subscriber=%s&after_id=%d", who, want[len(want)-6]))
			require.Equal(t, want[len(want)-5:len(want)-2], newer.ids())
		}
	}

	// the whole board is unchanged without the parameter, and a name is required with it
	whole := getDashboardPage(t, base+"?format=dashboard&limit=500")
	require.Equal(t, 25, whole.Total)
	resp, err := http.Get(base + "?for_subscriber=")
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, http.StatusBadRequest, resp.StatusCode)
}
