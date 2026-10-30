//go:build windows

// Package installrestart remembers, across an MSI install, that Coral was running when the installer closed it (#335), so the installer
// starts it again afterwards, and only then. It is one small file in this user's %LOCALAPPDATA%\Coral, written when Coral is closed for the
// install and taken (read and removed) after it; a mark older than MaxAge is for no install running now and starts nothing.
//
// The installer's helper may run ELEVATED while the folder belongs to the user, who can put a link where it expects a folder or a file. So
// nothing here walks a path twice: the folder is opened ONCE, as itself (never what a link in its place points at), refused if it is a link
// or is reached through one, and held open without delete sharing (so it cannot be renamed or replaced while it is in use); every read,
// remove and create then happens relative to that handle, and a link that has the mark's name is opened and removed as itself.
package installrestart

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/subgentic/coral/internal/logsafe"
)

// MaxAge is the longest an install may take between closing Coral and starting it again.
const MaxAge = 30 * time.Minute

const fileName = "restart-after-install"

// Win32 constants x/sys/windows does not name: FILE_ADD_FILE (a directory right), and the flags of GetFinalPathNameByHandle.
const (
	fileAddFile         = 0x2
	fileAddSubdirectory = 0x4
	fileNameNormalized  = 0x0
	volumeNameDOS       = 0x0
)

// ErrNotPlainFolder: the mark's folder is a link or a junction, or is reached through one, or is not a folder.
var ErrNotPlainFolder = errors.New("the mark's folder is not a plain folder (a link, a junction, or reached through one)")

// folder is this user's %LOCALAPPDATA%\<the product's folder name>: Windows' known folder for the user, not the LOCALAPPDATA variable (which an
// installer's process may not carry over); Windows may still expand %USERPROFILE% in it. The name follows the product the program belongs to
// (see productFolderName), so the tray and the installer's helper of one install agree on it, and another product's install (the rehearsal's
// "Coral Rehearsal") never reads or writes the live Coral's folder. A variable so a test can put it elsewhere.
var folder = func() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return folderFor(exe)
}

// folderFor is the mark's folder for a program at exe.
func folderFor(exe string) (string, error) {
	local, err := localAppData()
	if err != nil {
		return "", err
	}
	return folderUnder(local, exe), nil
}

// localAppData is the user's Local AppData folder (Windows' known folder, not the variable; Mark makes the mark's folder below it when missing). A
// variable so a test can put it elsewhere.
var localAppData = func() (string, error) {
	return windows.KnownFolderPath(windows.FOLDERID_LocalAppData, windows.KF_FLAG_DONT_VERIFY)
}

// ErrBadProduct: a product name that is not a Coral product's folder name.
var ErrBadProduct = errors.New("not a Coral product's folder name")

// ValidProduct says whether name is a Coral product's install-folder name: "Coral", or "Coral" and one more word ("Coral Rehearsal").
func ValidProduct(name string) bool { return productNameRe.MatchString(name) }

// productDir is the mark's folder for the named product: below the user's Local AppData folder, named by the product and by nothing else. The name is
// checked first, so no path is built from anything else (the installer's helper runs from a temporary copy, so it cannot tell its product from
// where it runs: it is told, by a constant in the package, never by a property a person can set).
func productDir(product string) (string, error) {
	if !ValidProduct(product) {
		return "", ErrBadProduct
	}
	local, err := localAppData()
	if err != nil {
		return "", err
	}
	return filepath.Join(local, product), nil
}

// folderUnder is the mark's folder below the user's Local AppData folder local, for a program at exe.
func folderUnder(local, exe string) string { return filepath.Join(local, productFolderName(exe)) }

// productNameRe is the folder name of a product's install: "Coral", or "Coral" and one more word ("Coral Rehearsal").
var productNameRe = regexp.MustCompile(`^Coral( [A-Za-z0-9]{1,24})?$`)

// productFolderName is the name of the folder the program at exe was installed in when that is a Coral product's ("Coral Rehearsal"), else "Coral": the
// live product, and a program run from anywhere else (a build, a portable copy). The installer's helper and the tray sit in the same install folder,
// so they get the same name.
func productFolderName(exe string) string {
	if name := filepath.Base(filepath.Dir(exe)); productNameRe.MatchString(name) {
		return name
	}
	return "Coral"
}

// afterFolderOpen runs once the folder is open and checked, before anything is done in it (a hook for a test, which tries to swap the folder
// then).
var afterFolderOpen = func() {}

// plainFolder is the opened folder: a handle to the directory itself.
type plainFolder struct{ h windows.Handle }

func (d *plainFolder) Close() { _ = windows.CloseHandle(d.h) }

// openPlainFolder opens dir as itself and returns it only if it is a plain directory reached by no link. FILE_FLAG_OPEN_REPARSE_POINT opens a
// junction or symlink in dir's place as the link, not its target; the handle's own attributes then say whether it is one; its final path says
// whether an ancestor is one. Sharing excludes delete and rename, so the folder cannot be swapped while the handle is held.
func openPlainFolder(dir string) (*plainFolder, error) {
	dir = filepath.Clean(dir)
	p, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(p, windows.FILE_LIST_DIRECTORY|fileAddFile|fileAddSubdirectory|windows.FILE_TRAVERSE|windows.FILE_READ_ATTRIBUTES|windows.SYNCHRONIZE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, err
	}
	d := &plainFolder{h: h}
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &info); err != nil {
		d.Close()
		return nil, err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 || info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
		d.Close()
		log.Printf("installrestart: the folder %s is a link or not a folder: refused, so Coral will not be started again by the installer", logsafe.Path(dir))
		return nil, ErrNotPlainFolder
	}
	// An ancestor that is a link: the handle's final path is where the folder really is, which then is not where it was asked for.
	final, err := finalPathOf(h)
	if err != nil || !sameFolder(final, longPath(dir)) {
		d.Close()
		// One line that explains "Coral did not restart after the install": the folder is reached through a link (a redirected profile, OneDrive, a network folder).
		log.Printf("installrestart: the folder %s is really %s (a redirected profile, OneDrive, a network folder or a link above it): refused, so Coral will not be started again by the installer", logsafe.Path(dir), logsafe.Path(final))
		return nil, ErrNotPlainFolder
	}
	return d, nil
}

// makeFolder makes dir when it is missing, through the same handle code as everything else: each missing level is created relative to its parent, and the parent is
// opened as a plain folder first (a link or a path through one is refused), so an elevated helper cannot create an empty folder behind a link. An existing plain folder is
// left as it is; anything that exists and is not a plain folder is refused, never "made".
func makeFolder(dir string) error {
	dir = filepath.Clean(dir)
	d, err := openPlainFolder(dir)
	if err == nil {
		d.Close()
		return nil
	}
	if !notFound(err) {
		return err
	}
	parent := filepath.Dir(dir)
	if parent == dir {
		return err
	}
	if err := makeFolder(parent); err != nil {
		return err
	}
	p, err := openPlainFolder(parent)
	if err != nil {
		return err
	}
	defer p.Close()
	h, err := p.openChild(filepath.Base(dir), windows.FILE_LIST_DIRECTORY|windows.FILE_READ_ATTRIBUTES, windows.FILE_OPEN_IF, windows.FILE_DIRECTORY_FILE)
	if err != nil {
		return err
	}
	return windows.CloseHandle(h)
}

// sameFolder: the handle's final path (\\?\ form) is the path the folder was asked for, case aside. A different one means an ancestor is a link.
func sameFolder(final, asked string) bool {
	return strings.EqualFold(strings.TrimPrefix(final, `\\?\`), strings.TrimPrefix(asked, `\\?\`))
}

// finalPathOf is finalPath (a test seam: a build that refuses to walk a junction ancestor cannot show the check being used).
var finalPathOf = finalPath

func finalPath(h windows.Handle) (string, error) {
	buf := make([]uint16, 1024)
	n, err := windows.GetFinalPathNameByHandle(h, &buf[0], uint32(len(buf)), fileNameNormalized|volumeNameDOS)
	if err != nil {
		return "", err
	}
	if int(n) > len(buf) {
		return "", errors.New("the folder's final path is too long")
	}
	return windows.UTF16ToString(buf[:n]), nil
}

// longPath is dir with 8.3 short names expanded (the known folder is normally long already); dir itself when it cannot be.
func longPath(dir string) string {
	in, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return dir
	}
	buf := make([]uint16, 1024)
	n, err := windows.GetLongPathName(in, &buf[0], uint32(len(buf)))
	if err != nil || n == 0 || int(n) > len(buf) {
		return dir
	}
	return windows.UTF16ToString(buf[:n])
}

// openChild opens the name below the folder, relative to its handle. A link with that name is opened as itself (FILE_OPEN_REPARSE_POINT), never
// followed. name is a plain file name.
func (d *plainFolder) openChild(name string, access, disposition, options uint32) (windows.Handle, error) {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, `\/:`) {
		return 0, errors.New("not a plain file name")
	}
	us, err := windows.NewNTUnicodeString(name)
	if err != nil {
		return 0, err
	}
	oa := windows.OBJECT_ATTRIBUTES{RootDirectory: d.h, ObjectName: us, Attributes: windows.OBJ_CASE_INSENSITIVE}
	oa.Length = uint32(unsafe.Sizeof(oa))
	var h windows.Handle
	var iosb windows.IO_STATUS_BLOCK
	if err := windows.NtCreateFile(&h, access|windows.SYNCHRONIZE, &oa, &iosb, nil, windows.FILE_ATTRIBUTE_NORMAL,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, disposition,
		options|windows.FILE_OPEN_REPARSE_POINT|windows.FILE_SYNCHRONOUS_IO_NONALERT, 0, 0); err != nil {
		return 0, err
	}
	return h, nil
}

// notFound: the name (or its folder) is not there.
func notFound(err error) bool {
	switch err {
	case windows.STATUS_OBJECT_NAME_NOT_FOUND, windows.STATUS_OBJECT_PATH_NOT_FOUND, windows.STATUS_NO_SUCH_FILE:
		return true
	}
	return errors.Is(err, os.ErrNotExist) || errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND)
}

// deleteHandle marks the open file (or the link itself) for deletion.
func deleteHandle(h windows.Handle) error {
	disp := struct{ DeleteFile byte }{1}
	return windows.SetFileInformationByHandle(h, windows.FileDispositionInfo, (*byte)(unsafe.Pointer(&disp)), uint32(unsafe.Sizeof(disp)))
}

// remove deletes what has the mark's name in the folder, as itself (a link is removed, never its target). Nothing there is no error.
func (d *plainFolder) remove(name string) error {
	h, err := d.openChild(name, windows.DELETE|windows.FILE_READ_ATTRIBUTES, windows.FILE_OPEN, 0)
	if err != nil {
		if notFound(err) {
			return nil
		}
		return err
	}
	defer windows.CloseHandle(h)
	return deleteHandle(h)
}

// Mark records that Coral was closed for an install, now. The folder is opened once as a plain folder (ErrNotPlainFolder otherwise); the
// file with the mark's name, if any, is removed as itself, and the mark is created new in that folder, so if something takes the name again
// in between the create fails rather than write through it (Security on #335).
func Mark(now time.Time) error {
	return markFile(fileName, now)
}

// markFile writes now into the file name in the mark's folder, with Mark's rules: the folder opened once as a plain folder, the file created new relative to it,
// no link followed.
func markFile(name string, now time.Time) error {
	dir, err := folder()
	if err != nil {
		return err
	}
	return markIn(dir, name, now)
}

// MarkFor is Mark in the named product's folder (see productDir).
func MarkFor(product string, now time.Time) error { return markFileFor(product, fileName, now) }

func markFileFor(product, name string, now time.Time) error {
	dir, err := productDir(product)
	if err != nil {
		return err
	}
	return markIn(dir, name, now)
}

func markIn(dir, name string, now time.Time) error {
	if err := makeFolder(dir); err != nil {
		return err
	}
	d, err := openPlainFolder(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	afterFolderOpen()
	if err := d.remove(name); err != nil {
		return err
	}
	h, err := d.openChild(name, windows.FILE_WRITE_DATA|windows.FILE_READ_ATTRIBUTES, windows.FILE_CREATE, windows.FILE_NON_DIRECTORY_FILE)
	if err != nil {
		return err
	}
	f := os.NewFile(uintptr(h), name)
	_, err = f.WriteString(now.UTC().Format(time.RFC3339) + "\n")
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

// Discard removes the mark, if there is one, without reading it: Coral is being uninstalled, so there is nothing to start again (#345: Restart
// Manager closing the tray for an uninstall made it mark). A link that has the mark's name is removed as itself. A folder that is not a plain
// folder is left alone (ErrNotPlainFolder).
func Discard() error {
	dir, err := folder()
	if err != nil {
		return err
	}
	return discardIn(dir)
}

// DiscardFor is Discard in the named product's folder.
func DiscardFor(product string) error {
	dir, err := productDir(product)
	if err != nil {
		return err
	}
	return discardIn(dir)
}

func discardIn(dir string) error {
	d, err := openPlainFolder(dir)
	if err != nil {
		if notFound(err) {
			return nil
		}
		return err
	}
	defer d.Close()
	return d.remove(fileName)
}

// CreateLog creates a new log file named <prefix>-<random>.log in the mark's folder and returns it, for an ELEVATED program that must not log into the user's
// TEMP (a folder the user controls, where it would be made to write through a link): the folder is opened once as a plain folder and the file is created
// new relative to it, exclusively, so nothing is followed and nothing existing is opened. A folder that is not a plain folder is ErrNotPlainFolder.
func CreateLog(prefix string) (*os.File, error) {
	dir, err := folder()
	if err != nil {
		return nil, err
	}
	return CreateLogIn(dir, prefix)
}

// CreateLogFor is CreateLog in the named product's folder.
func CreateLogFor(product, prefix string) (*os.File, error) {
	dir, err := productDir(product)
	if err != nil {
		return nil, err
	}
	return CreateLogIn(dir, prefix)
}

// CreateLogIn is CreateLog for the folder dir (the same checks and the same way of creating the file): it lets a program's tests point the log at a test folder
// without any way to change where the package puts its mark.
func CreateLogIn(dir, prefix string) (*os.File, error) {
	if err := makeFolder(dir); err != nil {
		return nil, err
	}
	d, err := openPlainFolder(dir)
	if err != nil {
		return nil, err
	}
	defer d.Close()
	var rnd [8]byte
	if _, err := rand.Read(rnd[:]); err != nil {
		return nil, err
	}
	name := prefix + "-" + hex.EncodeToString(rnd[:]) + ".log"
	h, err := d.openChild(name, windows.FILE_WRITE_DATA|windows.FILE_APPEND_DATA|windows.FILE_READ_ATTRIBUTES, windows.FILE_CREATE, windows.FILE_NON_DIRECTORY_FILE)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(h), name), nil
}

// maxMarkBytes bounds what Take reads: a mark is one RFC 3339 line.
const maxMarkBytes = 256

// Take removes the mark and reports whether it was there and recent (written within MaxAge before now, never after it). A missing,
// unreadable or stale mark is false; the file goes in every case, so it starts Coral once at most. A folder that is not a plain folder is not
// touched, and starts nothing; a link with the mark's name is removed as itself and starts nothing.
func Take(now time.Time) bool {
	return takeFile(fileName, now, MaxAge)
}

// takeFile is Take for the file name and the age maxAge.
func takeFile(name string, now time.Time, maxAge time.Duration) bool {
	dir, err := folder()
	if err != nil {
		return false
	}
	return takeIn(dir, name, now, maxAge)
}

// TakeFor is Take in the named product's folder.
func TakeFor(product string, now time.Time) bool {
	dir, err := productDir(product)
	if err != nil {
		return false
	}
	return takeIn(dir, fileName, now, MaxAge)
}

func takeIn(dir, name string, now time.Time, maxAge time.Duration) bool {
	d, err := openPlainFolder(dir)
	if err != nil {
		return false
	}
	defer d.Close()
	h, err := d.openChild(name, windows.FILE_READ_DATA|windows.DELETE|windows.FILE_READ_ATTRIBUTES, windows.FILE_OPEN, windows.FILE_NON_DIRECTORY_FILE)
	if err != nil {
		if !notFound(err) {
			_ = d.remove(name) // a directory or a link with the name: gone as itself, and nothing starts
		}
		return false
	}
	var info windows.ByHandleFileInformation
	isLink := windows.GetFileInformationByHandle(h, &info) != nil || info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0
	var b []byte
	var rerr error
	f := os.NewFile(uintptr(h), name)
	if !isLink {
		b, rerr = io.ReadAll(io.LimitReader(f, maxMarkBytes))
	}
	_ = deleteHandle(h)
	_ = f.Close()
	if isLink || rerr != nil {
		return false
	}
	at, err := time.Parse(time.RFC3339, strings.TrimSpace(string(b)))
	if err != nil {
		return false
	}
	age := now.Sub(at)
	return age >= -time.Minute && age <= maxAge
}

// LaunchPendingMaxAge is the longest between the installer's Finish button starting Coral through Explorer and Coral's start (task #380).
const LaunchPendingMaxAge = 2 * time.Minute

const launchPendingName = "launch-pending"

// MarkLaunchPending records that the installer's Finish button, in an ELEVATED installer, is starting Coral through Explorer now, so that
// Coral starts unelevated (task #380). A coral-tray that finds a fresh mark and is itself elevated was not started the way the installer
// meant (Explorer's unelevated start did not happen), and starts nothing. The same rules as Mark: the folder opened once as a plain folder, no link followed.
func MarkLaunchPending(now time.Time) error {
	return markFile(launchPendingName, now)
}

// MarkLaunchPendingFor is MarkLaunchPending in the named product's folder (the installer's helper, which is told its product).
func MarkLaunchPendingFor(product string, now time.Time) error {
	return markFileFor(product, launchPendingName, now)
}

// TakeLaunchPending removes the launch-pending mark and reports whether it was there and fresh (written within LaunchPendingMaxAge before
// now). Every start of Coral takes it, so a mark is used once at most and never outlives the start it was for.
func TakeLaunchPending(now time.Time) bool {
	return takeFile(launchPendingName, now, LaunchPendingMaxAge)
}
