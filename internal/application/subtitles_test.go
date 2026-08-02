package application

import (
	"strings"
	"testing"
)

func TestUnpackSubtitleAcceptsPlainTextMislabeledAsZip(t *testing.T) {
	data := []byte("1\n00:00:01,000 --> 00:00:02,000\nHello\n")
	got, format, err := unpackSubtitle(data, ".zip", "provider.zip", "Movie.mkv")
	if err != nil {
		t.Fatal(err)
	}
	if format != ".srt" || !strings.Contains(string(got), "Hello") {
		t.Fatalf("format=%q data=%q", format, got)
	}
}

func TestParseSubtitleSearchScope(t *testing.T) {
	tests := []struct {
		input string
		want  SubtitleSearchScope
		err   bool
	}{
		{input: "", want: SubtitleScopeAll},
		{input: " LOCAL ", want: SubtitleScopeLocal},
		{input: "remote", want: SubtitleScopeRemote},
		{input: "all", want: SubtitleScopeAll},
		{input: "provider", err: true},
	}
	for _, test := range tests {
		got, err := ParseSubtitleSearchScope(test.input)
		if (err != nil) != test.err {
			t.Fatalf("ParseSubtitleSearchScope(%q) error = %v", test.input, err)
		}
		if got != test.want {
			t.Fatalf("ParseSubtitleSearchScope(%q) = %q, want %q", test.input, got, test.want)
		}
	}
}
