package routes

import (
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// An agent artifact's name is shown to other people, so a name carrying a sign-in link is refused, without the token in the answer. The
// file's contents are not looked at: a report that quotes the parameter is still stored (#232 warns of files on the client).
func TestAnAgentArtifactsNameWithASignInLinkIsRefused(t *testing.T) {
	rig := newArtifactRig(t)
	for _, name := range []string{"report login_token=" + secretToken + ".txt", "x?next=%2F%3Flogin_token%253D" + secretToken} {
		code, out := rig.upload("s1", name, "text/plain", strings.NewReader("plain"))
		assert.Equal(t, http.StatusBadRequest, code, name)
		assert.Equal(t, "sign_in_link", out["code"], name)
		assert.NotContains(t, out["error"], secretToken)
	}
	code, out := rig.upload("s1", "report.txt", "text/plain", strings.NewReader("the log says login_token="+secretToken))
	require.Equal(t, http.StatusCreated, code, out)
}
