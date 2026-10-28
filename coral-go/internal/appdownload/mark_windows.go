//go:build windows

package appdownload

import "os"

// markDownloaded writes the Zone.Identifier stream (the "Mark of the Web", zone 3: the Internet) a browser gives a download, so SmartScreen and Office's Protected View
// treat the file as downloaded (#9894, Security Reviewer). Best effort: a volume that is not NTFS has no streams and the file is left unmarked.
func markDownloaded(path string) {
	_ = os.WriteFile(path+":Zone.Identifier", []byte("[ZoneTransfer]\r\nZoneId=3\r\n"), 0o644)
}
