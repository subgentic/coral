package hubdropbox

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// uploadHost is the only host a link may point at.
const uploadHost = "content.dropboxapi.com"

// Errors say what stopped the upload and never carry the link, a url.Error or a reply body.
var (
	ErrBadLink        = errors.New("the upload link is not a Dropbox upload link")
	ErrDigestMismatch = errors.New("the file's bytes do not match the requested digest")
	ErrNotAllowed     = errors.New("this file may not be sent")
	ErrRefused        = errors.New("Dropbox did not take the file")
	ErrNetwork        = errors.New("could not reach Dropbox")
)

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
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target.String(), bytes.NewReader(f.Data))
	if err != nil {
		return ErrBadLink
	}
	req.ContentLength = int64(len(f.Data))
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := u.client.Do(req)
	if err != nil {
		return ErrNetwork // never the url.Error: it holds the link
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusOK:
		return nil
	case resp.StatusCode == http.StatusTooManyRequests:
		return &RateLimited{After: retryAfter(resp.Header.Get("Retry-After"))}
	default:
		return fmt.Errorf("%w (status %d)", ErrRefused, resp.StatusCode)
	}
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
