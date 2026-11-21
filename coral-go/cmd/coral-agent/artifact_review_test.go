package main

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #20401: the review command names the file, sends the question and the session, prints the server's JSON, and refuses a 2xx that did not put the file for review.
func TestArtifactReviewSendsTheFileForReview(t *testing.T) {
	digest := strings.Repeat("ab", 32)
	var gotPath, gotQuery, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotQuery = r.URL.Path, r.URL.RawQuery
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Write([]byte(`{"uri":"coral://artifacts/` + digest + `","for_review":true,"inbox":"In the Operator's Inbox (Needs you) for review."}`))
	}))
	defer srv.Close()
	var out bytes.Buffer
	require.NoError(t, sendForReview(srv.URL, "coral://artifacts/"+digest, "Is it good?", "sess-1", &out))
	assert.Equal(t, "/api/agent/artifacts/"+digest+"/review", gotPath)
	assert.Equal(t, "session_id=sess-1", gotQuery)
	assert.JSONEq(t, `{"question":"Is it good?"}`, gotBody)
	assert.Contains(t, out.String(), `"for_review":true`)

	refuse := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"error":"this team has no such file"}`))
	}))
	defer refuse.Close()
	err := sendForReview(refuse.URL, "coral://artifacts/"+digest, "", "sess-1", &out)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "this team has no such file")

	// a success-shaped answer that did not put the file for review is not a success
	odd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{"uri":"x"}`)) }))
	defer odd.Close()
	assert.Error(t, sendForReview(odd.URL, "coral://artifacts/"+digest, "", "sess-1", &out))
}
