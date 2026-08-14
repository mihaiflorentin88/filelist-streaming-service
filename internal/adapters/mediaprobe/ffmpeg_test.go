package mediaprobe

import "testing"

func TestDecodeMediaInfoUsesOriginalDurationAndAudioStreamIndexes(t *testing.T) {
	info, err := decodeMediaInfo([]byte(`{
		"streams":[
			{"index":1,"codec_name":"eac3","channels":6,"tags":{"language":"eng","title":"Main"},"disposition":{"default":1}},
			{"index":3,"codec_name":"aac","channels":2,"tags":{"language":"ron","title":"Romanian"},"disposition":{"default":0}}
		],
		"format":{"duration":"3594.842000"}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if info.DurationMS != 3_594_842 {
		t.Fatalf("duration = %d", info.DurationMS)
	}
	if len(info.AudioTracks) != 2 || info.AudioTracks[0].Index != 1 || info.AudioTracks[0].Channels != 6 || !info.AudioTracks[0].Default || info.AudioTracks[1].Index != 3 {
		t.Fatalf("unexpected tracks: %#v", info.AudioTracks)
	}
}

func TestDecodeMediaInfoRejectsGrowingContainerWithoutDuration(t *testing.T) {
	if _, err := decodeMediaInfo([]byte(`{"streams":[{"index":1,"codec_name":"aac","channels":2}],"format":{"duration":"N/A"}}`)); err == nil {
		t.Fatal("expected missing duration error")
	}
}
