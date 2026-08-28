package subtitles

import "testing"

func TestDetectSubtitlePayloadWithoutTrustingExtension(t *testing.T) {
	if zipSignature([]byte("not a zip")) {
		t.Fatal("plain text must not be treated as a zip archive")
	}
	if got := detectSubtitleFormat([]byte("1\r\n00:00:01,000 --> 00:00:02,000\r\nHello\r\n")); got != ".srt" {
		t.Fatalf("detected %q, want .srt", got)
	}
	if got := detectSubtitleFormat([]byte("WEBVTT\n\n00:00.000 --> 00:01.000\nHello")); got != ".vtt" {
		t.Fatalf("detected %q, want .vtt", got)
	}
	if !rarSignature([]byte{'R', 'a', 'r', '!', 0x1a, 0x07, 0x01, 0x00}) {
		t.Fatal("RAR5 archive signature must be rejected")
	}
}

func TestUnpackedFileURLDropsCredentialQueryAndExtractsIDs(t *testing.T) {
	path, parent, fileID, ok := unpackFileIdentity("/subtitle/WIfqGGz6sa/iooM1nS2CO?api_key=must-not-leak")
	if !ok || path != "/subtitle/WIfqGGz6sa/iooM1nS2CO" || parent != "WIfqGGz6sa" || fileID != "iooM1nS2CO" {
		t.Fatalf("unexpected unpack identity: %q %q %q %v", path, parent, fileID, ok)
	}
	if _, _, _, ok = unpackFileIdentity("https://evil.example/subtitle/WIfqGGz6sa/iooM1nS2CO?api_key=secret"); ok {
		t.Fatal("foreign download host must be rejected")
	}
	if _, _, _, ok = unpackFileIdentity("/subtitle/../passwd?api_key=secret"); ok {
		t.Fatal("unsafe download path must be rejected")
	}
}

func TestSubDLLanguagesCombinesPreferredAndFallbackOnce(t *testing.T) {
	if got := subDLLanguages("ron", "eng"); got != "ro,en" {
		t.Fatalf("languages=%q, want ro,en", got)
	}
	if got := subDLLanguages("en", "eng"); got != "en" {
		t.Fatalf("duplicate languages=%q, want en", got)
	}
}

func TestSubDLLanguagesUsesCanonicalISOCodes(t *testing.T) {
	if got := subDLLanguages("jpn", "fre"); got != "ja,fr" {
		t.Fatalf("subDLLanguages(jpn, fre) = %q, want ja,fr", got)
	}
	if got := subDLLanguages("jp", "xx"); got != "" {
		t.Fatalf("subDLLanguages(jp, xx) = %q, want empty for unknown codes", got)
	}
	if got := subDLLanguages("deu", ""); got != "de" {
		t.Fatalf("subDLLanguages(deu, empty) = %q, want de", got)
	}
}

func TestCandidateIDCarriesLanguageAndKeepsOldIDsDecodable(t *testing.T) {
	id := encodeCandidate(candidateID{NID: "WIfqGGz6sa", FileID: "iooM1nS2CO", Name: "Movie.srt", Format: "srt", Language: "ja"})
	candidate, err := decodeCandidate(id)
	if err != nil || candidate.Language != "ja" {
		t.Fatalf("decodeCandidate(language id) = %#v, %v; want language ja", candidate, err)
	}
	legacy := encodeCandidate(candidateID{NID: "WIfqGGz6sa", FileID: "iooM1nS2CO", Name: "Movie.srt", Format: "srt"})
	candidate, err = decodeCandidate(legacy)
	if err != nil || candidate.Language != "" || candidate.FileID != "iooM1nS2CO" {
		t.Fatalf("decodeCandidate(legacy id) = %#v, %v; want decodable with empty language", candidate, err)
	}
}
