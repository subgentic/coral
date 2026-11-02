package agent

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestHermesGatewayRefusedIn(t *testing.T) {
	const real = "Error: Gateway could not start: the gateway exited with status 75 before it could serve:\n  ❌ Another gateway already owns this host: owner unknown (its record is gone)\n"
	assert.True(t, HermesGatewayRefusedIn(real))
	assert.True(t, HermesGatewayRefusedIn("ERROR: GATEWAY COULD NOT START ... ANOTHER GATEWAY\n   ALREADY OWNS THIS HOST"), "case and a wrapped line")
	assert.False(t, HermesGatewayRefusedIn("Error: Gateway could not start: the port is busy"), "another reason")
	assert.False(t, HermesGatewayRefusedIn("Another gateway already owns this host"), "one phrase alone")
	assert.False(t, HermesGatewayRefusedIn(""))
}
