import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import progressive_stream_smoke as smoke

PROBE_JSON = {
    "packets": [
        {"stream_index": 1, "pts_time": "0.000000", "pos": "100"},
        {"stream_index": 1, "pts_time": "3.776000", "pos": "200"},
        {"stream_index": 1, "pts_time": "5.000000", "pos": "300"},
        {"stream_index": 1, "pts_time": "2.500000", "pos": "2097162"},
        {"stream_index": 1, "pts_time": "71.392000", "pos": "3661166"},
        {"stream_index": 2, "pts_time": "84.320000", "pos": "18748122"},
        {"stream_index": 1, "pts_time": "84.224000", "pos": "18700000"},
        {"stream_index": 1, "pts_time": "N/A", "pos": "300"},
        {"stream_index": 1, "pts_time": "962.784000"},
    ]
}


class ParsePacketsTest(unittest.TestCase):
    def test_parses_measurements_and_drops_unusable_entries(self):
        packets = smoke.parse_packets(PROBE_JSON)
        self.assertEqual(packets[0], (1, 0, 100))
        self.assertEqual(len(packets), 8)  # N/A dropped; pos-less kept with offset 0
        self.assertIn((1, 962784, 0), packets)

    def test_malformed_timestamp_is_dropped(self):
        packets = smoke.parse_packets({"packets": [{"stream_index": 1, "pts_time": "later", "pos": "1"}]})
        self.assertEqual(packets, [])


class WindowSpanTest(unittest.TestCase):
    def test_classifies_window_by_byte_boundary_in_packet_order(self):
        packets = smoke.parse_packets(PROBE_JSON)
        self.assertEqual(smoke.window_span(packets, stream_index=1, header_len=2097152), (2500, 84224))

    def test_other_stream_is_measured_independently(self):
        packets = smoke.parse_packets(PROBE_JSON)
        self.assertEqual(smoke.window_span(packets, stream_index=2, header_len=2097152), (84320, 84320))

    def test_no_packets_means_no_span(self):
        self.assertIsNone(smoke.window_span([], stream_index=1, header_len=2097152))


class SyncVerdictTest(unittest.TestCase):
    def test_trim_lands_exactly_on_target(self):
        ok, offset_ms = smoke.sync_verdict(
            target_s=60.0, first_pts_ms=59000, decoded_duration_ms=13892, trim_ms=1000, tolerance_ms=150
        )
        self.assertTrue(ok)  # 59000 + 1000 = 60000
        self.assertEqual(offset_ms, 0)

    def test_small_placement_error_within_tolerance_passes(self):
        ok, offset_ms = smoke.sync_verdict(
            target_s=60.0, first_pts_ms=60020, decoded_duration_ms=13872, trim_ms=20, tolerance_ms=150
        )
        self.assertTrue(ok)
        self.assertEqual(offset_ms, 40)

    def test_zero_trim_places_first_sample_on_target(self):
        ok, offset_ms = smoke.sync_verdict(
            target_s=60.0, first_pts_ms=60000, decoded_duration_ms=13892, trim_ms=0, tolerance_ms=150
        )
        self.assertTrue(ok)
        self.assertEqual(offset_ms, 0)

    def test_trim_one_frame_below_duration_places_last_frame_on_target(self):
        ok, offset_ms = smoke.sync_verdict(
            target_s=73.871, first_pts_ms=60000, decoded_duration_ms=13892, trim_ms=13871, tolerance_ms=150
        )
        self.assertTrue(ok)  # 60000 + 13871 = 73871; trimming the whole window is invalid
        self.assertEqual(offset_ms, 0)

    def test_trim_equal_to_decoded_duration_is_rejected(self):
        # Trimming the entire decoded audio leaves nothing to play: not an
        # anchor, whatever the placement arithmetic says.
        ok, _ = smoke.sync_verdict(
            target_s=73.892, first_pts_ms=60000, decoded_duration_ms=13892, trim_ms=13892, tolerance_ms=150
        )
        self.assertFalse(ok)

    def test_negative_trim_is_rejected(self):
        # Audio-ahead window: content begins after the requested position; no
        # trim can rewind decoded audio, so the window is not a valid anchor.
        ok, _ = smoke.sync_verdict(
            target_s=60.0, first_pts_ms=71392, decoded_duration_ms=12832, trim_ms=-11392, tolerance_ms=150
        )
        self.assertFalse(ok)

    def test_trim_beyond_decoded_duration_is_rejected(self):
        # Audio-behind window: the requested position lies past every sample
        # the artifact can produce.
        ok, _ = smoke.sync_verdict(
            target_s=600.0, first_pts_ms=508514, decoded_duration_ms=12486, trim_ms=91486, tolerance_ms=150
        )
        self.assertFalse(ok)

    def test_placement_outside_tolerance_fails(self):
        ok, offset_ms = smoke.sync_verdict(
            target_s=60.0, first_pts_ms=71392, decoded_duration_ms=12832, trim_ms=0, tolerance_ms=150
        )
        self.assertFalse(ok)  # 71392 against 60000 -> +11392 ms, audio ahead
        self.assertEqual(offset_ms, 11392)

    def test_discontinuous_stream_uses_decoded_duration_not_packet_extrema(self):
        # Packet-order last PTS (31000) sits below first PTS (71392); the
        # verdict must rely on the decoded duration, which stays well-formed.
        ok, _ = smoke.sync_verdict(
            target_s=71.392, first_pts_ms=71392, decoded_duration_ms=13000, trim_ms=0, tolerance_ms=150
        )
        self.assertTrue(ok)




class CheckSyncTest(unittest.TestCase):
    """--check-sync orchestration with injected runners: no network, no ffmpeg.

    The server's span is cross-validated against an independent packet scan of
    the same artifact, and the trim implied by the MEASURED first PTS must be
    achievable within the window-only decoded duration (artifact decode minus
    head-only decode).
    """

    @staticmethod
    def harness(probe_span, probe_packets, decode_ms, target_s=60.0):
        calls = []

        def fetch_range(start: int, end: int) -> bytes:
            calls.append(("fetch", start, end))
            return bytes([start & 0xFF]) * (end - start + 1)

        def span(download_id, start_byte, length_bytes, stream_index):
            calls.append(("probe", download_id, start_byte, length_bytes, stream_index))
            return probe_span(start_byte, length_bytes, stream_index)

        report = smoke.check_sync(
            download_id="d1", stream_index=1, target_s=target_s, hint_byte=30_000_000,
            total_bytes=300 << 20, window_bytes=16 << 20, head_bytes=2 << 20,
            fetch_range=fetch_range, probe_span=span, probe_packets=probe_packets,
            decode_ms=decode_ms,
        )
        return report, calls

    def test_window_duration_is_artifact_decode_minus_head_decode(self):
        calls = []
        report, calls_out = self.harness(
            probe_span=lambda start, length, index: {"firstPtsMs": 60000, "lastPtsMs": 93000},
            probe_packets=lambda artifact: {"packets": []},
            decode_ms=lambda media: calls.append(("decode", len(media))) or 1000 * len(media),
        )
        self.assertEqual(calls_out[0], ("fetch", 0, (2 << 20) - 1))  # head
        self.assertEqual(calls_out[1], ("fetch", 30_000_000, 30_000_000 + (16 << 20) - 1))  # window
        self.assertEqual(calls_out[2][:2], ("probe", "d1"))
        self.assertEqual(report["windowMs"], 1000 * (16 << 20))  # artifact decode minus head decode
        self.assertEqual(report["serverFirstPtsMs"], 60000)
        # This fixture's scan finds no window packets: the report carries the
        # unavailable local measurement and anchors on the server value.
        self.assertIsNone(report["localFirstPtsMs"])

    def test_on_target_span_passes_with_zero_offset(self):
        report, _ = self.harness(
            probe_span=lambda start, length, index: {"firstPtsMs": 60000, "lastPtsMs": 93000},
            # Independent scan of the artifact agrees with the server: window
            # packets start at 60000 ms (positions past the 2 MiB head).
            probe_packets=lambda artifact: {"packets": [
                {"stream_index": 1, "pts_time": "0.000000", "pos": "100"},
                {"stream_index": 1, "pts_time": "60.000000", "pos": str((2 << 20) + 5)},
                {"stream_index": 1, "pts_time": "92.000000", "pos": str((2 << 20) + 9999)},
            ]},
            decode_ms=lambda media: 1000 * len(media),
        )
        self.assertTrue(report["measuredMatch"])
        self.assertTrue(report["ok"])
        self.assertEqual(report["offsetMs"], 0)

    def test_server_disagreeing_with_local_scan_fails(self):
        report, _ = self.harness(
            probe_span=lambda start, length, index: {"firstPtsMs": 60000, "lastPtsMs": 93000},
            # Independent scan measures 71392: the server window measurement is
            # not reproducible, so anchoring on it would misplace content.
            probe_packets=lambda artifact: {"packets": [
                {"stream_index": 1, "pts_time": "71.392000", "pos": str((2 << 20) + 5)},
            ]},
            decode_ms=lambda media: 1000 * len(media),
        )
        self.assertFalse(report["measuredMatch"])
        self.assertEqual(report["localFirstPtsMs"], 71392)
        self.assertFalse(report["ok"])

    def test_unachievable_trim_fails_even_when_measurements_agree(self):
        # Span content sits AFTER the target (firstPts 71392 for target 60 s):
        # the trim would be negative, so no trim can place the content.
        report, _ = self.harness(
            probe_span=lambda start, length, index: {"firstPtsMs": 71392, "lastPtsMs": 104000},
            probe_packets=lambda artifact: {"packets": [
                {"stream_index": 1, "pts_time": "71.392000", "pos": str((2 << 20) + 5)},
            ]},
            decode_ms=lambda media: 1000 * len(media),
        )
        self.assertTrue(report["measuredMatch"])
        self.assertFalse(report["ok"])


class FfmpegDecodeMsTest(unittest.TestCase):
    def test_pcm_length_maps_to_milliseconds_at_48k_stereo_s16le(self):
        # 192000 bytes = 1 second of 48 kHz stereo s16le.
        self.assertEqual(smoke.pcm_duration_ms(192_000), 1000)
        self.assertEqual(smoke.pcm_duration_ms(96_000), 500)


if __name__ == "__main__":
    unittest.main()
