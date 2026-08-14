import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from qbittorrent_config import merge_config


class QBittorrentConfigTests(unittest.TestCase):
    def test_preserves_credentials_and_unknown_settings(self):
        original = (
            b"[Preferences]\n"
            b"WebUI\\Username=admin\n"
            b"WebUI\\Password_PBKDF2=@ByteArray(secret-hash)\n"
            b"Downloads\\TempPath=/small/disk\n"
            b"Downloads\\TempPathEnabled=false\n"
            b"Unrelated\\Token=keep-me\n"
        )
        merged = merge_config(original, "/mnt/sda1/torrent/.incomplete")
        self.assertIn(b"WebUI\\Password_PBKDF2=@ByteArray(secret-hash)\n", merged)
        self.assertIn(b"Unrelated\\Token=keep-me\n", merged)
        self.assertIn(b"Downloads\\TempPath=/mnt/sda1/torrent/.incomplete/\n", merged)
        self.assertIn(b"Downloads\\TempPathEnabled=true\n", merged)
        self.assertIn(b"Downloads\\PreAllocation=false\n", merged)
        self.assertIn(b"Downloads\\UseIncompleteExtension=false\n", merged)

    def test_adds_preferences_without_changing_other_sections(self):
        original = b"[LegalNotice]\r\nAccepted=true\r\n[Network]\r\nCookies=@ByteArray(token)\r\n"
        merged = merge_config(original, "/big/temp")
        self.assertTrue(merged.startswith(original))
        self.assertIn(b"[Preferences]\r\n", merged)
        self.assertIn(b"Downloads\\TempPath=/big/temp/\r\n", merged)


if __name__ == "__main__":
    unittest.main()
