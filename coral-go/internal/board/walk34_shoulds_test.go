package board

import (
	"strings"
	"testing"
)

func TestWalk34SHOULDs(t *testing.T) {
	t.Run("quick-reply padding on touch", func(t *testing.T) {
		src := frontendSource(t, "board_quick_reply.js")
		if !strings.Contains(src, "@media(hover:none)") {
			t.Fatal("the Reply button's inline CSS must add padding on hover:none (touch) so it does not overlap the row's tags and time")
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

	t.Run("pw-strength-idle uses display:none", func(t *testing.T) {
		src := frontendSource(t, "css/components.css")
		idx := strings.Index(src, ".pw-strength-idle")
		if idx < 0 {
			t.Fatal(".pw-strength-idle rule must exist")
		}
		block := src[idx : idx+120]
		if !strings.Contains(block, "display: none") && !strings.Contains(block, "display:none") {
			t.Fatal(".pw-strength-idle must use display:none (not visibility:hidden) so the idle strength bar takes no space")
		}
		if strings.Contains(block, "visibility") {
			t.Fatal(".pw-strength-idle must not use visibility:hidden (it leaves a gap)")
		}
	})
}
