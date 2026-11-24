package reviewsize

import (
	"reflect"
	"testing"
)

const sampleDiff = `diff --git a/a.go b/a.go
index 111..222 100644
--- a/a.go
+++ b/a.go
@@ -1,3 +1,4 @@
 keep
-old
+new
+more
+++ not a header, an added line that starts with ++
 tail
diff --git a/dir/new file.txt b/dir/new file.txt
new file mode 100644
--- /dev/null
+++ b/dir/new file.txt
@@ -0,0 +1,2 @@
+x
+y
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-p
---q
diff --git a/img.png b/img.png
index 1..2 100644
Binary files a/img.png and b/img.png differ
diff --git a/old.go b/renamed.go
similarity index 90%
rename from old.go
rename to renamed.go
--- a/old.go
+++ b/renamed.go
@@ -1 +1 @@
-a
+b
`

func TestParseDiffCountsPerFile(t *testing.T) {
	got := ParseDiff([]byte(sampleDiff))
	want := []File{
		{Path: "a.go", Added: 3, Deleted: 1},
		{Path: "dir/new file.txt", Added: 2},
		{Path: "gone.txt", Deleted: 2},
		{Path: "img.png", Binary: true},
		{Path: "renamed.go", Added: 1, Deleted: 1},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

func TestParseDiffEmptyAndGarbage(t *testing.T) {
	for _, in := range []string{"", "hello\nworld\n", "+ only a plus line\n"} {
		if got := ParseDiff([]byte(in)); len(got) != 0 {
			t.Fatalf("%q: got %+v, want none", in, got)
		}
	}
}

func TestParseDiffQuotedPath(t *testing.T) {
	d := "diff --git \"a/caf\\303\\251.txt\" \"b/caf\\303\\251.txt\"\n--- \"a/caf\\303\\251.txt\"\n+++ \"b/caf\\303\\251.txt\"\n@@ -1 +1 @@\n-a\n+b\n"
	got := ParseDiff([]byte(d))
	if len(got) != 1 || got[0].Path != "café.txt" || got[0].Added != 1 || got[0].Deleted != 1 {
		t.Fatalf("got %+v", got)
	}
}
