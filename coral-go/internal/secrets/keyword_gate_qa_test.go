package secrets

import (
	"math/rand"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

// QA on #5158: places the gate must still look at. Each text is one the rules redact over the whole text, so the gated spans must equal them.
func TestKeywordGateKeepsWhatTheRulesFindInOddText(t *testing.T) {
	v := "Xk9mQ2vL7pR4tZ8wN3bY"
	for name, text := range map[string]string{
		"a long s (U+017F) in the name, which (?i) folds to s":                                  "paſſword=" + v,
		"a Kelvin sign (U+212A) in the name, which folds to k":                                  "api_Key=" + v,
		"a Kelvin sign in token":                                                                "toKen: " + v,
		"a long s in mysql":                                                                     "myſql -u r -p" + v,
		"white space between the separator and the value":                                       "api_key=" + strings.Repeat(" ", 9000) + v,
		"newlines between the separator and the value":                                          "token:" + strings.Repeat("\n", 9000) + v,
		"a flag name of 60 characters":                                                          "tool --" + strings.Repeat("a-", 30) + "password " + v,
		"a flag name of 100 characters":                                                         "tool --" + strings.Repeat("ab-", 34) + "token " + v,
		"a name chain over the look-back whose first word says password, an 11-character value": "x" + "PASSWORD" + strings.Repeat("a-", 600) + "x-api-key=mysql--user\r\nrest",
		"a --flag after a carriage return or a form feed":                                       "tool\r--password " + v + "\f--token " + v,
	} {
		sameCoverage(t, name, text)
		sameCoverage(t, name+" in lines", "pre\n"+text+"\npost: 1\n")
	}
}

// Random text built from the pieces the rules read, with the odd ones (long blanks, long names, two letters that fold, form feeds) the gate's own test leaves out.
func TestKeywordGateOnOddRandomText(t *testing.T) {
	t.Parallel() // pure and read-only on the redactor: runs after the timing tests, together (#354)
	pieces := []string{"api_key", "token", "TOKEN", "x-api-key", "password", "PASSWORD", "secret", "DB_PASSWORD", "PGPASSWORD", "STRIPE_KEY", "key", "sig", "auth",
		"Authorization", "Cookie", "Set-Cookie", "curl", "-u", "--user", "mysql", "mysqldump", "-p", "sshpass", "--password", "--token", "--api-key", "--", "-",
		"bearer", "=", ":", "\uFF1D", "%3D", "%253D", "%3F", "%3A", "%253A", "%20", "+", "&quot;", "&#34;", "&#x22;", "&apos;", "&#39;", "&amp;", "&", "?", ";", " ", "  ", "\t", "\n", "\r\n", "\f", "\u00a0", `"`, "'", `\"`, `\\`, "<", ">", "%", "_", ".",
		"\u017f", "\u212a", "pa\u017f\u017fword", "Zq8Lm2Xv9Rt4Wk7Pd3Hs", "abcdefgh", "a1", "x", strings.Repeat(" ", 2000), strings.Repeat("a-", 40),
		strings.Repeat("ab_", 30), strings.Repeat("x", 1100), strings.Repeat("\n", 50), "\u00e9", "A_KEY", "_KEY", "KEY", "export "}
	r := rand.New(rand.NewSource(51580))
	n := 4000
	if v, err := strconv.Atoi(os.Getenv("KEYWORD_GATE_ITERATIONS")); err == nil {
		n = v // a longer run on demand (QA ran 60000)
	}
	for i := 0; i < n; i++ {
		var b strings.Builder
		for n := 3 + r.Intn(30); n > 0; n-- {
			b.WriteString(pieces[r.Intn(len(pieces))])
		}
		sameCoverage(t, "odd random", b.String())
	}
}

// The gate reads a text of nothing but names once: each name's window ends at the first byte a value cannot hold, and without a memory of the
// stretch already scanned that was one scan to the end of the text per name (256 KiB of "token=" took 3.7 s; a Scanner gives the detector 16 KiB at a time,
// so it showed as speed, not a hang).
func TestKeywordGateIsLinearOnTextOfNames(t *testing.T) {
	if raceEnabled {
		t.Skip("the time is not read under -race")
	}
	for _, unit := range []string{"token=", "key:", "token%3D", "api_key=v;", "--password=x"} {
		if ratio, ok := growthRatio(func(text string) { keywordSpans(text) }, unit); ok && ratio > maxLinearGrowth {
			t.Errorf("%q repeated: four times the text took %.1f times as long (linear is 4, quadratic 16)", unit, ratio)
		}
	}
}

// The check is relative, not a wall-clock budget (#21793: a loaded CI runner took 1.81 s against a fixed 1.5 s): the same run times a text and one four times as long and compares them, so a slow machine slows
// both. Linear is a ratio of 4 and quadratic 16; the bound sits between them, generous for noise.
const maxLinearGrowth = 9.0

// growthRatio times run on n and 4n bytes of repeated unit (the best of three each, so one slow run does not decide) and returns big/small. ok is false when the small run is too quick to measure: nothing quadratic
// is that quick at this size.
func growthRatio(run func(string), unit string) (ratio float64, ok bool) {
	best := func(size int) time.Duration {
		text := strings.Repeat(unit, size/len(unit))
		var min time.Duration
		for i := 0; i < 3; i++ {
			start := time.Now()
			run(text)
			if d := time.Since(start); i == 0 || d < min {
				min = d
			}
		}
		return min
	}
	small, big := best(64<<10), best(256<<10)
	if small < 2*time.Millisecond {
		return 0, false
	}
	return float64(big) / float64(small), true
}

// The mutant: a scan that goes back to the end of the text once per name (what the gate did before it remembered the stretch scanned) is quadratic, and the relative check says so.
func TestTheGrowthCheckCatchesAQuadraticScan(t *testing.T) {
	if raceEnabled {
		t.Skip("the time is not read under -race")
	}
	quadratic := func(text string) {
		n := 0
		for i := 0; i < len(text); i += 6 { // one name every six bytes
			for j := i; j < len(text); j++ { // each scans to the end
				if text[j] == '\x00' {
					n++
				}
			}
		}
		_ = n
	}
	ratio, ok := growthRatio(quadratic, "token=")
	if !ok || ratio <= maxLinearGrowth {
		t.Fatalf("a quadratic scan was not caught: ratio %.1f ok=%v", ratio, ok)
	}
	linear := func(text string) {
		n := 0
		for j := 0; j < len(text); j++ {
			if text[j] == '\x00' {
				n++
			}
		}
		_ = n
	}
	if ratio, ok := growthRatio(linear, "token="); ok && ratio > maxLinearGrowth {
		t.Fatalf("a linear scan was called quadratic: ratio %.1f", ratio)
	}
}
