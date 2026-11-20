//go:build windows

package ptymanager

import (
	"fmt"
	"sort"
	"strings"
	"testing"
	"unsafe"

	"github.com/stretchr/testify/assert"
	"golang.org/x/sys/windows"
)

var procNtQueryObject = windows.NewLazySystemDLL("ntdll.dll").NewProc("NtQueryObject")

// handleTypes counts this process's open handles by object type (Event, Thread, File, Process, Job, ...). It exists for a failing handle test:
// a future red says which kind of handle was left open (#20081), instead of only a count. It is only called on a failure, so it may be slow:
// it asks each handle value in turn, and a value that is not a handle is skipped.
func handleTypes() map[string]int {
	out := map[string]int{}
	buf := make([]byte, 1024)
	const objectTypeInformation = 2
	// a handle value is a multiple of four; a process with a few thousand handles has values well under 1<<20
	for v := uintptr(4); v < 1<<20; v += 4 {
		var n uint32
		r, _, _ := procNtQueryObject.Call(v, objectTypeInformation, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)), uintptr(unsafe.Pointer(&n)))
		if r != 0 { // an NTSTATUS that is not success: not a handle (or one that cannot be asked)
			continue
		}
		// the answer starts with a UNICODE_STRING: Length, MaximumLength, then the pointer to the characters (inside buf)
		length := *(*uint16)(unsafe.Pointer(&buf[0]))
		ptr := *(*unsafe.Pointer)(unsafe.Pointer(&buf[8]))
		if length == 0 || ptr == nil {
			continue
		}
		out[windows.UTF16ToString(unsafe.Slice((*uint16)(ptr), length/2))]++
	}
	return out
}

// describeHandles is the failure message's second half: the handle types, most first.
func describeHandles() string {
	types := handleTypes()
	names := make([]string, 0, len(types))
	for k := range types {
		names = append(names, k)
	}
	sort.Slice(names, func(i, j int) bool { return types[names[i]] > types[names[j]] || types[names[i]] == types[names[j]] && names[i] < names[j] })
	parts := make([]string, 0, len(names))
	for _, k := range names {
		parts = append(parts, fmt.Sprintf("%s=%d", k, types[k]))
	}
	return "handle types now: " + strings.Join(parts, " ")
}

// The helper itself: it sees a handle this test opens, by type, and the total is close to what the process reports.
func TestHandleTypesCountsAnOpenHandleByType(t *testing.T) {
	before := handleTypes()
	ev, err := windows.CreateEvent(nil, 0, 0, nil)
	assert.NoError(t, err)
	defer windows.CloseHandle(ev)
	after := handleTypes()
	assert.Equal(t, before["Event"]+1, after["Event"], "one more Event: %s", describeHandles())
	total := 0
	for _, n := range after {
		total += n
	}
	assert.InDelta(t, handleCount(t), total, float64(handleCount(t))/10+5, "the typed total is about the process's handle count")
	t.Log(describeHandles())
}
