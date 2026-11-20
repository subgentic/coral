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

// unicodeString is the native UNICODE_STRING; Go lays it out with the pointer at its own alignment (offset 8 on 64-bit, 4 on 32-bit), as the system does.
type unicodeString struct {
	Length, MaximumLength uint16
	Buffer                uintptr
}

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
		// the answer starts with a UNICODE_STRING (Length, MaximumLength, Buffer): its characters must lie inside buf, or the entry is skipped; they are read as bytes of buf, never through the pointer
		us := (*unicodeString)(unsafe.Pointer(&buf[0]))
		start := uintptr(unsafe.Pointer(&buf[0]))
		if us.Length == 0 || us.Length%2 != 0 || us.Buffer < start+unsafe.Sizeof(*us) || us.Buffer-start > uintptr(len(buf)) || uintptr(us.Length) > uintptr(len(buf))-(us.Buffer-start) {
			continue
		}
		off, chars := int(us.Buffer-start), make([]uint16, us.Length/2)
		for i := range chars {
			chars[i] = uint16(buf[off+2*i]) | uint16(buf[off+2*i+1])<<8
		}
		out[windows.UTF16ToString(chars)]++
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
	sort.Slice(names, func(i, j int) bool {
		return types[names[i]] > types[names[j]] || types[names[i]] == types[names[j]] && names[i] < names[j]
	})
	parts := make([]string, 0, len(names))
	for _, k := range names {
		parts = append(parts, fmt.Sprintf("%s=%d", k, types[k]))
	}
	return "handle types now: " + strings.Join(parts, " ")
}

// The helper itself: it sees a handle this test opens, by type (the Go runtime opens and closes its own Events and Threads meanwhile, so the check is "at least one more"), and the total is close to what the process reports.
func TestHandleTypesCountsAnOpenHandleByType(t *testing.T) {
	before := handleTypes()
	ev, err := windows.CreateEvent(nil, 0, 0, nil)
	assert.NoError(t, err)
	defer windows.CloseHandle(ev)
	after := handleTypes()
	if after["Event"] < before["Event"]+1 { // the message scans the handles again, so it is built only on a failure
		assert.Fail(t, "at least one more Event (the runtime may open its own too)", describeHandles())
	}
	total := 0
	for _, n := range after {
		total += n
	}
	assert.InDelta(t, handleCount(t), total, float64(handleCount(t))/10+5, "the typed total is about the process's handle count")
	t.Log(describeHandles())
}
