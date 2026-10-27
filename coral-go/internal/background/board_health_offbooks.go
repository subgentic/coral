package background

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/teamhealth"
)

// Work done off the books (#7793, goal #21 part 3, the operator: "3 should be options in the health monitor settings"): three signals in the orchestrator's check, each
// a switch in the team's health settings, from the board's and the CLI's own records (hook events, posts, uploads), never from the screen:
//   a. an agent in a turn for BusyNoTask.AfterMin minutes with no task in progress (its turn is the occurrence);
//   b. a commit, SHA or patch posted by an agent with no task number in the post and no task in progress when it was posted (the message is the occurrence);
//   c. an artifact uploaded by an agent with no task in progress (noted by the upload route, board.OffBooksUpload: the digest is the occurrence).
// Each is said once: the occurrences are kept in health_offbooks until a check has been delivered with them. The orchestrator itself is left out (it coordinates, it is the one told).

// offBooksPostScan bounds one scan of a board's new messages.
const offBooksPostScan = 200

// maxOffBooksPerCheck is how many off-the-books lines one check says (the oldest first; the rest wait for the next check): the check drops whole lines when it is over its size cap, so a flood
// of occurrences must not push out the items that need the orchestrator.
const maxOffBooksPerCheck = 5

// postGrace is how long after a task is completed a post still counts as made on it.
const postGrace = 2 * time.Minute

var (
	shaTokenRe     = regexp.MustCompile(`\b[0-9a-f]{7,40}\b`)
	taskNumberRe   = regexp.MustCompile(`#\d+`)
	patchWordRe    = regexp.MustCompile(`(?i)\bpatch\b`)
	artifactLinkRe = regexp.MustCompile(`coral://artifacts/[0-9a-f]{64}`)
)

// idWords are the words that name an identifier or a colour, not a commit: the hex after one of them is not a SHA ("Task id abcdef12", "session 7a1b2c3d", "colour a1b2c3d4").
var idWords = map[string]bool{"id": true, "ids": true, "uuid": true, "guid": true, "session": true, "token": true, "key": true, "color": true, "colour": true, "rgb": true, "hex": true, "nonce": true}

// wordBefore is the word that ends just before position at, looking back over spaces and the marks that join a label to its value (: = quotes, brackets).
func wordBefore(s string, at int) string {
	i := at
	for i > 0 && strings.ContainsRune(" \t:=\"'([", rune(s[i-1])) {
		i--
	}
	end := i
	for i > 0 && (s[i-1] >= 'a' && s[i-1] <= 'z') {
		i--
	}
	return s[i:end]
}

// notACommit says a hex run is part of something else: it touches a hyphen (a UUID's parts, "0f3a-9c1e"), follows a "#" (a colour, an issue), or follows an id word.
func notACommit(lower string, loc []int) bool {
	if loc[0] > 0 && (lower[loc[0]-1] == '-' || lower[loc[0]-1] == '#') {
		return true
	}
	if loc[1] < len(lower) && lower[loc[1]] == '-' {
		return true
	}
	return idWords[wordBefore(lower, loc[0])]
}

// commitMention says what a post offers as a commit or a patch: a SHA (7 to 40 hex characters with a digit and a letter among them, not the start of an artifact's sha256, not a part
// of a UUID, a colour, or an id) or the word patch with an artifact link. what is a fixed phrase with the short SHA, never the agent's text.
func commitMention(content string) (what string, ok bool) {
	lower := strings.ToLower(content)
	for _, loc := range shaTokenRe.FindAllStringIndex(lower, -1) {
		tok := lower[loc[0]:loc[1]]
		if !strings.ContainsAny(tok, "0123456789") || strings.Trim(tok, "0123456789") == "" {
			continue // a number, or a word made of a-f (feedface), is not a SHA
		}
		from := loc[0] - 9
		if from < 0 {
			from = 0
		}
		if strings.Contains(lower[from:loc[0]], "sha256") || strings.Contains(lower[from:loc[0]], "sha-256") {
			continue // the start of an artifact's digest, not a commit
		}
		if notACommit(lower, loc) {
			continue
		}
		return "a commit (" + tok[:7] + ")", true
	}
	if patchWordRe.MatchString(content) && artifactLinkRe.MatchString(content) {
		return "a patch", true
	}
	return "", false
}

// offBooksKinds is what the board's settings leave on.
func offBooksKinds(hs board.HealthSettings) map[string]bool {
	return map[string]bool{board.OffBooksBusy: hs.BusyNoTask.On, board.OffBooksPost: hs.PostNoTask.On, board.OffBooksUpload: hs.UploadNoTask.On, board.OffBooksGoalSize: hs.GoalSize.On, board.OffBooksLanding: hs.Landing.On, board.OffBooksRelease: hs.Release.On, board.OffBooksGoalReady: hs.GoalsReady.On, board.OffBooksUnowned: hs.UnownedTasks.On}
}

// offBooksItems notes what happened off the books since the last check and returns the lines for the check: the occurrences not said yet, of the signals that are on. The ids it
// returns are marked as said once the check has gone out (markOffBooksShown).
func (m *BoardHealthMonitor) offBooksItems(ctx context.Context, project, orch string, subs []board.Subscriber, bySession map[string]AgentInfo, tasks []board.Task, now time.Time) []teamhealth.Item {
	hs := m.store.GetHealthSettings(ctx, project)
	inProgress := map[string]bool{}
	for _, t := range tasks {
		if t.AssignedTo != nil && t.Status == "in_progress" {
			inProgress[*t.AssignedTo] = true
		}
	}
	if hs.BusyNoTask.On {
		m.noteBusyNoTask(ctx, project, orch, subs, bySession, inProgress, time.Duration(hs.BusyNoTask.AfterMin)*time.Minute, now)
	}
	m.scanOffBooksPosts(ctx, project, orch, subs, hs.PostNoTask.On, now)
	if hs.GoalSize.On {
		m.noteGoalSizes(ctx, project, hs.GoalSize.Limit, now)
	}
	if hs.Landing.On && m.landing != nil {
		for _, detail := range m.landing.note(ctx, project, hs.Landing, now) {
			m.nudgeMember(ctx, project, orch, hs, hs.Landing.Nudge, "landing-alert:", detail, bySession, subs)
		}
	}
	if hs.Release.On && m.landing != nil {
		for _, detail := range m.landing.noteRelease(ctx, project, hs.Release, now) {
			m.nudgeMember(ctx, project, orch, hs, hs.Release.Nudge, "release-alert:", detail, bySession, subs)
		}
	}
	if hs.GoalsReady.On {
		m.noteGoalsReady(ctx, project, orch, hs, bySession, subs, now)
	}
	if hs.UnownedTasks.On {
		m.noteUnownedTasks(ctx, project, orch, hs, bySession, subs, now)
	}
	pending, err := m.store.PendingOffBooks(ctx, project, now, offBooksKinds(hs))
	if err != nil {
		return nil
	}
	if len(pending) > maxOffBooksPerCheck {
		pending = pending[:maxOffBooksPerCheck]
	}
	items := make([]teamhealth.Item, 0, len(pending))
	var ids []offBooksShown
	var dropped []int64
	for _, p := range pending {
		if p.Kind == board.OffBooksBusy && m.subscriberBlocked(ctx, subs, bySession, p.Agent) { // noted before the limit was seen: it is not working now
			dropped = append(dropped, p.ID)
			continue
		}
		if boardOwnLine(p.Kind) { // a line about the board's own goal, branch, release or tasks: no agent, and what to do is in it
			items = append(items, teamhealth.Item{Rank: 3, Agent: "Board", Problem: p.Detail})
			ids = append(ids, offBooksShown{id: p.ID, needle: "Board: " + p.Detail})
			continue
		}
		at, _ := time.Parse("2006-01-02T15:04:05.000Z", p.At)
		items = append(items, teamhealth.Item{Rank: 2, Agent: teamhealth.Name(p.Agent), Problem: p.Detail,
			Evidence: "Seen " + teamhealth.Age(now.Sub(at)) + " ago, off the board's tasks", Suggest: "ask what it is for, or put it on a task"})
		ids = append(ids, offBooksShown{id: p.ID, needle: teamhealth.Name(p.Agent) + ": " + p.Detail})
	}
	if len(dropped) > 0 {
		_ = m.store.MarkOffBooksShown(ctx, project, dropped, now) // said to no one, and not said later
	}
	m.mu.Lock()
	if m.offShown == nil {
		m.offShown = map[string][]offBooksShown{}
	}
	m.offShown[project] = ids
	m.mu.Unlock()
	return items
}

// subscriberBlocked says whether the member's live agent is stopped by a usage limit.
func (m *BoardHealthMonitor) subscriberBlocked(ctx context.Context, subs []board.Subscriber, bySession map[string]AgentInfo, subscriberID string) bool {
	for _, sub := range subs {
		if !board.SameIdentity(sub.SubscriberID, subscriberID) {
			continue
		}
		if a, live := bySession[sub.SessionName]; live {
			_, blocked := m.blockedByLimit(ctx, a)
			return blocked
		}
	}
	return false
}

// offBooksShown is an occurrence a check was composed with, and the words that show it in the check's text.
type offBooksShown struct {
	id     int64
	needle string
}

// markOffBooksShown records that the check just delivered said what offBooksItems returned for the board: it is not said again. A line the check's size cap left out ("N more not
// shown") is not in the text and stays for the next check.
func (m *BoardHealthMonitor) markOffBooksShown(ctx context.Context, project, text string, now time.Time) {
	m.mu.Lock()
	composed := m.offShown[project]
	delete(m.offShown, project)
	m.mu.Unlock()
	var ids []int64
	for _, c := range composed {
		if strings.Contains(text, c.needle) {
			ids = append(ids, c.id)
		}
	}
	if len(ids) > 0 {
		_ = m.store.MarkOffBooksShown(ctx, project, ids, now)
	}
}

// noteBusyNoTask (a): an agent in a turn, by its hook events, for at least after, with no task in progress. The turn's start is the occurrence, so a long turn is said once.
func (m *BoardHealthMonitor) noteBusyNoTask(ctx context.Context, project, orch string, subs []board.Subscriber, bySession map[string]AgentInfo, inProgress map[string]bool, after time.Duration, now time.Time) {
	for _, sub := range subs {
		a, live := bySession[sub.SessionName]
		if !live || board.SameIdentity(sub.SubscriberID, orch) || inProgress[sub.SubscriberID] {
			continue
		}
		sig, known := m.signal(ctx, a.SessionID)
		if !known || !sig.InTurn || sig.Since.IsZero() || now.Sub(sig.Since) < after {
			continue
		}
		if _, blocked := m.blockedByLimit(ctx, a); blocked {
			continue // its turn was cut short by a usage limit: it is not working, the check says it is blocked (#9361)
		}
		detail := fmt.Sprintf("has been working for %s with no task in progress", teamhealth.Age(now.Sub(sig.Since)))
		_ = m.store.AddOffBooks(ctx, project, board.OffBooksBusy, sub.SubscriberID, sub.SubscriberID+"|"+sig.Since.UTC().Format(time.RFC3339), detail, now)
	}
}

// scanOffBooksPosts (b): the board's messages since the last scan (the first scan only marks where the board is: nothing before it is judged). A post by a member other than the
// orchestrator, not Coral's, not a reply to a task, with no task number in it, that offers a commit or a patch, and whose author had no task in progress when it was posted.
func (m *BoardHealthMonitor) scanOffBooksPosts(ctx context.Context, project, orch string, subs []board.Subscriber, on bool, now time.Time) {
	cursor, known := m.store.OffBooksPostCursor(ctx, project)
	if !known {
		if latest, err := m.store.LatestMessageID(ctx, project); err == nil {
			_ = m.store.SetOffBooksPostCursor(ctx, project, latest)
		}
		return
	}
	msgs, err := m.store.ListMessagesAfter(ctx, project, cursor, offBooksPostScan)
	if err != nil || len(msgs) == 0 {
		return
	}
	member := map[string]bool{}
	for _, s := range subs {
		member[s.SubscriberID] = true
	}
	last := cursor
	for _, msg := range msgs {
		last = msg.ID
		if !on || msg.IsSystem || msg.Origin != nil || msg.TaskID != nil || !member[msg.SubscriberID] || board.SameIdentity(msg.SubscriberID, orch) || board.IsOperatorName(msg.SubscriberID) {
			continue
		}
		if taskNumberRe.MatchString(msg.Content) {
			continue
		}
		what, ok := commitMention(msg.Content)
		if !ok {
			continue
		}
		at, err := time.Parse(time.RFC3339, msg.CreatedAt)
		if err != nil {
			at = now
		}
		if had, err := m.store.HadTaskInProgress(ctx, project, msg.SubscriberID, at, postGrace); err != nil || had {
			continue
		}
		_ = m.store.AddOffBooks(ctx, project, board.OffBooksPost, msg.SubscriberID, strconv.FormatInt(msg.ID, 10), "posted "+what+" with no task number and no task in progress", at)
	}
	_ = m.store.SetOffBooksPostCursor(ctx, project, last)
}

// noteGoalSizes (#7808, goal #21 part 6): a goal that is not closed and has more than limit tasks, open and done together (a goal that has grown that big is the thing to split, and what is
// done is what to close), is a line of the check once per crossing and again at each further limit. Goals that are done or dropped are not counted. The line is numbers only: never the goal's title.
func (m *BoardHealthMonitor) noteGoalSizes(ctx context.Context, project string, limit int, now time.Time) {
	sizes, err := m.store.OpenGoalSizes(ctx, project)
	if err != nil {
		return
	}
	crossed, err := m.store.NoteGoalSizes(ctx, project, sizes, limit)
	if err != nil {
		return
	}
	for _, g := range crossed {
		detail := fmt.Sprintf("Goal #%d has %d tasks (limit %d): consider splitting it or closing what is done", g.ID, g.Total, limit)
		_ = m.store.AddOffBooks(ctx, project, board.OffBooksGoalSize, "Board", fmt.Sprintf("%d|%d|%d", g.ID, g.Total/limit, now.UnixNano()), detail, now)
	}
}

// boardOwnLine says an off-the-books kind is a line about the board itself (a goal, the branch, tasks by number) and not about an agent.
func boardOwnLine(kind string) bool {
	switch kind {
	case board.OffBooksGoalSize, board.OffBooksLanding, board.OffBooksRelease, board.OffBooksGoalReady, board.OffBooksUnowned:
		return true
	}
	return false
}

// nudgeMember tells who (a member the team named for a check; not the one the check goes to: they have the line) the line, once, through the gate, in one line. key names the check for the gate.
func (m *BoardHealthMonitor) nudgeMember(ctx context.Context, project, orch string, hs board.HealthSettings, who, key, detail string, bySession map[string]AgentInfo, subs []board.Subscriber) {
	rcpt := orch
	if hs.Recipient != "" {
		rcpt = hs.Recipient
	}
	if who == "" || board.SameIdentity(who, rcpt) {
		return
	}
	for _, s := range subs {
		if board.SameIdentity(s.SubscriberID, who) {
			if a, live := bySession[s.SessionName]; live {
				if err := sendUnlessBlocked(ctx, m.limit, m.deliver, a, key+project, "[Coral health] "+detail); err != nil {
					m.logger.Warn("health check delivery failed", "check", key, "project", project, "error", err)
				}
			}
			return
		}
	}
}
