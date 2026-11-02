package routes

import (
	"context"
	"net/http"
)

// tagNewComments is the word the list answers as a tag for the rows that have unseen agent replies (#12026); no file is stored with it.
const tagNewComments = "new comments"

// needsYouFile says whether a file waits for the Operator: one tagged for review counts until they open it (read), and again while agents have replied in their comment thread and they have not opened it; a file they
// already decided (approved or denied) is out of Needs you until such a reply brings it back as its own row, marked and counted once (#12026). Saved, ignored and superseded files are never counted.
func needsYouFile(tags []string, news int) bool {
	if hasTag(tags, "saved") || hasTag(tags, "ignored") || hasTag(tags, "superseded") {
		return false
	}
	if hasTag(tags, "for review") {
		if hasTag(tags, "changes requested") {
			return news > 0 // it is the agent's turn (#11985): only a reply in the Operator's thread, which is news, brings it back
		}
		return !hasTag(tags, "read") || news > 0
	}
	return news > 0 && (hasTag(tags, "approved") || hasTag(tags, "denied"))
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
