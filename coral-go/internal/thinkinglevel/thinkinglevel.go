// Package thinkinglevel is the set of thinking levels Coral records for usage and task claims (#8915): what an agent CLI reports is its own text, so a label is kept only when it is one of these.
package thinkinglevel

import "strings"

// Other is what any level outside Known is recorded as.
const Other = "other"

// Known are the levels Coral records as they are.
var Known = []string{"low", "medium", "high", "xhigh", "max"}

// Normalize trims and lower-cases a level, and caps it to the known set: "" stays "" (nothing was recorded, never a guess), a known level is itself, anything else is Other.
func Normalize(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == "" {
		return ""
	}
	for _, k := range Known {
		if s == k {
			return s
		}
	}
	return Other
}

// SQLExpr is a SQL expression that applies Normalize to the value of expr (a column or a sub-select): NULL and blank stay NULL.
func SQLExpr(expr string) string {
	return "(SELECT CASE WHEN v IS NULL OR v = '' THEN NULL WHEN v IN ('" + strings.Join(Known, "','") + "') THEN v ELSE '" + Other + "' END FROM (SELECT LOWER(TRIM(" + expr + ")) AS v))"
}
