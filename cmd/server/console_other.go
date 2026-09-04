//go:build !windows

package main

// attachParentConsole is a no-op off Windows: the process already streams to
// its controlling terminal.
func attachParentConsole() {}
