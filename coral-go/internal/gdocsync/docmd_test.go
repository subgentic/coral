package gdocsync

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func run(text string, style map[string]any) map[string]any {
	r := map[string]any{"content": text}
	if style != nil {
		r["textStyle"] = style
	}
	return map[string]any{"textRun": r}
}

func para(style string, els ...map[string]any) map[string]any {
	return map[string]any{"paragraph": map[string]any{"elements": els, "paragraphStyle": map[string]any{"namedStyleType": style}}}
}

func bullet(listID string, level int, els ...map[string]any) map[string]any {
	return map[string]any{"paragraph": map[string]any{"elements": els, "paragraphStyle": map[string]any{"namedStyleType": "NORMAL_TEXT"}, "bullet": map[string]any{"listId": listID, "nestingLevel": level}}}
}

func cell(text string) map[string]any {
	return map[string]any{"content": []any{para("NORMAL_TEXT", run(text+"\n", nil))}}
}

// docOf builds documents.get's JSON and decodes it as the client does.
func docOf(t *testing.T, lists map[string]any, content ...map[string]any) docRead {
	t.Helper()
	b, err := json.Marshal(map[string]any{"revisionId": "rev7", "lists": lists, "body": map[string]any{"content": content}})
	require.NoError(t, err)
	var d docRead
	require.NoError(t, json.Unmarshal(b, &d))
	return d
}

func TestDocToMarkdownMapsWhatAPersonTypes(t *testing.T) {
	lists := map[string]any{
		"ul": map[string]any{"listProperties": map[string]any{"nestingLevels": []any{map[string]any{"glyphType": ""}, map[string]any{"glyphType": ""}}}},
		"ol": map[string]any{"listProperties": map[string]any{"nestingLevels": []any{map[string]any{"glyphType": "DECIMAL"}}}},
	}
	d := docOf(t, lists,
		map[string]any{"sectionBreak": map[string]any{}},
		para("TITLE", run("The plan\n", nil)),
		para("HEADING_2", run("Goals\n", nil)),
		para("NORMAL_TEXT", run("We ship ", nil), run("on time", map[string]any{"bold": true}), run(" and ", nil), run("early", map[string]any{"italic": true}), run(", see ", nil), run("the spec", map[string]any{"link": map[string]any{"url": "https://example.com/a b"}}), run(".\n", nil)),
		para("NORMAL_TEXT", run("\n", nil)),
		bullet("ul", 0, run("first\n", nil)),
		bullet("ul", 1, run("nested\n", nil)),
		bullet("ul", 0, run("second\n", nil)),
		bullet("ol", 0, run("one\n", nil)),
		bullet("ol", 0, run("two\n", nil)),
		para("NORMAL_TEXT", run("run ", nil), run("go test", map[string]any{"weightedFontFamily": map[string]any{"fontFamily": "Courier New"}}), run(" and ", nil), run("gone", map[string]any{"strikethrough": true}), run("\n", nil)),
		map[string]any{"table": map[string]any{"tableRows": []any{
			map[string]any{"tableCells": []any{cell("Name"), cell("Cost")}},
			map[string]any{"tableCells": []any{cell("a|b"), cell("$3")}},
		}}},
	)
	got := DocToMarkdown(d)
	assert.Equal(t, "rev7", got.Revision)
	assert.Equal(t, "# The plan\n\n## Goals\n\nWe ship **on time** and *early*, see [the spec](https://example.com/a%20b).\n\n- first\n  - nested\n- second\n\n1. one\n1. two\n\nrun `go test` and ~~gone~~\n\n| Name | Cost |\n| --- | --- |\n| a\\|b | $3 |\n", got.Markdown)
	assert.Empty(t, got.Notes)
}

func TestMarkedWordsSplitAcrossRunsAreMarkedOnceAndSpacesStayOutside(t *testing.T) {
	d := docOf(t, nil, para("NORMAL_TEXT",
		run("a ", nil), run("bo", map[string]any{"bold": true}), run("ld ", map[string]any{"bold": true}), run("word", nil), run("\n", nil)))
	assert.Equal(t, "a **bold** word\n", DocToMarkdown(d).Markdown)
}

func TestTextThatLooksLikeMarkdownIsEscaped(t *testing.T) {
	d := docOf(t, nil,
		para("NORMAL_TEXT", run("2*3 and snake_case [x] `q`\n", nil)),
		para("NORMAL_TEXT", run("# not a heading\n", nil)),
		para("NORMAL_TEXT", run("- not a bullet\n", nil)),
		para("NORMAL_TEXT", run("1. not a list\n", nil)),
	)
	assert.Equal(t, "2\\*3 and snake\\_case \\[x\\] \\`q\\`\n\n\\# not a heading\n\n\\- not a bullet\n\n1\\. not a list\n", DocToMarkdown(d).Markdown)
}

func TestWhatCannotBeCarriedIsSaidNotDropped(t *testing.T) {
	d := docOf(t, nil, para("NORMAL_TEXT", run("see ", nil), map[string]any{"inlineObjectElement": map[string]any{}}, run(" here\n", nil)))
	got := DocToMarkdown(d)
	assert.Equal(t, "see  here\n", got.Markdown)
	assert.Equal(t, []string{"an image or drawing was left out"}, got.Notes)
}

func TestPullReadsTheDocFromTheServerAndRoundTripsThePushedMarkdown(t *testing.T) {
	f, c := newFake(t)
	f.paras = ParseMarkdown("# Title\n\nHello world\n\n- one\n- two\n\n## End\n\nbye")
	got, err := c.Pull(context.Background(), "doc1")
	require.NoError(t, err)
	assert.Equal(t, "# Title\n\nHello world\n\n- one\n- two\n\n## End\n\nbye\n", got.Markdown)
	assert.Equal(t, "rev0", got.Revision)
	// the Markdown that comes back parses to the paragraphs that went out
	assert.Equal(t, f.paras, ParseMarkdown(got.Markdown))
	assert.Equal(t, 1, f.countCalls("GET /v1/documents/doc1"))
}

func TestPullKeepsAPersonsEditsMadeInTheDoc(t *testing.T) {
	f, c := newFake(t)
	f.raw = map[string]any{"revisionId": "rev9", "body": map[string]any{"content": []any{
		para("HEADING_1", run("Plan\n", nil)),
		para("NORMAL_TEXT", run("Edited in the Doc by ", nil), run("Sam", map[string]any{"bold": true}), run("\n", nil)),
	}}}
	got, err := c.Pull(context.Background(), "doc1")
	require.NoError(t, err)
	assert.Equal(t, "# Plan\n\nEdited in the Doc by **Sam**\n", got.Markdown)
	assert.Equal(t, "rev9", got.Revision)
}
