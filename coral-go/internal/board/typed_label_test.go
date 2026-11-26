package board

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// TypedLabel keeps letters, digits, spaces and . , : _ - / and nothing else a shell could act on (goal #7).
func TestTypedLabel(t *testing.T) {
	for in, want := range map[string]string{
		"Fix the build": "Fix the build",
		"Ñandú 日本語 v2.0.3: done/ok_now-1":                 "Ñandú 日本語 v2.0.3: done/ok_now-1",
		`a"; New-Item m; "`:                               "a New-Item m",
		"$(calc) `whoami` & | < > ^ %PATH%":               "calc whoami PATH",
		"(calc) @(calc) { x } [y] it's":                   "calc calc x y it s",
		"line one\nline two\r\n":                          "line one line two",
		"\u201cq\u201d \u2018r\u2019 \u2013Force \u2014x": "q r Force x",
		"\u202efdp.exe zero\u200bwidth":                   "fdp.exe zero width",
		"   ":                                             "",
		"":                                                "",
	} {
		assert.Equal(t, want, TypedLabel(in), "%q", in)
	}
	long := TypedLabel(strings.Repeat("ab ", 60))
	assert.True(t, strings.HasSuffix(long, "..."), long)
	assert.LessOrEqual(t, len([]rune(long)), typedLabelMax+3)
}

// TypedText is the same set plus '#', cut at typedTextMax: the team health check keeps naming "#12".
func TestTypedText(t *testing.T) {
	assert.Equal(t, "Waiting: Backend Dev on #12 said calc", TypedText(`Waiting: Backend Dev on #12 (said "$(calc)")`))
	assert.Equal(t, 300, len(TypedText(strings.Repeat("a", 300))))
	// modifier letters (Lm) go: Windows may best-fit them to ASCII punctuation
	assert.Equal(t, "it s x y", TypedLabel("it\u02bcs x\u02c6y"))
	assert.Equal(t, typedTextMax+3, len([]rune(TypedText(strings.Repeat("a", 2000)))), "cut at the cap, with ...")
}

// #21501: a percentage in a typed notice keeps its sign ("5xx rate above 2% for 10m" arrived as "2 for 10m"); a '%' that is not right after a digit stays out, because cmd.exe expands %NAME% and "%s", "%%" are no number.
func TestTypedTextKeepsAPercentageAndNothingElseWithAPercent(t *testing.T) {
	for in, want := range map[string]string{
		"firing: HighErrorRate, web-1: 5xx rate above 2% for 10m": "firing: HighErrorRate, web-1: 5xx rate above 2% for 10m",
		"disk 100% full, 99.5% ok, 0%":                            "disk 100% full, 99.5% ok, 0%",
		"%":                                                       "",
		"%s %d %v":                                                "s d v",
		"%%":                                                      "",
		"2%%":                                                     "2%",
		"rate %PATH% here":                                        "rate PATH here",
		"%USERPROFILE%":                                           "USERPROFILE",
		"50 % off":                                                "50 off",
		"1%A1%":                                                   "1 A1%",
		"5%X2%":                                                   "5 X2%",
		"1%1%":                                                    "1 1%",
		"1%_x%":                                                   "1 _x",
	} {
		assert.Equal(t, want, TypedText(in), "%q", in)
		assert.Equal(t, want, TypedLabel(in), "%q (a label keeps the same rule)", in)
	}
	assert.NotContains(t, TypedText("up 3%\nnext %x %PATH% 4%"), "%x", "no format verb or variable gets through")
}
