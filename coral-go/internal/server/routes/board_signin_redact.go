package routes

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strconv"
)

// signInValue is a sign-in link's parameter and its value: login_token= (or its escape %3D, or %253D one level further), then the value up to
// the next & # " ' < > or white space.
var signInValue = regexp.MustCompile(`(?i)(login_token(?:=|%3d|%253d))[^&#"'<> ` + "\t\r\n" + `]*`)

// redactedValue replaces the value.
const redactedValue = "<removed>"

// RedactSignInLink is the middleware of a route that keeps a record an agent's own tools report (what a tool printed, a prompt it waits on):
// refusing it would lose the record, so a sign-in link's value in it is replaced with <removed> before the handler reads it, and the
// parameter's name is kept, so the record says something was there. A body without one is handed on unchanged.
//
// The body is read whole (BodyLimit has capped it). JSON is decoded, each string and key has the value replaced, and it is encoded again;
// any other body has the value replaced in its text.
func RedactSignInLink(next http.Handler) http.Handler {
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
			refuseUnreadableBody(w)
			return
		}
		if carriesSignInLink(body) {
			body = redactSignInLinks(body)
			r.ContentLength = int64(len(body))
			r.Header.Set("Content-Length", strconv.Itoa(len(body)))
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		next.ServeHTTP(w, r)
	})
}

// redactSignInLinks is body with every sign-in link's value replaced: as JSON when it is JSON, else as text.
func redactSignInLinks(body []byte) []byte {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var v any
	if dec.Decode(&v) == nil && !dec.More() {
		// Encoded without HTML escapes, so the record reads login_token=<removed>&... as written, not as \u003cremoved\u003e
		var out bytes.Buffer
		enc := json.NewEncoder(&out)
		enc.SetEscapeHTML(false)
		if enc.Encode(redactJSON(v)) == nil {
			return bytes.TrimSuffix(out.Bytes(), []byte("\n"))
		}
	}
	return []byte(redactText(string(body)))
}

func redactJSON(v any) any {
	switch x := v.(type) {
	case string:
		return redactText(x)
	case []any:
		for i := range x {
			x[i] = redactJSON(x[i])
		}
		return x
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, e := range x {
			out[redactText(k)] = redactJSON(e)
		}
		return out
	}
	return v
}

// redactText replaces the value of each sign-in link's parameter in text: written plainly, escaped once (%3D) or twice (%253D), the depth
// the refusal reads to (hasSignInLink). The parameter's name stays, followed by <removed>. Text that still carries a link once those are
// replaced (a name with an escaped letter: login%5Ftoken=, %6Cogin_token=) is replaced whole.
func redactText(s string) string {
	out := signInValue.ReplaceAllString(s, "${1}"+redactedValue)
	if hasSignInLink(redactedForm.ReplaceAllString(out, "")) {
		return redactedValue
	}
	return out
}

// redactedForm is a parameter whose value redactText has already replaced.
var redactedForm = regexp.MustCompile(`(?i)login_token(?:=|%3d|%253d)` + regexp.QuoteMeta(redactedValue))
