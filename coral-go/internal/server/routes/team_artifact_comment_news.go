package routes

import (
	"context"
	"net/http"
)

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
