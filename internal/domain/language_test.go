package domain

import "testing"

func TestNormalizeLanguageReturnsCanonicalISO6391(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{input: "", want: ""},
		{input: "  ", want: ""},
		{input: "ro", want: "ro"},
		{input: "EN", want: "en"},
		{input: " ja ", want: "ja"},
		{input: "ron", want: "ro"},
		{input: "rum", want: "ro"},
		{input: "eng", want: "en"},
		{input: "jpn", want: "ja"},
		{input: "fre", want: "fr"},
		{input: "fra", want: "fr"},
		{input: "ger", want: "de"},
		{input: "deu", want: "de"},
		{input: "zho", want: "zh"},
		{input: "chi", want: "zh"},
		{input: "srp", want: "sr"},
		{input: "nno", want: "nn"},
		{input: "mri", want: "mi"},
		{input: "mao", want: "mi"},
		{input: "hrv", want: "hr"},
		{input: "scr", want: "hr"},
		{input: "ron-RO", want: "ro"},
		{input: "en_US", want: "en"},
		{input: "es", want: "es"},
		{input: "dan", want: "da"},
		{input: "nob", want: "nb"},
		{input: "nno", want: "nn"},
		{input: "nor", want: "no"},
		{input: "kat", want: "ka"},
		{input: "geo", want: "ka"},
		{input: "bod", want: "bo"},
		{input: "tib", want: "bo"},
		{input: "ell", want: "el"},
		{input: "gre", want: "el"},
		{input: "fas", want: "fa"},
		{input: "per", want: "fa"},
		{input: "hye", want: "hy"},
		{input: "arm", want: "hy"},
		{input: "slk", want: "sk"},
		{input: "slo", want: "sk"},
		{input: "mkd", want: "mk"},
		{input: "mac", want: "mk"},
		{input: "msa", want: "ms"},
		{input: "may", want: "ms"},
		{input: "mya", want: "my"},
		{input: "bur", want: "my"},
		{input: "ces", want: "cs"},
		{input: "cze", want: "cs"},
		{input: "nld", want: "nl"},
		{input: "dut", want: "nl"},
		{input: "cym", want: "cy"},
		{input: "wel", want: "cy"},
		{input: "eus", want: "eu"},
		{input: "baq", want: "eu"},
		{input: "isl", want: "is"},
		{input: "ice", want: "is"},
		{input: "sqi", want: "sq"},
		{input: "alb", want: "sq"},
		{input: "und", want: ""},
		{input: "xx", want: ""},
		{input: "jp", want: ""},
		{input: "english", want: ""},
		{input: "1080p", want: ""},
	}
	for _, test := range tests {
		if got := NormalizeLanguage(test.input); got != test.want {
			t.Errorf("NormalizeLanguage(%q) = %q, want %q", test.input, got, test.want)
		}
	}
}

func TestLanguageTablesAreCompleteAndConsistent(t *testing.T) {
	if len(iso6391) != 183 {
		t.Fatalf("iso6391 holds %d codes, want the 183 current ISO 639-1 codes", len(iso6391))
	}
	if len(iso6392) != 205 {
		t.Fatalf("iso6392 holds %d synonyms, want 183 terminology codes plus 22 bibliographic codes", len(iso6392))
	}
	for synonym, canonical := range iso6392 {
		if _, ok := iso6391[canonical]; !ok {
			t.Fatalf("synonym %q maps to %q, which is not an ISO 639-1 code", synonym, canonical)
		}
	}
}
