package board

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// #11412: an ask to the Operator names a goal in words; a bare #N is as likely a task.
func TestGoalsNamedInReadsGoalNumbersInWordsOnly(t *testing.T) {
	for text, want := range map[string][]int64{
		"@Operator goal 92: please check":                   {92},
		"@Operator Goal #92, please check":                  {92},
		"@Operator goals 92, 100 and #101: all three":       {92, 100, 101},
		"@Operator goals 5 & 6":                             {5, 6},
		"@Operator goal 7 and goal 7 again":                 {7},
		"@Operator see #92 and task 12":                     nil,
		"@Operator the goal is to ship in 2 weeks":          nil,
		"@Operator goal 0":                                  nil,
		"@Operator goal 99999999999999999999999999 is huge": nil,
		"": nil,
	} {
		assert.Equal(t, want, GoalsNamedIn(text), text)
	}
}
