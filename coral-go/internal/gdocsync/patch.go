package gdocsync

// Updating the Doc by sending only what changed (#19932, the Operator's "we can just send the changes"): read the Doc's structure (documents.get), compare its paragraphs with
// the revised Markdown's, and send documents.batchUpdate requests for the changed ranges only, from the end of the Doc back to the start so an earlier index never moves under a
// later request, with writeControl.requiredRevisionId so a concurrent edit by a person makes the call fail instead of being overwritten. A paragraph that changed in part has only
// its middle replaced, so a comment on the words around the change keeps the text it was on.
//
// Scope of the proof of concept: paragraphs, headings and bullets. Tables, code blocks, images and nested lists are not mapped (they would be sent as plain paragraphs);
// that is a limit to say aloud, not a hidden one.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"unicode/utf16"
)

// Para is one paragraph of the Doc or of the Markdown: its text without the paragraph mark, its style and whether it is a bullet.
type Para struct {
	Text   string
	Style  string // NORMAL_TEXT, HEADING_1 .. HEADING_6
	Bullet bool
}

// ParseMarkdown reads the Markdown into paragraphs: a blank line ends one, "#" lines are headings, "- " and "* " lines are bullets (one paragraph each), anything else is joined into a
// normal paragraph. Inline marks (bold, links) are dropped to their text, which is what the Doc's text run holds before its own styling.
func ParseMarkdown(md string) []Para {
	var out []Para
	var cur []string
	flush := func() {
		if len(cur) > 0 {
			out = append(out, Para{Text: strings.Join(cur, " "), Style: "NORMAL_TEXT"})
			cur = nil
		}
	}
	for _, line := range strings.Split(strings.ReplaceAll(md, "\r\n", "\n"), "\n") {
		t := strings.TrimSpace(line)
		switch {
		case t == "":
			flush()
		case strings.HasPrefix(t, "#"):
			flush()
			n := 0
			for n < len(t) && t[n] == '#' {
				n++
			}
			if n <= 6 && n < len(t) && t[n] == ' ' {
				out = append(out, Para{Text: plain(strings.TrimSpace(t[n:])), Style: "HEADING_" + string(rune('0'+n))})
			} else {
				cur = append(cur, plain(t))
			}
		case strings.HasPrefix(t, "- ") || strings.HasPrefix(t, "* "):
			flush()
			out = append(out, Para{Text: plain(strings.TrimSpace(t[2:])), Style: "NORMAL_TEXT", Bullet: true})
		default:
			cur = append(cur, plain(t))
		}
	}
	flush()
	return out
}

// plain drops the inline marks of one line: **bold**, *italic*, `code`, [text](url) become their text.
func plain(s string) string {
	for {
		i := strings.Index(s, "](")
		if i < 0 {
			break
		}
		open := strings.LastIndex(s[:i], "[")
		cl := strings.Index(s[i:], ")")
		if open < 0 || cl < 0 {
			break
		}
		s = s[:open] + s[open+1:i] + s[i+cl+1:]
	}
	return strings.NewReplacer("**", "", "__", "", "`", "").Replace(s)
}

// docDoc is the part of documents.get the patch reads.
type docDoc struct {
	RevisionID string `json:"revisionId"`
	Body       struct {
		Content []struct {
			StartIndex int `json:"startIndex"`
			EndIndex   int `json:"endIndex"`
			Paragraph  *struct {
				Elements []struct {
					TextRun *struct {
						Content string `json:"content"`
					} `json:"textRun"`
				} `json:"elements"`
				ParagraphStyle struct {
					NamedStyleType string `json:"namedStyleType"`
				} `json:"paragraphStyle"`
				Bullet *struct{} `json:"bullet"`
			} `json:"paragraph"`
		} `json:"content"`
	} `json:"body"`
}

// DocParas is a paragraph read from the Doc with the index range it occupies (the paragraph mark included in End).
type DocParas struct {
	Para
	Start, End int
}

// Read returns the Doc's paragraphs with their index ranges and its revision id (documents.get).
func (c *Client) Read(ctx context.Context, docID string) ([]DocParas, string, error) {
	var d docDoc
	if err := c.do(ctx, http.MethodGet, "/v1/documents/"+url.PathEscape(docID), url.Values{"fields": {"revisionId,body(content(startIndex,endIndex,paragraph(elements(textRun(content)),paragraphStyle(namedStyleType),bullet)))"}}, "", nil, &d); err != nil {
		return nil, "", err
	}
	var out []DocParas
	for _, e := range d.Body.Content {
		if e.Paragraph == nil {
			continue // a section break or a table: not mapped
		}
		var sb strings.Builder
		for _, el := range e.Paragraph.Elements {
			if el.TextRun != nil {
				sb.WriteString(el.TextRun.Content)
			}
		}
		style := e.Paragraph.ParagraphStyle.NamedStyleType
		if style == "" {
			style = "NORMAL_TEXT"
		}
		out = append(out, DocParas{Para: Para{Text: strings.TrimSuffix(sb.String(), "\n"), Style: style, Bullet: e.Paragraph.Bullet != nil}, Start: e.StartIndex, End: e.EndIndex})
	}
	return out, d.RevisionID, nil
}

// ulen is a string's length in UTF-16 code units, which is what the Docs API counts in.
func ulen(s string) int { return len(utf16.Encode([]rune(s))) }

// Request is one entry of documents.batchUpdate's requests (kept as JSON-ready maps so the fake and the live API see the same bytes).
type Request map[string]any

type op struct {
	at   int // the index it works at; requests are sent in descending order of at
	seq  int // a later step of the same position goes after an earlier one in the sorted order
	reqs []Request
}

func rng(s, e int) map[string]any { return map[string]any{"startIndex": s, "endIndex": e} }

// BuildPatch compares the Doc's paragraphs with the revised ones and returns the requests for the changes only, ordered from the end of the Doc to the start.
func BuildPatch(cur []DocParas, want []Para) []Request {
	key := func(p Para) string {
		return p.Style + "|" + map[bool]string{true: "b", false: "n"}[p.Bullet] + "|" + strings.TrimSpace(p.Text)
	}
	n, m := len(cur), len(want)
	lcs := make([][]int, n+1)
	for i := range lcs {
		lcs[i] = make([]int, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if key(cur[i].Para) == key(want[j]) {
				lcs[i][j] = lcs[i+1][j+1] + 1
			} else if lcs[i+1][j] >= lcs[i][j+1] {
				lcs[i][j] = lcs[i+1][j]
			} else {
				lcs[i][j] = lcs[i][j+1]
			}
		}
	}
	bodyEnd := 1
	if n > 0 {
		bodyEnd = cur[n-1].End
	}
	var ops []op
	seq := 0
	// walk both lists; runs of deletions and insertions between two kept paragraphs are paired up (a changed paragraph) before the rest are plain deletes or inserts
	i, j := 0, 0
	for i < n || j < m {
		if i < n && j < m && key(cur[i].Para) == key(want[j]) {
			i++
			j++
			continue
		}
		i0 := i
		var dels []DocParas
		var adds []Para
		for (i < n || j < m) && !(i < n && j < m && key(cur[i].Para) == key(want[j])) {
			if j >= m || (i < n && lcs[i+1][j] >= lcs[i][j+1]) {
				dels = append(dels, cur[i])
				i++
			} else {
				adds = append(adds, want[j])
				j++
			}
		}
		// the index where new paragraphs go when nothing is paired: the start of the paragraph after the run (or the end of the body)
		anchor := 0
		if len(dels) > 0 {
			anchor = dels[0].Start
		} else if i < n {
			anchor = cur[i].Start
		} else if n > 0 {
			anchor = cur[n-1].End
		} else {
			anchor = 1
		}
		pairs := len(dels)
		if len(adds) < pairs {
			pairs = len(adds)
		}
		for k := 0; k < pairs; k++ {
			d, a := dels[k], adds[k]
			seq++
			reqs := editMiddle(d, a.Text)
			if d.Style != a.Style || d.Bullet != a.Bullet { // restyled in place: the paragraph keeps its place and its words, and its length is the new text's
				end := d.Start + ulen(a.Text) + 1
				reqs = append(reqs, Request{"updateParagraphStyle": map[string]any{"range": rng(d.Start, end), "paragraphStyle": map[string]any{"namedStyleType": a.Style}, "fields": "namedStyleType"}})
				if a.Bullet && !d.Bullet {
					reqs = append(reqs, Request{"createParagraphBullets": map[string]any{"range": rng(d.Start, end), "bulletPreset": "BULLET_DISC_CIRCLE_SQUARE"}})
				} else if !a.Bullet && d.Bullet {
					reqs = append(reqs, Request{"deleteParagraphBullets": map[string]any{"range": rng(d.Start, end)}})
				}
			}
			ops = append(ops, op{at: d.Start, seq: seq, reqs: reqs})
		}
		if len(dels) > pairs {
			seq++
			ops = append(ops, op{at: dels[pairs].Start, seq: seq, reqs: deleteParas(dels[pairs:], bodyEnd, prevOf(cur, i0+pairs))})
		}
		if len(adds) > pairs {
			at := anchor
			if pairs > 0 {
				at = dels[pairs-1].End
			}
			seq++
			ops = append(ops, op{at: at, seq: seq, reqs: insertParas(at, adds[pairs:], bodyEnd)})
		}
	}
	sort.SliceStable(ops, func(a, b int) bool {
		if ops[a].at != ops[b].at {
			return ops[a].at > ops[b].at
		}
		return ops[a].seq > ops[b].seq
	})
	var out []Request
	for _, o := range ops {
		out = append(out, o.reqs...)
	}
	return out
}

// editMiddle replaces only the part of a paragraph's text that differs: the common start and end stay, so a comment on them keeps its words.
func editMiddle(d DocParas, newText string) []Request {
	old := []rune(d.Text)
	nw := []rune(newText)
	p := 0
	for p < len(old) && p < len(nw) && old[p] == nw[p] {
		p++
	}
	s := 0
	for s < len(old)-p && s < len(nw)-p && old[len(old)-1-s] == nw[len(nw)-1-s] {
		s++
	}
	start := d.Start + ulen(string(old[:p]))
	end := d.Start + ulen(string(old[:len(old)-s]))
	var reqs []Request
	mid := string(nw[p : len(nw)-s])
	if end > start { // delete first, then insert at the same start: the insert is the one at the lower position in the sorted order, so it is sent after the delete
		reqs = append(reqs, Request{"deleteContentRange": map[string]any{"range": rng(start, end)}})
	}
	if mid != "" {
		reqs = append(reqs, Request{"insertText": map[string]any{"location": map[string]any{"index": start}, "text": mid}})
	}
	return reqs
}

func prevOf(cur []DocParas, i int) *DocParas {
	if i > 0 && i-1 < len(cur) {
		return &cur[i-1]
	}
	return nil
}

func deleteParas(ps []DocParas, bodyEnd int, prev *DocParas) []Request {
	start, end := ps[0].Start, ps[len(ps)-1].End
	if end < bodyEnd {
		return []Request{{"deleteContentRange": map[string]any{"range": rng(start, end)}}}
	}
	// the body's last paragraph mark cannot be deleted: take the mark before the run instead. A paragraph's style lives on its mark, so the paragraph before the run (now ending in the
	// surviving final mark) is given its own style and bullet back.
	end = bodyEnd - 1
	if start > 1 {
		start--
	}
	reqs := []Request{{"deleteContentRange": map[string]any{"range": rng(start, end)}}}
	if prev != nil && ps[0].Start > 1 {
		pe := prev.Start + ulen(prev.Text) + 1
		reqs = append(reqs, Request{"updateParagraphStyle": map[string]any{"range": rng(prev.Start, pe), "paragraphStyle": map[string]any{"namedStyleType": prev.Style}, "fields": "namedStyleType"}})
		if prev.Bullet {
			reqs = append(reqs, Request{"createParagraphBullets": map[string]any{"range": rng(prev.Start, pe), "bulletPreset": "BULLET_DISC_CIRCLE_SQUARE"}})
		} else {
			reqs = append(reqs, Request{"deleteParagraphBullets": map[string]any{"range": rng(prev.Start, pe)}})
		}
	}
	return reqs
}

func insertParas(at int, ps []Para, bodyEnd int) []Request {
	var sb strings.Builder
	insertAt := at
	if at >= bodyEnd { // after the last paragraph: insert before its mark, starting with a paragraph break
		insertAt = bodyEnd - 1
		for _, p := range ps {
			sb.WriteString("\n")
			sb.WriteString(p.Text)
		}
	} else {
		for _, p := range ps {
			sb.WriteString(p.Text)
			sb.WriteString("\n")
		}
	}
	reqs := []Request{{"insertText": map[string]any{"location": map[string]any{"index": insertAt}, "text": sb.String()}}}
	pos := at
	for _, p := range ps {
		end := pos + ulen(p.Text) + 1
		reqs = append(reqs, Request{"updateParagraphStyle": map[string]any{"range": rng(pos, end), "paragraphStyle": map[string]any{"namedStyleType": p.Style}, "fields": "namedStyleType"}})
		if p.Bullet {
			reqs = append(reqs, Request{"createParagraphBullets": map[string]any{"range": rng(pos, end), "bulletPreset": "BULLET_DISC_CIRCLE_SQUARE"}})
		}
		pos = end
	}
	return reqs
}

// ErrDocChanged is returned when the Doc moved since it was read: a person edited it, and Coral's patch was refused instead of overwriting them.
var ErrDocChanged = errors.New("gdocsync: the Doc was edited while the patch was prepared; read it again and redo the patch")

// ErrEditedSinceSync: the Doc's revision is not the one Coral left it at, so someone edited it in Google since the last sync; nothing was sent.
var ErrEditedSinceSync = errors.New("gdocsync: the Doc was edited in Google since the last sync; nothing was changed")

// IsRateLimited says Google answered 429 (too many requests): the caller backs off.
func IsRateLimited(err error) bool {
	var he *httpError
	return errors.As(err, &he) && he.Status == http.StatusTooManyRequests
}

// Patch changes the Doc to match revisedMarkdown, sending only the ranges that differ. It returns the number of requests sent; the Doc is read again just before, and a write
// that finds the Doc changed meanwhile is refused (ErrDocChanged), never applied on top of someone's edit.
func (c *Client) Patch(ctx context.Context, docID, revisedMarkdown string) (int, error) {
	n, _, err := c.PatchSince(ctx, docID, revisedMarkdown, "")
	return n, err
}

// PatchSince is Patch for the automatic sync: lastRev is the revision the Doc had when Coral last left it ("" for none known). When the Doc is at another revision, someone edited it
// since, and ErrEditedSinceSync comes back with nothing sent. On success it returns the Doc's revision after the change (read again), to be kept for the next sync.
func (c *Client) PatchSince(ctx context.Context, docID, revisedMarkdown, lastRev string) (int, string, error) {
	cur, rev, err := c.Read(ctx, docID)
	if err != nil {
		return 0, "", err
	}
	if lastRev != "" && rev != lastRev {
		return 0, "", ErrEditedSinceSync
	}
	reqs := BuildPatch(cur, ParseMarkdown(revisedMarkdown))
	if len(reqs) == 0 {
		return 0, rev, nil
	}
	body, _ := json.Marshal(map[string]any{"requests": reqs, "writeControl": map[string]any{"requiredRevisionId": rev}})
	err = c.do(ctx, http.MethodPost, "/v1/documents/"+url.PathEscape(docID)+":batchUpdate", nil, "application/json", body, nil)
	var he *httpError
	if errors.As(err, &he) && he.Status == http.StatusBadRequest && strings.Contains(strings.ToLower(he.Body), "revision") && !errors.Is(err, ErrOutcomeUnknown) {
		return 0, "", ErrDocChanged
	}
	if err != nil {
		return 0, "", err // nothing is known to have been applied: the count is of requests sent and accepted
	}
	_, newRev, err := c.Read(ctx, docID)
	if err != nil {
		newRev = "" // the change was applied; the next sync has no revision to compare and takes the Doc as it is
	}
	return len(reqs), newRev, nil
}
