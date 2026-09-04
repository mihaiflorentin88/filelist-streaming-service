// Package listenaddr renders a server listen address as one a browser can
// open. Settings accept wildcard binds (":8097"), whose raw form is not a
// resolvable URL host — displayed verbatim it produced links like
// "http://:8097". The derivation mirrors what a real bind produces: a
// wildcard listen actually binds 0.0.0.0/[::], a loopback listen binds the
// loopback stack, and anything else is taken at its word.
package listenaddr

import "net"

// primaryLookup stands in for the interface scan in tests.
var primaryLookup = primaryIPv4

// DisplayAddress returns listenAddr with a resolvable host: loopback binds
// (localhost, 127.x, ::1) display as 127.0.0.1; wildcard binds (empty
// host, 0.0.0.0, ::) as the primary non-loopback IPv4, falling back to
// "localhost" on loopback-only machines; a configured hostname or specific
// IP passes through. Addresses without a usable host:port split return
// unchanged.
func DisplayAddress(listenAddr string) string {
	host, port, err := net.SplitHostPort(listenAddr)
	if err != nil || port == "" {
		return listenAddr
	}
	return net.JoinHostPort(displayHost(host), port)
}

func displayHost(host string) string {
	switch host {
	case "localhost":
		return "127.0.0.1"
	case "", "0.0.0.0", "::":
		if primary := primaryLookup(); primary != "" {
			return primary
		}
		return "localhost"
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		return "127.0.0.1"
	}
	return host
}

// primaryIPv4 returns the first IPv4 address of an up, non-loopback
// interface (skipping link-local autoconfiguration addresses), in
// interface order — the address a wildcard bind is reachable at from the
// network. Empty when the machine has no such interface.
func primaryIPv4() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ipNet, ok := addr.(*net.IPNet)
			if !ok {
				continue
			}
			ip4 := ipNet.IP.To4()
			if ip4 == nil || ip4.IsLoopback() || ip4.IsLinkLocalUnicast() {
				continue
			}
			return ip4.String()
		}
	}
	return ""
}
