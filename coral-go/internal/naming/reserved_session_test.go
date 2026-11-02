package naming

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #12309 (Security's SHOULD on #12176): the id that holds the person's own pictures can never be a real session's.
func TestThePersonPictureSessionIDIsReserved(t *testing.T) {
	assert.Equal(t, "70657273-6f6e-4000-8000-706963747572", PersonPictureSessionID, "the value other code stored records under: it must not change")
	assert.True(t, IsReservedSessionID(PersonPictureSessionID))
	assert.True(t, IsReservedSessionID(strings.ToUpper(PersonPictureSessionID)), "case does not make it another id")
	assert.True(t, IsReservedSessionID(" "+PersonPictureSessionID+"\n"), "nor does white space")
	for _, id := range []string{"", "70657273-6f6e-4000-8000-706963747573", "6b35e836-8b9d-c7c2-e799-9d775bf350f0", "claude-" + PersonPictureSessionID} {
		assert.False(t, IsReservedSessionID(id), id)
	}
}
