package routes

// The test fakes of this package are not real terminals: the notice check does not apply to them (ptymanager.NoticeCheckExempt). A real terminal without the check fails closed.
func (*uiRequestTerminal) NoticeCheckNotApplicable()        {}
func (*loadTestRuntime) NoticeCheckNotApplicable()          {}
func (*waitTimeoutFaultTerminal) NoticeCheckNotApplicable() {}
func (*humanCtxTerm) NoticeCheckNotApplicable()             {}
func (*agentTerm) NoticeCheckNotApplicable()                {}
func (*gatedReminderTerminal) NoticeCheckNotApplicable()    {}
func (*mockSessionTerminal) NoticeCheckNotApplicable()      {}
func (*blockingTerminal) NoticeCheckNotApplicable()         {}
