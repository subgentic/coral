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
	"regexp"
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
	legacy   bool   // a 1.x server: its messages are on /session/<id>/message in the {info, parts} shape (its /api/session/<id>/message answers an empty list: checked on 1.19.5)
	events   string // the event stream's path: /api/event, or /event on 1.x (see EventPath)
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
	return &Client{base: u, password: password, http: &http.Client{Timeout: 30 * time.Second}, events: "/api/event"}, nil
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
	if c.legacy {
		return c.messagesLegacy(ctx, sessionID, opts)
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

// ping asks the server one authenticated question (GET /api/session) and reports the status it answers: 200 is a server that took this client's password.
func (c *Client) ping(ctx context.Context) (int, error) {
	q := url.Values{}
	q.Set("limit", "1")
	resp, err := c.get(ctx, "/api/session", q, "application/json")
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
	return resp.StatusCode, nil
}

// LastMessage is the newest message with text of a session: one page, newest first, the first of it with text (the row's last_message of #11097).
func (c *Client) LastMessage(ctx context.Context, sessionID string) (Message, bool, error) {
	return c.LastMessageSkipping(ctx, sessionID, nil)
}

// LastMessageSkipping is LastMessage past the messages skip says are not what was said (what Coral itself typed into the agent). A message with no text, a tool call or result alone, is never one: the page
// parser drops it.
func (c *Client) LastMessageSkipping(ctx context.Context, sessionID string, skip func(Message) bool) (Message, bool, error) {
	p, err := c.Messages(ctx, sessionID, MessagesOpts{Desc: true, Limit: 20})
	if err != nil {
		return Message{}, false, err
	}
	for _, m := range p.Messages {
		if skip == nil || !skip(m) {
			return m, true, nil
		}
	}
	return Message{}, false, nil
}

// What AllMessages keeps in memory: a session longer than maxAllMessages, or holding more than maxAllBytes of text, shows its newest messages only, and one message is cut at maxMessageBytes.
const (
	maxAllMessages  = 5000
	maxMessageBytes = 200 << 10
)

// maxAllBytes is a variable so a test can use a small budget.
var maxAllBytes = 16 << 20

// AllMessages is a session's messages, oldest first. It reads NEWEST first, a page at a time, and stops when it has maxAllMessages or maxAllBytes of text: the newest are what is kept, and a long session is never
// read whole.
func (c *Client) AllMessages(ctx context.Context, sessionID string) ([]Message, error) {
	var newest []Message
	bytes, cursor := 0, ""
read:
	for pages := 0; pages < 100; pages++ {
		p, err := c.Messages(ctx, sessionID, MessagesOpts{Desc: true, Limit: 100, Cursor: cursor})
		if err != nil {
			return nil, err
		}
		for _, m := range p.Messages {
			if len(m.Text) > maxMessageBytes {
				m.Text = strings.ToValidUTF8(m.Text[:maxMessageBytes], "")
			}
			if len(newest) >= maxAllMessages || bytes+len(m.Text) > maxAllBytes {
				break read
			}
			bytes += len(m.Text)
			newest = append(newest, m)
		}
		if p.Next == "" || p.Next == cursor || len(p.Messages) == 0 {
			break
		}
		cursor = p.Next
	}
	for i, j := 0, len(newest)-1; i < j; i, j = i+1, j-1 {
		newest[i], newest[j] = newest[j], newest[i]
	}
	return newest, nil
}

// EventPath is where a server of this major version streams the events that say a turn began and ended. On 1.x the durable stream at /api/event carries messages and sessions' updates but NOT session.status or
// session.idle, and /event shows only the folder the request is scoped to (a TUI attached with --dir works in the agent's folder, not the server's): /global/event, every folder's events wrapped with their
// directory, is the one (checked on 1.19.5, #137997).
func EventPath(major int) string {
	if major == 1 {
		return "/global/event"
	}
	return "/api/event"
}

// ForVersion is the client of a server of this major version: the event stream is read where that version streams the turn's state.
func (c *Client) ForVersion(major int) *Client {
	cp := *c
	cp.events = EventPath(major)
	cp.legacy = major == 1
	return &cp
}

// legacyMessage is a message as a 1.x server sends it: its info, and its parts (text, tool calls, step markers).
type legacyMessage struct {
	Info struct {
		ID   string `json:"id"`
		Role string `json:"role"`
		Time struct {
			Created float64 `json:"created"`
		} `json:"time"`
	} `json:"info"`
	Parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"parts"`
}

var cursorRe = regexp.MustCompile(`^[A-Za-z0-9_=-]{1,512}$`)

// messagesLegacy is Messages for a 1.x server: GET /session/<id>/message?limit=N&before=<cursor> gives the newest N messages, oldest first among them, and the cursor of the older page in the X-Next-Cursor header
// (absent on the oldest). A page is turned the way the caller asked: newest first when Desc.
func (c *Client) messagesLegacy(ctx context.Context, sessionID string, opts MessagesOpts) (Page, error) {
	q := url.Values{}
	if opts.Limit > 0 {
		q.Set("limit", strconv.Itoa(opts.Limit))
	}
	if opts.Cursor != "" {
		q.Set("before", opts.Cursor)
	}
	resp, err := c.get(ctx, "/session/"+sessionID+"/message", q, "application/json")
	if err != nil {
		return Page{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		return Page{}, fmt.Errorf("opencode: messages of %s: HTTP %d", sessionID, resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	if err != nil {
		return Page{}, err
	}
	if len(raw) > maxBody {
		return Page{}, errors.New("opencode: the answer is too large")
	}
	var list []legacyMessage
	if err := json.Unmarshal(raw, &list); err != nil {
		return Page{}, fmt.Errorf("opencode: messages of %s: %w", sessionID, err)
	}
	var page Page
	for _, m := range list {
		if m.Info.Role != "user" && m.Info.Role != "assistant" {
			continue
		}
		var parts []string
		for _, p := range m.Parts {
			if p.Type == "text" && p.Text != "" {
				parts = append(parts, p.Text)
			}
		}
		text := strings.Join(parts, "\n")
		if text == "" {
			continue // a turn of tool calls and step markers alone says nothing
		}
		at := ""
		if m.Info.Time.Created > 0 {
			at = strconv.FormatInt(int64(m.Info.Time.Created), 10)
		}
		page.Messages = append(page.Messages, Message{ID: m.Info.ID, Role: m.Info.Role, Text: text, At: at})
	}
	if opts.Desc {
		for i, j := 0, len(page.Messages)-1; i < j; i, j = i+1, j-1 {
			page.Messages[i], page.Messages[j] = page.Messages[j], page.Messages[i]
		}
	}
	if next := resp.Header.Get("X-Next-Cursor"); cursorRe.MatchString(next) {
		page.Next = next
	}
	return page, nil
}
