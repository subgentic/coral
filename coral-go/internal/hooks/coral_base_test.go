package hooks

import (
	"strconv"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/internal/config"
)

// C7 (#13695): the hooks find Coral the way coral-board does, so CORAL_HOST counts when CORAL_URL is not set.
func TestCoralBaseHonoursCoralHostLikeCoralBoard(t *testing.T) {
	t.Setenv("CORAL_URL", "")
	t.Setenv("CORAL_HOST", "10.1.2.3")
	t.Setenv("CORAL_PORT", "8451")
	assert.Equal(t, "http://10.1.2.3:8451", CoralBase())
	t.Setenv("CORAL_PORT", "")
	assert.Equal(t, "http://10.1.2.3:"+strconv.Itoa(config.DefaultPort), CoralBase(), "a host alone takes the default port")
	t.Setenv("CORAL_HOST", "0.0.0.0")
	t.Setenv("CORAL_PORT", "8451")
	assert.Equal(t, "http://127.0.0.1:8451", CoralBase(), "a wildcard bind address is not dialable")
	t.Setenv("CORAL_HOST", "")
	assert.Equal(t, "http://localhost:8451", CoralBase(), "a port alone is as before")
	t.Setenv("CORAL_URL", "http://example.test:9/")
	t.Setenv("CORAL_HOST", "10.1.2.3")
	assert.Equal(t, "http://example.test:9", CoralBase(), "CORAL_URL still wins")
}
