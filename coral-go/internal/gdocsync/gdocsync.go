// Package gdocsync is the proof of concept for #19932: share a Coral Markdown artifact as a Google Doc, pull the reviewers' comments back, revise the Markdown, update the same
// Doc in place, and reply to and resolve the comments that were handled. It is a library and a fake Drive for tests, not yet wired into a route or a command.
//
// Nothing here has run against Google: the tests use a fake Drive made from the public v3 reference (files.create, files.update, comments.list, replies.create), so they prove
// Coral's side (requests, paging, the retry, the mapping, the state file) and not Google's behaviour. What only Google can answer (does an in-place update keep a comment
// anchored, what a comment on deleted text becomes) is left out on purpose and listed in the findings.
//
// The token never enters a log, an error or a file: the client asks its TokenFunc for it inside each request and nothing keeps it.
package gdocsync

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	DocMime       = "application/vnd.google-apps.document"
	maxBody       = 8 << 20 // the Markdown we send: far under Drive's own limits
	maxResponse   = 4 << 20 // a response we read
	maxErrBody    = 300     // how much of an error body is quoted
	maxRetries    = 3       // 429 and 5xx
	maxRetryAfter = 30 * time.Second
	commentFields = "nextPageToken,comments(id,content,author(displayName),createdTime,modifiedTime,resolved,deleted,quotedFileContent(mimeType,value),anchor,replies(id,content,author(displayName),createdTime,action))"
)

// Production is the only host the client talks to outside a test (#19950): the bearer token is sent there and nowhere else. There is no exported way to change it; this package's
// own tests set the unexported base to a test server.
const Production = "https://www.googleapis.com"

// Client talks to Drive v3 and Docs v1. The zero value, or one from NewClient, talks to Production.
type Client struct {
	base      string // empty means Production; set only by this package's tests
	HTTP      *http.Client
	TokenFunc func() (string, error)
	Sleep     func(time.Duration) // replaced in tests
}

// Author is who wrote a comment or reply on the Google side.
type Author struct {
	DisplayName string `json:"displayName"` // the name only: a reviewer's email address is not asked for and never reaches Coral
}

// Reply is one reply under a comment; Action is "resolve" or "reopen" when the reply did that.
type Reply struct {
	ID          string `json:"id"`
	Content     string `json:"content"`
	Author      Author `json:"author"`
	CreatedTime string `json:"createdTime"`
	Action      string `json:"action"`
}

// Comment is a Drive comment on the Doc.
type Comment struct {
	ID                string `json:"id"`
	Content           string `json:"content"`
	Author            Author `json:"author"`
	CreatedTime       string `json:"createdTime"`
	ModifiedTime      string `json:"modifiedTime"`
	Resolved          bool   `json:"resolved"`
	Deleted           bool   `json:"deleted"`
	QuotedFileContent struct {
		MimeType string `json:"mimeType"`
		Value    string `json:"value"`
	} `json:"quotedFileContent"`
	Anchor  string  `json:"anchor"`
	Replies []Reply `json:"replies"`
}

// NewClient returns a client for Production that asks tok for the token inside each request.
func NewClient(tok func() (string, error)) *Client { return &Client{TokenFunc: tok} }

// NewClientAt is a client for a Drive and Docs stand-in at base (another package's tests): it answers for both hosts and never sleeps between retries.
func NewClientAt(base string, tok func() (string, error)) *Client {
	if u, err := url.Parse(base); err != nil || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost") {
		panic("gdocsync: NewClientAt is for a stand-in on this computer (127.0.0.1 or localhost) only") // a token must never be sent to another host through this door
	}
	return &Client{base: base, TokenFunc: tok, Sleep: func(time.Duration) {}}
}

// DocsProduction is the second and last host: Docs v1 is served from here, Drive v3 from Production (found live, #19953).
const DocsProduction = "https://docs.googleapis.com"

// hostFor picks the host for a request path; a test server (the unexported base) answers for both.
func (c *Client) hostFor(path string) string {
	if c.base != "" {
		return c.base
	}
	if strings.HasPrefix(path, "/v1/documents/") {
		return DocsProduction
	}
	return Production
}

func (c *Client) baseURL() string {
	if c.base != "" {
		return c.base
	}
	return Production
}

// ErrOutcomeUnknown wraps the error of a write that may have been applied although it reported a failure (a server error or a lost connection): read the Doc or the comments again
// before sending it a second time.
var ErrOutcomeUnknown = errors.New("gdocsync: the request may have been applied; read again before sending it again")

// httpError is a response that was not a success.
type httpError struct {
	Method, Path string
	Status       int
	Body         string
}

func (e *httpError) Error() string {
	return fmt.Sprintf("gdocsync: %s %s: HTTP %d: %s", e.Method, e.Path, e.Status, e.Body)
}

func (c *Client) do(ctx context.Context, method, path string, q url.Values, contentType string, body []byte, out any) error {
	if c.TokenFunc == nil {
		return errors.New("gdocsync: no token source")
	}
	u := c.hostFor(path) + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	hc := c.HTTP
	if hc == nil {
		hc = &http.Client{Timeout: 60 * time.Second}
	}
	sleep := c.Sleep
	if sleep == nil {
		sleep = time.Sleep
	}
	for attempt := 0; ; attempt++ {
		tok, err := c.TokenFunc() // read here, used once, never stored or printed
		if err != nil {
			return errors.New("gdocsync: the token source failed")
		}
		if strings.TrimSpace(tok) == "" {
			return errors.New("gdocsync: the token source gave an empty token; nothing was sent") // never send a request with no credential (#19947)
		}
		req, err := http.NewRequestWithContext(ctx, method, u, bytes.NewReader(body))
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+tok)
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		resp, err := hc.Do(req)
		if err != nil {
			if method != http.MethodGet { // the request may have reached Google before the connection broke
				return fmt.Errorf("%w: %v", ErrOutcomeUnknown, redact(err, tok))
			}
			return redact(err, tok)
		}
		data, _ := io.ReadAll(io.LimitReader(resp.Body, maxResponse))
		resp.Body.Close()
		// only a read is sent again: Push, Update, Reply and a batchUpdate are not idempotent, so a lost response must not make a second Doc, reply or edit (#19947)
		if method == http.MethodGet && (resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500) && attempt < maxRetries {
			wait := time.Duration(1<<attempt) * time.Second
			if s, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil && s >= 0 {
				wait = time.Duration(s) * time.Second
			}
			if wait > maxRetryAfter {
				wait = maxRetryAfter
			}
			sleep(wait)
			continue
		}
		if resp.StatusCode/100 != 2 {
			msg := strings.ReplaceAll(string(data), tok, "[token]")
			if len(msg) > maxErrBody {
				msg = msg[:maxErrBody] + "..."
			}
			he := &httpError{Method: method, Path: path, Status: resp.StatusCode, Body: msg}
			if method != http.MethodGet && resp.StatusCode >= 500 {
				return fmt.Errorf("%w: %w", ErrOutcomeUnknown, he)
			}
			return he
		}
		if out != nil && len(data) > 0 {
			return json.Unmarshal(data, out)
		}
		return nil
	}
}

func redact(err error, tok string) error {
	return errors.New(strings.ReplaceAll(err.Error(), tok, "[token]"))
}

// Push makes a new Google Doc from the Markdown (files.create, multipart, the target type a Google Doc so Drive converts it) and returns its file id.
func (c *Client) Push(ctx context.Context, title, markdown string) (string, error) {
	if len(markdown) > maxBody {
		return "", errors.New("gdocsync: the Markdown is too large")
	}
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	meta, _ := json.Marshal(map[string]string{"name": title, "mimeType": DocMime})
	h := textproto.MIMEHeader{"Content-Type": {"application/json; charset=UTF-8"}}
	p, _ := mw.CreatePart(h)
	p.Write(meta)
	h = textproto.MIMEHeader{"Content-Type": {"text/markdown"}}
	p, _ = mw.CreatePart(h)
	p.Write([]byte(markdown))
	mw.Close()
	var out struct {
		ID string `json:"id"`
	}
	err := c.do(ctx, http.MethodPost, "/upload/drive/v3/files", url.Values{"uploadType": {"multipart"}, "fields": {"id"}}, "multipart/related; boundary="+mw.Boundary(), buf.Bytes(), &out)
	if err == nil && out.ID == "" {
		err = errors.New("gdocsync: Drive made no file id")
	}
	return out.ID, err
}

// Update replaces the content of the same Doc in place (files.update, media) so its file id, link and sharing stay.
func (c *Client) Update(ctx context.Context, fileID, markdown string) error {
	if len(markdown) > maxBody {
		return errors.New("gdocsync: the Markdown is too large")
	}
	return c.do(ctx, http.MethodPatch, "/upload/drive/v3/files/"+url.PathEscape(fileID), url.Values{"uploadType": {"media"}, "fields": {"id"}}, "text/markdown", []byte(markdown), nil)
}

// Comments lists every comment on the Doc, paging through Drive's pages; deleted comments are left out.
func (c *Client) Comments(ctx context.Context, fileID string) ([]Comment, error) {
	var all []Comment
	token := ""
	for page := 0; page < 200; page++ {
		q := url.Values{"fields": {commentFields}, "pageSize": {"100"}, "includeDeleted": {"false"}}
		if token != "" {
			q.Set("pageToken", token)
		}
		var out struct {
			NextPageToken string    `json:"nextPageToken"`
			Comments      []Comment `json:"comments"`
		}
		if err := c.do(ctx, http.MethodGet, "/drive/v3/files/"+url.PathEscape(fileID)+"/comments", q, "", nil, &out); err != nil {
			return nil, err
		}
		for _, cm := range out.Comments {
			if !cm.Deleted {
				all = append(all, cm)
			}
		}
		if out.NextPageToken == "" {
			return all, nil
		}
		token = out.NextPageToken
	}
	return nil, errors.New("gdocsync: more than 200 pages of comments")
}

// Reply adds a reply to a comment; action "resolve" also resolves the comment, "reopen" reopens it, "" is a plain reply.
func (c *Client) Reply(ctx context.Context, fileID, commentID, content, action string) error {
	body, _ := json.Marshal(map[string]string{"content": content, "action": action})
	return c.do(ctx, http.MethodPost, "/drive/v3/files/"+url.PathEscape(fileID)+"/comments/"+url.PathEscape(commentID)+"/replies", url.Values{"fields": {"id"}}, "application/json", body, nil)
}

// CoralAnchor is the shape of Coral's artifact comment anchor (routes.commentAnchor): the selected text with context, or the whole document.
type CoralAnchor struct {
	Quote  string `json:"quote"`
	Prefix string `json:"prefix,omitempty"`
	Suffix string `json:"suffix,omitempty"`
	Whole  bool   `json:"whole,omitempty"`
}

// CoralComment is a Google comment as Coral would store it on the artifact: who said it, on what text, and where it came from.
type CoralComment struct {
	RemoteID string      `json:"remote_id"`
	Anchor   CoralAnchor `json:"anchor"`
	Body     string      `json:"body"` // "[Name] text": the Google author is a text prefix, Coral's own author is the sync's
	Replies  []string    `json:"replies,omitempty"`
	Resolved bool        `json:"resolved"`
}

// ToCoral maps a Google comment: its quoted text becomes the anchor (the Doc's own anchor is opaque and kept out), a comment with no quote is a whole-document comment, the
// author becomes a text prefix and the replies keep their order. The quote is found in the Markdown to give the prefix and suffix Coral uses to tell repeats apart.
func ToCoral(c Comment, markdown string) CoralComment {
	a := CoralAnchor{Quote: strings.TrimSpace(c.QuotedFileContent.Value)}
	if a.Quote == "" {
		a = CoralAnchor{Whole: true}
	} else if i := strings.Index(markdown, a.Quote); i >= 0 {
		a.Prefix = tail(markdown[:i], 32)
		a.Suffix = head(markdown[i+len(a.Quote):], 32)
	}
	out := CoralComment{RemoteID: c.ID, Anchor: a, Body: signed(c.Author, c.Content), Resolved: c.Resolved}
	for _, r := range c.Replies {
		if r.Action != "" && strings.TrimSpace(r.Content) == "" {
			continue // a bare resolve or reopen is the Resolved flag, not a message
		}
		out.Replies = append(out.Replies, signed(r.Author, r.Content))
	}
	return out
}

// signed puts the Google author in front of the text as "[Name] text". Both are the reviewer's words and untrusted: the name loses its brackets, line breaks and control characters (and
// is cut), and a bracket that starts a line of the text is escaped, so no text can pass as another author's "[Name]" line. Exactly one line of the result starts with a bracket.
func signed(a Author, text string) string {
	return "[" + cleanName(a.DisplayName) + "] " + escapeLeadingBrackets(text)
}

func cleanName(n string) string {
	var sb strings.Builder
	for _, r := range n {
		switch {
		case r == '[' || r == ']':
		case r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) || r == '\u2028' || r == '\u2029':
			sb.WriteRune(' ')
		default:
			sb.WriteRune(r)
		}
	}
	out := strings.Join(strings.Fields(sb.String()), " ")
	if rs := []rune(out); len(rs) > 60 {
		out = string(rs[:60])
	}
	if out == "" {
		return "unknown"
	}
	return out
}

func escapeLeadingBrackets(text string) string {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	for i, l := range lines {
		if t := strings.TrimLeft(l, " \t"); strings.HasPrefix(t, "[") {
			lines[i] = l[:len(l)-len(t)] + "\\" + t
		}
	}
	return strings.Join(lines, "\n")
}

func tail(s string, n int) string {
	if len(s) > n {
		s = s[len(s)-n:]
	}
	return s
}

func head(s string, n int) string {
	if len(s) > n {
		s = s[:n]
	}
	return s
}

// Action is one thing to do on the Google side after the Markdown was revised.
type Action struct {
	CommentID string
	Reply     string
	Resolve   bool
	Survives  bool // the quoted text is still in the new Markdown
}

// Plan decides the replies for the comments an agent handled: each open, handled comment gets a reply and is resolved. A comment whose quoted text is gone from the new
// Markdown is told so (it can no longer point at anything); one whose text survives is told it was handled. Comments not named in handled are left open and untouched.
func Plan(open []Comment, handled map[string]string, newMarkdown string) []Action {
	var acts []Action
	for _, c := range open {
		note, ok := handled[c.ID]
		if !ok || c.Resolved {
			continue
		}
		q := strings.TrimSpace(c.QuotedFileContent.Value)
		survives := q == "" || strings.Contains(newMarkdown, q)
		reply := note
		if !survives {
			reply = strings.TrimSpace(note + " (The text this comment was on has changed, so it no longer points at anything; it is resolved.)")
		}
		acts = append(acts, Action{CommentID: c.ID, Reply: reply, Resolve: true, Survives: survives})
	}
	return acts
}

// Apply sends the actions, resolving as it replies, and stops at the first error so a retry starts from what is still open.
func (c *Client) Apply(ctx context.Context, fileID string, acts []Action) error {
	for _, a := range acts {
		action := ""
		if a.Resolve {
			action = "resolve"
		}
		if err := c.Reply(ctx, fileID, a.CommentID, a.Reply, action); err != nil {
			return err
		}
	}
	return nil
}

// State is what a sync remembers between runs: the Doc, the artifact series it follows and which remote comments were already taken into Coral (by their modified time), so a
// run takes in only the new and the changed ones and never twice. It holds no token.
type State struct {
	FileID   string            `json:"file_id"`
	SeriesID string            `json:"series_id"`
	Seen     map[string]string `json:"seen"`
}

// LoadState reads the state file; a missing file is an empty state.
func LoadState(path string) (State, error) {
	s := State{Seen: map[string]string{}}
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return s, nil
	}
	if err != nil {
		return s, err
	}
	if err := json.Unmarshal(b, &s); err != nil {
		return State{Seen: map[string]string{}}, fmt.Errorf("gdocsync: state file %s is not valid", filepath.Base(path))
	}
	if s.Seen == nil {
		s.Seen = map[string]string{}
	}
	return s, nil
}

// Save writes the state file through a temporary file so a crash never leaves half of it.
func (s State) Save(path string) error {
	b, _ := json.MarshalIndent(s, "", "  ")
	// a unique temporary name made with O_EXCL (CreateTemp), never a fixed one a link could be planted at (#19950)
	f, err := os.CreateTemp(filepath.Dir(path), ".state-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	_, werr := f.Write(b)
	cerr := f.Close()
	if werr != nil || cerr != nil {
		os.Remove(tmp)
		return errors.Join(werr, cerr)
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// New returns the comments not yet taken in (new, or modified since), and records them as seen in a copy of the state.
func (s State) New(all []Comment) ([]Comment, State) {
	next := State{FileID: s.FileID, SeriesID: s.SeriesID, Seen: map[string]string{}}
	for k, v := range s.Seen {
		next.Seen[k] = v
	}
	var fresh []Comment
	for _, c := range all {
		if s.Seen[c.ID] != c.ModifiedTime || c.ModifiedTime == "" {
			fresh = append(fresh, c)
		}
		next.Seen[c.ID] = c.ModifiedTime
	}
	return fresh, next
}
