// The board database's schema and its migrations (moved out of store.go, #4998; no behaviour change).

package board

import (
	"context"
	"log"
)

func (s *Store) ensureSchema(ctx context.Context) error {
	if err := s.createBoardCoreTables(ctx); err != nil {
		return err
	}
	if err := s.createBoardTaskTables(ctx); err != nil {
		return err
	}
	if err := s.createBoardTaskDependencies(ctx); err != nil {
		return err
	}
	s.migrateBoardColumns(ctx)
	s.backfillBoardSubscriberIDs(ctx)
	s.createBoardLookupIndexes(ctx)
	if err := s.ensureMessageCounts(ctx); err != nil {
		return err
	}

	// Migrate CHECK constraint to include 'blocked' status for existing databases.
	// SQLite doesn't support ALTER CONSTRAINT, so we recreate the table.
	if err := s.migrateTasksCheckConstraint(ctx); err != nil {
		return err
	}

	if err := s.ensureWaitsSchema(ctx); err != nil {
		return err
	}
	if err := s.ensureBoardSettingsSchema(ctx); err != nil {
		return err
	}
	if err := s.migrateHealthDefaultOff(ctx); err != nil {
		return err
	}
	if err := s.ensureHubOperatorActionsSchema(ctx); err != nil {
		return err
	}
	if err := s.ensureSwitchLogSchema(ctx); err != nil {
		return err
	}
	if err := s.ensureTeamLinksSchema(ctx); err != nil {
		return err
	}
	if err := s.ensureHealthSchema(ctx); err != nil {
		return err
	}

	if err := s.initTaskWorkflows(ctx); err != nil {
		return err
	}
	if err := s.ensureBoardsSchema(ctx); err != nil {
		return err
	}
	if err := s.ensureCrossTeamIDSchema(ctx); err != nil {
		return err
	}
	if err := s.ensureGoalsSchema(ctx); err != nil {
		return err
	}
	if err := s.ensureGoalRequestsSchema(ctx); err != nil {
		return err
	}
	if err := s.ensureAsksSchema(ctx); err != nil {
		return err
	}
	if err := s.ensureArtifactTagsSchema(ctx); err != nil {
		return err
	}
	if err := s.ensureTaskVersions(ctx); err != nil {
		return err
	}
	// The mention index and its backfill (#4465). A failure here only means ReadMessages reads as it did.
	if err := s.ensureMentionIndexSchema(ctx); err != nil {
		log.Printf("[board] mention index: %v", err)
	}
	return nil
}
