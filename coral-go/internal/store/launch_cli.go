package store

import "context"

// SetLaunchCLI keeps the CLI path a terminal session was launched with, or recorded as the agent with (#408); "" removes it.
func (s *SessionStore) SetLaunchCLI(ctx context.Context, sessionName, cli string) error {
	if sessionName == "" {
		return nil
	}
	if cli == "" {
		_, err := s.db.ExecContext(ctx, "DELETE FROM session_launch_cli WHERE session_name = ?", sessionName)
		return err
	}
	_, err := s.db.ExecContext(ctx,
		"INSERT INTO session_launch_cli (session_name, cli, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_name) DO UPDATE SET cli = excluded.cli, updated_at = excluded.updated_at",
		sessionName, cli, nowUTC())
	return err
}

// LaunchCLI is the CLI path kept for a terminal session, "" when there is none (a session from before it was kept, or one launched without a resolvable CLI).
func (s *SessionStore) LaunchCLI(ctx context.Context, sessionName string) string {
	var cli string
	if err := s.db.Reader().GetContext(ctx, &cli, "SELECT cli FROM session_launch_cli WHERE session_name = ?", sessionName); err != nil {
		return "" // none kept (sql.ErrNoRows), or unreadable: either way nothing to go on
	}
	return cli
}

// PruneLaunchCLI removes the paths kept for terminal sessions that are no longer active (a path with a user name in it must not outlive its session). Run where dead sessions are cleaned up.
func (s *SessionStore) PruneLaunchCLI(ctx context.Context) {
	_, _ = s.db.ExecContext(ctx,
		"DELETE FROM session_launch_cli WHERE session_name NOT IN (SELECT agent_type || '-' || session_id FROM live_sessions WHERE status = 'active')")
}
