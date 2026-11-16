package routes

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #17119: an upload's note is stored against that version, cleaned to one line; a note carrying a sign-in link is refused, without the token in the answer.
func TestAnUploadsNoteIsStoredForThatVersionAndASignInLinkInItIsRefused(t *testing.T) {
	k := newKindRig(t)
	code, out := k.up("s1", "&note=added+a+Copy+all+button", nil)
	require.Equal(t, 201, code, out)
	id := strings.TrimPrefix(out["digest"].(string), "sha256:")
	require.NotEmpty(t, id, out)
	notes, err := k.h.bs.ArtifactNotes(context.Background(), []string{id})
	require.NoError(t, err)
	assert.Equal(t, "added a Copy all button", notes[id])

	code, out = k.up("s1", "&note=see+login_token%3D"+secretToken, nil)
	assert.Equal(t, 400, code)
	assert.Equal(t, "sign_in_link", out["code"])
	assert.NotContains(t, out["error"], secretToken)
}
