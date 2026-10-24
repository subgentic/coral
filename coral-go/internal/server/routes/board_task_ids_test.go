package routes

import (
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #7247 (part 1 of the #7245 note): the machine-wide task query takes a repeatable id filter. The tasks come in the order the ids were asked, each once; an id that is not there, was filtered out (a board
// narrowed away, a status) or is another board's the query is not asked about is listed in "missing" alike, so a caller learns nothing it could not read.
func TestTaskQueryByIds(t *testing.T) {
	e := newTQEnv(t)
	e.seed() // a, b (alpha), c, d (beta), e (gamma)
	a, b, c, d := e.ids["a"], e.ids["b"], e.ids["c"], e.ids["d"]
	idq := func(ids ...int64) string {
		var parts []string
		for _, id := range ids {
			parts = append(parts, fmt.Sprintf("id=%d", id))
		}
		return strings.Join(parts, "&")
	}
	missing := func(out map[string]any) []int64 {
		m := []int64{}
		for _, v := range out["missing"].([]any) {
			m = append(m, int64(v.(float64)))
		}
		return m
	}

	// Request order, not the sort order (created_at descending would be d, c, b, a), each once.
	assert.Equal(t, []string{"c", "a", "d"}, e.titles(idq(c, a, d, a)))
	code, out, body := e.get(idq(d, b, 99999) + "&fields=summary")
	require.Equal(t, 200, code, body)
	assert.Len(t, out["tasks"], 2)
	assert.Equal(t, []int64{99999}, missing(out), "an id that is not there is missing")
	assert.EqualValues(t, 2, out["total"])
	code, out, body = e.get(idq(a, b))
	require.Equal(t, 200, code, body)
	assert.Equal(t, []int64{}, missing(out), "nothing missing is an empty list, not an absent key")

	// A comma list is the same as repeating, and both spellings can be mixed.
	assert.Equal(t, []string{"b", "a", "c"}, e.titles(fmt.Sprintf("id=%d,%d&id=%d", b, a, c)))

	// Another filter narrows: the ids it filters out are missing, exactly like an id that does not exist.
	code, out, body = e.get(idq(a, b, c, d) + "&board=beta")
	require.Equal(t, 200, code, body)
	assert.Len(t, out["tasks"], 2)
	assert.Equal(t, []int64{a, b}, missing(out), "the ids of another board look like ids that are not there")
	code, outNone, _ := e.get(idq(99998, 99999) + "&board=beta")
	require.Equal(t, 200, code)
	assert.Equal(t, []int64{99998, 99999}, missing(outNone))
	assert.Empty(t, outNone["tasks"])

	// The whole rows too (no fields): same order.
	code, out, body = e.get(idq(d, c))
	require.Equal(t, 200, code, body)
	rows := out["tasks"].([]any)
	require.Len(t, rows, 2)
	assert.Equal(t, "d", rows[0].(map[string]any)["title"])
	assert.Equal(t, "c", rows[1].(map[string]any)["title"])
}

func TestTaskQueryByIdsRefusals(t *testing.T) {
	e := newTQEnv(t)
	e.seed()
	a := e.ids["a"]
	many := func(n int) string {
		var parts []string
		for i := 1; i <= n; i++ {
			parts = append(parts, fmt.Sprintf("id=%d", i))
		}
		return strings.Join(parts, "&")
	}
	for name, q := range map[string]string{
		"not a number":         "id=abc",
		"zero":                 "id=0",
		"negative":             "id=-4",
		"signed":               "id=%2B4",
		"a float":              "id=1.5",
		"an empty value":       "id=",
		"an empty list member": "id=1,,2",
		"too large":            "id=99999999999999999999",
		"over the cap":         many(101),
		"with a cursor":        fmt.Sprintf("id=%d&cursor=abc", a),
		"with a limit":         fmt.Sprintf("id=%d&limit=5", a),
		"with sort":            fmt.Sprintf("id=%d&sort=updated_at", a),
		"with order":           fmt.Sprintf("id=%d&order=asc", a),
		"with a search":        fmt.Sprintf("id=%d&q=x", a),
	} {
		code, out, body := e.get(q)
		assert.Equal(t, 400, code, "%s: %s", name, body)
		assert.NotEmpty(t, out["error"], name)
	}
	code, out, body := e.get(many(100))
	assert.Equal(t, 200, code, "exactly the cap is fine: %s", body)
	assert.Len(t, out["missing"], 100-5, "five of the first hundred ids are the seeded tasks (or fewer): the rest are missing")
}
