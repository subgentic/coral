//go:build !darwin && !windows

package appdownload

// markDownloaded: Linux has no download mark a desktop honours across file managers; the file is left as written.
func markDownloaded(path string) {}
