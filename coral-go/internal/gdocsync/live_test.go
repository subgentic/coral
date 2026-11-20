package gdocsync

// The five live checks of #19953. Skipped unless GDOC_LIVE=1. Runs against ONE Doc this test creates in the signed-in throwaway account (keychain account "file", scope drive.file only)
// and deletes at the end. It writes what Google answered, never a token, to $GDOC_LIVE_OUT.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"testing"
	"time"
)

func TestLive(t *testing.T) {
	if os.Getenv("GDOC_LIVE") != "1" {
		t.Skip("live checks: set GDOC_LIVE=1 (throwaway account signed in with gdoc-login)")
	}
	out := os.Getenv("GDOC_LIVE_OUT")
	if out == "" {
		t.Fatal("set GDOC_LIVE_OUT to a results file")
	}
	var res strings.Builder
	rec := func(k, v string) {
		fmt.Fprintf(&res, "## %s\n%s\n\n", k, v)
		os.WriteFile(out, []byte(res.String()), 0o600)
	}
	ctx := context.Background()
	c := NewClient(KeychainTokenFunc("file"))
	why := func(err error) string {
		if err == nil {
			return "ok"
		}
		var he *httpError
		if errors.As(err, &he) {
			b := he.Body
			if len(b) > 600 {
				b = b[:600] + "..."
			}
			return fmt.Sprintf("HTTP %d %s", he.Status, strings.Join(strings.Fields(b), " "))
		}
		return err.Error()
	}
	raw := func(method, path string, q url.Values, body any, dst any) error {
		var b []byte
		ct := ""
		if body != nil {
			b, _ = json.Marshal(body)
			ct = "application/json"
		}
		return c.do(ctx, method, path, q, ct, b, dst)
	}

	md := "# Live check\n\nAlpha paragraph one.\n\nBravo paragraph two.\n\nCharlie paragraph three.\n"
	id, err := c.Push(ctx, "Coral gdocsync live check (safe to delete)", md)
	if err != nil {
		rec("push", why(err))
		t.Fatal("push failed: ", why(err))
	}
	rec("setup: Push (Drive files.create, text/markdown to a Google Doc, drive.file)", "ok")
	t.Cleanup(func() {
		err := raw("DELETE", "/drive/v3/files/"+id, nil, nil, nil)
		rec("cleanup: delete the test Doc", why(err))
	})

	// check 5: do the Docs v1 calls work with drive.file alone?
	paras, rev0, err := c.Read(ctx, id)
	var sty []string
	for _, p := range paras {
		sty = append(sty, fmt.Sprintf("%s:%q", p.Style, p.Text))
	}
	rec("check 5a: documents.get with drive.file only", why(err)+"; revision "+rev0+"; paragraphs "+strings.Join(sty, " | "))
	_, err = c.Comments(ctx, id)
	rec("check 5b: comments.list with drive.file only", why(err))

	// comments through Drive: one on text that will stay, one on text that will be deleted, one on the whole Doc
	mk := func(content, quote string) string {
		body := map[string]any{"content": content}
		if quote != "" {
			body["quotedFileContent"] = map[string]string{"mimeType": "text/plain", "value": quote}
		}
		var cm struct {
			ID     string          `json:"id"`
			Anchor json.RawMessage `json:"anchor"`
		}
		err := raw("POST", "/drive/v3/files/"+id+"/comments", url.Values{"fields": {"id,anchor,quotedFileContent"}}, body, &cm)
		rec("comments.create "+content, why(err)+" anchor="+string(cm.Anchor))
		return cm.ID
	}
	cKeep := mk("on text that stays (Bravo)", "Bravo paragraph two.")
	cGone := mk("on text that gets deleted (Charlie)", "Charlie paragraph three.")
	cEdit := mk("on text that gets edited (Alpha)", "Alpha paragraph one.")
	cWhole := mk("on the whole Doc", "")

	dump := func(label string) {
		var l struct {
			Comments []map[string]any `json:"comments"`
		}
		err := raw("GET", "/drive/v3/files/"+id+"/comments", url.Values{"fields": {"comments(id,content,resolved,deleted,anchor,quotedFileContent,replies(content,action))"}, "includeDeleted": {"true"}, "pageSize": {"100"}}, nil, &l)
		var lines []string
		names := map[string]string{cKeep: "keep", cGone: "gone", cEdit: "edit", cWhole: "whole"}
		for _, m := range l.Comments {
			b, _ := json.Marshal(m)
			lines = append(lines, names[fmt.Sprint(m["id"])]+": "+string(b))
		}
		sort.Strings(lines)
		rec(label, why(err)+"\n"+strings.Join(lines, "\n"))
	}
	dump("comments before the in-place edit")

	// check 1 and 3a: an in-place batchUpdate that edits Alpha, keeps Bravo and deletes Charlie
	n, err := c.Patch(ctx, id, "# Live check\n\nAlpha paragraph ONE, edited.\n\nBravo paragraph two.\n")
	rec("check 1/3: Patch in place (edit Alpha, keep Bravo, delete Charlie)", why(err)+fmt.Sprintf("; %d requests", n))
	dump("check 1/3: comments after the in-place batchUpdate (do they still exist, resolved, quoted, anchor)")

	// reply and resolve
	err = c.Reply(ctx, id, cKeep, "handled by the sync", "resolve")
	rec("replies.create with action resolve", why(err))
	dump("comments after a resolve reply")

	// check 2: can documents.batchUpdate create a comment? the public discovery document lists every request type
	func() {
		hc := &http.Client{Timeout: 30 * time.Second}
		resp, err := hc.Get("https://docs.googleapis.com/$discovery/rest?version=v1")
		if err != nil {
			rec("check 2: Docs v1 discovery document", err.Error())
			return
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		var d struct {
			Schemas map[string]struct {
				Properties map[string]json.RawMessage `json:"properties"`
			} `json:"schemas"`
		}
		json.Unmarshal(b, &d)
		var req, hit []string
		for k := range d.Schemas["Request"].Properties {
			req = append(req, k)
		}
		sort.Strings(req)
		for k := range d.Schemas {
			if strings.Contains(strings.ToLower(k), "comment") {
				hit = append(hit, k)
			}
		}
		for _, k := range req {
			if strings.Contains(strings.ToLower(k), "comment") {
				hit = append(hit, "Request."+k)
			}
		}
		rec("check 2: batchUpdate request types in Google's own discovery document", fmt.Sprintf("HTTP %d; %d request types: %s\nanything named *comment*: %v", resp.StatusCode, len(req), strings.Join(req, ", "), hit))
	}()

	// check 3b: what Google answers on a stale requiredRevisionId (nothing is changed by it)
	_, rev1, _ := c.Read(ctx, id)
	err = raw("POST", "/v1/documents/"+id+":batchUpdate", nil, map[string]any{
		"requests":     []any{map[string]any{"insertText": map[string]any{"location": map[string]any{"index": 1}, "text": "x"}}},
		"writeControl": map[string]any{"requiredRevisionId": rev0}}, nil)
	rec("check 3: batchUpdate with a stale requiredRevisionId (rev "+rev0+" while the Doc is at "+rev1+")", why(err))

	// check 4: suggestions view modes accepted by documents.get; native Markdown import gave real headings
	for _, m := range []string{"SUGGESTIONS_INLINE", "PREVIEW_SUGGESTIONS_ACCEPTED", "PREVIEW_WITHOUT_SUGGESTIONS"} {
		var d struct {
			RevisionID string `json:"revisionId"`
		}
		err := raw("GET", "/v1/documents/"+id, url.Values{"suggestionsViewMode": {m}, "fields": {"revisionId"}}, nil, &d)
		rec("check 4: documents.get suggestionsViewMode="+m, why(err)+" revision "+d.RevisionID)
	}

	// whole-file replace through Drive (the other update path): do comments survive it?
	err = c.Update(ctx, id, "# Live check\n\nAlpha paragraph ONE, edited.\n\nBravo paragraph two, replaced whole.\n")
	rec("files.update with new Markdown (whole-file replace)", why(err))
	dump("comments after the whole-file replace")
	t.Logf("results written to %s", out)
}

// Found in Google's discovery document by check 2: documents.batchUpdate has an insertComment request that takes a Range. Does it make a comment that is really anchored,
// does Drive list it, and does it survive an in-place edit of other text and of its own text?
func TestLiveInsertComment(t *testing.T) {
	if os.Getenv("GDOC_LIVE") != "1" {
		t.Skip("live checks: set GDOC_LIVE=1")
	}
	out := os.Getenv("GDOC_LIVE_OUT")
	var res strings.Builder
	rec := func(k, v string) {
		fmt.Fprintf(&res, "## %s\n%s\n\n", k, v)
		os.WriteFile(out+".insert.md", []byte(res.String()), 0o600)
	}
	ctx := context.Background()
	c := NewClient(KeychainTokenFunc("file"))
	why := func(err error) string {
		var he *httpError
		if err == nil {
			return "ok"
		}
		if errors.As(err, &he) {
			return fmt.Sprintf("HTTP %d %s", he.Status, strings.Join(strings.Fields(he.Body), " "))
		}
		return err.Error()
	}
	raw := func(method, path string, q url.Values, body any, dst any) error {
		var b []byte
		ct := ""
		if body != nil {
			b, _ = json.Marshal(body)
			ct = "application/json"
		}
		return c.do(ctx, method, path, q, ct, b, dst)
	}
	id, err := c.Push(ctx, "Coral gdocsync live check 2 (safe to delete)", "# Live check\n\nAlpha paragraph one.\n\nBravo paragraph two.\n\nCharlie paragraph three.\n")
	if err != nil {
		t.Fatal(why(err))
	}
	t.Cleanup(func() { rec("cleanup: delete the test Doc", why(raw("DELETE", "/drive/v3/files/"+id, nil, nil, nil))) })
	paras, rev0, err := c.Read(ctx, id)
	rec("documents.get now goes to docs.googleapis.com", why(err)+"; revision "+rev0+fmt.Sprintf("; %d paragraphs", len(paras)))
	if err != nil || len(paras) < 3 {
		t.Fatal("cannot read the Doc")
	}
	var reqs []any
	for _, p := range paras { // the Alpha, Bravo and Charlie lines (the import also made empty paragraphs between them: skip those)
		if !strings.HasSuffix(p.Text, "paragraph one.") && !strings.HasSuffix(p.Text, "paragraph two.") && !strings.HasSuffix(p.Text, "paragraph three.") {
			continue
		}
		reqs = append(reqs, map[string]any{"insertComment": map[string]any{"content": "anchored on: " + p.Text, "range": map[string]any{"startIndex": p.Start, "endIndex": p.End - 1}}})
	}
	var resp json.RawMessage
	err = raw("POST", "/v1/documents/"+id+":batchUpdate", nil, map[string]any{"requests": reqs}, &resp)
	rec("insertComment x3 through documents.batchUpdate (drive.file only)", why(err)+" response="+string(resp))
	dump := func(label string) {
		var l struct {
			Comments []map[string]any `json:"comments"`
		}
		err := raw("GET", "/drive/v3/files/"+id+"/comments", url.Values{"fields": {"comments(id,content,resolved,deleted,anchor,quotedFileContent,replies(content,action))"}, "includeDeleted": {"true"}, "pageSize": {"100"}}, nil, &l)
		var lines []string
		for _, m := range l.Comments {
			b, _ := json.Marshal(m)
			lines = append(lines, string(b))
		}
		sort.Strings(lines)
		rec(label, why(err)+fmt.Sprintf("; %d comments\n", len(l.Comments))+strings.Join(lines, "\n"))
	}
	dump("Drive comments.list after insertComment")
	n, err := c.Patch(ctx, id, "# Live check\n\nAlpha paragraph ONE, edited.\n\nBravo paragraph two.\n")
	rec("Patch in place: edit Alpha, keep Bravo, delete Charlie", why(err)+fmt.Sprintf("; %d requests", n))
	dump("Drive comments.list after the in-place edit")
	// a stale revision, and the suggestions view
	_, rev1, _ := c.Read(ctx, id)
	err = raw("POST", "/v1/documents/"+id+":batchUpdate", nil, map[string]any{
		"requests":     []any{map[string]any{"insertText": map[string]any{"location": map[string]any{"index": 1}, "text": "x"}}},
		"writeControl": map[string]any{"requiredRevisionId": rev0}}, nil)
	rec("stale requiredRevisionId (sent "+rev0+", Doc at "+rev1+")", why(err))
	for _, m := range []string{"SUGGESTIONS_INLINE", "PREVIEW_SUGGESTIONS_ACCEPTED", "PREVIEW_WITHOUT_SUGGESTIONS"} {
		var d struct {
			RevisionID string `json:"revisionId"`
		}
		err := raw("GET", "/v1/documents/"+id, url.Values{"suggestionsViewMode": {m}, "fields": {"revisionId"}}, nil, &d)
		rec("documents.get suggestionsViewMode="+m, why(err)+" revision "+d.RevisionID)
	}
	var ps []string
	paras, _, _ = c.Read(ctx, id)
	for _, p := range paras {
		ps = append(ps, fmt.Sprintf("%s:%q", p.Style, p.Text))
	}
	rec("what the Doc holds after the edits", strings.Join(ps, " | "))
}
