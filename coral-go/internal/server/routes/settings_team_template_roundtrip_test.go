package routes

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #17509 (beta walk 73): a saved team template comes back from the settings store exactly as the New team dialog saved it. Each member keeps its permission_mode (Auto stays Auto), model and thinking level, and the
// template its working mode; the server stores the list as the dialog wrote it and drops no field. The mode and model lost in the walk were lost in the page (the dialog), which its browser suite pins.
func TestSavedTeamTemplateKeepsEachMembersModeAndModel(t *testing.T) {
	put, stored := settingsClient(t)
	const list = `[{"name":"walk73-template","flags":"","agents":[{"name":"Lead Developer","prompt":"You lead.","agent_type":"claude","model":"claude-haiku-5-5","thinking":"high","permission_mode":"auto","flags":"--permission-mode auto"},{"name":"QA Engineer","prompt":"You test.","agent_type":"claude","model":"claude-haiku-5-5","permission_mode":"default"}],"working_mode":{"mode":"task_queue","custom_instructions":"Use tabs."}}]`
	quoted, err := json.Marshal(list)
	require.NoError(t, err)
	body := `{"saved_team_templates": ` + string(quoted) + `}`
	require.Equal(t, http.StatusOK, put(body))
	assert.JSONEq(t, list, stored()["saved_team_templates"].(string), "the list is stored whole: every member's mode, model and thinking, and the working mode")
}
