package gdocsync

// A fake Drive v3 and Docs v1 made from the public references: it models the request and response shapes and the index arithmetic of documents.batchUpdate, and nothing of Google's
// own behaviour (how it moves a comment's anchor when text changes is NOT modelled; the findings say what only a live Doc can answer).

import (
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf16"
)

type fakeDrive struct {
	mu          sync.Mutex
	t           *testing.T
	token       string
	paras       []Para
	rev         int
	comments    []*Comment
	pageSize    int
	afterGet    func() // run after a documents.get is answered: a person typing in the Doc
	batchStatus int    // answer the next batchUpdate with this status (a 5xx whose outcome the client cannot know)
	fail429     int    // answer this many requests with 429 first
	calls       []string
	requests    [][]Request    // every batchUpdate body, in order
	raw         map[string]any // when set, documents.get answers with this instead of the paragraphs (a Doc a person styled by hand)
}

func newFake(t *testing.T) (*fakeDrive, *Client) {
	f := &fakeDrive{t: t, token: "tok-SECRET-123", pageSize: 2}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	return f, &Client{base: srv.URL, TokenFunc: func() (string, error) { return "tok-SECRET-123", nil }, Sleep: func(d time.Duration) {}}
}

func (f *fakeDrive) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, r.Method+" "+r.URL.Path)
	if r.Header.Get("Authorization") != "Bearer "+f.token {
		http.Error(w, "unauthenticated: "+r.Header.Get("Authorization"), 401) // a server that echoes the header, to prove the client redacts it
		return
	}
	if f.fail429 > 0 {
		f.fail429--
		w.Header().Set("Retry-After", "1")
		http.Error(w, "slow down", 429)
		return
	}
	p := r.URL.Path
	switch {
	case r.Method == "POST" && p == "/upload/drive/v3/files":
		mt, params, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if !strings.HasPrefix(mt, "multipart/") {
			http.Error(w, "need multipart", 400)
			return
		}
		mr := multipart.NewReader(r.Body, params["boundary"])
		var meta map[string]string
		var md string
		for {
			part, err := mr.NextPart()
			if err != nil {
				break
			}
			b, _ := io.ReadAll(part)
			if strings.HasPrefix(part.Header.Get("Content-Type"), "application/json") {
				json.Unmarshal(b, &meta)
			} else {
				md = string(b)
			}
		}
		if meta["mimeType"] != DocMime {
			http.Error(w, "the target must be a Google Doc", 400)
			return
		}
		f.paras = ParseMarkdown(md)
		f.rev = 1
		json.NewEncoder(w).Encode(map[string]string{"id": "doc1"})
	case r.Method == "PATCH" && strings.HasPrefix(p, "/upload/drive/v3/files/"):
		b, _ := io.ReadAll(r.Body)
		f.paras = ParseMarkdown(string(b))
		f.rev++
		w.Write([]byte(`{"id":"doc1"}`))
	case r.Method == "GET" && p == "/drive/v3/files/doc1/comments":
		start := 0
		if tk := r.URL.Query().Get("pageToken"); tk != "" {
			start, _ = strconv.Atoi(tk)
		}
		end := start + f.pageSize
		next := ""
		if end < len(f.comments) {
			next = strconv.Itoa(end)
		} else {
			end = len(f.comments)
		}
		json.NewEncoder(w).Encode(map[string]any{"nextPageToken": next, "comments": f.comments[start:end]})
	case r.Method == "POST" && strings.HasPrefix(p, "/drive/v3/files/doc1/comments/") && strings.HasSuffix(p, "/replies"):
		id := strings.TrimSuffix(strings.TrimPrefix(p, "/drive/v3/files/doc1/comments/"), "/replies")
		var in struct{ Content, Action string }
		json.NewDecoder(r.Body).Decode(&in)
		for _, c := range f.comments {
			if c.ID == id {
				c.Replies = append(c.Replies, Reply{ID: fmt.Sprint("r", len(c.Replies)+1), Content: in.Content, Action: in.Action, Author: Author{DisplayName: "Coral sync"}})
				if in.Action == "resolve" {
					c.Resolved = true
				}
				w.Write([]byte(`{"id":"r"}`))
				return
			}
		}
		http.Error(w, "no such comment", 404)
	case r.Method == "GET" && p == "/v1/documents/doc1":
		json.NewEncoder(w).Encode(f.structure())
		if f.afterGet != nil {
			f.afterGet()
		}
	case r.Method == "POST" && p == "/v1/documents/doc1:batchUpdate":
		if f.batchStatus != 0 {
			st := f.batchStatus
			f.batchStatus = 0
			http.Error(w, "backend error", st)
			return
		}
		var in struct {
			Requests     []Request `json:"requests"`
			WriteControl struct {
				RequiredRevisionID string `json:"requiredRevisionId"`
			} `json:"writeControl"`
		}
		json.NewDecoder(r.Body).Decode(&in)
		if in.WriteControl.RequiredRevisionID != "" && in.WriteControl.RequiredRevisionID != fmt.Sprint("rev", f.rev) {
			http.Error(w, `{"error":{"message":"The requiredRevisionId does not match the latest revision"}}`, 400)
			return
		}
		f.requests = append(f.requests, in.Requests)
		for i, rq := range in.Requests {
			if err := f.apply(rq); err != nil {
				http.Error(w, fmt.Sprintf("request %d: %v", i, err), 400)
				return
			}
		}
		f.rev++
		w.Write([]byte(`{}`))
	default:
		http.Error(w, "no route "+p, 404)
	}
}

func (f *fakeDrive) structure() map[string]any {
	if f.raw != nil {
		return f.raw
	}
	var content []map[string]any
	pos := 1
	for _, p := range f.paras {
		end := pos + ulen(p.Text) + 1
		para := map[string]any{"elements": []map[string]any{{"textRun": map[string]any{"content": p.Text + "\n"}}}, "paragraphStyle": map[string]any{"namedStyleType": p.Style}}
		if p.Bullet {
			para["bullet"] = map[string]any{}
		}
		content = append(content, map[string]any{"startIndex": pos, "endIndex": end, "paragraph": para})
		pos = end
	}
	return map[string]any{"revisionId": fmt.Sprint("rev", f.rev), "body": map[string]any{"content": content}}
}

func u16(s string) []uint16 { return utf16.Encode([]rune(s)) }
func s16(u []uint16) string { return string(utf16.Decode(u)) }

// locate returns the paragraph holding index i and the offset into its text (the mark is offset len(text)).
func (f *fakeDrive) locate(i int) (int, int, error) {
	pos := 1
	for k, p := range f.paras {
		end := pos + len(u16(p.Text)) + 1
		if i >= pos && i < end {
			return k, i - pos, nil
		}
		pos = end
	}
	return 0, 0, fmt.Errorf("index %d is outside the body", i)
}

func (f *fakeDrive) apply(rq Request) error {
	num := func(m map[string]any, k string) int { v, _ := m[k].(float64); return int(v) }
	switch {
	case rq["insertText"] != nil:
		m := rq["insertText"].(map[string]any)
		idx := num(m["location"].(map[string]any), "index")
		k, off, err := f.locate(idx)
		if err != nil {
			return err
		}
		cur := f.paras[k]
		u := u16(cur.Text)
		head, tail := s16(u[:off]), s16(u[off:])
		pieces := strings.Split(m["text"].(string), "\n")
		var repl []Para
		for n, pc := range pieces {
			txt := pc
			if n == 0 {
				txt = head + pc
			}
			if n == len(pieces)-1 {
				txt += tail
			}
			repl = append(repl, Para{Text: txt, Style: cur.Style, Bullet: cur.Bullet})
		}
		f.paras = append(f.paras[:k], append(repl, f.paras[k+1:]...)...)
	case rq["deleteContentRange"] != nil:
		r := rq["deleteContentRange"].(map[string]any)["range"].(map[string]any)
		s, e := num(r, "startIndex"), num(r, "endIndex")
		if e <= s {
			return fmt.Errorf("empty range [%d,%d)", s, e)
		}
		// flatten, cut, rebuild: a deleted paragraph mark joins the two paragraphs around it
		var flat []uint16
		var marks []int // index in flat of each paragraph mark
		for _, p := range f.paras {
			flat = append(flat, u16(p.Text)...)
			marks = append(marks, len(flat))
			flat = append(flat, '\n')
		}
		if e-1 > len(flat) || s < 1 {
			return fmt.Errorf("range [%d,%d) is outside the body", s, e)
		}
		if e-1 == len(flat) {
			return fmt.Errorf("range [%d,%d) deletes the final paragraph mark", s, e)
		}
		cutS, cutE := s-1, e-1
		styles := make([]Para, len(f.paras))
		copy(styles, f.paras)
		var out []Para
		var cur []uint16
		for i, ch := range flat {
			if i >= cutS && i < cutE {
				continue
			}
			if ch == '\n' {
				k := 0
				for k < len(marks) && marks[k] != i {
					k++
				}
				st := styles[k]
				st.Text = s16(cur)
				out = append(out, st)
				cur = nil
			} else {
				cur = append(cur, ch)
			}
		}
		f.paras = out
	case rq["updateParagraphStyle"] != nil:
		m := rq["updateParagraphStyle"].(map[string]any)
		r := m["range"].(map[string]any)
		st := m["paragraphStyle"].(map[string]any)["namedStyleType"].(string)
		f.eachPara(num(r, "startIndex"), num(r, "endIndex"), func(p *Para) { p.Style = st })
	case rq["createParagraphBullets"] != nil:
		r := rq["createParagraphBullets"].(map[string]any)["range"].(map[string]any)
		f.eachPara(num(r, "startIndex"), num(r, "endIndex"), func(p *Para) { p.Bullet = true })
	case rq["deleteParagraphBullets"] != nil:
		r := rq["deleteParagraphBullets"].(map[string]any)["range"].(map[string]any)
		f.eachPara(num(r, "startIndex"), num(r, "endIndex"), func(p *Para) { p.Bullet = false })
	default:
		return fmt.Errorf("unsupported request %v", rq)
	}
	return nil
}

func (f *fakeDrive) eachPara(s, e int, fn func(*Para)) {
	pos := 1
	for k := range f.paras {
		end := pos + len(u16(f.paras[k].Text)) + 1
		if pos < e && end > s {
			fn(&f.paras[k])
		}
		pos = end
	}
}

func (f *fakeDrive) countCalls(call string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if c == call {
			n++
		}
	}
	return n
}
