package routes

import (
	"errors"
	"strconv"
)

// parseID reads a goal or task id from a path or a query: canonical decimal only, so "01", "+1", " 1", "1.0" and "0x1" are not another spelling of 1 (a path allowlist or a cache keyed on the literal
// path sees one spelling, #7239). Callers still refuse an id of 0.
func parseID(s string) (int64, error) {
	if s == "" || (len(s) > 1 && s[0] == '0') {
		return 0, errors.New("not a canonical id")
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0, errors.New("not a canonical id")
		}
	}
	return strconv.ParseInt(s, 10, 64)
}
