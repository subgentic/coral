package board

import (
	"strings"
	"testing"
)

func TestWalk34SHOULDs(t *testing.T) {
	t.Run("quick-reply padding on touch", func(t *testing.T) {
		src := frontendSource(t, "css/board_quick_reply.css") // the Reply button's rules are a lazy stylesheet (the Hub's CSP refuses an injected <style>, #18816)
		if !strings.Contains(src, "@media(hover:none)") {
			t.Fatal("the Reply button's CSS must add padding on hover:none (touch) so it does not overlap the row's tags and time")
		}
		if !strings.Contains(src, "padding-inline-end") {
			t.Fatal("the touch rule must add padding-inline-end to the message row")
		}
	})

	t.Run("item 4 chip wording", func(t *testing.T) {
		src := frontendSource(t, "team_page.js")
		if !strings.Contains(src, "No agent has sent a first message yet") {
			t.Fatal("the status chip must use the full wording when no agent has responded")
		}
	})

	t.Run("pw-strength-idle hidden via JS attribute", func(t *testing.T) {
		css := frontendSource(t, "css/components.css")
		if strings.Contains(css, ".pw-strength-idle") {
			t.Fatal(".pw-strength-idle must not be in the start CSS (hiding is via the hidden attribute in password_ui.js)")
		}
		js := frontendSource(t, "password_ui.js")
		if !strings.Contains(js, "root.hidden") {
			t.Fatal("password_ui.js must set root.hidden to hide the idle strength meter")
		}
	})
}
