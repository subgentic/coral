package agentmodels

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The dashboard suites that pin a model picker (settings_html_pin, dialog_requests_golden) name the built-in models from tests/frontend/fixtures/builtin_model_names.json when
// they replace a CLI's leftover list (helpers/known_models.js). That table must be the server's own: a built-in model renamed here and not there would otherwise pass those pins.
func TestBuiltinNamesMatchTheTestFixture(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "tests", "frontend", "fixtures", "builtin_model_names.json"))
	require.NoError(t, err)
	var fixture map[string]string
	require.NoError(t, json.Unmarshal(raw, &fixture))
	require.NotEmpty(t, fixture, "an empty table pins nothing")
	assert.Equal(t, builtinDisplayNames, fixture, "builtinDisplayNames and tests/frontend/fixtures/builtin_model_names.json must name the same models the same way")
}
