package testtemp

import "golang.org/x/sys/windows"

// hold opens each folder without delete sharing and returns the func that closes them. While they are open, nothing can delete or rename the private world's folders
// (RemoveAll, a sweep, another package's cleanup): the one that tries fails with a sharing violation in its own log, and the folder survives with its files. What it holds are the
// folders themselves; files made in them can still be made and removed. A folder that can't be opened is left unheld.
func hold(dirs ...string) (release func()) {
	var handles []windows.Handle
	for _, d := range dirs {
		p, err := windows.UTF16PtrFromString(d)
		if err != nil {
			continue
		}
		h, err := windows.CreateFile(p, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
		if err == nil {
			handles = append(handles, h)
		}
	}
	return func() {
		for _, h := range handles {
			windows.CloseHandle(h)
		}
	}
}
