package routes

import (
	"html"
	"net/url"
	"regexp"
	"strings"
)

// renderMarkdownSafe turns Markdown an agent wrote into HTML for the viewer's Open in new tab (#11845). It is safe by construction, not by filtering: every character of the source reaches the page through
// html.EscapeString, so no tag or attribute of the author's can exist, and the only tags are the ones written here (headings, paragraphs, emphasis, code, lists, quotes, rules and links). A link keeps only an
// http, https or mailto address. The page is also served under a sandbox policy with no script (serveMarkdownOpen), so a mistake here could not run anything.
func renderMarkdownSafe(src string) string {
	lines := strings.Split(strings.ReplaceAll(strings.ReplaceAll(src, "\r\n", "\n"), "\r", "\n"), "\n")
	var out strings.Builder
	var para []string
	list := ""
	flush := func() {
		if len(para) > 0 {
			out.WriteString("<p>" + mdInline(strings.Join(para, " ")) + "</p>\n")
			para = nil
		}
	}
	closeList := func() {
		if list != "" {
			out.WriteString("</" + list + ">\n")
			list = ""
		}
	}
	for i := 0; i < len(lines); i++ {
		line := lines[i]
		trim := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(trim, "```") || strings.HasPrefix(trim, "~~~"):
			flush()
			closeList()
			fence := trim[:3]
			var code []string
			for i++; i < len(lines) && !strings.HasPrefix(strings.TrimSpace(lines[i]), fence); i++ {
				code = append(code, lines[i])
			}
			out.WriteString("<pre><code>" + html.EscapeString(strings.Join(code, "\n")) + "</code></pre>\n")
		case trim == "":
			flush()
			closeList()
		case mdRule.MatchString(trim):
			flush()
			closeList()
			out.WriteString("<hr>\n")
		case mdHeading.MatchString(trim):
			flush()
			closeList()
			m := mdHeading.FindStringSubmatch(trim)
			n := len(m[1])
			out.WriteString("<h" + string(rune('0'+n)) + ">" + mdInline(strings.TrimRight(m[2], "# ")) + "</h" + string(rune('0'+n)) + ">\n")
		case strings.HasPrefix(trim, ">"):
			flush()
			closeList()
			var quote []string
			for ; i < len(lines) && strings.HasPrefix(strings.TrimSpace(lines[i]), ">"); i++ {
				quote = append(quote, strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(lines[i]), ">")))
			}
			i--
			out.WriteString("<blockquote>" + mdInline(strings.Join(quote, " ")) + "</blockquote>\n")
		case mdBullet.MatchString(trim) || mdNumber.MatchString(trim):
			flush()
			kind, item := "ul", mdBullet.ReplaceAllString(trim, "")
			if mdNumber.MatchString(trim) {
				kind, item = "ol", mdNumber.ReplaceAllString(trim, "")
			}
			if list != kind {
				closeList()
				out.WriteString("<" + kind + ">\n")
				list = kind
			}
			out.WriteString("<li>" + mdInline(item) + "</li>\n")
		default:
			closeList()
			para = append(para, trim)
		}
	}
	flush()
	closeList()
	return out.String()
}

var (
	mdRule    = regexp.MustCompile(`^(?:-{3,}|\*{3,}|_{3,})$`)
	mdHeading = regexp.MustCompile(`^(#{1,6})\s+(.*)$`)
	mdBullet  = regexp.MustCompile(`^[-*+]\s+`)
	mdNumber  = regexp.MustCompile(`^\d+[.)]\s+`)
	mdLink    = regexp.MustCompile(`^\[([^\]]*)\]\(([^)\s]*)\)`)
)

// mdInline renders the inline marks of one run of text: `code`, **strong**, *emphasis* or _emphasis_, and [text](address). Everything else is escaped text.
func mdInline(s string) string {
	var out strings.Builder
	for i := 0; i < len(s); {
		rest := s[i:]
		switch {
		case rest[0] == '`':
			if j := strings.IndexByte(rest[1:], '`'); j >= 0 {
				out.WriteString("<code>" + html.EscapeString(rest[1:1+j]) + "</code>")
				i += j + 2
				continue
			}
		case strings.HasPrefix(rest, "**"):
			if j := strings.Index(rest[2:], "**"); j > 0 {
				out.WriteString("<strong>" + mdInline(rest[2:2+j]) + "</strong>")
				i += j + 4
				continue
			}
		case rest[0] == '*' || rest[0] == '_':
			if j := strings.IndexByte(rest[1:], rest[0]); j > 0 {
				out.WriteString("<em>" + mdInline(rest[1:1+j]) + "</em>")
				i += j + 2
				continue
			}
		case rest[0] == '[':
			if m := mdLink.FindStringSubmatch(rest); m != nil {
				if safeLink(m[2]) {
					out.WriteString(`<a href="` + html.EscapeString(m[2]) + `" rel="noopener noreferrer nofollow" target="_blank">` + html.EscapeString(m[1]) + "</a>")
				} else {
					out.WriteString(html.EscapeString(m[1]))
				}
				i += len(m[0])
				continue
			}
		}
		out.WriteString(html.EscapeString(rest[:1]))
		i++
	}
	return out.String()
}

// safeLink keeps an address only if it is http, https or mailto with no control character: nothing that runs (javascript:, data:, vbscript:) or reads a local file (file:).
func safeLink(raw string) bool {
	for _, r := range raw {
		if r < 0x21 || r == 0x7f {
			return false
		}
	}
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	switch strings.ToLower(u.Scheme) {
	case "http", "https":
		return u.Host != ""
	case "mailto":
		return true
	}
	return false
}

// markdownPage wraps the rendered body in a complete page: the name as its title, a quiet reading style that follows the browser's light or dark setting, and no script.
func markdownPage(title, body string) string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>` + html.EscapeString(title) + `</title>
<style>:root{color-scheme:light dark}body{max-width:46rem;margin:2rem auto;padding:0 1rem;font:16px/1.6 system-ui,sans-serif}pre{overflow:auto;padding:.75rem;border:1px solid #8885;border-radius:6px}code{font-family:ui-monospace,monospace}blockquote{margin-left:0;padding-left:1rem;border-left:3px solid #8886}a{color:#1f6feb}hr{border:0;border-top:1px solid #8885}</style></head><body>
` + body + `</body></html>
`
}
