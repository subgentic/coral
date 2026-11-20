package routes

import (
	"fmt"
	"math/rand"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/pkg/tunnel"
)

// #20078 (Security's INFO on #20061): the Hub table's {goal} segment (pkg/tunnel goalKeyRe) and the machine's own parser (parseGoalSubject) are two copies of one rule, and pkg/tunnel cannot import this package. They must accept exactly
// the same keys: a key the table lets through that the handler refuses is a dead row, and one the handler would take that the table refuses is a thread the Hub can never read. The oracle for the table is the real row: the owner
// pattern a GET of that key's comments path is classified by.
func TestTheHubTablesGoalKeyAndTheMachinesGoalKeyAreTheSameRule(t *testing.T) {
	inTable := func(key string) bool {
		pattern, _ := tunnel.OwnerRoute("GET", "/api/artifacts/"+key+"/comments")
		return pattern == "/api/artifacts/{goal}/comments"
	}
	inMachine := func(key string) bool { _, _, ok := parseGoalSubject(key); return ok }

	cases := []string{
		"goal:team-a:1", "goal:team-a:12", "goal:a:9", "goal:A:1", "goal:0:1", "goal:a.b_c-d:42", "goal:team-a:1234567890", "goal:team-a:12345678901", // the number's length limit: ten digits
		"goal:team-a:0", "goal:team-a:01", "goal:team-a:-1", "goal:team-a:1:2", "goal:team-a:", "goal::1", "goal:team-a", "goal:", "goal", "",
		"goal:.a:1", "goal:-a:1", "goal:_a:1", "goal:a/b:1", "goal:../x:1", "goal:a b:1", "goal:a:1x", "goal:a:x1", "goal:a:١", "goal:é:1", "GOAL:a:1", "Goal:a:1", " goal:a:1", "goal:a:1 ", "goal:a:1\n",
		"goal:" + strings.Repeat("a", 64) + ":1", "goal:" + strings.Repeat("a", 65) + ":1", "diff:a:1", "diff:" + strings.Repeat("a", 64) + ":a.go", strings.Repeat("a", 64),
	}
	// and a spread of generated keys over the characters either rule might treat differently
	alphabet := []rune("abzAZ09._-: /\\%é١\n")
	rng := rand.New(rand.NewSource(20078))
	for i := 0; i < 20000; i++ {
		var b strings.Builder
		b.WriteString("goal:")
		for n := rng.Intn(5); n > 0; n-- {
			b.WriteRune(alphabet[rng.Intn(len(alphabet))])
		}
		b.WriteString(":")
		for n := rng.Intn(4); n > 0; n-- {
			b.WriteRune(alphabet[rng.Intn(len(alphabet))])
		}
		cases = append(cases, b.String())
	}
	for i := 0; i < 2000; i++ {
		cases = append(cases, fmt.Sprintf("goal:%s:%d", strings.Repeat("t", 1+rng.Intn(70)), rng.Int63n(100000000000)))
	}
	accepted := 0
	for _, key := range cases {
		if inMachine(key) {
			accepted++
		}
		if !assert.Equal(t, inMachine(key), inTable(key), "the Hub table and the machine disagree about %q (machine %v)", key, inMachine(key)) {
			return
		}
	}
	assert.Greater(t, accepted, 10, "the check saw almost no accepted key, so it compared nothing")
}
