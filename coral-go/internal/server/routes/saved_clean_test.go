package routes

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// The rule (#20329, #20333, #20336, #20339), for coral-hub to match:
//   1. Control characters (Cc) and format characters (Cf) are dropped: RTL override, zero width space, BOM, bidi isolates, word joiner, soft hyphen.
//   2. Exception A, joiners: a run of ZWJ (U+200D) and ZWNJ (U+200C) is KEPT when the character before the run and the character after it are both non-ASCII and visible
//      (not control or format), and the run is a single joiner; a run of two or more is dropped entirely. "Before" is the last character kept in the output, "after" is the
//      next input character past the run.
//   3. Exception B, flags: a tag character (U+E0020 to U+E007F) is KEPT only inside one of the three subdivision flags: U+1F3F4 followed by the tags of gbeng (England),
//      gbsct (Scotland) or gbwls (Wales), each tag being U+E0000 plus the ASCII letter, then the cancel tag U+E007F. There is no neighbour test: a flag keeps its tags before ASCII
//      or at the end. Every other tag character is dropped, so any other tag sequence leaves the bare black flag (or nothing, after no flag).
//
//   | input                                       | expected      | why                                                             |
//   | inv<RLO>oice.txt                            | invoice.txt   | rule 1: RTL override                                            |
//   | a<ZWSP>dmin                                 | admin         | rule 1: zero width space                                        |
//   | <BOM>name                                   | name          | rule 1: byte order mark                                         |
//   | <U+2066>a<U+2069>b                          | ab            | rule 1: bidi isolates                                           |
//   | x<WJ>y                                      | xy            | rule 1: word joiner                                             |
//   | co<SHY>ral                                  | coral         | rule 1: soft hyphen                                             |
//   | a<ESC>[31mb<NUL>                            | a[31mb        | rule 1: control characters                                      |
//   | man<ZWJ>woman<ZWJ>girl (emoji)              | unchanged     | rule 2: both sides non-ASCII (family emoji)                     |
//   | Persian mi<ZWNJ>khwaham                     | unchanged     | rule 2: both sides non-ASCII (Persian word)                     |
//   | ad<ZWJ>min                                  | admin         | rule 2: ASCII on both sides                                     |
//   | a<ZWNJ>Persian-letter                       | a + letter    | rule 2: ASCII before                                            |
//   | <ZWJ>man<ZWJ>                               | man           | rule 2: nothing before, nothing after                           |
//   | letter + 9 x ZWJ + letter                   | two letters   | rule 2: a run of two or more is dropped entirely                                       |
//   | letter + ZWJ + ZWJ + letter                 | two letters   | rule 2: two joiners in a row                                                           |
//   | letter + ZWNJ + ZWJ + letter                | two letters   | rule 2: two joiners in a row, mixed                                                    |
//   | letter<ZWJ><RLO>letter                      | two letters   | rule 2: a format character after the run, so no visible 'after' |
//   | flag + gbeng tags + cancel + smiley         | unchanged     | rule 3: England                                                 |
//   | flag + gbsct tags + cancel                  | unchanged     | rule 3: Scotland, at the end                                    |
//   | flag + gbwls tags + cancel + x              | unchanged     | rule 3: Wales, no neighbour test, ASCII after is fine           |
//   | flag + tags g,b + cancel                    | flag          | rule 3: not one of the three                                    |
//   | flag + gbeng tags (no cancel)               | flag          | rule 3: no cancel tag                                           |
//   | flag + gbeng tags + 1 more tag + cancel     | flag          | rule 3: not exactly one of the three                            |
//   | flag + 7 tags + cancel                      | flag          | rule 3: not one of the three                                    |
//   | flag + cancel only                          | flag          | rule 3: no tags                                                 |
//   | smiley + gbeng tags + cancel                | smiley        | rule 3: not after the black flag                                |
//   | gbeng tags + cancel alone                   | (empty)       | rule 3: not after the black flag                                |
//   | smiley + hidden tags 'hi' + x               | smiley x      | rule 3: tags that are not a flag (a hidden message)             |
//   | a<tag h>smiley                              | a smiley      | rule 3: a tag that is not in a flag                             |
//   | thumbs up, e-acute, Japanese, spaces around | kept, trimmed | visible characters are never touched                            |

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
		// #20333: a joiner between two non-ASCII characters is kept, next to ASCII it is dropped.
		"zwj family emoji":       {"\U0001F468\u200D\U0001F469\u200D\U0001F467", "\U0001F468\u200D\U0001F469\u200D\U0001F467"},
		"persian zwnj word":      {"\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645", "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645"},
		"ad zwj min":             {"ad\u200Dmin", "admin"},
		"zwnj beside ascii":      {"a\u200C\u0645", "a\u0645"},
		"zwj at the ends":        {"\u200D\U0001F468\u200D", "\U0001F468"},
		"england then emoji":     {"\U0001F3F4\U000E0067\U000E0062\U000E0065\U000E006E\U000E0067\U000E007F\U0001F600", "\U0001F3F4\U000E0067\U000E0062\U000E0065\U000E006E\U000E0067\U000E007F\U0001F600"},
		"scotland at the end":    {"\U0001F3F4\U000E0067\U000E0062\U000E0073\U000E0063\U000E0074\U000E007F", "\U0001F3F4\U000E0067\U000E0062\U000E0073\U000E0063\U000E0074\U000E007F"},
		"wales then ascii":       {"\U0001F3F4\U000E0067\U000E0062\U000E0077\U000E006C\U000E0073\U000E007Fx", "\U0001F3F4\U000E0067\U000E0062\U000E0077\U000E006C\U000E0073\U000E007Fx"},
		"other tags drop":        {"\U0001F3F4\U000E0067\U000E0062\U000E007F", "\U0001F3F4"},
		"england with no cancel": {"\U0001F3F4\U000E0067\U000E0062\U000E0065\U000E006E\U000E0067", "\U0001F3F4"},
		"england plus one tag":   {"\U0001F3F4\U000E0067\U000E0062\U000E0065\U000E006E\U000E0067\U000E0061\U000E007F", "\U0001F3F4"},
		"flag with 7 tags":       {"\U0001F3F4" + strings.Repeat("\U000E0061", 7) + "\U000E007F", "\U0001F3F4"},
		"flag with cancel only":  {"\U0001F3F4\U000E007F", "\U0001F3F4"},
		"tags after an emoji":    {"\U0001F600\U000E0067\U000E0062\U000E0065\U000E006E\U000E0067\U000E007F", "\U0001F600"},
		"tags alone":             {"\U000E0067\U000E0062\U000E0065\U000E006E\U000E0067\U000E007F", ""},
		"tags hide ascii":        {"\U0001F600\U000E0068\U000E0069x", "\U0001F600x"},
		"tags after ascii":       {"a\U000E0068\U0001F600", "a\U0001F600"},
		"two zwj in a row":       {"\u0645\u200D\u200D\u0645", "\u0645\u0645"},
		"zwnj then zwj":          {"\u0645\u200C\u200D\u0645", "\u0645\u0645"},
		"long joiner run":        {"\u0645" + strings.Repeat("\u200D", 9) + "\u0645", "\u0645\u0645"},
		"format next to joiner":  {"\u0645\u200D\u202E\u0645", "\u0645\u0645"},
	} {
		assert.Equal(t, c.want, cleanSavedField(c.in), name)
	}
}
