package routes

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/subgentic/coral/internal/signinguard"
)

// signInLinkRefusal is the answer to a board write whose text carries a sign-in link. It never repeats the token.
const signInLinkRefusal = "Refused: this text contains a sign-in link (" + signinguard.Param + "=), and anyone who reads it could sign in with it. " +
	"Nothing was saved. Post only the result lines, never a command's whole output; to talk about the parameter, write it without '='."

// RefuseSignInLink is the middleware (r.With) of a board route whose body is text other people read (a post, a task, a goal, a notification): a body that carries a
// sign-in link's token is answered 400 sign_in_link and the handler never runs. coral-board and coral-agent refuse such text before they send it
// (#232); this is the same rule (signinguard) for a client that calls the API directly. A guard against accidents, not a leak filter.
//
// As middleware the route keeps its handler: chi.Walk, the board route pin and the identity census see the handler itself.
//
// The body is read whole (BodyLimit has capped it) and handed on unchanged. It is checked as text and, when it is JSON, string by string after
// decoding, so an escape such as \u003d in place of '=' is no way around it.
func RefuseSignInLink(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body == nil || r.Body == http.NoBody {
			next.ServeHTTP(w, r)
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
		next.ServeHTTP(w, r)
	})
}

// carriesSignInLink reports whether body carries a sign-in link's token: in its text, or in any JSON string or key once decoded.
func carriesSignInLink(body []byte) bool {
	if hasSignInLink(string(body)) {
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
		return hasSignInLink(x)
	case []any:
		for _, e := range x {
			if jsonCarriesSignInLink(e) {
				return true
			}
		}
	case map[string]any:
		for k, e := range x {
			if hasSignInLink(k) || jsonCarriesSignInLink(e) {
				return true
			}
		}
	}
	return false
}

// hasSignInLink is signinguard's rule on text, and on the text once more with its percent-escapes decoded: a link carried inside another
// parameter (next=%2F%3Flogin_token%253D...) is escaped twice, and signinguard itself only reads the parameter written plainly or once escaped.
func hasSignInLink(text string) bool {
	return signinguard.Contains(text) || signinguard.Contains(percentDecoded(text))
}

// percentDecoded is text with each %XX escape decoded once; anything else, a stray % included, is kept as it is.
func percentDecoded(text string) string {
	if !strings.Contains(text, "%") {
		return text
	}
	var b strings.Builder
	b.Grow(len(text))
	for i := 0; i < len(text); i++ {
		if text[i] == '%' && i+2 < len(text) && linkHexDigit(text[i+1]) && linkHexDigit(text[i+2]) {
			b.WriteByte(linkHexValue(text[i+1])<<4 | linkHexValue(text[i+2]))
			i += 2
			continue
		}
		b.WriteByte(text[i])
	}
	return b.String()
}

func linkHexDigit(c byte) bool { return '0' <= c && c <= '9' || 'a' <= c && c <= 'f' || 'A' <= c && c <= 'F' }

func linkHexValue(c byte) byte {
	switch {
	case '0' <= c && c <= '9':
		return c - '0'
	case 'a' <= c && c <= 'f':
		return c - 'a' + 10
	default:
		return c - 'A' + 10
	}
}
