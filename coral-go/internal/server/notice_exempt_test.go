package server

// The hub e2e fake is not a real terminal: the notice check does not apply to it (ptymanager.NoticeCheckExempt).
func (*fakeTerminal) NoticeCheckNotApplicable() {}
