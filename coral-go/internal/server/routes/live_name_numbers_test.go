package routes

import "testing"

func row(sid, typ, dir string, extra map[string]any) map[string]any {
	r := map[string]any{"session_id": sid, "agent_type": typ, "working_directory": dir}
	for k, v := range extra {
		r[k] = v
	}
	return r
}

func numbers(rows []map[string]any) []int {
	out := make([]int, len(rows))
	for i, r := range rows {
		out[i], _ = r["name_number"].(int)
	}
	return out
}

// Two agents nobody named, in the home folder, are "Claude" and "Claude 2"; named, archived and terminal rows are not counted; every row carries the field (#10249).
func TestUnnamedDuplicatesAreNumberedInListOrder(t *testing.T) {
	home := "/home/someone"
	named := "My Own Name"
	title := "Backend Dev"
	rows := []map[string]any{
		row("a", "claude", home, nil),                                       // 1: the first keeps the plain name
		row("b", "claude", home+"/", nil),                                   // 2: the same default (the home folder is no name), trailing slash
		row("c", "claude", home, map[string]any{"display_name": &named}),    // named: 1
		row("d", "claude", home, map[string]any{"board_job_title": title}),  // a job title: 1
		row("e", "codex", home, nil),                                        // a different CLI: 1
		row("f", "claude", home, nil),                                       // 3
		row("g", "terminal", home, nil),                                     // a terminal: 1
		row("h", "claude", home, map[string]any{"archived": true}),          // archived: 1
		row("i", "claude", "/work/app", nil),                                // the folder's name: 1
		row("j", "claude", "/other/App", nil),                               // the same folder name in another place, any case: 2
		row("k", "claude", "/work/app", map[string]any{"display_name": ""}), // an empty name is no name: 3
	}
	numberUnnamedDuplicates(rows, home)
	want := []int{1, 2, 1, 1, 1, 3, 1, 1, 1, 2, 3}
	got := numbers(rows)
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("row %s: name_number %d, want %d (all: %v)", rows[i]["session_id"], got[i], want[i], got)
		}
	}
}

func TestADriveRootAndTheRootAreNoFolderName(t *testing.T) {
	rows := []map[string]any{row("a", "claude", `C:\`, nil), row("b", "claude", "C:", nil), row("c", "claude", "~", nil)}
	numberUnnamedDuplicates(rows, `C:\Users\x`)
	if got := numbers(rows); got[0] != 1 || got[1] != 2 || got[2] != 3 {
		t.Fatalf("a drive, a drive and ~ all fall to the CLI name: %v", got)
	}
}
