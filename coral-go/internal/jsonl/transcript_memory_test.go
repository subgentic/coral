package jsonl

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestAMemoryTranscriptIsSlicedLikeAFileOne(t *testing.T) {
	tr := NewMemoryTranscript([]map[string]any{{"content": "a"}, {"content": "b"}, {"content": "c"}})
	assert.Equal(t, 3, tr.Total)
	got := tr.Slice(context.Background(), 1, 3)
	assert.Equal(t, []string{"b", "c"}, []string{got[0]["content"].(string), got[1]["content"].(string)})
	assert.Len(t, tr.All(context.Background()), 3)
	assert.Empty(t, NewMemoryTranscript(nil).All(context.Background()))
}
