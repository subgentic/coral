package routes

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// redactCall sends body through RedactSignInLink and reports what the handler behind it received.
func redactCall(t *testing.T, body string) (*httptest.ResponseRecorder, string) {
	t.Helper()
	var got string
	h := RedactSignInLink(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		got = string(b)
		assert.EqualValues(t, len(b), r.ContentLength, "the length the handler is told is the body's")
		w.WriteHeader(http.StatusOK)
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/sessions/live/a/events", strings.NewReader(body)))
	return rec, got
}

// An agent's hook report is kept, with a sign-in link's value replaced: however the link is written, the handler never sees the token, and
// the parameter's name stays, so the record says something was there.
func TestAHookReportKeepsItsRecordWithTheLinksValueRemoved(t *testing.T) {
	jsonEscapedEquals := string([]byte{92}) + "u003d"
	for name, body := range map[string]string{
		"in a tool's output":         `{"event_type":"tool_use","summary":"printed http://127.0.0.1:8420/?login_token=` + secretToken + `&x=1"}`,
		"in capitals":                `{"summary":"LOGIN_TOKEN=` + secretToken + `"}`,
		"escaped once":               `{"summary":"next=%2F%3Flogin_token%3D` + secretToken + `"}`,
		"escaped twice":              `{"summary":"next=%2F%3Flogin_token%253D` + secretToken + `"}`,
		"as a JSON escape":           `{"summary":"login_token` + jsonEscapedEquals + secretToken + `"}`,
		"in a key, in a nested list": `{"items":[{"login_token=` + secretToken + `":"v"}]}`,
		"a body that is not JSON":    `printed login_token=` + secretToken + ` done`,
	} {
		t.Run(name, func(t *testing.T) {
			rec, got := redactCall(t, body)
			assert.Equal(t, http.StatusOK, rec.Code, "the report is kept, not refused")
			assert.NotContains(t, got, secretToken)
			assert.Contains(t, strings.ToLower(got), "login_token")
			assert.Contains(t, got, redactedValue)
		})
	}
	// The rest of a JSON report is as it was.
	_, got := redactCall(t, `{"event_type":"tool_use","n":12345678901234567890,"summary":"see login_token=`+secretToken+`&x=1"}`)
	var v map[string]any
	require.NoError(t, json.Unmarshal([]byte(got), &v))
	assert.Equal(t, "tool_use", v["event_type"])
	assert.Equal(t, "see login_token=<removed>&x=1", v["summary"])
	assert.Contains(t, got, `"n":12345678901234567890`, "numbers are kept as written")
}

// A report without a link is handed on byte for byte.
func TestAHookReportWithoutALinkPassesUnchanged(t *testing.T) {
	for _, body := range []string{`{"summary":"login_token is the parameter, written without the sign"}`, `{"a" : 1 , "b":"x"}`, ``} {
		_, got := redactCall(t, body)
		assert.Equal(t, body, got)
	}
}

// An uploaded file whose name carries a sign-in link is refused; its contents are not looked at.
func TestAnUploadWhoseNameCarriesASignInLinkIsRefused(t *testing.T) {
	send := func(name string, content []byte) *httptest.ResponseRecorder {
		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)
		fw, err := mw.CreateFormFile("file", name)
		require.NoError(t, err)
		_, _ = fw.Write(content)
		require.NoError(t, mw.Close())
		req := httptest.NewRequest(http.MethodPost, "/api/upload", &buf)
		req.Header.Set("Content-Type", mw.FormDataContentType())
		rec := httptest.NewRecorder()
		UploadFile(rec, req)
		return rec
	}
	rec := send("shot login_token="+secretToken+".png", []byte("x"))
	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), `"code":"sign_in_link"`)
	assert.NotContains(t, rec.Body.String(), secretToken)
}

// A link whose parameter name has an escaped letter is not matched by the value pattern; the string that carries it is replaced whole.
func TestAHookReportWithAnEscapedLetterInTheNameLosesTheWholeString(t *testing.T) {
	for _, name := range []string{"login%5Ftoken=", "%6Cogin_token="} {
		_, got := redactCall(t, `{"event_type":"tool_use","summary":"see /?`+name+secretToken+`","tool_name":"Bash"}`)
		assert.NotContains(t, got, secretToken, name)
		var v map[string]any
		require.NoError(t, json.Unmarshal([]byte(got), &v), name)
		assert.Equal(t, redactedValue, v["summary"], name)
		assert.Equal(t, "Bash", v["tool_name"], "%s: the other fields are kept", name)
	}
}

// A value ends at ) ] } , ; or a backslash as well as at & # quotes and white space: what follows it in the text is kept.
func TestARedactedValueStopsAtTheCharactersAroundIt(t *testing.T) {
	for _, stop := range []string{")", "]", "}", ",", ";", `\`, "&", " "} {
		in := "(see login_token=" + secretToken + stop + "after"
		got := redactText(in)
		assert.Equal(t, "(see login_token=<removed>"+stop+"after", got, "stop %q", stop)
	}
}

// A parameter with no value is left as it is: there is nothing to remove, and the text is kept whole.
func TestAParameterWithNoValueIsLeftAsItIs(t *testing.T) {
	for _, in := range []string{"login_token=", "set login_token= to a link", "login_token=&next=1", "(login_token=)", "login_token%3D"} {
		assert.Equal(t, in, redactText(in), in)
	}
}
