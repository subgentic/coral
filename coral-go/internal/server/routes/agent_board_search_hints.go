package routes

import (
	"context"
	"net/url"
	"strconv"
	"strings"

	"github.com/subgentic/coral/internal/board"
)

const nearMatchLimit = 5

// searchEmptyHints is what a search that found nothing can still say (#19476): the tasks and goals that hold SOME of the words, best first ("near"), and, for each filter the request set, how many tasks and goals
// the same search finds without it ("without"), so the caller learns which filter left nothing. Both are for tasks and goals only (the work search); messages and chats say nothing more.
func searchEmptyHints(ctx context.Context, bs *board.Store, boardKey string, vals url.Values, since, until string, sources map[string]bool) (near []board.WorkHit, without map[string]int) {
	if !sources["tasks"] && !sources["goals"] {
		return nil, nil
	}
	text := strings.TrimSpace(vals.Get("q"))
	if text == "" {
		return nil, nil
	}
	base := board.WorkQuery{Board: boardKey, Text: text, State: strings.ToLower(strings.TrimSpace(vals.Get("state"))), Assignee: strings.TrimSpace(vals.Get("assignee")), Since: since, Until: until, Limit: 20}
	if sources["tasks"] {
		base.Sources = append(base.Sources, "tasks")
	}
	if sources["goals"] {
		base.Sources = append(base.Sources, "goals")
	}
	if g := strings.TrimSpace(vals.Get("goal")); g != "" {
		if id, err := strconv.ParseInt(strings.TrimPrefix(g, "#"), 10, 64); err == nil && id > 0 {
			base.GoalID = id
		}
	}
	if len(board.SearchTerms(text)) > 1 {
		q := base
		q.Relaxed, q.Limit = true, nearMatchLimit
		if hits, _, err := bs.SearchWork(ctx, q); err == nil {
			near = hits
		}
	}
	without = map[string]int{}
	try := func(name string, mod func(*board.WorkQuery)) {
		q := base
		mod(&q)
		if hits, _, err := bs.SearchWork(ctx, q); err == nil && len(hits) > 0 {
			without[name] = len(hits)
		}
	}
	if base.State != "" {
		try("state", func(q *board.WorkQuery) { q.State = "" })
	}
	if base.GoalID != 0 {
		try("goal", func(q *board.WorkQuery) { q.GoalID = 0 })
	}
	if base.Assignee != "" {
		try("assignee", func(q *board.WorkQuery) { q.Assignee = "" })
	}
	if base.Since != "" {
		try("since", func(q *board.WorkQuery) { q.Since = "" })
	}
	if base.Until != "" {
		try("until", func(q *board.WorkQuery) { q.Until = "" })
	}
	return near, without
}
