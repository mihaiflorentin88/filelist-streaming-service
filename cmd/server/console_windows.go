//go:build windows

package main

import (
	"os"

	"golang.org/x/sys/windows"
)

const attachParentProcess = ^uintptr(0) // ATTACH_PARENT_PROCESS

var procAttachConsole = windows.NewLazySystemDLL("kernel32.dll").NewProc("AttachConsole")

// attachParentConsole re-attaches stdout/stderr when a windowsgui-subsystem
// binary is started from an existing terminal, so `serve` streams logs.
func attachParentConsole() {
	if err := procAttachConsole.Find(); err != nil {
		return
	}
	r1, _, _ := procAttachConsole.Call(attachParentProcess)
	if r1 == 0 {
		return
	}
	if h, err := windows.GetStdHandle(windows.STD_OUTPUT_HANDLE); err == nil {
		os.Stdout = os.NewFile(uintptr(h), "stdout")
	}
	if h, err := windows.GetStdHandle(windows.STD_ERROR_HANDLE); err == nil {
		os.Stderr = os.NewFile(uintptr(h), "stderr")
	}
	if h, err := windows.GetStdHandle(windows.STD_INPUT_HANDLE); err == nil {
		os.Stdin = os.NewFile(uintptr(h), "stdin")
	}
}
