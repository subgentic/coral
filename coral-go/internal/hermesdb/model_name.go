package hermesdb

import "strings"

// ModelNameMax is the longest model name taken from Hermes's session row: a real one ("provider/vendor-model-1.2:tag") is far shorter, and the column is Hermes's own text.
const ModelNameMax = 120

// ModelNameOK reports whether text from the session row's model column is a model name: 1 to ModelNameMax bytes of letters, digits and "._-:/@+" and nothing else. Anything else (a control or escape character, a
// zero-width or reordering mark, a space, markup, a long text) is not one. The one rule the chip and the usage rows share (#12314): an agent that writes its own state.db can put nothing else on either.
func ModelNameOK(s string) bool {
	if s == "" || len(s) > ModelNameMax {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case strings.ContainsRune("._-:/@+", r):
		default:
			return false
		}
	}
	return true
}
