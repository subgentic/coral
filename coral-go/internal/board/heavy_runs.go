package board

import (
	"context"
	"regexp"
	"sort"
	"strings"
	"time"
)

// The board's HEAVY RUN START / END posts are the record of how heavy runs shared a machine before the resource queue (#13671): the team posted them by hand from 2026-10-30. They are free text, so this
// reads them with a few plain rules (below) and keeps only who, which machine and when; the text itself never leaves this file.

// HeavyPost is one post reduced to what the baseline reads.
type HeavyPost struct {
	Who  string
	Text string
	At   time.Time
}

// HeavyRun is one heavy run as its posts tell it.
type HeavyRun struct {
	Who      string
	Machine  string // "mini" when the start post says mini, else "Mac"
	Start    time.Time
	End      time.Time
	Unclosed bool // no END post: End is Start plus UnclosedRunCap (or now, if sooner)
}

// UnclosedRunCap is how long a run with no END post is taken to have lasted.
const UnclosedRunCap = 3 * time.Hour

// SlotWaitCap is the longest gap from a slot-request post to the same poster's next START that counts as one wait.
const SlotWaitCap = 2 * time.Hour

// SlotRequestPhrases are the words that make a post a request for a machine slot (lower case, matched anywhere in the post): the posts the queue is meant to make unnecessary.
var SlotRequestPhrases = []string{
	"waiting for the orchestrator", "need the next isolated", "need the mac", "need the mini", "need a heavy run", "need the next slot",
	"slot request", "waiting for your call", "call me for the mac", "call me for the mini", "may i run",
}

var heavyWordsRe = regexp.MustCompile(`(?i)heavy run (start|end)`)
var miniRe = regexp.MustCompile(`(?i)\bmini\b`)
var macMiniRe = regexp.MustCompile(`(?i)mac mini`)

// heavyKind is "start", "end" or "" for a post: the words must not be quoted (a rule that tells people what to post) nor a pair written as START/END or a template with <what>.
func heavyKind(text string) string {
	for _, m := range heavyWordsRe.FindAllStringSubmatchIndex(text, -1) {
		if m[0] > 0 && strings.ContainsRune("'\"`", rune(text[m[0]-1])) {
			continue
		}
		if m[1] < len(text) && (text[m[1]] == '/' || text[m[1]] == '<') {
			continue
		}
		return strings.ToLower(text[m[2]:m[3]])
	}
	return ""
}

func machineOf(text string) string {
	if miniRe.MatchString(text) && !macMiniRe.MatchString(text) {
		return "mini"
	}
	return "Mac"
}

// HeavyRuns pairs each START with its poster's next END. now cuts a run still open.
func HeavyRuns(posts []HeavyPost, now time.Time) []HeavyRun {
	sorted := append([]HeavyPost(nil), posts...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].At.Before(sorted[j].At) })
	var runs []HeavyRun
	open := map[string]int{} // who -> index in runs of the run still open
	cut := func(i int, limit time.Time) {
		r := &runs[i]
		r.Unclosed = true
		r.End = r.Start.Add(UnclosedRunCap)
		if limit.Before(r.End) {
			r.End = limit
		}
	}
	for _, p := range sorted {
		switch heavyKind(p.Text) {
		case "start":
			if i, ok := open[p.Who]; ok {
				cut(i, p.At)
			}
			runs = append(runs, HeavyRun{Who: p.Who, Machine: machineOf(p.Text), Start: p.At})
			open[p.Who] = len(runs) - 1
		case "end":
			if i, ok := open[p.Who]; ok {
				runs[i].End = p.At
				delete(open, p.Who)
			}
		}
	}
	for _, i := range open {
		cut(i, now)
	}
	return runs
}

// OverlapMinutes is, by UTC day and machine, the minutes in which two or more runs were on the machine at once.
func OverlapMinutes(runs []HeavyRun) map[string]map[string]int {
	out := map[string]map[string]int{}
	type edge struct {
		at time.Time
		d  int
	}
	by := map[string][]edge{}
	for _, r := range runs {
		if !r.End.After(r.Start) {
			continue
		}
		by[r.Machine] = append(by[r.Machine], edge{r.Start, 1}, edge{r.End, -1})
	}
	for machine, es := range by {
		sort.Slice(es, func(i, j int) bool {
			if !es[i].at.Equal(es[j].at) {
				return es[i].at.Before(es[j].at)
			}
			return es[i].d < es[j].d // an end before a start at the same instant
		})
		depth := 0
		for i := 0; i < len(es)-1; i++ {
			depth += es[i].d
			if depth < 2 {
				continue
			}
			for t := es[i].at; t.Before(es[i+1].at); {
				next := t.UTC().Truncate(24 * time.Hour).Add(24 * time.Hour)
				if next.After(es[i+1].at) {
					next = es[i+1].at
				}
				day := t.UTC().Format("2006-01-02")
				if out[day] == nil {
					out[day] = map[string]int{}
				}
				out[day][machine] += int(next.Sub(t).Round(time.Minute) / time.Minute)
				t = next
			}
		}
	}
	return out
}

func isSlotRequest(text string) bool {
	l := strings.ToLower(text)
	for _, p := range SlotRequestPhrases {
		if strings.Contains(l, p) {
			return true
		}
	}
	return false
}

// SlotRequestPosts counts, by UTC day, the posts that ask for a machine slot.
func SlotRequestPosts(posts []HeavyPost) map[string]int {
	out := map[string]int{}
	for _, p := range posts {
		if heavyKind(p.Text) == "" && isSlotRequest(p.Text) {
			out[p.At.UTC().Format("2006-01-02")]++
		}
	}
	return out
}

// SlotWait is the time from a slot request to the poster's next run starting.
type SlotWait struct {
	Day  string
	Wait time.Duration
}

// SlotWaits pairs each slot-request post with its poster's next run start within SlotWaitCap (an estimate: nobody says "I am waiting" in the same words every time). One start answers one sample, the earliest request.
func SlotWaits(posts []HeavyPost, runs []HeavyRun) []SlotWait {
	sorted := append([]HeavyPost(nil), posts...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].At.Before(sorted[j].At) })
	used := map[string]bool{}
	var out []SlotWait
	for _, p := range sorted {
		if heavyKind(p.Text) != "" || !isSlotRequest(p.Text) {
			continue
		}
		var best *HeavyRun
		for i := range runs {
			r := &runs[i]
			if r.Who == p.Who && !r.Start.Before(p.At) && r.Start.Sub(p.At) <= SlotWaitCap && (best == nil || r.Start.Before(best.Start)) {
				best = r
			}
		}
		if best == nil {
			continue
		}
		k := best.Who + "|" + best.Start.String()
		if used[k] {
			continue
		}
		used[k] = true
		out = append(out, SlotWait{Day: p.At.UTC().Format("2006-01-02"), Wait: best.Start.Sub(p.At)})
	}
	return out
}

// HeavyPosts reads the posts of [since, until) that the baseline cares about (a HEAVY RUN post or a slot request), of team or of every team when it is "". Coral's own posts are left out. Only the poster's name, the text and
// the time come back, for the functions above to reduce to numbers; the route never sends any of it.
func (s *Store) HeavyPosts(ctx context.Context, team string, since, until time.Time) ([]HeavyPost, error) {
	like := []string{"lower(m.content) LIKE '%heavy run%'"}
	args := []any{}
	for _, p := range SlotRequestPhrases {
		like = append(like, "lower(m.content) LIKE ?")
		args = append(args, "%"+p+"%")
	}
	q := `SELECT COALESCE(s.job_title, m.subscriber_id, 'Unknown') AS who, m.content AS text, m.created_at AS at FROM board_messages m
		LEFT JOIN board_subscribers s ON m.project = s.project AND m.subscriber_id = s.subscriber_id
		WHERE m.is_system = 0 AND m.created_at >= ? AND m.created_at < ? AND (` + strings.Join(like, " OR ") + `)`
	full := append([]any{since.UTC().Format(activityTimeFormat), until.UTC().Format(activityTimeFormat)}, args...)
	if team != "" {
		q += ` AND m.project = ?`
		full = append(full, team)
	}
	q += ` ORDER BY m.created_at`
	var rows []struct {
		Who, Text, At string
	}
	if err := s.reader().SelectContext(ctx, &rows, q, full...); err != nil {
		return nil, err
	}
	out := make([]HeavyPost, 0, len(rows))
	for _, r := range rows {
		t, err := time.Parse(time.RFC3339Nano, r.At)
		if err != nil {
			continue
		}
		out = append(out, HeavyPost{Who: r.Who, Text: r.Text, At: t.UTC()})
	}
	return out, nil
}
