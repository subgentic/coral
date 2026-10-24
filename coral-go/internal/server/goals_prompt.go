package server

import (
	"context"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/subgentic/coral/internal/board"
)

// boardGoalsPromptBlock is the source of the board system prompt's goals block (#7296): an agent starts already subscribed and never runs join, so the goals reach it here. The board's open goals (up to five,
// oldest first) with what makes each one done, a blocked one with what it is blocked on, and one line on how a task joins a goal; "" when the board has no open goal or cannot be read (a launch never waits on it).
func boardGoalsPromptBlock(bs *board.Store) func(boardName string) string {
	return func(boardName string) string {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		goals, err := bs.ListGoals(ctx, boardName, board.GoalListQuery{Limit: 6})
		if err != nil || len(goals) == 0 {
			return ""
		}
		cut := func(s string, n int) string {
			if utf8.RuneCountInString(s) > n {
				return string([]rune(s)[:n]) + "…"
			}
			return s
		}
		var b strings.Builder
		b.WriteString("This board's open goals (what the team is working toward):\n")
		for i, g := range goals {
			if i == 5 {
				b.WriteString("  ... and more: coral-board goal list\n")
				break
			}
			fmt.Fprintf(&b, "  #%d %s", g.ID, cut(g.Title, 80))
			switch {
			case g.State == board.GoalBlocked && g.BlockedOn != "":
				fmt.Fprintf(&b, " (blocked on %s)", cut(g.BlockedOn, 60))
			case g.State != board.GoalActive:
				fmt.Fprintf(&b, " (%s)", g.State)
			}
			if g.DoneWhen != "" {
				fmt.Fprintf(&b, " — done when: %s", cut(g.DoneWhen, 100))
			}
			b.WriteString("\n")
		}
		b.WriteString("A task that serves one joins it: coral-board task add \"title\" --goal <id> (or coral-board task goal <task> <goal>).")
		return b.String()
	}
}
