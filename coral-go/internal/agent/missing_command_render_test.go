package agent

import (
	"strings"
	"testing"

	"github.com/subgentic/coral/internal/vtscreen"
)

// QA's caveat on #253: on ConPTY the reconciler reads the live screen's render (vtscreen.Screen.Render, as PTYBackend.RenderedScreenText does),
// not the capture route. Windows PowerShell 5.1's answer to a missing CLI, written as the terminal receives it (CRLF line ends, the long sentence
// left for the terminal to wrap), then its blank line and prompt, rendered at QA's two widths: the shell's latest answer is found on the render.
// The same output followed by a typed command and a new prompt is not.
func TestMissingCommandAtBottomOnAConPTYRender(t *testing.T) {
	const ps51 = "claude : The term 'claude' is not recognized as the name of a cmdlet, function, script file, or operable program. Check the spelling " +
		"of the name, or if a path was included, verify that the path is correct and try again.\r\n" +
		"At line:1 char:1\r\n" +
		"+ claude\r\n" +
		"+ ~~~~~~\r\n" +
		"    + CategoryInfo          : ObjectNotFound: (claude:String) [], CommandNotFoundException\r\n" +
		"    + FullyQualifiedErrorId : CommandNotFoundException\r\n" +
		" \r\n"
	const prompt = `PS C:\Users\someone\AppData\Local\Temp\coral-run\work> `
	render := func(cols, rows int, out string) string {
		sc := vtscreen.NewScreen(cols, rows)
		sc.Write([]byte("\x1b[2J\x1b[H" + out)) // the quiet launch clears the screen first
		return sc.Render()
	}
	for _, cols := range []int{120, 30} {
		screen := render(cols, 50, ps51+prompt)
		if !MissingCommandAtBottom(screen, "claude") {
			t.Errorf("%d columns: the render's latest answer is the CLI missing, not marked:\n%s", cols, screen)
		}
		typed := render(cols, 50, ps51+prompt+"dir\r\n\r\n"+strings.TrimSpace(prompt)+" ")
		if MissingCommandAtBottom(typed, "claude") {
			t.Errorf("%d columns: a typed command after the error: marked:\n%s", cols, typed)
		}
	}
}
