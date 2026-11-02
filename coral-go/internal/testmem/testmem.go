// Package testmem is a memory guard for a package's test run (#12062): a test binary that holds more than a set amount of memory is stopped with a message, instead of pushing the machine out of
// memory. It exists because ./internal/server grew past 3 GB (each of its tests built the whole dashboard bundle, about 12 MB of it kept for the rest of the run) and an operator's Mac ran out.
package testmem

import (
	"fmt"
	"os"
	"runtime/metrics"
	"strconv"
	"sync"
	"time"
)

// DefaultLimitMB is the most a package's test binary may hold, in MiB. CORAL_TEST_MAX_MB changes it for one run (0 turns the guard off).
const DefaultLimitMB = 2048

var names = []string{"/memory/classes/total:bytes", "/memory/classes/heap/released:bytes"}

// Held is what the Go runtime holds from the OS now, in bytes: all its memory minus what it has given back.
func Held() uint64 {
	s := []metrics.Sample{{Name: names[0]}, {Name: names[1]}}
	metrics.Read(s)
	total, released := s[0].Value, s[1].Value
	if total.Kind() != metrics.KindUint64 || released.Kind() != metrics.KindUint64 || released.Uint64() > total.Uint64() {
		return 0
	}
	return total.Uint64() - released.Uint64()
}

// LimitMB reads CORAL_TEST_MAX_MB, else def.
func LimitMB(def int) int {
	if v := os.Getenv("CORAL_TEST_MAX_MB"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			return n
		}
	}
	return def
}

// Start watches the process every 250 ms and, the moment it holds more than limitMB, says so on stderr and ends the process with code 3 (what a test binary does when it is out of
// its budget, not a test failure to look for). The returned function stops the watch and gives the peak seen, in MiB. A limit of 0 watches nothing.
func Start(pkg string, limitMB int) (stop func() (peakMB int)) {
	if limitMB <= 0 {
		return func() int { return 0 }
	}
	var mu sync.Mutex
	peak := uint64(0)
	done, finished := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(finished)
		t := time.NewTicker(250 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				h := Held()
				mu.Lock()
				if h > peak {
					peak = h
				}
				mu.Unlock()
				if h > uint64(limitMB)<<20 {
					fmt.Fprintf(os.Stderr, "\n%s: the test binary holds %d MiB, over its %d MiB limit (CORAL_TEST_MAX_MB changes it, 0 turns it off): stopped so that it does not push the machine out of memory (#12062). Run with -test.v and -test.run on halves to find the tests that hold it.\n", pkg, h>>20, limitMB)
					os.Exit(3)
				}
			}
		}
	}()
	return func() int {
		close(done)
		<-finished
		mu.Lock()
		defer mu.Unlock()
		if h := Held(); h > peak {
			peak = h
		}
		return int(peak >> 20)
	}
}
