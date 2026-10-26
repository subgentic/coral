package server

import (
	"context"
	"github.com/go-chi/chi/v5"
	"log"
	"net/http"

	"github.com/subgentic/coral/internal/proxy"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/server/routes"
	"github.com/subgentic/coral/internal/store"
)

// registerBoard: the board, board remotes and one-shot task routes, and the board handler's wiring.
func (s *Server) registerBoard(r *chi.Mux, h *routeHandlers) {
	s.registerBoardRemotes(r)
	boardHandler, notifHandler := s.configureBoardHandlers(h)
	r.Post("/api/notifications", notifHandler.Create)
	s.registerBoardAPI(r, boardHandler, h.sess)
	s.registerOneShotTasks(r)
}

func (s *Server) registerBoardRemotes(r *chi.Mux) {
	// Board remotes
	brHandler := routes.NewBoardRemotesHandler(s.db, s.cfg)
	r.Post("/api/board/remotes", brHandler.AddSubscription)
	r.Delete("/api/board/remotes", brHandler.RemoveSubscription)
	r.Get("/api/board/remotes", brHandler.ListSubscriptions)
	r.Get("/api/board/remotes/proxy/{remoteServer}/projects", brHandler.ProxyProjects)
	r.Get("/api/board/remotes/proxy/{remoteServer}/{project}/messages/all", brHandler.ProxyMessages)
	r.Get("/api/board/remotes/proxy/{remoteServer}/{project}/subscribers", brHandler.ProxySubscribers)
	r.Get("/api/board/remotes/proxy/{remoteServer}/{project}/messages/check", brHandler.ProxyCheckUnread)
}

func (s *Server) configureBoardHandlers(h *routeHandlers) (*routes.BoardHandler, *routes.NotificationHandler) {
	sessHandler, teamsHandler := h.sess, h.teams
	// Message board
	boardHandler := routes.NewBoardHandler(s.boardStore)
	boardHandler.SetTerminal(s.terminal)
	boardHandler.SetHubOperatorAllowed(func(r *http.Request) bool {
		return s.cloudHandler != nil && s.cloudHandler.HubOperatorAllowed(r)
	})
	boardHandler.SetArchivedSessionLookup(routes.ArchivedSessionLookup(store.NewSessionStore(s.db)))
	boardHandler.SetLiveSessionLookup(routes.LiveSessionLookup(store.NewSessionStore(s.db)))
	boardHandler.SetTaskArtifactWriter(s.cfg.CoralDir(), sessHandler.PersistTaskChanges)
	sessStore := store.NewSessionStore(s.db)
	boardHandler.SetBoardChatFlagsClearer(sessStore.DeleteBoardChatFlags)
	boardHandler.SetAllowlistFlag(routes.AllowlistEnabled(sessStore))
	artifactNudger := routes.NewClaudeArtifactNudger(sessStore, s.terminal)
	boardHandler.SetArtifactNudger(artifactNudger)
	sessHandler.SetArtifactNudger(artifactNudger)
	boardHandler.SetHubCrossTeamLock(routes.HubCrossTeamLockFromSettings(sessStore.GetSettings))
	boardHandler.SetLinksSeen(routes.LinksSeenFromSettings(sessStore.GetSettings), routes.MarkLinksSeen(sessStore.SetSetting))
	boardHandler.SetOwnServerID(func(ctx context.Context) (string, error) {
		c, err := store.NewCloudStore(s.db, store.NewRemoteServerStore(s.db, s.cfg.CoralDir())).Get(ctx)
		if err != nil || c == nil {
			return "", err
		}
		return c.ServerID, nil
	})
	boardHandler.SetAutoAttacher(routes.NewAutoAttacher(s.cfg.CoralDir(), routes.AutoAttachEnabled(sessStore), routes.SessionDirs(sessStore)))
	s.goBackground(boardHandler.RecoverTaskNotifications)
	s.goBackground(boardHandler.RunWaitTimeouts)
	s.goBackground(func(ctx context.Context) {
		if err := boardHandler.RestoreSubscriberReminders(ctx); err != nil {
			log.Printf("restore subscriber reminders: %v", err)
		}
	})
	s.boardHandler = boardHandler
	sessHandler.SetBoardHandler(boardHandler)
	sessHandler.SetScheduleStore(store.NewScheduleStore(s.db))
	sessHandler.SetTeamStore(teamsHandler.Store())
	sessHandler.SetAgentOperatorGate(s.identity.AgentOperatorAction)
	sessHandler.SetTokenStore(store.NewTokenUsageStore(s.db))
	// Automated sends are spaced per team (#3613): a session's team is the board it is on.
	ptymanager.SetTeamResolver(newTeamResolver(s.boardStore))
	notifStore := routes.NewNotificationStore()
	sessHandler.SetNotificationStore(notifStore)
	autoAccept := routes.NewAutoAcceptor(sessHandler)
	autoAccept.Start(s.bgCtx)
	s.goBackground(autoAccept.Run)
	s.goBackground(sessHandler.RecoverPersonalTaskNotifications)
	// Sessions launched before their CLI version was recorded get it now (#3573).
	s.goBackground(sessHandler.BackfillCLIVersions)
	notifHandler := routes.NewNotificationHandler(notifStore)
	return boardHandler, notifHandler
}

func (s *Server) registerBoardAPI(r *chi.Mux, boardHandler *routes.BoardHandler, sessHandler *routes.SessionsHandler) {
	// Board routes need an open board store; when messageboard.db could not be opened they answer 503
	// instead of dereferencing a nil store (#4924). Routes that work without a board stay outside this
	// group: team availability self-guards on a nil board, and session artifacts use the artifact store.
	r.Group(func(r chi.Router) {
		r.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if s.boardStore == nil {
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusServiceUnavailable)
					_, _ = w.Write([]byte(`{"error":"board unavailable","code":"board_unavailable"}`))
					return
				}
				next.ServeHTTP(w, req)
			})
		})
		s.registerBoardMessageRoutes(r, boardHandler)
		s.registerBoardTaskRoutes(r, boardHandler)
	})

	// These work without an open board, so they stay outside the board group (#4924): team
	// availability self-guards on a nil board store, and session artifacts come from the artifact store.
	r.Get("/api/board/{project}/status", sessHandler.TeamAvailability)
	r.Get("/api/session-artifacts", boardHandler.ListSessionArtifacts)
}

func (s *Server) registerBoardMessageRoutes(r chi.Router, boardHandler *routes.BoardHandler) {
	r.Get("/api/board/projects", boardHandler.ListProjects)
	r.Post("/api/board/{project}/subscribe", boardHandler.Subscribe)
	r.Delete("/api/board/{project}/subscribe", boardHandler.Unsubscribe)
	r.Post("/api/board/{project}/messages", boardHandler.PostMessage)
	r.Get("/api/board/{project}/messages", boardHandler.ReadMessages)
	r.Get("/api/board/{project}/messages/all", boardHandler.ListAllMessages)
	r.Get("/api/board/{project}/messages/search", boardHandler.SearchMessages)
	r.Post("/api/board/{project}/messages/mark-read", boardHandler.MarkRead)
	r.Get("/api/board/{project}/messages/check", boardHandler.CheckUnread)
	r.Delete("/api/board/{project}/messages/{messageID}", boardHandler.DeleteMessage)
	r.Get("/api/board/{project}/subscribers", boardHandler.ListSubscribers)
	r.Get("/api/board/{project}/peek", boardHandler.PeekAgent)
	r.Post("/api/board/{project}/pause", boardHandler.PauseBoard)
	r.Post("/api/board/{project}/resume", boardHandler.ResumeBoard)
	r.Get("/api/board/{project}/paused", boardHandler.GetPaused)
	r.Get("/api/board/{project}/settings", boardHandler.GetBoardSettings)
	r.Put("/api/board/{project}/settings", boardHandler.UpdateBoardSettings)
	r.Post("/api/board/{project}/external-messages", boardHandler.PostExternalMessage)
	r.Post("/api/board/{project}/external-artifacts", boardHandler.PostExternalArtifact)
	// To another Coral through Coral Hub (#3489); this computer only (not in the tunnel's table).
	r.Post("/api/board/{project}/relay-messages", boardHandler.PostRelayMessage)
	r.Get("/api/board/{project}/relay-targets", boardHandler.ListRelayTargets)
	r.Post("/api/board/{project}/hub-notice", boardHandler.PostHubNotice)
	// Coral Hub's full list of cross-team links (#5572): only through this computer's own connector, only from Coral Hub.
	r.Post("/api/cloud/cross-team-links", boardHandler.PostCrossTeamLinks)
	// Coral Hub's owner turns a team's two cross-team switches on or off (#5572): Launch tier, the owner marker, the local lock.
	r.Get("/api/board/{project}/cross-team/settings", boardHandler.GetCrossTeamSettingsForHub)
	r.Post("/api/board/{project}/cross-team/enable", boardHandler.HubCrossTeamEnable)
	r.Post("/api/board/{project}/cross-team/disable", boardHandler.HubCrossTeamDisable)
	r.Post("/api/board/{project}/cross-team/files/enable", boardHandler.HubCrossTeamFilesEnable)
	r.Post("/api/board/{project}/cross-team/files/disable", boardHandler.HubCrossTeamFilesDisable)
	r.Delete("/api/board/{project}", boardHandler.DeleteBoard)
	r.Get("/api/board/{project}", boardHandler.GetBoardInfo)
	r.Patch("/api/board/{project}", boardHandler.RenameBoard)
	r.Get("/api/board/{project}/groups", boardHandler.ListGroups)
	r.Get("/api/board/{project}/groups/{groupID}/members", boardHandler.ListGroupMembers)
	r.Post("/api/board/{project}/groups/{groupID}/members", boardHandler.AddGroupMember)
	r.Delete("/api/board/{project}/groups/{groupID}/members/{sessionID}", boardHandler.RemoveGroupMember)
	r.Post("/api/board/{project}/waits", boardHandler.RegisterWait)
	r.Get("/api/board/{project}/waits", boardHandler.GetActiveWait)
	r.Delete("/api/board/{project}/waits", boardHandler.CancelWait)
	r.Get("/api/board/{project}/waits/poll", boardHandler.PollWait)
}

func (s *Server) registerBoardTaskRoutes(r chi.Router, boardHandler *routes.BoardHandler) {
	// Board tasks (global)
	r.Get("/api/board/tasks", boardHandler.ListAllTasks)
	// Board tasks (per-project)
	r.Post("/api/board/{project}/tasks", boardHandler.CreateTask)
	r.Get("/api/board/{project}/working-mode", boardHandler.GetWorkingMode)
	r.Put("/api/board/{project}/working-mode", boardHandler.SetWorkingMode)
	r.Get("/api/board/{project}/cross-team-state", boardHandler.GetCrossTeamState)
	r.Get("/api/board/{project}/cross-team-candidates", boardHandler.GetCrossTeamCandidates)
	r.Get("/api/board/{project}/settings/log", boardHandler.GetCrossTeamLog)
	r.Get("/api/board/{project}/working-mode/presets", boardHandler.ListWorkflowPresets)
	r.Post("/api/board/{project}/working-mode/presets", boardHandler.SaveWorkflowPreset)
	r.Put("/api/board/{project}/working-mode/presets/{presetID}", boardHandler.SaveWorkflowPreset)
	r.Post("/api/board/{project}/working-mode/presets/{presetID}/reset", boardHandler.ResetWorkflowPreset)
	r.Get("/api/board/{project}/tasks", boardHandler.ListTasks)
	r.Get("/api/board/{project}/spend", routes.NewSpendHandler(s.db, s.boardStore).Spend) // the Analytics view: tokens, commits on main, tool calls and task times (#7525); never through the Hub
	// Goals (#7087): board text, written by the Operator or an orchestrator, readable like tasks.
	r.Post("/api/board/{project}/goals", boardHandler.CreateGoal)
	r.Get("/api/goals", boardHandler.ListAllGoals) // every board's goals (#7260), the Operator's; /api/goals/metrics is the Jobs metrics
	r.Get("/api/board/{project}/goals", boardHandler.ListGoals)
	r.Get("/api/board/{project}/goals/{goalID}", boardHandler.GetGoal)
	r.Patch("/api/board/{project}/goals/{goalID}", boardHandler.UpdateGoal)
	r.Post("/api/board/{project}/goals/{goalID}/close", boardHandler.CloseGoal)
	r.Put("/api/board/{project}/tasks/{taskID}/goal", boardHandler.SetTaskGoal)
	// Goal requests between two boards of this computer (#7361): not carried through Coral Hub yet.
	r.Post("/api/board/{project}/goal-requests", boardHandler.PostGoalRequest)
	r.Get("/api/goal-links", boardHandler.GoalLinks) // the Hub's service-only read of the tasks made for one accepted goal request (#7364); 403 for everyone else
	r.Get("/api/board/{project}/goal-requests", boardHandler.ListGoalRequests)
	r.Post("/api/board/{project}/goal-requests/{requestID}/accept", boardHandler.AcceptGoalRequest)
	r.Post("/api/board/{project}/goal-requests/{requestID}/decline", boardHandler.DeclineGoalRequest)
	r.Post("/api/board/{project}/tasks/claim", boardHandler.ClaimTask)
	r.Post("/api/board/{project}/tasks/current", boardHandler.ActiveTask)
	r.Get("/api/board/{project}/tasks/{taskID}", boardHandler.GetTask)
	r.Get("/api/board/{project}/tasks/{taskID}/artifact-content", boardHandler.TeamArtifactContent)
	r.Get("/api/board/{project}/artifacts", boardHandler.ListTeamArtifacts)
	r.Put("/api/board/{project}/artifacts/{id}/tags", boardHandler.SetArtifactTags) // the Operator's and the team owner's (#8583); no tunnel row
	r.Post("/api/board/{project}/tasks/{taskID}/complete", boardHandler.CompleteTaskByID)
	r.Post("/api/board/{project}/tasks/{taskID}/submit-review", boardHandler.SubmitCompletionReview)
	r.Post("/api/board/{project}/tasks/{taskID}/release-review", boardHandler.ReleaseCompletionReview)
	r.Post("/api/board/{project}/tasks/{taskID}/review", boardHandler.DelegateReview)  // #3725
	r.Post("/api/board/{project}/tasks/{taskID}/approve", boardHandler.ApproveReview)  // #3725
	r.Post("/api/board/{project}/tasks/{taskID}/reject", boardHandler.RejectReview)    // #3725
	r.Post("/api/board/{project}/tasks/{taskID}/attach", boardHandler.AttachPatches)   // the merge queue (#5689)
	r.Post("/api/board/{project}/tasks/{taskID}/send-back", boardHandler.SendBack)     // the merge queue (#5689)
	r.Post("/api/board/{project}/tasks/{taskID}/mark-landed", boardHandler.MarkLanded) // the merge queue (#5689)
	r.Get("/api/board/{project}/queue", boardHandler.MergeQueue)                       // the merge queue (#5689)
	r.Post("/api/board/{project}/tasks/{taskID}/cancel", boardHandler.CancelTaskByID)
	r.Patch("/api/board/{project}/tasks/{taskID}", boardHandler.UpdateTask)
	r.Patch("/api/board/{project}/tasks/{taskID}/amend", boardHandler.AmendTask)
	r.Post("/api/board/{project}/tasks/{taskID}/reassign", boardHandler.ReassignTask)
	r.Post("/api/board/{project}/tasks/{taskID}/nudge", boardHandler.NudgeTask)
	r.Post("/api/board/{project}/tasks/{taskID}/reply", boardHandler.ReplyToTask) // a message linked to the task, the creator mentioned (#5463)
	r.Post("/api/board/{project}/tasks/{taskID}/park", boardHandler.ParkTask)
	r.Delete("/api/board/{project}/tasks/{taskID}/park", boardHandler.ParkTask)
	r.Post("/api/board/{project}/health/ack", boardHandler.AckHealthItem)
	r.Post("/api/board/{project}/tasks/{taskID}/reminder", boardHandler.RemindTask)
	r.Delete("/api/board/{project}/tasks/{taskID}/reminder", boardHandler.RemindTask)
	r.Post("/api/board/{project}/reminder", boardHandler.RemindSubscriber)
	r.Delete("/api/board/{project}/reminder", boardHandler.RemindSubscriber)
	r.Get("/api/board/{project}/reminder", boardHandler.GetSubscriberReminder) // the instruction in force, for a person only and never through the Hub (#6329)
	r.Post("/api/board/{project}/tasks/{taskID}/publish", boardHandler.PublishTask)
	r.Get("/api/board/{project}/tasks/{taskID}/cost", boardHandler.TaskLiveCost)
	r.Get("/api/board/{project}/tasks/{taskID}/changes.diff", boardHandler.TaskChangesDiff)
}

func (s *Server) registerOneShotTasks(r *chi.Mux) {
	// One-shot tasks
	tasksHandler := routes.NewTasksHandler(s.db, s.cfg)
	s.tasksHandler = tasksHandler
	r.Post("/api/tasks/run", tasksHandler.SubmitTask)
	r.Get("/api/tasks/runs", tasksHandler.ListTasks)
	r.Get("/api/tasks/active", tasksHandler.ListActiveRuns)
	r.Get("/api/tasks/runs/{runID}", tasksHandler.GetTaskStatus)
	r.Post("/api/tasks/runs/{runID}/kill", tasksHandler.KillTask)

	// Proxy interception, CONNECT, proxy dashboards, and provider-key loading
	// are retired. Keep the historical proxy store read-only for cost reports.
	historicalProxyStore := proxy.NewStore(s.db.DB)
	tasksHandler.SetProxyStore(historicalProxyStore)
}
