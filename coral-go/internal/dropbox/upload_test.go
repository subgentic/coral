package dropbox

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
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

// #14703, Dropbox stage 4b: retention's calls.

func TestDeleteBatchSendsPathAndParentRevAndReadsEachOutcome(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/2/files/delete_batch", r.URL.Path)
		require.NoError(t, json.NewDecoder(r.Body).Decode(&got))
		w.Write([]byte(`{".tag":"complete","entries":[
			{".tag":"success","metadata":{".tag":"file"}},
			{".tag":"failure","failure":{".tag":"path_lookup","path_lookup":{".tag":"not_found"}}},
			{".tag":"failure","failure":{".tag":"too_many_write_operations"}},
			{".tag":"failure","failure":{".tag":"path_write","path_write":{".tag":"conflict","conflict":{".tag":"file"}}}},
			{".tag":"failure","failure":{".tag":"something_new"}}]}`))
	}))
	defer srv.Close()
	job, res, err := newTestClient(t, srv).DeleteBatch(context.Background(), "acc", []Delete{
		{Path: "/v1/a", Rev: "r1"}, {Path: "/v1/b", Rev: "r1"}, {Path: "/v1/c", Rev: "r1"}, {Path: "/v1/d", Rev: "r1"}, {Path: "/v1/e", Rev: "r1"},
	})
	require.NoError(t, err)
	assert.Empty(t, job)
	assert.Equal(t, []DeleteOutcome{DeleteOK, DeleteNotFound, DeleteRetry, DeleteRefused, DeleteRefused}, res, "anything unknown keeps the file")
	e := got["entries"].([]any)[0].(map[string]any)
	assert.Equal(t, "/v1/a", e["path"], "by path, never by id")
	assert.Equal(t, "r1", e["parent_rev"])

}

// QA Reviewer 2's gap on #14703. Mutant: DeleteBatch sends an entry with no parent_rev.
func TestADeleteWithNoStoredRevIsNeverSent(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Write([]byte(`{".tag":"complete","entries":[{".tag":"success","metadata":{}},{".tag":"success","metadata":{}}]}`))
	}))
	defer srv.Close()
	_, res, err := newTestClient(t, srv).DeleteBatch(context.Background(), "acc", []Delete{{Path: "/v1/a", Rev: "r1"}, {Path: "/v1/b"}})
	assert.Error(t, err)
	assert.Nil(t, res)
	assert.Zero(t, calls, "nothing reaches Dropbox when any entry lacks the rev Coral stored")
}

func TestDeleteBatchAsyncJobAndItsCheck(t *testing.T) {
	polls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/2/files/delete_batch":
			w.Write([]byte(`{".tag":"async_job_id","async_job_id":"j1"}`))
		case "/2/files/delete_batch/check":
			var a map[string]string
			json.NewDecoder(r.Body).Decode(&a)
			if a["async_job_id"] != "j1" {
				w.WriteHeader(http.StatusConflict)
				w.Write([]byte(`{"error_summary":"invalid_async_job_id/"}`))
				return
			}
			polls++
			if polls == 1 {
				w.Write([]byte(`{".tag":"in_progress"}`))
				return
			}
			w.Write([]byte(`{".tag":"complete","entries":[{".tag":"success","metadata":{}}]}`))
		}
	}))
	defer srv.Close()
	c := newTestClient(t, srv)
	job, res, err := c.DeleteBatch(context.Background(), "acc", []Delete{{Path: "/v1/a", Rev: "r1"}})
	require.NoError(t, err)
	assert.Equal(t, "j1", job)
	assert.Nil(t, res)
	done, _, err := c.DeleteBatchCheck(context.Background(), "acc", "j1", 1)
	require.NoError(t, err)
	assert.False(t, done)
	done, res, err = c.DeleteBatchCheck(context.Background(), "acc", "j1", 1)
	require.NoError(t, err)
	assert.True(t, done)
	assert.Equal(t, []DeleteOutcome{DeleteOK}, res)
	_, _, err = c.DeleteBatchCheck(context.Background(), "acc", "gone", 1)
	assert.ErrorIs(t, err, ErrJobUnknown)
	_, _, err = c.DeleteBatchCheck(context.Background(), "acc", "j1", 2)
	assert.Error(t, err, "an answer that does not match the batch is not applied")
}

func TestSpaceUsageAtReadsDropboxsClock(t *testing.T) {
	when := time.Date(2026, 11, 8, 16, 0, 0, 0, time.UTC)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Date", when.Format(http.TimeFormat))
		w.Write([]byte(`{"used":1,"allocation":{"allocated":2}}`))
	}))
	defer srv.Close()
	used, alloc, at, err := newTestClient(t, srv).SpaceUsageAt(context.Background(), "acc")
	require.NoError(t, err)
	assert.EqualValues(t, 1, used)
	assert.EqualValues(t, 2, alloc)
	assert.True(t, at.Equal(when), "%v", at)
}

// #14714, Dropbox stage 5a: the listing and the capped download.

func TestListFolderPagesAndAReset(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var a map[string]any
		json.NewDecoder(r.Body).Decode(&a)
		switch r.URL.Path {
		case "/2/files/list_folder":
			assert.Equal(t, "/v1", a["path"])
			assert.Equal(t, true, a["recursive"])
			assert.Equal(t, true, a["include_deleted"], "a deleted version file is seen")
			w.Write([]byte(`{"entries":[{".tag":"file","path_lower":"/v1/a","rev":"r2","size":3,"content_hash":"h"},{".tag":"deleted","path_lower":"/v1/b"}],"cursor":"c1","has_more":true}`))
		case "/2/files/list_folder/continue":
			if a["cursor"] == "old" {
				w.WriteHeader(http.StatusConflict)
				w.Write([]byte(`{"error_summary":"reset/.."}`))
				return
			}
			w.Write([]byte(`{"entries":[],"cursor":"c2","has_more":false}`))
		}
	}))
	defer srv.Close()
	c := newTestClient(t, srv)
	p, err := c.ListFolder(context.Background(), "acc", "/v1")
	require.NoError(t, err)
	assert.Equal(t, []ListEntry{{Tag: "file", PathLower: "/v1/a", Rev: "r2", Size: 3, ContentHash: "h"}, {Tag: "deleted", PathLower: "/v1/b"}}, p.Entries)
	assert.True(t, p.HasMore)
	p, err = c.ListFolderContinue(context.Background(), "acc", "c1")
	require.NoError(t, err)
	assert.Equal(t, "c2", p.Cursor)
	_, err = c.ListFolderContinue(context.Background(), "acc", "old")
	assert.ErrorIs(t, err, ErrCursorReset)
}

func TestDownloadAsksForTheRevAndIsCappedByWhatIsRead(t *testing.T) {
	body := strings.Repeat("x", 100)
	declared := int64(100)
	chunked := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/2/files/download", r.URL.Path)
		assert.JSONEq(t, `{"path":"rev:015abc"}`, r.Header.Get("Dropbox-API-Arg"), "exactly the listed rev")
		w.Header().Set("Dropbox-API-Result", fmt.Sprintf(`{"rev":"015abc","size":%d,"content_hash":"h"}`, declared))
		if chunked {
			w.(http.Flusher).Flush() // no Content-Length: the size is unknown until read
		}
		w.Write([]byte(body))
	}))
	defer srv.Close()
	c := newTestClient(t, srv)
	var buf bytes.Buffer
	d, n, err := c.Download(context.Background(), "acc", "015abc", 100, &buf)
	require.NoError(t, err)
	assert.Equal(t, Downloaded{Rev: "015abc", Size: 100, ContentHash: "h"}, d)
	assert.EqualValues(t, 100, n)

	buf.Reset()
	declared = 1000
	_, n, err = c.Download(context.Background(), "acc", "015abc", 100, &buf)
	assert.ErrorIs(t, err, ErrTooBig, "a declared size over the cap is refused")
	assert.Zero(t, n, "before any byte is read")

	buf.Reset()
	declared, chunked, body = 10, true, strings.Repeat("y", 500) // Dropbox's size says 10; the stream carries 500 with no length
	_, n, err = c.Download(context.Background(), "acc", "015abc", 100, &buf)
	assert.ErrorIs(t, err, ErrTooBig, "a lying or absent length is cut at the cap plus one")
	assert.EqualValues(t, 101, n)

	_, _, err = c.Download(context.Background(), "acc", "", 100, &buf)
	assert.Error(t, err, "never without the rev")
}
