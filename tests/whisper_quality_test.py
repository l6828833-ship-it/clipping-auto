import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("words", Path(__file__).parents[1] / "scripts/whisper_words.py")
words = importlib.util.module_from_spec(spec)
spec.loader.exec_module(words)


class WhisperQuality(unittest.TestCase):
    def test_container_arabic_setting_cannot_override_darija(self):
        with patch.dict(os.environ, {"WHISPER_MODEL_ARABIC": "small"}, clear=True):
            self.assertEqual(words.pick_model("ar-ma", "ar", "base"), "large-v3-turbo")
            self.assertEqual(words.pick_model("ar", "ar", "base"), "small")

    def test_explicit_darija_model_is_preserved(self):
        with patch.dict(os.environ, {"WHISPER_MODEL_DARIJA": "darija-finetune"}, clear=True):
            self.assertEqual(words.pick_model("ar-ma", "ar", "base"), "darija-finetune")

    def test_silence_does_not_become_words_and_timing_stays_absolute(self):
        result = {"segments": [{"text": "speech hallucination speech", "words": [
            {"word": " hello", "start": 0, "end": 0.8},
            {"word": " invented", "start": 3, "end": 4},
            {"word": " again", "start": 6, "end": 7},
        ]}]}
        output = []
        words.collect_words(result, 100, 110, output, [(100, 101), (106, 108)])
        self.assertEqual([w["word"] for w in output], ["hello", "again"])
        self.assertEqual([w["start"] for w in output], [100, 106])

    def test_speech_chunks_skip_long_music_gaps(self):
        chunks = words.speech_chunks([(1, 4), (60, 65), (100, 130)], 12)
        self.assertTrue(all(end - start <= 12 for start, end in chunks))
        self.assertFalse(any(start < 30 < end for start, end in chunks))
        self.assertEqual(chunks[-1][1], 130)


if __name__ == "__main__":
    unittest.main()
