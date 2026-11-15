//go:build windows

// Package winjob puts a command and everything it starts in one Windows Job Object (#17603). Windows has no process groups: ending the shell left what it started running beside the next
// agent's run. A job with kill-on-close ends the whole tree when it is terminated, and also when the process that owns the job dies (a dropped connection, a killed coral-board), with a
// cap on memory and on the number of live processes so a runaway command cannot take the box.
package winjob

import (
	"errors"
	"os/exec"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Limits are the caps of one job. Zero means no cap of that kind.
type Limits struct {
	MemoryBytes uint64 // the whole job's committed memory
	Processes   uint32 // live processes at once
}

// Default caps for a heavy run: generous for a Go or node build, small enough that a fork bomb stops.
var Default = Limits{MemoryBytes: 24 << 30, Processes: 512}

// Job is a job object. Close ends every process still in it.
type Job struct{ h windows.Handle }

// New makes a job with kill-on-close and the caps.
func New(l Limits) (*Job, error) {
	h, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | windows.JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
	if l.Processes > 0 {
		info.BasicLimitInformation.LimitFlags |= windows.JOB_OBJECT_LIMIT_ACTIVE_PROCESS
		info.BasicLimitInformation.ActiveProcessLimit = l.Processes
	}
	if l.MemoryBytes > 0 {
		info.BasicLimitInformation.LimitFlags |= windows.JOB_OBJECT_LIMIT_JOB_MEMORY
		info.JobMemoryLimit = uintptr(l.MemoryBytes)
	}
	if _, err := windows.SetInformationJobObject(h, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(h)
		return nil, err
	}
	return &Job{h: h}, nil
}

// Assign puts a started command in the job; what it starts afterwards joins the job too.
func (j *Job) Assign(c *exec.Cmd) error {
	if c.Process == nil {
		return errors.New("winjob: the command is not started")
	}
	p, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(c.Process.Pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(p)
	return windows.AssignProcessToJobObject(j.h, p)
}

// Kill ends every process in the job now.
func (j *Job) Kill() error { return windows.TerminateJobObject(j.h, 1) }

// Close ends every process still in the job and releases it.
func (j *Job) Close() error { return windows.CloseHandle(j.h) }
