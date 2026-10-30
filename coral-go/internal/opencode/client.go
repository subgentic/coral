// Package opencode talks to an opencode server (opencode v2): the messages of a session through its public HTTP API, its event stream, and the lifecycle of the one server Coral runs for its own data
// scope (#11364). Coral reads an opencode session through this API and never by opening its SQLite database, and its server is never the person's own background service.
package opencode

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Username is the HTTP Basic user of an opencode server; its password is the one Coral generated for it (OPENCODE_PASSWORD). Confirmed on v2.2.4 (Pi Tester, #11364): HTTP Basic, opencode:<OPENCODE_PASSWORD>.
const Username = "opencode"

// maxBody bounds what a read of the API takes: a message list page is small, and a server that answers with more is not trusted to.
const maxBody = 8 << 20

// Client is one opencode server, by its base URL and password. The server must be on this computer: a base URL that does not name a loopback host is refused, so the password never goes anywhere else.
type Client struct {
	base     *url.URL
	password string
	http     *http.Client
}

// ErrNotLoopback is a base URL whose host is not this computer.
var ErrNotLoopback = errors.New("opencode: the server must be on a loopback address")

// New is a client of the server at base (http://127.0.0.1:<port>) with its password.
func New(base, password string) (*Client, error) {
	u, err := url.Parse(base)
	if err != nil || u.Scheme != "http" || u.Host == "" {
		return nil, fmt.Errorf("opencode: not a server address: %q", base)
	}
	host := u.Hostname()
	if ip := net.ParseIP(host); (ip == nil || !ip.IsLoopback()) && host != "localhost" {
		return nil, ErrNotLoopback
	}
	return &Client{base: u, password: password, http: &http.Client{Timeout: 30 * time.Second}}, nil
}

// Message is one message of a session as Coral keeps it: who said it, its text and when.
type Message struct {
	ID   string
	Role string // "user" or "assistant"
	Text string
	At   string
}

// apiMessage is a message as the API sends it (the shape of `session export`: a type, a text, or assistant content blocks of which the text ones are what was said).
type apiMessage struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	Role    string `json:"role"`
	Text    string `json:"text"`
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
	Time struct {
		Created any `json:"created"`
	} `json:"time"`
	CreatedAt string `json:"created_at"`
}

func (m apiMessage) message() (Message, bool) {
	role := m.Role
	if role == "" {
		role = m.Type
	}
	if role != "user" && role != "assistant" {
		return Message{}, false // idle markers, tool rows and the rest are not what was said
	}
	text := m.Text
	if text == "" {
		var parts []string
		for _, c := range m.Content {
			if c.Type == "text" && c.Text != "" {
				parts = append(parts, c.Text)
			}
		}
		text = strings.Join(parts, "\n")
	}
	if text == "" {
		return Message{}, false
	}
	at := m.CreatedAt
	switch v := m.Time.Created.(type) {
	case string:
		at = v
	case float64:
		at = strconv.FormatInt(int64(v), 10)
	}
	return Message{ID: m.ID, Role: role, Text: text, At: at}, true
}

// Page is a page of messages and the cursor of the next one ("" for the last).
type Page struct {
	Messages []Message
	Next     string
}

// MessagesOpts selects a page of GET /api/session/{id}/message: newest first when Desc, at most Limit (0: the server's), from Cursor.
type MessagesOpts struct {
	Desc   bool
	Limit  int
	Cursor string
}

func (c *Client) get(ctx context.Context, path string, q url.Values, accept string) (*http.Response, error) {
	u := *c.base
	u.Path = strings.TrimRight(u.Path, "/") + path
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(Username, c.password)
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	return c.http.Do(req)
}

// validSessionID is an opencode session id as it is written ("ses_" and word characters): it is put into a URL path, so nothing else is.
func validSessionID(id string) bool {
	if len(id) < 5 || len(id) > 128 || !strings.HasPrefix(id, "ses_") {
		return false
	}
	for _, r := range id {
		if !(r == '_' || r == '-' || r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z') {
			return false
		}
	}
	return true
}

// Messages reads a page of a session's messages from the server's API.
func (c *Client) Messages(ctx context.Context, sessionID string, opts MessagesOpts) (Page, error) {
	if !validSessionID(sessionID) {
		return Page{}, fmt.Errorf("opencode: not a session id: %q", sessionID)
	}
	q := url.Values{}
	if opts.Desc {
		q.Set("order", "desc")
	}
	if opts.Limit > 0 {
		q.Set("limit", strconv.Itoa(opts.Limit))
	}
	if opts.Cursor != "" {
		q.Set("cursor", opts.Cursor)
	}
	resp, err := c.get(ctx, "/api/session/"+sessionID+"/message", q, "application/json")
	if err != nil {
		return Page{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		return Page{}, fmt.Errorf("opencode: messages of %s: HTTP %d", sessionID, resp.StatusCode)
	}
	// The page of v2.2.4 is {"data": [...], "cursor": {"previous": ..., "next": ...}}; "items" and a bare list or a cursor that is a string are read too, for another build.
	var body struct {
		Items  []apiMessage    `json:"items"`
		Data   []apiMessage    `json:"data"`
		Cursor json.RawMessage `json:"cursor"`
		Next   string          `json:"next"`
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	if err != nil {
		return Page{}, err
	}
	if len(raw) > maxBody {
		return Page{}, errors.New("opencode: the answer is too large")
	}
	var list []apiMessage
	if json.Unmarshal(raw, &list) == nil { // a bare list
		body.Items = list
	} else if err := json.Unmarshal(raw, &body); err != nil {
		return Page{}, fmt.Errorf("opencode: messages of %s: %w", sessionID, err)
	}
	items := body.Items
	if len(items) == 0 {
		items = body.Data
	}
	page := Page{Next: body.Next}
	if page.Next == "" && len(body.Cursor) > 0 {
		var obj struct {
			Next string `json:"next"`
		}
		var str string
		if json.Unmarshal(body.Cursor, &obj) == nil {
			page.Next = obj.Next
		} else if json.Unmarshal(body.Cursor, &str) == nil {
			page.Next = str
		}
	}
	for _, m := range items {
		if msg, ok := m.message(); ok {
			page.Messages = append(page.Messages, msg)
		}
	}
	return page, nil
}

// LastMessage is the newest message with text of a session: one page, newest first, the first of it with text (the row's last_message of #11097).
func (c *Client) LastMessage(ctx context.Context, sessionID string) (Message, bool, error) {
	p, err := c.Messages(ctx, sessionID, MessagesOpts{Desc: true, Limit: 20})
	if err != nil || len(p.Messages) == 0 {
		return Message{}, false, err
	}
	return p.Messages[0], true, nil
}
