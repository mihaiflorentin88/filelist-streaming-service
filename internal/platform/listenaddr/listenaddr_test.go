package listenaddr

import "testing"

func withPrimary(t *testing.T, primary string) {
	t.Helper()
	orig := primaryLookup
	primaryLookup = func() string { return primary }
	t.Cleanup(func() { primaryLookup = orig })
}

func TestDisplayAddress(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		primary string
		want    string
	}{
		{"loopback stays", "127.0.0.1:8097", "10.0.0.2", "127.0.0.1:8097"},
		{"localhost becomes addressable", "localhost:8097", "10.0.0.2", "127.0.0.1:8097"},
		{"ipv6 loopback becomes addressable", "[::1]:8097", "10.0.0.2", "127.0.0.1:8097"},
		{"configured ipv4 stays", "192.168.1.5:9000", "10.0.0.2", "192.168.1.5:9000"},
		{"configured hostname stays", "server.lan:8097", "10.0.0.2", "server.lan:8097"},
		{"bare port takes primary ipv4", ":8097", "10.0.0.2", "10.0.0.2:8097"},
		{"wildcard ipv4 takes primary", "0.0.0.0:8097", "10.0.0.2", "10.0.0.2:8097"},
		{"wildcard ipv6 takes primary", "[::]:8097", "10.0.0.2", "10.0.0.2:8097"},
		{"bare port falls back to localhost", ":8097", "", "localhost:8097"},
		{"wildcard ipv4 falls back to localhost", "0.0.0.0:80", "", "localhost:80"},
		{"empty stays empty", "", "10.0.0.2", ""},
		{"portless value stays", "127.0.0.1", "10.0.0.2", "127.0.0.1"},
		{"colonless host stays", "8097", "10.0.0.2", "8097"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			withPrimary(t, tc.primary)
			if got := DisplayAddress(tc.in); got != tc.want {
				t.Fatalf("DisplayAddress(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}
