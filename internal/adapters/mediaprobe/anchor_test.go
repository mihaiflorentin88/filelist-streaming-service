package mediaprobe

import "testing"

func TestDecodeAnchorPacketsParsesMeasurementsAndDropsUnusableEntries(t *testing.T) {
	out := []byte(`{
		"packets":[
			{"stream_index":1,"pts_time":"0.000000","pos":"100"},
			{"stream_index":1,"pts_time":"3.776000","pos":"200"},
			{"stream_index":1,"pts_time":"71.392000","pos":"3661166"},
			{"stream_index":1,"pts_time":"N/A","pos":"300"},
			{"stream_index":1,"pts_time":"962.784000"}
		]
	}`)
	packets, err := decodeAnchorPackets(out)
	if err != nil {
		t.Fatal(err)
	}
	if len(packets) != 4 {
		t.Fatalf("packets = %d entries, want 4 (N/A dropped, pos-less kept)", len(packets))
	}
	last := packets[len(packets)-1]
	if last.StreamIndex != 1 || last.PTSMS != 962784 || last.ByteOffset != 0 {
		t.Fatalf("last = %+v, want the pos-less packet kept with zero offset", last)
	}
}

func TestAnchorSpanClassifiesWindowByByteBoundary(t *testing.T) {
	out := []byte(`{
		"packets":[
			{"stream_index":1,"pts_time":"0.000000","pos":"100"},
			{"stream_index":1,"pts_time":"3.776000","pos":"200"},
			{"stream_index":1,"pts_time":"5.000000","pos":"300"},
			{"stream_index":1,"pts_time":"2.500000","pos":"2097162"},
			{"stream_index":1,"pts_time":"71.392000","pos":"3661166"},
			{"stream_index":2,"pts_time":"84.320000","pos":"18748122"},
			{"stream_index":1,"pts_time":"84.224000","pos":"18700000"},
			{"stream_index":1,"pts_time":"962.784000"}
		]
	}`)
	packets, err := decodeAnchorPackets(out)
	if err != nil {
		t.Fatal(err)
	}
	first, last, ok := anchorSpan(packets, 1, 2097152)
	if !ok {
		t.Fatal("expected a span inside the fetch window")
	}
	if first != 2500 || last != 84224 {
		t.Fatalf("span = [%d, %d], want [2500, 84224]: the 2.5s discontinuity packet is inside the window by bytes, the 5s packet is head bytes, and the pos-less packet is unclassifiable", first, last)
	}

	first, last, ok = anchorSpan(packets, 2, 2097152)
	if !ok || first != 84320 || last != 84320 {
		t.Fatalf("stream 2 span = [%d, %d] ok=%v, want [84320, 84320]", first, last, ok)
	}

	if _, _, ok := anchorSpan(packets, 3, 2097152); ok {
		t.Fatal("expected no span for an absent stream")
	}
	if _, _, ok := anchorSpan(nil, 1, 2097152); ok {
		t.Fatal("expected no span without packets")
	}
}

func TestAnchorSpanFollowsPacketOrderNotExtrema(t *testing.T) {
	packets := []anchorPacket{
		{StreamIndex: 1, PTSMS: 71392, ByteOffset: 3661166},
		{StreamIndex: 1, PTSMS: 84224, ByteOffset: 18700000},
		{StreamIndex: 1, PTSMS: 30000, ByteOffset: 18740000},
		{StreamIndex: 1, PTSMS: 31000, ByteOffset: 18750000},
		{StreamIndex: 2, PTSMS: 999999, ByteOffset: 18760000},
		{StreamIndex: 1, PTSMS: 500, ByteOffset: 100},
	}
	first, last, ok := anchorSpan(packets, 1, 2097152)
	if !ok || first != 71392 || last != 31000 {
		t.Fatalf("span = [%d, %d] ok=%v, want [71392, 31000]: first and last follow packet order across the discontinuity, not PTS extrema", first, last, ok)
	}
}
