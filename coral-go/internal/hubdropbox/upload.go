package hubdropbox

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"sync/atomic"
	"time"
)

// uploadHost is the only host a link may point at.
const uploadHost = "content.dropboxapi.com"

// Errors say what stopped the upload and never carry the link, a url.Error or a reply body.
var (
	ErrBadLink        = errors.New("the upload link is not a Dropbox upload link")
	ErrDigestMismatch = errors.New("the file's bytes do not match the requested digest")
	ErrNotAllowed     = errors.New("this file may not be sent")
	ErrNetwork        = errors.New("could not reach Dropbox")
)

// Refused is Dropbox's answer when it did not take the file: the status, and whether a 409 said the space is full (the only tag read, never Dropbox's text).
type Refused struct {
	Status    int
	QuotaFull bool
}

func (r *Refused) Error() string {
	return fmt.Sprintf("Dropbox did not take the file (status %d)", r.Status)
}

// RateLimited carries a wait, clamped to an hour (a missing one is a minute).
type RateLimited struct{ After time.Duration }

func (r *RateLimited) Error() string { return "Dropbox asked Coral to wait" }

const (
	maxWait     = time.Hour
	defaultWait = time.Minute
)

// ValidLink checks a link before any byte is sent: https, the host exactly content.dropboxapi.com (by Hostname), port 443 or none, no user info, no fragment.
func ValidLink(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Hostname() != uploadHost || u.User != nil || u.Fragment != "" || u.Opaque != "" {
		return nil, ErrBadLink
	}
	if p := u.Port(); p != "" && p != "443" {
		return nil, ErrBadLink
	}
	return u, nil
}

// Uploader sends one file to a one-time link. Allowed is asked immediately before the bytes go (the private mark OR the internal tag, read fresh): an error or a false means nothing is sent.
type Uploader struct {
	client  *http.Client
	Allowed func(ctx context.Context) (bool, error)
}

// NewUploader builds the production client: no redirects, no proxy from the environment, a total timeout.
func NewUploader(allowed func(ctx context.Context) (bool, error)) *Uploader {
	return newUploader(&http.Transport{Proxy: nil, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 60 * time.Second, MaxResponseHeaderBytes: 16 << 10}, allowed)
}

// NewUploaderWith is NewUploader over a given transport, for the tests of the code that calls it.
func NewUploaderWith(rt http.RoundTripper, allowed func(ctx context.Context) (bool, error)) *Uploader {
	return newUploader(rt, allowed)
}

func newUploader(rt http.RoundTripper, allowed func(ctx context.Context) (bool, error)) *Uploader {
	return &Uploader{
		client: &http.Client{
			Transport:     rt,
			Timeout:       10 * time.Minute,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		Allowed: allowed,
	}
}

// Upload sends f.Data to link. Order, each step failing closed: the link is checked, the bytes must hash to wantDigest (so a file edited after the owner's confirm cannot slip past the secret check),
// the gate is asked, and only then does one request carry exactly len(f.Data) bytes.
func (u *Uploader) Upload(ctx context.Context, link, wantDigest string, f *File) error {
	target, err := ValidLink(link)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(f.Data)
	if hex.EncodeToString(sum[:]) != wantDigest || f.Digest != wantDigest {
		return ErrDigestMismatch
	}
	if u.Allowed == nil {
		return ErrNotAllowed
	}
	if ok, err := u.Allowed(ctx); err != nil || !ok {
		return ErrNotAllowed
	}
	body := &gatedBody{data: f.Data, ctx: ctx, allowed: u.Allowed}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target.String(), body)
	if err != nil {
		return ErrBadLink
	}
	req.ContentLength = int64(len(f.Data))
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := u.client.Do(req)
	if err != nil {
		if body.denied.Load() {
			return ErrNotAllowed // the mark or tag appeared while the bytes were going: the last chunk was never read
		}
		return ErrNetwork // never the url.Error: it holds the link
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusOK:
		return nil
	case resp.StatusCode == http.StatusTooManyRequests:
		return &RateLimited{After: retryAfter(resp.Header.Get("Retry-After"))}
	default:
		ref := &Refused{Status: resp.StatusCode}
		if resp.StatusCode == http.StatusConflict {
			b, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<10))
			ref.QuotaFull = bytes.Contains(b, []byte("insufficient_space"))
		}
		return ref
	}
}

// tailHold is the part of the file held back until the gate has been asked a second time (Security's S3 on #16109): a mark or tag set while the
// stream runs stops the last chunk, and Dropbox never gets a complete file.
const tailHold = 64 << 10

// gatedBody serves f.Data, but not its last tailHold bytes until Allowed says yes again. A no, or an error, ends the stream with an error (the request fails,
// short of its declared length) and sets denied.
type gatedBody struct {
	data    []byte
	pos     int
	checked bool
	denied  atomic.Bool // written by the transport's writer goroutine, read after Do returns
	ctx     context.Context
	allowed func(ctx context.Context) (bool, error)
}

func (b *gatedBody) Read(p []byte) (int, error) {
	if b.denied.Load() {
		return 0, ErrNotAllowed
	}
	hold := len(b.data) - tailHold
	if hold < 0 {
		hold = 0
	}
	if b.pos >= hold && !b.checked {
		if ok, err := b.allowed(b.ctx); err != nil || !ok {
			b.denied.Store(true)
			return 0, ErrNotAllowed
		}
		b.checked = true
	}
	if b.pos >= len(b.data) {
		return 0, io.EOF
	}
	end := len(b.data)
	if !b.checked {
		end = hold // before the check, only the part ahead of the held tail
	}
	n := copy(p, b.data[b.pos:end])
	b.pos += n
	return n, nil
}

func retryAfter(v string) time.Duration {
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return defaultWait
	}
	if n > int(maxWait/time.Second) {
		return maxWait
	}
	return time.Duration(n) * time.Second
}
