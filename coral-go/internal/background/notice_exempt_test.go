package background

// The test fakes of this package are not real terminals: the notice check does not apply to them (ptymanager.NoticeCheckExempt). A real runtime without the check fails closed.
func (*failingRuntime) NoticeCheckNotApplicable()     {}
func (*mockRuntime) NoticeCheckNotApplicable()        {}
func (*reconMockRuntime) NoticeCheckNotApplicable()   {}
func (*killRecorder) NoticeCheckNotApplicable()       {}
func (*mockFailingRuntime) NoticeCheckNotApplicable() {}
func (*faultyRuntime) NoticeCheckNotApplicable()      {}
func (*wfMockRuntime) NoticeCheckNotApplicable()      {}
