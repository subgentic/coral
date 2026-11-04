package routes

import (
	"encoding/base64"
	"net/http"
	"strconv"
	"strings"
)

// The paging sweep's id cursor (#13188): base64url of "i:<id>", at most 1024 bytes, a position in a list ordered by id and never a query or a path.
func encodeIDCursor(id int64) string {
	return base64.RawURLEncoding.EncodeToString([]byte("i:" + strconv.FormatInt(id, 10)))
}

func decodeIDCursor(c string) (int64, bool) {
	if len(c) > 1024 {
		return 0, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(c)
	if err != nil || !strings.HasPrefix(string(raw), "i:") {
		return 0, false
	}
	n, err := strconv.ParseInt(strings.TrimPrefix(string(raw), "i:"), 10, 64)
	return n, err == nil && n > 0
}

// idPageParams reads limit (1 to max, def when not given) and cursor (what encodeIDCursor made, 0 when not given); a bad one is a 400.
func idPageParams(w http.ResponseWriter, r *http.Request, def, max int) (limit int, after int64, ok bool) {
	limit = def
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > max {
			errBadRequest(w, "limit must be 1 to "+strconv.Itoa(max))
			return 0, 0, false
		}
		limit = n
	}
	if c := r.URL.Query().Get("cursor"); c != "" {
		id, good := decodeIDCursor(c)
		if !good {
			errBadRequest(w, "invalid cursor")
			return 0, 0, false
		}
		after = id
	}
	return limit, after, true
}
