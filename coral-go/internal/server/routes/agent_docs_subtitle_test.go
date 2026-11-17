package routes

import (
	"testing"
	"testing/fstest"
)

// #19412: two topics titled "Chief" are told apart by the words after the heading's colon, not by the file name.
func TestDocSubtitleIsTheHeadingAfterItsColon(t *testing.T) {
	fs := fstest.MapFS{
		"chief.md":       {Data: []byte("# Chief: the Operator's front agent\n\nbody\n")},
		"chief-guide.md": {Data: []byte("# Chief: a user guide\n\nbody\n")},
		"plain.md":       {Data: []byte("# Plain topic\n\nbody\n")},
	}
	for file, want := range map[string]string{"chief.md": "the Operator's front agent", "chief-guide.md": "a user guide", "plain.md": ""} {
		if got := docSubtitle(fs, file); got != want {
			t.Errorf("docSubtitle(%s) = %q, want %q", file, got, want)
		}
	}
}
