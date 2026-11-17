package sessionstate

import "testing"

// An agent compacting its conversation is working, and says so: Claude's PreCompact hook starts it, and the SessionStart that follows
// the compaction (source "compact") or the next prompt, tool or stop ends it (#19090).
func TestACompactingAgentIsWorkingUntilItsSessionStartsAgain(t *testing.T) {
	compact := Event{Type: "compact_start", Summary: "Compacting conversation"}
	st := Derive(Input{Events: []Event{stop, compact}, StalenessSeconds: 1})
	if !st.Compacting || !st.Working || !st.InTurn || st.AwaitingUser {
		t.Fatalf("compacting: %+v", st)
	}
	for name, end := range map[string]Event{"session start": {Type: "session_reset", Summary: "Session compacted"}, "stop": stop, "prompt": prompt, "tool": tool} {
		if st := Derive(Input{Events: []Event{stop, compact, end}, StalenessSeconds: 1}); st.Compacting {
			t.Errorf("%s did not end the compaction: %+v", name, st)
		}
	}
}

// #19151 (Security on #19090): a compaction that was aborted leaves only its PreCompact; the row stops saying Compacting past the longest a compaction takes, and does not before.
func TestACompactionWithNoEventAfterItStopsShowingCompactingAfterTenMinutes(t *testing.T) {
	compact := Event{Type: "compact_start", Summary: "Compacting conversation"}
	if st := Derive(Input{Events: []Event{stop, compact}, StalenessSeconds: CompactingMaxSeconds - 1}); !st.Compacting {
		t.Fatalf("a compaction under the bound still compacts: %+v", st)
	}
	st := Derive(Input{Events: []Event{stop, compact}, StalenessSeconds: CompactingMaxSeconds})
	if st.Compacting {
		t.Fatalf("an aborted compaction shows Compacting for ever: %+v", st)
	}
	if st.Working {
		t.Fatalf("and it is not Working with no news for ten minutes: %+v", st)
	}
}
