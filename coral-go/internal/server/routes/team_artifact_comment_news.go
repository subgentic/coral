package routes

import (
	"context"
	"net/http"

	"github.com/subgentic/coral/internal/board"
)

// tagNewComments is the word the list answers as a tag for the rows that have unseen agent replies (#12026); no file is stored with it.
const tagNewComments = "new comments"

// needsYouFile says whether a file waits for the Operator: one tagged for review counts until they open it (read), and again while agents have replied in their comment thread and they have not opened it; a file they
// already decided (approved or denied) is out of Needs you until such a reply brings it back as its own row, marked and counted once (#12026). Ignored and superseded files are never counted, nor a saved file still
// waiting; a saved file that is decided (it keeps "saved" since #22133, to stay in Saved under Done) comes back for a reply like any decided file.
func needsYouFile(tags []string, news int) bool { return needsYouFileV(tags, news, false) }

// needsYouFileV is needsYouFile for the person who is asking, version-aware (#13959): a file tagged for review and read still waits for them while a NEWER version than the one they last opened exists (newVersion, from
// their own opened_version, #13910). A file with changes requested stays the agent's turn: only a reply counts, whatever versions came.
func needsYouFileV(tags []string, news int, newVersion bool) bool {
	if hasTag(tags, "ignored") || hasTag(tags, "superseded") || (hasTag(tags, "saved") && hasTag(tags, "for review")) {
		return false
	}
	if hasTag(tags, "for review") {
		if hasTag(tags, "changes requested") {
			return news > 0 // it is the agent's turn (#11985): only a reply in the Operator's thread, which is news, brings it back
		}
		return !hasTag(tags, "read") || news > 0 || newVersion
	}
	return news > 0 && (hasTag(tags, "approved") || hasTag(tags, "denied"))
}

// decidedWithNews says a file the Operator already decided (approved or denied) is back in Needs you for news in its comment thread, in needsYouFile's own words: it waits for the Operator although it is not tagged
// for review. The list answers the tag "for review" with these rows too, so the Inbox reads one list for what waits (#12097).
func decidedWithNews(tags []string, news int) bool {
	return !hasTag(tags, "for review") && needsYouFile(tags, news)
}

// SetCommentNews tells the board where to read the unseen agent replies in the Operator's comment threads, per artifact id (#12026). nil: none.
func (h *BoardHandler) SetCommentNews(fn func(ctx context.Context) (map[string]int, error)) {
	h.commentNews = fn
}

// attachNewComments puts NewComments on the rows of the files whose threads have unseen agent replies. It is the Operator's alone, as the comments are: a list an agent or a Coral Hub guest reads has none. A read
// that fails leaves the rows as they are.
func (h *BoardHandler) attachNewComments(r *http.Request, items []teamArtifact) {
	if h.commentNews == nil || len(items) == 0 || !operatorOrKeyCaller(r) {
		return
	}
	news, err := h.commentNews(r.Context())
	if err != nil || len(news) == 0 {
		return
	}
	for i := range items {
		items[i].NewComments = news[items[i].ID]
	}
}

// attachGoalNews puts NewComments on goals whose comment threads (the subject key goal:<team>:<id>, goalSubject) have unseen agent replies (#12073). The Operator's alone, as a file's: an agent's or a guest's read has none.
func (h *BoardHandler) attachGoalNews(r *http.Request, goals ...*board.Goal) {
	if h.commentNews == nil || len(goals) == 0 || !operatorOrKeyCaller(r) {
		return
	}
	news, err := h.commentNews(r.Context())
	if err != nil || len(news) == 0 {
		return
	}
	for _, g := range goals {
		if g != nil {
			g.NewComments = news[goalSubject(g.BoardID, g.ID)]
		}
	}
}

// SetGoalThreads tells the board where to read the open comment threads per goal (#21989). nil: none.
func (h *BoardHandler) SetGoalThreads(fn func(ctx context.Context) (map[string]int, error)) {
	h.goalThreads = fn
}

// attachGoalThreads puts CommentsOpen on the goals of a list, from one read for all of them. It only reads: nothing is marked seen. The Operator's alone, as the Comments tab is (an agent's or a guest's read has none).
func (h *BoardHandler) attachGoalThreads(r *http.Request, goals ...*board.Goal) {
	if h.goalThreads == nil || len(goals) == 0 || !operatorOrKeyCaller(r) {
		return
	}
	open, err := h.goalThreads(r.Context())
	if err != nil || len(open) == 0 {
		return
	}
	for _, g := range goals {
		if g != nil {
			g.CommentsOpen = open[goalSubject(g.BoardID, g.ID)]
		}
	}
}

// reviewNoteCap is the most characters of a request-changes note a list row carries (#21989).
const reviewNoteCap = 500

// SetReviewNotes tells the board where to read the latest Request-changes note per artifact id (#21989). nil: none.
func (h *BoardHandler) SetReviewNotes(fn func(ctx context.Context) (map[string]string, error)) {
	h.reviewNotes = fn
}

// attachReviewNotes puts ReviewNote on the rows of files that have changes requested, from one read for all of them. It only reads. The Operator's alone, as the comments are.
func (h *BoardHandler) attachReviewNotes(r *http.Request, items []teamArtifact) bool {
	if h.reviewNotes == nil || len(items) == 0 || !operatorOrKeyCaller(r) {
		return false
	}
	notes, err := h.reviewNotes(r.Context())
	if err != nil || len(notes) == 0 {
		return false
	}
	for i := range items {
		if n := notes[items[i].ID]; n != "" && hasTag(items[i].Tags, "changes requested") {
			if rs := []rune(n); len(rs) > reviewNoteCap {
				n = string(rs[:reviewNoteCap]) + "…"
			}
			items[i].ReviewNote = n
		}
	}
	return true
}

// SetDraftCounts tells the board where to read the reviewer's draft comments, per artifact id (#21194): the file's row says how many are waiting to be sent. nil: none.
func (h *BoardHandler) SetDraftCounts(fn func(r *http.Request) (map[string]int, error)) {
	h.draftCounts = fn
}
