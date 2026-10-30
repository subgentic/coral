package routes

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/subgentic/coral/internal/signinguard"
)

// signInLinkRefusal is the answer to a board write whose text carries a sign-in link. It never repeats the token.
const signInLinkRefusal = "Refused: this text contains a sign-in link (" + signinguard.Param + "=), and anyone who reads it could sign in with it. " +
	"Nothing was saved. Post only the result lines, never a command's whole output; to talk about the parameter, write it without '='."

// RefuseSignInLink wraps a board route whose body is text other people read (a post, a task, a goal, a notification): a body that carries a
// sign-in link's token is answered 400 sign_in_link and the handler never runs. coral-board and coral-agent refuse such text before they send it
// (#232); this is the same rule (signinguard) for a client that calls the API directly. A guard against accidents, not a leak filter.
//
// The body is read whole (BodyLimit has capped it) and handed on unchanged. It is checked as text and, when it is JSON, string by string after
// decoding, so an escape such as = in place of '=' is no way around it.
func RefuseSignInLink(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Body == nil || r.Body == http.NoBody {
			next(w, r)
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				writeError(w, http.StatusRequestEntityTooLarge, "body_too_large", "This request's body is over the limit")
				return
			}
			refuseUnreadableBody(w) // what was read is not handed on (#7204)
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		if carriesSignInLink(body) {
			writeError(w, http.StatusBadRequest, "sign_in_link", signInLinkRefusal)
			return
		}
		next(w, r)
	}
}

// carriesSignInLink reports whether body carries a sign-in link's token: in its text, or in any JSON string or key once decoded.
func carriesSignInLink(body []byte) bool {
	if signinguard.Contains(string(body)) {
		return true
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var v any
	if dec.Decode(&v) != nil {
		return false // not JSON: the text check above is all there is, and the handler answers the body as it would
	}
	return jsonCarriesSignInLink(v)
}

func jsonCarriesSignInLink(v any) bool {
	switch x := v.(type) {
	case string:
		return signinguard.Contains(x)
	case []any:
		for _, e := range x {
			if jsonCarriesSignInLink(e) {
				return true
			}
		}
	case map[string]any:
		for k, e := range x {
			if signinguard.Contains(k) || jsonCarriesSignInLink(e) {
				return true
			}
		}
	}
	return false
}
