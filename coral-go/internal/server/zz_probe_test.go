package server

import (
	"context"
	"encoding/json"
	"testing"
)

func TestZZProbe(t *testing.T) {
	r, enrolled, hubOf, _ := askWorld(t)
	h := r.srv.Router()
	bs := r.srv.boardStore
	bs.Subscribe(context.Background(), "team", "Operator", "Operator", "", nil, "all")
	q, _ := bs.PostMessage(context.Background(), "team", "Lead", "@Operator q?", nil)
	to, _ := bs.AskTargets(context.Background(), "team", "Lead", q.Content)
	bs.RecordAsk(context.Background(), "team", q, to)
	for _, l := range []string{enrolled, askAdded} {
		for _, rt := range []int64{0, q.ID} {
			b, _ := json.Marshal(map[string]any{"subscriber_id": "Operator", "content": "x", "reply_to": rt})
			rec := call(h, "POST", "/api/board/team/messages", string(b), hubOf(l))
			t.Logf("PROBE %s reply_to=%d -> %d %s", l, rt, rec.Code, rec.Body.String())
		}
	}
}
