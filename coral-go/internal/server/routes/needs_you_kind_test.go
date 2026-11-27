package routes

import (
	"context"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13834: GET /api/needs-you?kind=<kind> lists one kind whole (up to the cap) and leaves the counts true, so a Hub's shell reads the skill rows without paging past newer items.
func TestNeedsYouKindListsOnlyThatKindAndKeepsTheCounts(t *testing.T) {
	h, _ := operatorAsksRig(t)
	old := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).Format(time.RFC3339Nano)
	h.SetNeedsYouSkills(func(context.Context) ([]NeedsYouItem, error) {
		return []NeedsYouItem{{Kind: "skill", From: "Dev", Line: "Dev published skill deploy", Team: "t", ID: "skill:1", At: old}}, nil
	})
	agentReads := 0
	h.SetNeedsYouAgents(func(*http.Request) ([]NeedsYouItem, error) {
		agentReads++
		var out []NeedsYouItem
		for i := 0; i < 25; i++ { // 25 newer agents: the skill is past the default page of 20
			out = append(out, NeedsYouItem{Kind: "agent", Line: "waiting", Team: "t", ID: "agent:" + strconv.Itoa(i), At: time.Date(2026, 6, 1, 0, 0, i, 0, time.UTC).Format(time.RFC3339Nano)})
		}
		return out, nil
	})
	code, all := readNeedsYou(t, h, "", asPerson)
	require.Equal(t, http.StatusOK, code, all)
	for _, it := range needsYouItems(all) {
		assert.NotEqual(t, "skill", it["kind"], "the old skill is past the first page of the whole list")
	}
	code, out := readNeedsYou(t, h, "?kind=skill", asPerson)
	require.Equal(t, http.StatusOK, code, out)
	items := needsYouItems(out)
	require.Len(t, items, 1)
	assert.Equal(t, "skill", items[0]["kind"])
	assert.EqualValues(t, 1, out["count"], "#18623: ?kind=skill reads the skills only: count and counts are what that read holds")
	assert.EqualValues(t, 0, out["counts"].(map[string]any)["agent"])
	assert.EqualValues(t, 1, out["counts"].(map[string]any)["skill"])
	assert.Equal(t, 1, agentReads, "and the agents were not read for it (only the whole list's read above did)")
	for _, bad := range []string{"?kind=SKILL", "?kind=skills", "?kind=%20", "?kind=proposals"} {
		code, _ = readNeedsYou(t, h, bad, asPerson)
		assert.Equal(t, http.StatusBadRequest, code, bad)
	}
	code, out = readNeedsYou(t, h, "?kind=wait", asPerson)
	require.Equal(t, http.StatusOK, code)
	assert.Empty(t, needsYouItems(out), "a kind with nothing waiting is an empty list, with the true count")
}

// #21880: device_key is a kind ?kind= takes, so a page reads the new-browser notices alone.
func TestNeedsYouKindTakesDeviceKey(t *testing.T) {
	h, _ := operatorAsksRig(t)
	h.SetNeedsYouDeviceKeys(func(context.Context) ([]NeedsYouItem, error) {
		return []NeedsYouItem{{Kind: "device_key", Line: "\"Phone\" can now act on this computer as view: ABCD-EFGH-IJKL-MNOP", Team: "", ID: "device_key:k:1", At: time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC).Format(time.RFC3339Nano)}}, nil
	})
	code, out := readNeedsYou(t, h, "?kind=device_key", asPerson)
	require.Equal(t, http.StatusOK, code, out)
	items := needsYouItems(out)
	require.Len(t, items, 1)
	assert.Equal(t, "device_key", items[0]["kind"])
	code, _ = readNeedsYou(t, h, "?kind=device_keys", asPerson)
	assert.Equal(t, http.StatusBadRequest, code)
}
