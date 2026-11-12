package routes

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #15719: the dialog's line is the launch builders' answer for the chosen permissions.
func TestLaunchPermissionArgsRouteAnswersFromTheLaunchBuilders(t *testing.T) {
	h := &SessionsHandler{}
	ask := func(body string) (int, string) {
		w := httptest.NewRecorder()
		h.PostLaunchPermissionArgs(w, httptest.NewRequest(http.MethodPost, "/api/launch/permission-args", strings.NewReader(body)))
		return w.Code, w.Body.String()
	}
	code, out := ask(`{"agent_type":"codex","permission_mode":"bypassPermissions"}`)
	require.Equal(t, http.StatusOK, code, out)
	assert.JSONEq(t, `{"args":["--dangerously-bypass-approvals-and-sandbox"],"text":"--dangerously-bypass-approvals-and-sandbox"}`, out)
	_, out = ask(`{"agent_type":"codex","permission_mode":"plan"}`)
	assert.JSONEq(t, `{"args":["--sandbox","read-only","-a","on-request"],"text":"--sandbox read-only -a on-request"}`, out)
	_, out = ask(`{"agent_type":"codex","permission_mode":"plan","keep_full_access":true}`)
	assert.Contains(t, out, `"--dangerously-bypass-approvals-and-sandbox"`)
	_, out = ask(`{"agent_type":"codex","permission_mode":"default"}`)
	assert.JSONEq(t, `{"args":[],"text":""}`, out)
	code, _ = ask(`not json`)
	assert.Equal(t, http.StatusBadRequest, code)
}
