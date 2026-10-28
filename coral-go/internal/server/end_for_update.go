package server

import "log"

// endForUpdate ends this server for an update's relaunch (the dashboard's or Coral Hub's): the updater was just started and waits for the server AND everything else of the install to be gone before it
// replaces the install, then starts Coral again. Where a tray or the desktop app supervises this server (QuitForUpdate is set) the server quits the way the local "Install update" does, with the exit code the tray
// takes as "do not start it again, and quit too" (#166); a plain SIGTERM is a clean stop, which the tray leaves alone (it stays in the menu bar and starts nothing), so the updater waited two minutes for the
// tray to go, swapped nothing and started nothing, and the person was left with a tray and no Coral (update-real-macos item 5, #9760). Without a supervisor fallback ends the process as before.
func (s *Server) endForUpdate(fallback func()) {
	if s.cloudHandler != nil && s.cloudHandler.QuitForUpdate != nil {
		if err := s.cloudHandler.QuitForUpdate(); err == nil {
			return
		} else {
			log.Printf("[update] the supervisor would not quit this server for the update: %v", err)
		}
	}
	fallback()
}
