package server

import (
	"log/slog"
	"path/filepath"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/limitwaits"
	"github.com/subgentic/coral/internal/server/routes"
)

// registerLimitWaits serves the limit waits of the agents (#21020). Their record is one small file of its own under the data folder: a file that cannot be opened leaves the page saying nothing is
// tracked, never a server that does not start (upgrades must not break Coral).
func (s *Server) registerLimitWaits(r chi.Router) {
	h := routes.NewLimitWaitsHandler(nil)
	r.Get("/api/analytics/limit-waits", h.Read) // the cost page's Limit waits card: names and counts only, the Operator's alone (through Coral Hub the owner's)
	st, err := limitwaits.Open(filepath.Join(s.cfg.CoralDir(), "limit_waits.db"))
	if err != nil {
		slog.Warn("the limit waits are not recorded", "error", err)
		return
	}
	s.limitWaits = st
	h.SetStore(st)
}

// LimitWaitsStore is the record of the limit waits (nil when it could not be opened): the counter writes to it.
func (s *Server) LimitWaitsStore() *limitwaits.Store { return s.limitWaits }
