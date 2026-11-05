package server

import (
	"context"
	"log/slog"
	"path/filepath"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/proctree"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/resources"
	"github.com/subgentic/coral/internal/server/routes"
)

// registerResources serves the resource queue (#13613). Its state is one file under the data folder; a file that cannot be read leaves the routes out and says why, never an empty queue (an agent that holds
// the Mac would be forgotten) and never a server that does not start (upgrades must not break Coral).
func (s *Server) registerResources(r chi.Router, sess *routes.SessionsHandler) {
	if s.boardStore == nil {
		return
	}
	mgr, err := resources.Open(resources.Options{
		Path:        filepath.Join(s.cfg.CoralDir(), "resources.json"),
		HistoryPath: filepath.Join(s.cfg.CoralDir(), "resource_history.db"), // the record of the queue's use (#13671): its own small file, so a file that fails loses analytics only
		Priorities:  resources.BoardPriorities{Store: s.boardStore},
		Alive:       func(agent string) bool { return agentStillOnABoard(s, agent) },
	})
	if err != nil {
		slog.Warn("resource queue is off", "error", err)
		return
	}
	hook := resources.NewHook(mgr, resources.HookOptions{
		Agent: func(ctx context.Context, sessionName string) (string, bool) {
			sub, err := s.boardStore.GetSubscriptionBySessionName(ctx, sessionName)
			if err != nil || sub == nil || sub.IsActive == 0 || sub.SubscriberID == "" {
				return "", false
			}
			return sub.SubscriberID, true
		},
		Commands: func(sessionName string) []string { return s.commandsBelowSession(sessionName) },
		Event: func(e resources.HookEvent) {
			slog.Info("[resource] shell hook", "kind", e.Kind, "resource", e.Resource, "pattern", e.Pattern, "agent", e.Agent, "why", e.Why) // the pattern, never the command
		},
	})
	if sess != nil {
		sess.SetResourceHook(hook)
	}
	h := &routes.ResourcesHandler{M: mgr, Board: s.boardStore, Hook: hook}
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

// commandsBelowSession is the command lines of the processes the session's agent has started that still run, or nil when that is not known (no per-session process, no ps): the hook then gives a slot back
// when the call ends.
func (s *Server) commandsBelowSession(sessionName string) []string {
	p, ok := s.backend.(ptymanager.SessionPIDProvider)
	if !ok {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	pid, err := p.SessionPID(ctx, sessionName)
	if err != nil || pid <= 1 {
		return nil
	}
	cmds, ok := proctree.CommandsBelow(ctx, pid)
	if !ok {
		return nil
	}
	return cmds
}
