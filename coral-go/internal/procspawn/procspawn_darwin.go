//go:build darwin

package procspawn

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"unsafe"

	"github.com/ebitengine/purego"
)

const (
	posixSpawnSetsid = 0x0400 // POSIX_SPAWN_SETSID
)

var (
	loadOnce sync.Once
	loadErr  error

	attrInit, attrDestroy, faInit, faDestroy func(p unsafe.Pointer) int32
	attrSetFlags                             func(attr unsafe.Pointer, flags int16) int32
	setDisclaim                              func(attr unsafe.Pointer, disclaim int32) int32
	faAddDup2                                func(fa unsafe.Pointer, fd, newfd int32) int32
	faAddOpen                                func(fa unsafe.Pointer, fd int32, path string, oflag int32, mode uint16) int32
	posixSpawn                               func(pid unsafe.Pointer, path string, fa, attr, argv, envp unsafe.Pointer) int32
)

func load() error {
	loadOnce.Do(func() {
		defer func() {
			if r := recover(); r != nil {
				loadErr = fmt.Errorf("procspawn: %v", r)
			}
		}()
		lib, err := purego.Dlopen("/usr/lib/libSystem.B.dylib", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			loadErr = err
			return
		}
		for _, f := range []struct {
			fn   any
			name string
		}{
			{&attrInit, "posix_spawnattr_init"}, {&attrDestroy, "posix_spawnattr_destroy"},
			{&faInit, "posix_spawn_file_actions_init"}, {&faDestroy, "posix_spawn_file_actions_destroy"},
			{&attrSetFlags, "posix_spawnattr_setflags"}, {&setDisclaim, "responsibility_spawnattrs_setdisclaim"},
			{&faAddDup2, "posix_spawn_file_actions_adddup2"}, {&faAddOpen, "posix_spawn_file_actions_addopen"},
			{&posixSpawn, "posix_spawn"},
		} {
			purego.RegisterLibFunc(f.fn, lib, f.name) // panics when the symbol is missing: a macOS without it keeps the plain start
		}
	})
	return loadErr
}

// Supported reports whether this macOS can disclaim responsibility (the function is a private one of libSystem, present since macOS 10.14).
func Supported() bool { return load() == nil }

// Spawn starts path with argv (argv[0] included) as a process that is its own responsible process, and returns its pid; the caller waits for it (os.FindProcess, Wait).
func Spawn(path string, argv []string, o Options) (int, error) {
	if err := load(); err != nil {
		return 0, ErrUnsupported
	}
	// posix_spawn does not search PATH (exec.Command does): a bare name is resolved the same way first, so "tmux" starts as it always did.
	if !strings.Contains(path, "/") {
		resolved, err := exec.LookPath(path)
		if err != nil {
			return 0, &os.PathError{Op: "spawn", Path: path, Err: syscall.ENOENT}
		}
		path = resolved
	}
	cargv, pargv, err := cstrings(argv)
	if err != nil {
		return 0, err
	}
	cenv, penv, err := cstrings(o.Env)
	if err != nil {
		return 0, err
	}
	var attr, fa uintptr
	if r := attrInit(unsafe.Pointer(&attr)); r != 0 {
		return 0, syscall.Errno(r)
	}
	defer attrDestroy(unsafe.Pointer(&attr))
	if r := faInit(unsafe.Pointer(&fa)); r != 0 {
		return 0, syscall.Errno(r)
	}
	defer faDestroy(unsafe.Pointer(&fa))
	if r := setDisclaim(unsafe.Pointer(&attr), 1); r != 0 {
		return 0, fmt.Errorf("procspawn: disclaim: %w", syscall.Errno(r))
	}
	if o.Setsid {
		if r := attrSetFlags(unsafe.Pointer(&attr), posixSpawnSetsid); r != 0 {
			return 0, syscall.Errno(r)
		}
	}
	for fd, f := range []*os.File{o.Stdin, o.Stdout, o.Stderr} {
		var r int32
		if f == nil {
			flag := int32(syscall.O_RDWR)
			r = faAddOpen(unsafe.Pointer(&fa), int32(fd), os.DevNull, flag, 0)
		} else {
			r = faAddDup2(unsafe.Pointer(&fa), int32(f.Fd()), int32(fd))
		}
		if r != 0 {
			return 0, syscall.Errno(r)
		}
	}
	var pid int32
	r := posixSpawn(unsafe.Pointer(&pid), path, unsafe.Pointer(&fa), unsafe.Pointer(&attr), unsafe.Pointer(&pargv[0]), unsafe.Pointer(&penv[0]))
	runtime.KeepAlive(cargv)
	runtime.KeepAlive(cenv)
	runtime.KeepAlive(o)
	if r != 0 {
		return 0, &os.PathError{Op: "spawn", Path: path, Err: syscall.Errno(r)}
	}
	return int(pid), nil
}

// cstrings makes the NUL-terminated array posix_spawn takes (and the strings it points to, which the caller keeps alive).
func cstrings(s []string) ([]*byte, []*byte, error) {
	own := make([]*byte, 0, len(s))
	arr := make([]*byte, 0, len(s)+1)
	for _, v := range s {
		b, err := syscall.BytePtrFromString(v)
		if err != nil {
			return nil, nil, err
		}
		own = append(own, b)
		arr = append(arr, b)
	}
	arr = append(arr, nil)
	return own, arr, nil
}
