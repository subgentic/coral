package gdocsync

// Doc -> Markdown (#20013, slice 4b): what a person typed in the Google Doc, read with documents.get and written as Markdown, so it can become a new version of the Coral artifact.
//
// Mapped: Title and Heading 1-6 (# to ######), paragraphs, bold, italic, bold italic, strikethrough, monospace runs (code), links, bulleted and numbered lists with their nesting, tables (a pipe
// table whose first row is the header) and soft line breaks. Not mapped, and said so in the result's Notes rather than dropped silently: images and drawings, footnotes, page and section breaks'
// layout, table cells with more than text (their text is kept on one line), colours and fonts other than monospace. The text of every one of those survives; only its styling does not.

import (
	"context"
	"net/http"
	"net/url"
	"strings"
)

// Pulled is the Doc read back: its Markdown, the revision it was read at, and what the Markdown could not carry.
type Pulled struct {
	Markdown string
	Revision string
	Notes    []string // one line each, deduplicated: "an image was left out", ...
}

type docRead struct {
	RevisionID string `json:"revisionId"`
	Body       struct {
		Content []structElem `json:"content"`
	} `json:"body"`
	Lists map[string]struct {
		ListProperties struct {
			NestingLevels []struct {
				GlyphType   string `json:"glyphType"`
				GlyphSymbol string `json:"glyphSymbol"`
			} `json:"nestingLevels"`
		} `json:"listProperties"`
	} `json:"lists"`
}

type structElem struct {
	Paragraph *struct {
		Elements       []paraElem `json:"elements"`
		ParagraphStyle struct {
			NamedStyleType string `json:"namedStyleType"`
		} `json:"paragraphStyle"`
		Bullet *struct {
			ListID       string `json:"listId"`
			NestingLevel int    `json:"nestingLevel"`
		} `json:"bullet"`
	} `json:"paragraph"`
	Table *struct {
		TableRows []struct {
			TableCells []struct {
				Content []structElem `json:"content"`
			} `json:"tableCells"`
		} `json:"tableRows"`
	} `json:"table"`
	SectionBreak *struct{} `json:"sectionBreak"`
}

type paraElem struct {
	TextRun *struct {
		Content   string `json:"content"`
		TextStyle struct {
			Bold          bool `json:"bold"`
			Italic        bool `json:"italic"`
			Strikethrough bool `json:"strikethrough"`
			Link          *struct {
				URL string `json:"url"`
			} `json:"link"`
			WeightedFontFamily *struct {
				FontFamily string `json:"fontFamily"`
			} `json:"weightedFontFamily"`
		} `json:"textStyle"`
	} `json:"textRun"`
	InlineObjectElement *struct{} `json:"inlineObjectElement"`
	FootnoteReference   *struct{} `json:"footnoteReference"`
	HorizontalRule      *struct{} `json:"horizontalRule"`
}

const pullFields = "revisionId,lists,body(content(paragraph(elements(textRun(content,textStyle(bold,italic,strikethrough,link(url),weightedFontFamily(fontFamily))),inlineObjectElement,footnoteReference,horizontalRule),paragraphStyle(namedStyleType),bullet(listId,nestingLevel)),table(tableRows(tableCells(content(paragraph(elements(textRun(content,textStyle(bold,italic,strikethrough,link(url),weightedFontFamily(fontFamily)))),paragraphStyle(namedStyleType)))))),sectionBreak))"

// Pull reads the Doc and returns it as Markdown.
func (c *Client) Pull(ctx context.Context, docID string) (Pulled, error) {
	var d docRead
	if err := c.do(ctx, http.MethodGet, "/v1/documents/"+url.PathEscape(docID), url.Values{"fields": {pullFields}}, "", nil, &d); err != nil {
		return Pulled{}, err
	}
	return DocToMarkdown(d), nil
}

// DocToMarkdown is the pure half of Pull: documents.get's body as Markdown.
func DocToMarkdown(d docRead) Pulled {
	n := &notes{}
	var blocks []string // each block is one paragraph, heading, list run or table; joined by a blank line
	var list []string   // the list items being gathered: a run of items is one block
	flushList := func() {
		if len(list) > 0 {
			blocks = append(blocks, strings.Join(list, "\n"))
			list = nil
		}
	}
	lastList := ""
	for _, e := range d.Body.Content {
		switch {
		case e.Paragraph != nil:
			p := e.Paragraph
			text := runsToMarkdown(p.Elements, n)
			if p.Bullet != nil {
				if lastList != "" && lastList != p.Bullet.ListID {
					flushList() // two different lists back to back stay two blocks
				}
				lastList = p.Bullet.ListID
				if strings.TrimSpace(text) == "" {
					continue
				}
				list = append(list, strings.Repeat("  ", p.Bullet.NestingLevel)+listMarker(d, p.Bullet.ListID, p.Bullet.NestingLevel)+text)
				continue
			}
			flushList()
			lastList = ""
			if strings.TrimSpace(text) == "" {
				continue // an empty paragraph is only spacing
			}
			blocks = append(blocks, headingPrefix(p.ParagraphStyle.NamedStyleType)+escapeLineStart(text))
		case e.Table != nil:
			flushList()
			lastList = ""
			blocks = append(blocks, tableToMarkdown(e.Table.TableRows, n))
		}
	}
	flushList()
	return Pulled{Markdown: strings.Join(blocks, "\n\n") + "\n", Revision: d.RevisionID, Notes: n.list}
}

type notes struct{ list []string }

func (n *notes) add(s string) {
	for _, x := range n.list {
		if x == s {
			return
		}
	}
	n.list = append(n.list, s)
}

func headingPrefix(style string) string {
	switch style {
	case "TITLE":
		return "# "
	case "HEADING_1", "HEADING_2", "HEADING_3", "HEADING_4", "HEADING_5", "HEADING_6":
		return strings.Repeat("#", int(style[len(style)-1]-'0')) + " "
	}
	return ""
}

func listMarker(d docRead, listID string, level int) string {
	if l, ok := d.Lists[listID]; ok && level < len(l.ListProperties.NestingLevels) {
		switch g := l.ListProperties.NestingLevels[level].GlyphType; g {
		case "DECIMAL", "ZERO_DECIMAL", "ALPHA", "UPPER_ALPHA", "ROMAN", "UPPER_ROMAN":
			return "1. "
		}
	}
	return "- "
}

type span struct {
	text                       string
	bold, italic, strike, code bool
	link                       string
}

func isMono(f string) bool {
	f = strings.ToLower(f)
	return strings.Contains(f, "courier") || strings.Contains(f, "consolas") || strings.Contains(f, "mono")
}

// runsToMarkdown joins a paragraph's runs, merging neighbours that share a style so a word split into runs is not marked twice.
func runsToMarkdown(els []paraElem, n *notes) string {
	var spans []span
	for _, el := range els {
		switch {
		case el.InlineObjectElement != nil:
			n.add("an image or drawing was left out")
		case el.FootnoteReference != nil:
			n.add("a footnote mark was left out")
		case el.HorizontalRule != nil:
			n.add("a horizontal rule was left out")
		case el.TextRun != nil:
			t := el.TextRun.Content
			t = strings.TrimSuffix(t, "\n")
			t = strings.ReplaceAll(t, "\v", "\u0000") // a soft line break, turned into a Markdown break below
			if t == "" {
				continue
			}
			ts := el.TextRun.TextStyle
			s := span{text: t, bold: ts.Bold, italic: ts.Italic, strike: ts.Strikethrough}
			if ts.Link != nil {
				s.link = ts.Link.URL
			}
			if ts.WeightedFontFamily != nil && isMono(ts.WeightedFontFamily.FontFamily) {
				s.code = true
			}
			if k := len(spans) - 1; k >= 0 && sameStyle(spans[k], s) {
				spans[k].text += s.text
			} else {
				spans = append(spans, s)
			}
		}
	}
	var sb strings.Builder
	for _, s := range spans {
		sb.WriteString(renderSpan(s))
	}
	return strings.ReplaceAll(sb.String(), "\u0000", "  \n")
}

func sameStyle(a, b span) bool {
	return a.bold == b.bold && a.italic == b.italic && a.strike == b.strike && a.code == b.code && a.link == b.link
}

// renderSpan puts the marks around the span's words and leaves its edge spaces outside them (Markdown does not open emphasis next to a space).
func renderSpan(s span) string {
	core := strings.TrimSpace(strings.ReplaceAll(s.text, "\u0000", "\v"))
	if core == "" {
		return s.text
	}
	lead := s.text[:len(s.text)-len(strings.TrimLeft(s.text, " \t"))]
	trail := s.text[len(strings.TrimRight(s.text, " \t")):]
	core = strings.ReplaceAll(core, "\v", "\u0000")
	var out string
	if s.code {
		out = "`" + strings.ReplaceAll(core, "`", "'") + "`"
	} else {
		out = escapeInline(core)
	}
	if s.strike {
		out = "~~" + out + "~~"
	}
	switch {
	case s.bold && s.italic:
		out = "***" + out + "***"
	case s.bold:
		out = "**" + out + "**"
	case s.italic:
		out = "*" + out + "*"
	}
	if s.link != "" {
		out = "[" + out + "](" + strings.NewReplacer(" ", "%20", ")", "%29", "(", "%28").Replace(s.link) + ")"
	}
	return lead + out + trail
}

// escapeInline keeps Markdown's own characters in the person's text from becoming marks.
func escapeInline(s string) string {
	return strings.NewReplacer(`\`, `\\`, "*", `\*`, "_", `\_`, "`", "\\`", "[", `\[`, "]", `\]`, "<", `\<`, "~~", `\~~`).Replace(s)
}

// escapeLineStart stops a paragraph that starts like Markdown ("1. ", "- ", "> ", "#") from becoming a list, a quote or a heading.
func escapeLineStart(s string) string {
	t := strings.TrimLeft(s, " ")
	if t == "" {
		return s
	}
	switch {
	case strings.HasPrefix(t, "#"), strings.HasPrefix(t, ">"), strings.HasPrefix(t, "+ "), strings.HasPrefix(t, "- "), strings.HasPrefix(t, "-\t"):
		return `\` + t
	}
	i := 0
	for i < len(t) && t[i] >= '0' && t[i] <= '9' {
		i++
	}
	if i > 0 && i < len(t) && (t[i] == '.' || t[i] == ')') && i+1 < len(t) && t[i+1] == ' ' {
		return t[:i] + `\` + t[i:]
	}
	return s
}

func tableToMarkdown(rows []struct {
	TableCells []struct {
		Content []structElem `json:"content"`
	} `json:"tableCells"`
}, n *notes) string {
	var cells [][]string
	width := 0
	for _, r := range rows {
		var row []string
		for _, c := range r.TableCells {
			var parts []string
			for _, e := range c.Content {
				if e.Paragraph == nil {
					continue
				}
				if t := strings.TrimSpace(runsToMarkdown(e.Paragraph.Elements, n)); t != "" {
					parts = append(parts, t)
				}
			}
			if len(parts) > 1 {
				n.add("a table cell with several paragraphs was joined onto one line")
			}
			t := strings.Join(parts, " ")
			t = strings.ReplaceAll(strings.ReplaceAll(t, "  \n", " "), "\u0000", " ")
			row = append(row, strings.ReplaceAll(t, "|", `\|`))
		}
		if len(row) > width {
			width = len(row)
		}
		cells = append(cells, row)
	}
	if width == 0 {
		return ""
	}
	var lines []string
	for i, row := range cells {
		for len(row) < width {
			row = append(row, "")
		}
		lines = append(lines, "| "+strings.Join(row, " | ")+" |")
		if i == 0 {
			sep := make([]string, width)
			for k := range sep {
				sep[k] = "---"
			}
			lines = append(lines, "| "+strings.Join(sep, " | ")+" |")
		}
	}
	return strings.Join(lines, "\n")
}
