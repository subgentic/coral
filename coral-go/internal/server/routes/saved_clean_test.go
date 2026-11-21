package routes

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// #20329: a saved title, ref, team, author and date lose Unicode format characters (Cf) as well as control characters, as the Hub does (coral-hub #257695): an RTL override
// or a zero width mark can make a name read as another, and nothing visible is lost by dropping them.
func TestCleanSavedFieldDropsFormatCharacters(t *testing.T) {
	for name, c := range map[string]struct{ in, want string }{
		"rtl override":      {"inv\u202eoice.txt", "invoice.txt"},
		"zero width space":  {"a\u200bdmin", "admin"},
		"zero width joiner": {"te\u200dam", "team"},
		"bom":               {"\ufeffname", "name"},
		"bidi isolates":     {"\u2066a\u2069b", "ab"},
		"word joiner":       {"x\u2060y", "xy"},
		"soft hyphen":       {"co\u00adral", "coral"},
		"control still":     {"a\x1b[31mb\x00", "a[31mb"},
		"plain text":        {"  Plain title é 日本  ", "Plain title é 日本"},
		"emoji kept":        {"ok 👍", "ok 👍"},
	} {
		assert.Equal(t, c.want, cleanSavedField(c.in), name)
	}
}
