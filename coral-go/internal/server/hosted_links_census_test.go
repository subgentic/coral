package server

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store/storetest"
)

// #21276 (Security's INFO on #21220): a server is built with the hosted-link check wired. Without it every tunneled request stays callerHub, and a key-linked Hub's request would be the person.
func TestTheServerWiresTheHostedLinkCheck(t *testing.T) {
	cfg := newE2EConfig(t, t.TempDir())
	db, err := storetest.Open(t, cfg.DBPath)
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	stack := newTermStack(t)
	srv := newTestServer(t, cfg, db, stack.backend, stack.terminal)
	require.NotNil(t, srv.identity)
	assert.True(t, srv.identity.HostedLinksSet(), "router.go wires SetHostedLinks: a key link's request is never the person")
	assert.True(t, srv.identity.KeyLinkHubsSet(), "router.go wires SetKeyLinkHubs: a stamp on a key link is checked against the hub id the link recorded (#21261)")
}
