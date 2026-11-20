package routes

import (
	"context"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/clitext"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// What the Operator did that an agent has not acted on yet (#19916), for the Inbox's "Waiting on an agent" tab (#19904):
//
//	GET /api/waiting-on-agent -> {items: [{kind: "answered_ask"|"comment_sent", id, board, agent: {name, role, session_id}, since, title, operator_words, goal, task, artifact, thread_id}]}
//
// answered_ask: a question an agent put to the Operator, which the Operator answered with a reply, until its asker posts anything on that board (or the question is closed). comment_sent: a comment of the Operator's on a
// file that was sent to one agent (the comment's ask, automatic or Send to agent), until an agent replies in its thread, the file gets a new version, or the comment is resolved or deleted. Oldest first, at most 100.
// Like GET /api/activity it is this computer's and the Operator's alone (operatorOnlyRead), and read only: no new write route. The agent's state is not here: the dashboard reads it from the live list.

const (
	waitingOnAgentMax   = 100
	waitingWordsMax     = 280 // characters of the Operator's words
	waitingTitleMax     = 200
	waitingCommentsSpan = 7 * 24 * time.Hour // as an unanswered question: older ones are left alone
)

type waitingAgent struct {
	Name      string `json:"name"`
	Role      string `json:"role"`
	SessionID string `json:"session_id"`
}

type waitingRef struct {
	ID    int64  `json:"id"`
	Title string `json:"title"`
}

type waitingArtifact struct {
	Hex     string `json:"hex"`
	Name    string `json:"name"`
	Version int    `json:"version"`
}

type waitingItem struct {
	Kind          string           `json:"kind"`
	ID            string           `json:"id"`
	Board         string           `json:"board"`
	Agent         waitingAgent     `json:"agent"`
	Since         string           `json:"since"`
	Title         string           `json:"title"`
	OperatorWords string           `json:"operator_words"`
	Goal          *waitingRef      `json:"goal"`
	Task          *waitingRef      `json:"task"`
	Artifact      *waitingArtifact `json:"artifact"`
	ThreadID      *int64           `json:"thread_id"`
	at            time.Time
}

// waitingCand is one candidate row before its lookups: the answer (1-based index into the answers) or the comment (1-based index into the comments), and when the Operator acted.
type waitingCand struct {
	at      time.Time
	answer  int
	comment int
}

// SetWaitingComments gives the board the Operator's comments that wait on an agent (SetWaitingComments, #19916). Nil: none.
func (h *BoardHandler) SetWaitingComments(fn func(ctx context.Context) ([]store.WaitingComment, error)) {
	h.waitingComments = fn
}

// cutWords cleans s and cuts it to max characters (not bytes), adding an ellipsis when it cut.
func cutWords(s string, max int) string {
	s = strings.TrimSpace(clitext.Clean(s))
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	r := []rune(s)
	return strings.TrimSpace(string(r[:max-1])) + "…"
}

// firstLine is the first non-empty line of s, cleaned and cut.
func firstLine(s string, max int) string {
	for _, l := range strings.Split(clitext.Clean(s), "\n") {
		if l = strings.TrimSpace(l); l != "" {
			return cutWords(l, max)
		}
	}
	return ""
}

// WaitingOnAgent answers GET /api/waiting-on-agent.
func (h *BoardHandler) WaitingOnAgent(w http.ResponseWriter, r *http.Request) {
	if !operatorOnlyRead(w, r) {
		return
	}
	ctx := r.Context()
	now := time.Now().UTC()
	items := []waitingItem{}
	subsOf := map[string]map[string]board.Subscriber{} // board -> lower-case member id -> subscription
	subscribers := func(project string) map[string]board.Subscriber {
		if m, ok := subsOf[project]; ok {
			return m
		}
		m := map[string]board.Subscriber{}
		if subs, err := h.bs.ListSubscribers(ctx, project); err == nil {
			for _, s := range subs {
				m[strings.ToLower(s.SubscriberID)] = s
			}
		}
		subsOf[project] = m
		return m
	}
	agentOf := func(project, name string) waitingAgent {
		a := waitingAgent{Name: clitext.CleanName(name)}
		if s, ok := subscribers(project)[strings.ToLower(name)]; ok {
			a.Role = clitext.CleanName(s.JobTitle)
			if s.IsActive != 0 {
				a.SessionID = naming.SessionIDFromName(s.SessionName)
			}
		}
		return a
	}
	// The candidates first, with no lookup per item: each board reads at most the cap of its oldest answers, the comments are read as one list, and only the oldest waitingOnAgentMax of them all are then
	// decorated (#19923), so the cost does not grow with the questions and comments a long-used Coral holds.
	type answeredCand struct {
		project string
		a       board.AnsweredAsk
	}
	projects, err := h.bs.ListProjects(ctx)
	if err != nil {
		errInternalServer(w, "could not read the boards")
		return
	}
	var cands []waitingCand
	var answers []answeredCand
	for _, p := range projects {
		got, err := h.bs.AnsweredAsksOf(ctx, p.Project, board.OperatorName, now, waitingOnAgentMax)
		if err != nil {
			continue
		}
		for _, a := range got {
			answers = append(answers, answeredCand{p.Project, a})
			cands = append(cands, waitingCand{at: a.AnsweredAt, answer: len(answers)})
		}
	}
	var comments []store.WaitingComment
	if h.waitingComments != nil {
		if comments, err = h.waitingComments(ctx); err != nil {
			errInternalServer(w, "could not read the comments")
			return
		}
		for i, c := range comments {
			cands = append(cands, waitingCand{at: c.Since, comment: i + 1})
		}
	}
	sort.SliceStable(cands, func(i, j int) bool { return cands[i].at.Before(cands[j].at) })
	if len(cands) > waitingOnAgentMax {
		cands = cands[:waitingOnAgentMax]
	}
	subjectsOf := map[string]map[int64]board.AskSubject{}
	linksOf := map[string]*askSubjectLinks{}
	files := map[string]map[string]teamArtifact{} // board -> store id -> file, read once per board that has a comment
	for _, cd := range cands {
		if cd.answer > 0 {
			p, a := answers[cd.answer-1].project, answers[cd.answer-1].a
			if _, ok := linksOf[p]; !ok {
				var ids []int64
				for _, o := range answers {
					if o.project == p {
						ids = append(ids, o.a.MessageID)
					}
				}
				subjectsOf[p], linksOf[p] = h.askSubjects(ctx, p, ids)
			}
			it := waitingItem{Kind: "answered_ask", ID: "ask-" + strconv.FormatInt(a.MessageID, 10), Board: p, Agent: agentOf(p, a.Asker), Since: a.AnsweredAt.UTC().Format(time.RFC3339),
				Title: firstLine(a.Question, waitingTitleMax), OperatorWords: cutWords(a.Answer, waitingWordsMax), at: a.AnsweredAt}
			if sj := subjectsOf[p][a.MessageID]; sj.GoalID > 0 {
				it.Goal = &waitingRef{ID: sj.GoalID, Title: linksOf[p].goalTitle(ctx, sj.GoalID)}
			}
			if sj := subjectsOf[p][a.MessageID]; sj.TaskID > 0 {
				it.Task = &waitingRef{ID: sj.TaskID, Title: linksOf[p].taskTitle(ctx, sj.TaskID)}
			}
			items = append(items, it)
			continue
		}
		c := comments[cd.comment-1]
		it := waitingItem{Kind: "comment_sent", ID: "cmt-" + strconv.FormatInt(c.CommentID, 10), Board: c.Board, Agent: agentOf(c.Board, c.AgentName), Since: c.Since.UTC().Format(time.RFC3339),
			Title: "A file", OperatorWords: cutWords(c.Body, waitingWordsMax), at: c.Since}
		if it.Agent.Name == "" {
			it.Agent.Name = clitext.CleanName(c.AgentName)
		}
		if it.Agent.SessionID == "" {
			it.Agent.SessionID = c.AgentSession
		}
		if _, gid, ok := parseGoalSubject(c.ArtifactID); ok {
			it.Title = "Goal #" + strconv.FormatInt(gid, 10)
			if g, err := h.bs.GetGoal(ctx, c.Board, gid); err == nil && g != nil {
				it.Title = clitext.CleanName(g.Title)
				it.Goal = &waitingRef{ID: gid, Title: clitext.CleanName(g.Title)}
			}
		} else if _, _, _, ok := parseDiffSubject(c.ArtifactID); ok {
			it.Title = "Changes by " + it.Agent.Name
		} else if c.Board != "" {
			byID, seen := files[c.Board]
			if !seen {
				byID = map[string]teamArtifact{}
				if fs, _, ferr := h.projectArtifactItems(r, c.Board, ""); ferr == nil {
					for _, f := range fs {
						if id := artifactStoreID(f); id != "" {
							byID[strings.ToLower(id)] = f
						}
					}
				}
				files[c.Board] = byID
			}
			if f, ok := byID[strings.ToLower(c.ArtifactID)]; ok {
				v := f.Version
				if v < 1 {
					v = 1
				}
				it.Title = clitext.CleanName(f.Name)
				it.Artifact = &waitingArtifact{Hex: strings.ToLower(c.ArtifactID), Name: clitext.CleanName(f.Name), Version: v}
				if f.TaskID > 0 {
					it.Task = &waitingRef{ID: f.TaskID, Title: clitext.CleanName(f.TaskTitle)}
				}
				if f.GoalID != nil && *f.GoalID > 0 {
					it.Goal = &waitingRef{ID: *f.GoalID, Title: clitext.CleanName(f.GoalTitle)}
				}
			}
		}
		items = append(items, it)
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].at.Before(items[j].at) })
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}
