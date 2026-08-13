#!/usr/bin/env python3
"""
Word-level transcription helper.

Inworld's synchronous STT returns the transcript text but leaves
`wordTimestamps` empty, so captions built from it can only ever be
interpolated. faster-whisper returns a real start/end for every word, which is
what caption timing needs.

Usage:
    whisper_words.py <audio-path> [language] [model]

Prints a single JSON object to stdout:
    {"text": "...", "words": [{"word": "hi", "start": 0.12, "end": 0.31}, ...]}

Any failure exits non-zero with the reason on stderr so the caller can fall
back to its previous behaviour instead of losing the render.
"""
import json
import os
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: whisper_words.py <audio-path> [language] [model]", file=sys.stderr)
        return 2

    audio_path = sys.argv[1]
    language = (sys.argv[2] if len(sys.argv) > 2 else "en") or "en"
    model_name = (
        sys.argv[3]
        if len(sys.argv) > 3
        else os.environ.get("WHISPER_MODEL", "base.en")
    )

    if not os.path.isfile(audio_path):
        print(f"audio file not found: {audio_path}", file=sys.stderr)
        return 2

    from faster_whisper import WhisperModel

    # int8 on CPU keeps this fast enough to sit inside a render without a GPU.
    model = WhisperModel(model_name, device="cpu", compute_type="int8")

    # English-only models reject an explicit language argument.
    transcribe_kwargs = {
        "word_timestamps": True,
        # Trims silence before decoding, which stops the model inventing words
        # in the quiet parts.
        "vad_filter": True,
        "vad_parameters": {"min_silence_duration_ms": 300},
    }
    if not model_name.endswith(".en"):
        transcribe_kwargs["language"] = language

    segments, _info = model.transcribe(audio_path, **transcribe_kwargs)

    words = []
    text_parts = []
    for segment in segments:
        if segment.text:
            text_parts.append(segment.text.strip())
        for word in (segment.words or []):
            token = (word.word or "").strip()
            if not token:
                continue
            start = float(word.start)
            end = float(word.end)
            if end <= start:
                # Keep it renderable rather than dropping the word entirely.
                end = start + 0.08
            words.append(
                {"word": token, "start": round(start, 3), "end": round(end, 3)}
            )

    json.dump(
        {"text": " ".join(text_parts).strip(), "words": words},
        sys.stdout,
        ensure_ascii=False,
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 - surfaced to the caller as stderr
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
