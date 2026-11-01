package routes

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// #11845: Markdown opened in a new tab is rendered, and nothing an author writes can run: every source character is escaped, so no tag or attribute of the author's exists, and a link keeps only
// http, https and mailto. (The page is also served under a sandbox with no script: TestArtifactOpenInNewTabIsReadableForEveryType.)
func TestRenderMarkdownSafeRendersAndNeverRuns(t *testing.T) {
	rendered := renderMarkdownSafe("# Title\n\nSome **bold**, *emph*, `code <b>` and a [link](https://example.com/a?b=1&c=2).\n\n- one\n- two\n\n1. first\n2. second\n\n> quoted\n\n---\n\n```\nfenced <script>x</script>\n```\n")
	for _, want := range []string{"<h1>Title</h1>", "<strong>bold</strong>", "<em>emph</em>", "<code>code &lt;b&gt;</code>", `<a href="https://example.com/a?b=1&amp;c=2" rel="noopener noreferrer nofollow" target="_blank">link</a>`, "<ul>", "<li>one</li>", "<ol>", "<li>first</li>", "<blockquote>quoted</blockquote>", "<hr>", "<pre><code>fenced &lt;script&gt;x&lt;/script&gt;</code></pre>"} {
		require.Contains(t, rendered, want)
	}
	hostile := []struct{ name, src string }{
		{"a script tag", "before <script>parent.pwned=1</script> after"},
		{"a script tag alone", "<script>alert(1)</script>"},
		{"an event-handler attribute", `<img src=x onerror="alert(1)"> and <div onclick="x()">hi</div>`},
		{"a javascript: link", "[click](javascript:alert(1))"},
		{"a javascript: link in any case", "[click](JaVaScRiPt:alert(1)) [two](  javascript:alert(2))"},
		{"a data: link", "[page](data:text/html,<script>alert(1)</script>)"},
		{"a vbscript: and file: link", "[a](vbscript:x) [b](file:///etc/passwd)"},
		{"a link with a control character", "[a](java\tscript:alert(1))"},
		{"an html link", `<a href="javascript:alert(1)">x</a>`},
		{"a heading with a tag", "# <iframe src=//evil></iframe>"},
		{"an image", `![x](https://evil/x.png"onerror="alert(1))`},
		{"an attribute break in an address", `[x](https://a.com/"onmouseover="alert(1))`},
		{"a style and svg", "<style>*{}</style><svg onload=alert(1)>"},
	}
	for _, c := range hostile {
		t.Run(c.name, func(t *testing.T) {
			out := strings.ToLower(renderMarkdownSafe(c.src))
			for _, bad := range []string{"<script", "<img", "<iframe", "<svg", "<style", "<div", "<a href=\"javascript", "href=\"data:", "href=\"vbscript", "href=\"file:", " onerror=\"", "<img onerror"} {
				require.NotContains(t, out, bad, "the page must not contain %q: %s", bad, out)
			}
			// the only tags are the renderer's own
			for _, tag := range strings.FieldsFunc(out, func(r rune) bool { return r == '<' }) {
				name := strings.TrimLeft(tag, "/")
				name = strings.FieldsFunc(name, func(r rune) bool { return r == '>' || r == ' ' })[0:1][0]
				require.Contains(t, []string{"p", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "code", "pre", "ul", "ol", "li", "blockquote", "hr", "a"}, name, "a tag the renderer does not write: <%s in %s", name, out)
			}
			// a link, if one survived, is http, https or mailto and its attribute cannot be closed early
			for _, part := range strings.Split(out, `href="`)[1:] {
				addr := part[:strings.Index(part, `"`)]
				require.Regexp(t, `^(https?://|mailto:)`, addr)
				require.NotContains(t, addr, "\"")
			}
		})
	}
	require.Equal(t, "", renderMarkdownSafe(""))
}
