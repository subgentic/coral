package dropbox

// The calls Dropbox stage 4's upload worker makes (#14655): upload sessions committed in batches (never overwriting: mode add, strict_conflict),
// file metadata, space usage, and Dropbox's content hash. Through the same gated client as the sign-in; errors carry a tag only.

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
	"strconv"
	"strings"
	"time"
)

var (
	// ErrNotFound: Dropbox has no file at that path.
	ErrNotFound = errors.New("Dropbox has no file there")
	// ErrAccessExpired: the access token expired; refresh it and try again.
	ErrAccessExpired = errors.New("the Dropbox access token expired")
)

// RateLimited is Dropbox asking Coral to slow down, with how long to wait.
type RateLimited struct{ After time.Duration }

func (r *RateLimited) Error() string { return fmt.Sprintf("Dropbox asked Coral to wait %s", r.After) }

const blockSize = 4 << 20

// ContentHash is Dropbox's content_hash of data: SHA-256 over the SHA-256 of each 4 MiB block.
func ContentHash(data []byte) string {
	var all []byte
	for i := 0; i < len(data); i += blockSize {
		end := i + blockSize
		if end > len(data) {
			end = len(data)
		}
		h := sha256.Sum256(data[i:end])
		all = append(all, h[:]...)
	}
	sum := sha256.Sum256(all)
	return hex.EncodeToString(sum[:])
}

// apiError is Dropbox's error answer, of which only the summary's first tag is kept.
type apiError struct {
	Summary string `json:"error_summary"`
}

func (c *Client) do(req *http.Request, access string, out any) error {
	req.Header.Set("Authorization", "Bearer "+access)
	req.Header.Set("User-Agent", c.userAgent)
	resp, err := c.hc.Do(req)
	if err != nil {
		return fmt.Errorf("could not reach Dropbox: %w", stripURL(err))
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if resp.StatusCode == http.StatusOK {
		if out == nil {
			return nil
		}
		if err := json.Unmarshal(data, out); err != nil {
			return errors.New("Dropbox: an answer Coral does not understand")
		}
		return nil
	}
	var e apiError
	_ = json.Unmarshal(data, &e)
	tag := strings.SplitN(e.Summary, "/", 2)[0]
	switch {
	case resp.StatusCode == http.StatusTooManyRequests || tag == "too_many_requests":
		after := time.Second
		if n, err := strconv.Atoi(strings.TrimSpace(resp.Header.Get("Retry-After"))); err == nil && n > 0 && n <= 3600 {
			after = time.Duration(n) * time.Second
		}
		return &RateLimited{After: after}
	case resp.StatusCode == http.StatusUnauthorized && tag == "expired_access_token":
		return ErrAccessExpired
	case resp.StatusCode == http.StatusConflict && strings.Contains(e.Summary, "not_found"):
		return ErrNotFound
	}
	if !validTag(tag) {
		tag = "unknown"
	}
	return fmt.Errorf("Dropbox: %d %s", resp.StatusCode, tag)
}

func (c *Client) rpc(ctx context.Context, access, endpoint string, arg, out any) error {
	var body io.Reader = http.NoBody
	if arg != nil {
		b, err := json.Marshal(arg)
		if err != nil {
			return err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.api+"/2/"+endpoint, body)
	if err != nil {
		return err
	}
	if arg != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return c.do(req, access, out)
}

// StartSession sends a whole file as one closed upload session and returns its id, for a later batch commit.
func (c *Client) StartSession(ctx context.Context, access string, data []byte) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.content+"/2/files/upload_session/start", bytes.NewReader(data))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("Dropbox-API-Arg", `{"close":true}`)
	var out struct {
		SessionID string `json:"session_id"`
	}
	if err := c.do(req, access, &out); err != nil {
		return "", err
	}
	if out.SessionID == "" {
		return "", errors.New("Dropbox: no upload session id")
	}
	return out.SessionID, nil
}

// Commit is one finished upload session to commit at Path.
type Commit struct {
	SessionID string
	Size      int64
	Path      string
}

// CommitOutcome is how one commit of a batch ended.
type CommitOutcome int

// Commit outcomes.
const (
	CommitOK            CommitOutcome = iota
	CommitConflict                    // a file already at that path: never overwritten
	CommitNoSpace                     // the Dropbox account is full
	CommitTooManyWrites               // Dropbox asked Coral to slow down its writes
	CommitOther
)

// CommitResult is one commit's outcome; on CommitOK, what Dropbox stored.
type CommitResult struct {
	Outcome     CommitOutcome
	FileID      string
	Rev         string
	ContentHash string
}

// FinishBatch commits up to 1,000 sessions in one call with mode add (a file already at a path is a conflict, never overwritten) and returns each
// commit's outcome in order. A batch answered asynchronously is followed until it ends.
func (c *Client) FinishBatch(ctx context.Context, access string, commits []Commit) ([]CommitResult, error) {
	type cursor struct {
		SessionID string `json:"session_id"`
		Offset    int64  `json:"offset"`
	}
	type commitInfo struct {
		Path           string `json:"path"`
		Mode           string `json:"mode"`
		Autorename     bool   `json:"autorename"`
		Mute           bool   `json:"mute"`
		StrictConflict bool   `json:"strict_conflict"`
	}
	type entry struct {
		Cursor cursor     `json:"cursor"`
		Commit commitInfo `json:"commit"`
	}
	arg := struct {
		Entries []entry `json:"entries"`
	}{}
	for _, cm := range commits {
		arg.Entries = append(arg.Entries, entry{Cursor: cursor{cm.SessionID, cm.Size}, Commit: commitInfo{Path: cm.Path, Mode: "add", Mute: true, StrictConflict: true}})
	}
	var out struct {
		Tag     string            `json:".tag"`
		JobID   string            `json:"async_job_id"`
		Entries []json.RawMessage `json:"entries"`
	}
	if err := c.rpc(ctx, access, "files/upload_session/finish_batch_v2", arg, &out); err != nil {
		return nil, err
	}
	for i := 0; out.Tag == "async_job_id" && i < 120; i++ {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Second):
		}
		out.Tag = ""
		if err := c.rpc(ctx, access, "files/upload_session/finish_batch/check", map[string]string{"async_job_id": out.JobID}, &out); err != nil {
			return nil, err
		}
		if out.Tag == "in_progress" {
			out.Tag = "async_job_id"
		}
	}
	if len(out.Entries) != len(commits) {
		return nil, errors.New("Dropbox: the batch answer does not match the commits")
	}
	res := make([]CommitResult, len(commits))
	for i, raw := range out.Entries {
		var e struct {
			Tag         string          `json:".tag"`
			ID          string          `json:"id"`
			Rev         string          `json:"rev"`
			ContentHash string          `json:"content_hash"`
			Failure     json.RawMessage `json:"failure"`
		}
		_ = json.Unmarshal(raw, &e)
		switch {
		case e.Tag == "success":
			res[i] = CommitResult{Outcome: CommitOK, FileID: e.ID, Rev: e.Rev, ContentHash: e.ContentHash}
		case bytes.Contains(e.Failure, []byte(`"conflict"`)):
			res[i] = CommitResult{Outcome: CommitConflict}
		case bytes.Contains(e.Failure, []byte(`"insufficient_space"`)):
			res[i] = CommitResult{Outcome: CommitNoSpace}
		case bytes.Contains(e.Failure, []byte(`"too_many_write_operations"`)):
			res[i] = CommitResult{Outcome: CommitTooManyWrites}
		default:
			res[i] = CommitResult{Outcome: CommitOther}
		}
	}
	return res, nil
}

// Meta is what Dropbox says about a stored file.
type Meta struct {
	FileID      string
	Rev         string
	ContentHash string
}

// Metadata reads a file's id, rev and content hash. ErrNotFound when there is none.
func (c *Client) Metadata(ctx context.Context, access, path string) (Meta, error) {
	var out struct {
		Tag         string `json:".tag"`
		ID          string `json:"id"`
		Rev         string `json:"rev"`
		ContentHash string `json:"content_hash"`
	}
	if err := c.rpc(ctx, access, "files/get_metadata", map[string]string{"path": path}, &out); err != nil {
		return Meta{}, err
	}
	if out.Tag != "file" {
		return Meta{}, ErrNotFound
	}
	return Meta{FileID: out.ID, Rev: out.Rev, ContentHash: out.ContentHash}, nil
}

// SpaceUsage reads how much of the account is used and how much it has (bytes).
func (c *Client) SpaceUsage(ctx context.Context, access string) (used, allocated int64, err error) {
	var out struct {
		Used       int64 `json:"used"`
		Allocation struct {
			Allocated int64 `json:"allocated"`
		} `json:"allocation"`
	}
	if err := c.rpc(ctx, access, "users/get_space_usage", nil, &out); err != nil {
		return 0, 0, err
	}
	return out.Used, out.Allocation.Allocated, nil
}
