package dropbox

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14655, Dropbox stage 4: the calls the upload worker makes.

func TestContentHashIsDropboxsBlockHash(t *testing.T) {
	small := []byte("hello")
	h := sha256.Sum256(small)
	outer := sha256.Sum256(h[:])
	assert.Equal(t, hex.EncodeToString(outer[:]), ContentHash(small), "one block: the hash of the block's hash")

	big := bytes.Repeat([]byte("x"), 5<<20) // two blocks: 4 MiB and 1 MiB
	b1 := sha256.Sum256(big[:4<<20])
	b2 := sha256.Sum256(big[4<<20:])
	all := sha256.Sum256(append(b1[:], b2[:]...))
	assert.Equal(t, hex.EncodeToString(all[:]), ContentHash(big))
	assert.Equal(t, hex.EncodeToString(func() []byte { s := sha256.Sum256(nil); return s[:] }()), ContentHash(nil), "an empty file has no blocks")
}

func TestStartSessionSendsTheBytesAndClosesTheSession(t *testing.T) {
	var gotArg string
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/2/files/upload_session/start", r.URL.Path)
		assert.Equal(t, "Bearer acc", r.Header.Get("Authorization"))
		assert.Equal(t, "application/octet-stream", r.Header.Get("Content-Type"))
		gotArg = r.Header.Get("Dropbox-API-Arg")
		gotBody, _ = io.ReadAll(r.Body)
		w.Write([]byte(`{"session_id":"sess-1"}`))
	}))
	defer srv.Close()
	id, err := newTestClient(t, srv).StartSession(context.Background(), "acc", []byte("the bytes"))
	require.NoError(t, err)
	assert.Equal(t, "sess-1", id)
	assert.JSONEq(t, `{"close":true}`, gotArg)
	assert.Equal(t, "the bytes", string(gotBody))
}

func TestFinishBatchCommitsWithAddAndReadsEachResult(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/2/files/upload_session/finish_batch_v2", r.URL.Path)
		require.NoError(t, json.NewDecoder(r.Body).Decode(&got))
		w.Write([]byte(`{"entries":[
			{".tag":"success","id":"id:1","rev":"r1","content_hash":"h1","path_lower":"/v1/a"},
			{".tag":"failure","failure":{".tag":"path","path":{".tag":"conflict","conflict":{".tag":"file"}}}},
			{".tag":"failure","failure":{".tag":"path","path":{".tag":"insufficient_space"}}},
			{".tag":"failure","failure":{".tag":"too_many_write_operations"}},
			{".tag":"failure","failure":{".tag":"lookup_failed","lookup_failed":{".tag":"not_found"}}}]}`))
	}))
	defer srv.Close()
	res, err := newTestClient(t, srv).FinishBatch(context.Background(), "acc", []Commit{
		{SessionID: "s1", Size: 3, Path: "/v1/a"}, {SessionID: "s2", Size: 3, Path: "/v1/b"}, {SessionID: "s3", Size: 3, Path: "/v1/c"},
		{SessionID: "s4", Size: 3, Path: "/v1/d"}, {SessionID: "s5", Size: 3, Path: "/v1/e"},
	})
	require.NoError(t, err)
	require.Len(t, res, 5)
	assert.Equal(t, CommitResult{Outcome: CommitOK, FileID: "id:1", Rev: "r1", ContentHash: "h1"}, res[0])
	assert.Equal(t, CommitConflict, res[1].Outcome)
	assert.Equal(t, CommitNoSpace, res[2].Outcome)
	assert.Equal(t, CommitTooManyWrites, res[3].Outcome)
	assert.Equal(t, CommitOther, res[4].Outcome)

	entries := got["entries"].([]any)
	require.Len(t, entries, 5)
	commit := entries[0].(map[string]any)["commit"].(map[string]any)
	assert.Equal(t, "/v1/a", commit["path"])
	assert.Equal(t, "add", commit["mode"], "never overwrite")
	assert.Equal(t, false, commit["autorename"])
	assert.Equal(t, true, commit["strict_conflict"])
	cursor := entries[0].(map[string]any)["cursor"].(map[string]any)
	assert.Equal(t, "s1", cursor["session_id"])
	assert.EqualValues(t, 3, cursor["offset"])
}

func TestMetadataAndANotFoundFile(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var a map[string]string
		json.NewDecoder(r.Body).Decode(&a)
		if a["path"] == "/missing" {
			w.WriteHeader(http.StatusConflict)
			w.Write([]byte(`{"error_summary":"path/not_found/..","error":{".tag":"path","path":{".tag":"not_found"}}}`))
			return
		}
		w.Write([]byte(`{".tag":"file","id":"id:9","rev":"r9","content_hash":"h9","size":3}`))
	}))
	defer srv.Close()
	c := newTestClient(t, srv)
	m, err := c.Metadata(context.Background(), "acc", "/v1/x")
	require.NoError(t, err)
	assert.Equal(t, Meta{FileID: "id:9", Rev: "r9", ContentHash: "h9"}, m)
	_, err = c.Metadata(context.Background(), "acc", "/missing")
	assert.ErrorIs(t, err, ErrNotFound)
}

func TestSpaceUsage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/2/users/get_space_usage", r.URL.Path)
		w.Write([]byte(`{"used":100,"allocation":{".tag":"individual","allocated":1000}}`))
	}))
	defer srv.Close()
	used, alloc, err := newTestClient(t, srv).SpaceUsage(context.Background(), "acc")
	require.NoError(t, err)
	assert.EqualValues(t, 100, used)
	assert.EqualValues(t, 1000, alloc)
}

func TestARateLimitSaysHowLongToWait(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "7")
		w.WriteHeader(http.StatusTooManyRequests)
		w.Write([]byte(`{"error_summary":"too_many_requests/...","error":{"reason":{".tag":"too_many_requests"},"retry_after":7}}`))
	}))
	defer srv.Close()
	_, _, err := newTestClient(t, srv).SpaceUsage(context.Background(), "acc")
	var rl *RateLimited
	require.True(t, errors.As(err, &rl), "%v", err)
	assert.Equal(t, 7*time.Second, rl.After)
}

func TestAnExpiredAccessTokenIsToldApart(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"error_summary":"expired_access_token/","error":{".tag":"expired_access_token"}}`))
	}))
	defer srv.Close()
	_, err := newTestClient(t, srv).StartSession(context.Background(), "tok-7f3a9c", []byte("x"))
	assert.ErrorIs(t, err, ErrAccessExpired)
	assert.False(t, strings.Contains(err.Error(), "tok-7f3a9c"), "the error never carries the token")
}
