package board

import (
	"context"
	"sync"
)

// deletedBoards remembers the boards deleted since this server started (#12995): a page left open elsewhere keeps subscribing the Operator and saving settings on its board, and either would start the board again
// (a board is whatever has a member, a message or a setting). The Operator's subscribe and a settings save refuse a deleted board; an agent's own join is an explicit start and clears the mark. In memory
// only: a restart forgets it, and the open page's next load shows the board gone.
type deletedBoards struct {
	mu sync.Mutex
	m  map[string]bool
}

// NoteBoardDeleted marks a board as deleted.
func (s *Store) NoteBoardDeleted(project string) {
	s.deleted.mu.Lock()
	defer s.deleted.mu.Unlock()
	if s.deleted.m == nil {
		s.deleted.m = map[string]bool{}
	}
	s.deleted.m[project] = true
}

// BoardDeleted reports whether the board was deleted since the server started and nothing has started it again.
func (s *Store) BoardDeleted(project string) bool {
	s.deleted.mu.Lock()
	defer s.deleted.mu.Unlock()
	return s.deleted.m[project]
}

// ClearBoardDeleted forgets the mark: a board an agent joins on purpose is a board again.
func (s *Store) ClearBoardDeleted(project string) {
	s.deleted.mu.Lock()
	defer s.deleted.mu.Unlock()
	delete(s.deleted.m, project)
}

// StaysDeleted reports whether the board was deleted and nothing has started it again: marked, and no member, message, task or goal on it now (an agent that posted or joined started it; the mark is then dropped).
func (s *Store) StaysDeleted(ctx context.Context, project string) bool {
	if !s.BoardDeleted(project) {
		return false
	}
	if known, err := s.BoardKnown(ctx, project); err != nil || known {
		if err == nil {
			s.ClearBoardDeleted(project)
		}
		return false
	}
	return true
}
