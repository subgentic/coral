package gdocsync

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const v1 = `# Plan

The launch is on Friday and the team is ready.

- ship the build
- tell the users

## Risks

Nothing known.
`

func paras(f *fakeDrive) []Para { return append([]Para(nil), f.paras...) }

func TestPushMakesADocFromMarkdownAndUpdateKeepsItsId(t *testing.T) {
	f, c := newFake(t)
	id, err := c.Push(context.Background(), "Plan", v1)
	require.NoError(t, err)
	assert.Equal(t, "doc1", id)
	assert.Equal(t, ParseMarkdown(v1), paras(f), "Drive converted the Markdown")
	require.NoError(t, c.Update(context.Background(), id, v1+"\nMore.\n"))
	assert.Equal(t, "More.", f.paras[len(f.paras)-1].Text)
}

// the Operator: "we can just send the changes". Each case revises the Markdown and the patched Doc must equal the revised paragraphs, with only the changed ranges sent.
func TestPatchSendsOnlyTheChangesAndTheDocEndsUpAsTheRevision(t *testing.T) {
	cases := map[string]string{
		"a word changed in a paragraph": strings.Replace(v1, "on Friday", "on Monday", 1),
		"a paragraph inserted":          strings.Replace(v1, "## Risks", "Mind the gap.\n\n## Risks", 1),
		"a paragraph appended":          v1 + "\nThe end.\n",
		"a middle paragraph deleted":    strings.Replace(v1, "The launch is on Friday and the team is ready.\n\n", "", 1),
		"the last paragraph deleted":    strings.Replace(v1, "\nNothing known.\n", "", 1),
		"a bullet added":                strings.Replace(v1, "- tell the users\n", "- tell the users\n- thank the team\n", 1),
		"a heading restyled":            strings.Replace(v1, "## Risks", "### Risks", 1),
		"a bullet made a paragraph":     strings.Replace(v1, "- ship the build", "ship the build", 1),
		"emoji text changed":            strings.Replace(v1, "ready.", "ready 🎉 now.", 1),
		"two changes at once":           strings.Replace(strings.Replace(v1, "Friday", "Monday", 1), "Nothing known.", "One thing.", 1),
	}
	for name, revised := range cases {
		t.Run(name, func(t *testing.T) {
			f, c := newFake(t)
			ctx := context.Background()
			id, err := c.Push(ctx, "Plan", v1)
			require.NoError(t, err)
			n, err := c.Patch(ctx, id, revised)
			require.NoError(t, err)
			assert.Greater(t, n, 0)
			assert.Equal(t, ParseMarkdown(revised), paras(f), "the Doc is the revision")
			// a second patch of the same Markdown sends nothing
			n, err = c.Patch(ctx, id, revised)
			require.NoError(t, err)
			assert.Zero(t, n, "nothing left to send")
		})
	}
}

func TestPatchOnlyReplacesTheMiddleOfAChangedParagraph(t *testing.T) {
	f, c := newFake(t)
	ctx := context.Background()
	_, err := c.Push(ctx, "Plan", v1)
	require.NoError(t, err)
	_, err = c.Patch(ctx, "doc1", strings.Replace(v1, "on Friday and", "on Monday and", 1))
	require.NoError(t, err)
	require.Len(t, f.requests, 1)
	var del, ins int
	for _, rq := range f.requests[0] {
		if rq["deleteContentRange"] != nil {
			r := rq["deleteContentRange"].(map[string]any)["range"].(map[string]any)
			del = int(r["endIndex"].(float64)) - int(r["startIndex"].(float64))
		}
		if rq["insertText"] != nil {
			ins = len(rq["insertText"].(map[string]any)["text"].(string))
		}
	}
	assert.Equal(t, len("Fri"), del, "only the letters that differ are deleted (Friday and Monday share \"day\"), so a comment on the rest of the paragraph keeps its text")
	assert.Equal(t, len("Mon"), ins)
}

func TestPatchSendsRequestsFromTheEndBackToTheStart(t *testing.T) {
	f, c := newFake(t)
	ctx := context.Background()
	_, err := c.Push(ctx, "Plan", v1)
	require.NoError(t, err)
	_, err = c.Patch(ctx, "doc1", strings.Replace(strings.Replace(v1, "Friday", "Monday", 1), "Nothing known.", "One thing.", 1))
	require.NoError(t, err)
	last := 1 << 30
	for _, rq := range f.requests[0] {
		var at int
		if rq["deleteContentRange"] != nil {
			at = int(rq["deleteContentRange"].(map[string]any)["range"].(map[string]any)["startIndex"].(float64))
		} else if rq["insertText"] != nil {
			at = int(rq["insertText"].(map[string]any)["location"].(map[string]any)["index"].(float64))
		} else {
			continue
		}
		assert.LessOrEqual(t, at, last, "a later request never sits after an earlier one")
		last = at
	}
}

func TestPatchIsRefusedWhenAPersonEditedTheDocMeanwhile(t *testing.T) {
	f, c := newFake(t)
	ctx := context.Background()
	_, err := c.Push(ctx, "Plan", v1)
	require.NoError(t, err)
	f.afterGet = func() { // a person types in the Doc after Coral read it and before it sends
		f.rev++
		f.paras[1].Text = "A person rewrote this."
		f.afterGet = nil
	}
	_, err = c.Patch(ctx, "doc1", strings.Replace(v1, "Friday", "Monday", 1))
	assert.True(t, errors.Is(err, ErrDocChanged), "got %v", err)
	assert.Equal(t, "A person rewrote this.", f.paras[1].Text, "the person's edit was not overwritten")
	assert.Empty(t, f.requests, "no request was applied")
}

func TestCommentsPageAndSkipDeleted(t *testing.T) {
	f, c := newFake(t)
	for _, id := range []string{"c1", "c2", "c3", "c4", "c5"} {
		f.comments = append(f.comments, &Comment{ID: id, Content: id, Deleted: id == "c3"})
	}
	got, err := c.Comments(context.Background(), "doc1")
	require.NoError(t, err)
	var ids []string
	for _, cm := range got {
		ids = append(ids, cm.ID)
	}
	assert.Equal(t, []string{"c1", "c2", "c4", "c5"}, ids, "every page read, deleted ones left out")
}

func TestToCoralMapsTheQuoteTheAuthorAndTheReplies(t *testing.T) {
	var cm Comment
	cm.ID, cm.Content, cm.Author = "c1", "Is Friday firm?", Author{DisplayName: "Dana"}
	cm.QuotedFileContent.Value = "on Friday"
	cm.Replies = []Reply{{Content: "Yes.", Author: Author{DisplayName: "Lee"}}, {Action: "resolve", Author: Author{DisplayName: "Lee"}}}
	cm.Resolved = true
	got := ToCoral(cm, v1)
	assert.Equal(t, "on Friday", got.Anchor.Quote)
	assert.Contains(t, got.Anchor.Prefix, "launch is")
	assert.Contains(t, got.Anchor.Suffix, "and the team")
	assert.Equal(t, "[Dana] Is Friday firm?", got.Body)
	assert.Equal(t, []string{"[Lee] Yes."}, got.Replies, "a bare resolve is the flag, not a message")
	assert.True(t, got.Resolved)
	whole := ToCoral(Comment{ID: "c2", Content: "Looks good"}, v1)
	assert.True(t, whole.Anchor.Whole, "a comment with no quote is on the whole document")
}

func TestPlanRepliesAndResolvesOnlyTheHandledOnesAndSaysWhenTheTextIsGone(t *testing.T) {
	mk := func(id, quote string) Comment {
		c := Comment{ID: id}
		c.QuotedFileContent.Value = quote
		return c
	}
	open := []Comment{mk("a", "on Friday"), mk("b", "Nothing known."), mk("c", "tell the users")}
	revised := strings.Replace(strings.Replace(v1, "Friday", "Monday", 1), "Nothing known.", "One thing.", 1)
	acts := Plan(open, map[string]string{"a": "Moved to Monday.", "b": "Listed the one risk."}, revised)
	require.Len(t, acts, 2, "c was not handled: left open")
	assert.Equal(t, "a", acts[0].CommentID)
	assert.False(t, acts[0].Survives, "its quoted words were changed")
	assert.Contains(t, acts[0].Reply, "no longer points at anything")
	assert.True(t, acts[0].Resolve)
	assert.True(t, Plan([]Comment{mk("c", "tell the users")}, map[string]string{"c": "Done."}, revised)[0].Survives)
}

func TestApplyRepliesThroughTheClientAndResolvesTheComment(t *testing.T) {
	f, c := newFake(t)
	f.comments = []*Comment{{ID: "a"}, {ID: "b"}}
	require.NoError(t, c.Apply(context.Background(), "doc1", []Action{{CommentID: "a", Reply: "Done.", Resolve: true}}))
	assert.True(t, f.comments[0].Resolved)
	assert.Equal(t, "Done.", f.comments[0].Replies[0].Content)
	assert.False(t, f.comments[1].Resolved)
}

func TestStateTakesInEachCommentOnceAndAgainWhenItChanges(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	s, err := LoadState(path)
	require.NoError(t, err)
	all := []Comment{{ID: "a", ModifiedTime: "t1"}, {ID: "b", ModifiedTime: "t1"}}
	fresh, s := s.New(all)
	assert.Len(t, fresh, 2)
	require.NoError(t, s.Save(path))
	s, err = LoadState(path)
	require.NoError(t, err)
	fresh, s = s.New(all)
	assert.Empty(t, fresh, "nothing new")
	all[1].ModifiedTime = "t2"
	fresh, _ = s.New(all)
	require.Len(t, fresh, 1)
	assert.Equal(t, "b", fresh[0].ID, "a reply or an edit makes the comment new again")
	info, _ := os.Stat(path)
	assert.Equal(t, os.FileMode(0o600), info.Mode().Perm())
}

func TestTheTokenNeverAppearsInAnError(t *testing.T) {
	f, c := newFake(t)
	f.token = "other"
	_, err := c.Comments(context.Background(), "doc1")
	require.Error(t, err)
	assert.NotContains(t, err.Error(), "tok-SECRET-123")
	c.BaseURL = "http://127.0.0.1:1"
	_, err = c.Comments(context.Background(), "doc1")
	require.Error(t, err)
	assert.NotContains(t, err.Error(), "tok-SECRET-123")
}

func TestARateLimitIsRetriedThenSucceeds(t *testing.T) {
	f, c := newFake(t)
	f.fail429 = 2
	var slept int
	c.Sleep = func(time.Duration) { slept++ }
	_, err := c.Push(context.Background(), "Plan", v1)
	require.NoError(t, err)
	assert.Equal(t, 2, slept)
}
