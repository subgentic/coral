package server

import (
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/internal/server/routes"
)

// #9760: a server a tray supervises ends itself for an update's relaunch with the quit-for-update exit (the tray quits too and the updater has the install), not with a plain SIGTERM, which the tray takes as a clean
// stop and leaves running: the updater then waits for it, swaps nothing and starts nothing.
func TestAnUpdateRelaunchQuitsASupervisedServerForTheUpdate(t *testing.T) {
	quits, fallbacks := 0, 0
	s := &Server{cloudHandler: &routes.CloudHandler{QuitForUpdate: func() error { quits++; return nil }}}
	s.endForUpdate(func() { fallbacks++ })
	assert.Equal(t, 1, quits, "the supervisor's quit-for-update is used")
	assert.Equal(t, 0, fallbacks, "and the plain end is not")

	// no supervisor (a plain coral run): the process ends as it always did
	quits, fallbacks = 0, 0
	s = &Server{cloudHandler: &routes.CloudHandler{}}
	s.endForUpdate(func() { fallbacks++ })
	assert.Equal(t, 1, fallbacks)
	s = &Server{}
	s.endForUpdate(func() { fallbacks++ })
	assert.Equal(t, 2, fallbacks, "a server with no handler either")

	// a supervisor that refuses: the server still ends, so the updater is not left waiting for it
	fallbacks = 0
	s = &Server{cloudHandler: &routes.CloudHandler{QuitForUpdate: func() error { return errors.New("no") }}}
	s.endForUpdate(func() { fallbacks++ })
	assert.Equal(t, 1, fallbacks)
}
