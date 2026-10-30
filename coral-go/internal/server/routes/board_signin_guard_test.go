package routes

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// secretToken stands for a sign-in link's token: the refusal must never repeat it.
const secretToken = "S3cretTok3n"

// guardCall sends body through RefuseSignInLink and reports the answer, and what the handler behind it received (nil when it never ran).
func guardCall(t *testing.T, body string) (*httptest.ResponseRecorder, []byte) {
	t.Helper()
	var got []byte
	h := RefuseSignInLink(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		got = append([]byte{}, b...)
		w.WriteHeader(http.StatusOK)
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/board/team/messages", strings.NewReader(body)))
	return rec, got
}

// A body that carries a sign-in link's token, however it is spelled or wherever it sits in the JSON, is refused before the handler runs,
// with the sentence and code the clients match on, and without the token.
func TestABoardWriteWithASignInLinkIsRefused(t *testing.T) {
	jsonEscapedEquals := string([]byte{92}) + "u003d" // \u003d, an escaped '=' that only decoding the JSON shows
	for name, body := range map[string]string{
		"in a post":                    `{"content":"see http://127.0.0.1:8420/?login_token=` + secretToken + `","subscriber_id":"Lead"}`,
		"in capitals":                  `{"content":"LOGIN_TOKEN=` + secretToken + `"}`,
		"URL-encoded":                  `{"content":"next=%2F%3Flogin_token%3D` + secretToken + `"}`,
		"a JSON escape for =":          `{"content":"login_token` + jsonEscapedEquals + secretToken + `"}`,
		"in a task's title":            `{"title":"fix it","body":"","description":"x login_token=` + secretToken + `"}`,
		"nested in a list":             `{"artifacts":[{"name":"a"},{"note":"login_token=` + secretToken + `"}]}`,
		"in a key":                     `{"login_token=` + secretToken + `":"x"}`,
		"a body that is not JSON":      `plain text login_token=` + secretToken,
		"after the first JSON value":   `{"content":"ok"} {"content":"login_token=` + secretToken + `"}`,
		"in a goal's done-when":        `{"title":"g","done_when":"a link login_token=` + secretToken + ` works"}`,
		"in a notification's sentence": `{"title":"t","message":"open login_token=` + secretToken + `"}`,
		"inside another parameter":     `{"content":"http://127.0.0.1:8420/x?next=%2F%3Flogin_token%253D` + secretToken + `"}`,
	} {
		t.Run(name, func(t *testing.T) {
			rec, got := guardCall(t, body)
			assert.Equal(t, http.StatusBadRequest, rec.Code)
			assert.Nil(t, got, "the handler never runs")
			var answer map[string]string
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &answer))
			assert.Equal(t, "sign_in_link", answer["code"])
			assert.Equal(t, signInLinkRefusal, answer["error"])
			assert.NotContains(t, rec.Body.String(), secretToken, "the refusal never repeats the token")
		})
	}
}

// Text that only talks about the parameter passes, and the handler gets the body exactly as it was sent.
func TestABoardWriteWithoutASignInLinkPassesUnchanged(t *testing.T) {
	for _, body := range []string{
		`{"content":"the parameter is login_token, written without the equals sign"}`,
		`{"content":"login token= is two words","n":12345678901234567890}`,
		`{"content":"login_tokens are gone"}`,
		`not json at all`,
		`{"content":"100% done, login_token not written, a stray %zz and %2"}`,
		``,
	} {
		rec, got := guardCall(t, body)
		assert.Equal(t, http.StatusOK, rec.Code, body)
		assert.Equal(t, body, string(got), "handed on byte for byte: %q", body)
	}
}
