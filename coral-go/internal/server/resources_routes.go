package server

import (
	"context"
	"log/slog"
	"path/filepath"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/resources"
	"github.com/subgentic/coral/internal/server/routes"
)

// registerResources serves the resource queue (#13613). Its state is one file under the data folder; a file that cannot be read leaves the routes out and says why, never an empty queue (an agent that holds
// the Mac would be forgotten) and never a server that does not start (upgrades must not break Coral).
func (s *Server) registerResources(r chi.Router) {
	if s.boardStore == nil {
		return
	}
	mgr, err := resources.Open(resources.Options{
		Path:       filepath.Join(s.cfg.CoralDir(), "resources.json"),
		Priorities: resources.BoardPriorities{Store: s.boardStore},
		Alive:      func(agent string) bool { return agentStillOnABoard(s, agent) },
	})
	if err != nil {
		slog.Warn("resource queue is off", "error", err)
		return
	}
	h := &routes.ResourcesHandler{M: mgr, Board: s.boardStore}
	r.Get("/api/resources", h.List)
	r.Get("/api/resources/{name}", h.Get)
	r.Post("/api/resources/{name}/claim", h.Claim)
	r.Post("/api/resources/{name}/release", h.Release)
	r.Post("/api/resources/{name}/renew", h.Renew)
	r.Put("/api/resources/{name}", h.Define)
	r.Delete("/api/resources/{name}", h.Remove)
	r.Post("/api/resources/entries/{id}/move", h.Move)
	r.Delete("/api/resources/entries/{id}", h.Cancel)
}

// agentStillOnABoard is the queue's "is this agent alive": it still has an active subscription on some board. An agent that was removed (or the Operator's name) loses its place; a database error keeps it, because
// dropping a holder on a read failure would hand the Mac to a second agent.
func agentStillOnABoard(s *Server, agent string) bool {
	if agent == "Operator" {
		return true
	}
	sub, err := s.boardStore.GetSubscription(context.Background(), agent)
	return err != nil || sub != nil
}
