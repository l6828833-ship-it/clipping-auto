#!/usr/bin/env python3
"""Transcribe audio with OpenAI Whisper and print JSON with word timings."""

import json
import math
import os
import sys


def main() -> None:
    if len(sys.argv) < 2:
        raise ValueError("usage: whisper_words.py <audio-path> [language] [model]")

    audio_path = sys.argv[1]
    if not os.path.isfile(audio_path):
        raise FileNotFoundError(audio_path)

    locale = sys.argv[2].strip().lower() if len(sys.argv) > 2 else "auto"
    language = locale.split("-", 1)[0]
    model_name = sys.argv[3] if len(sys.argv) > 3 else os.environ.get("WHISPER_MODEL", "base")
    if model_name in {"tiny.en", "base.en", "small.en", "medium.en"} and language not in {"en", "english"}:
        model_name = model_name.removesuffix(".en")

    import torch
    import whisper
    from whisper.tokenizer import LANGUAGES

    torch.set_num_threads(2)
    if locale == "ar-ma":
        from darija_whisper import model_path

        model_name = str(model_path())
    model = whisper.load_model(model_name, device="cpu")
    result = model.transcribe(
        audio_path,
        language=language if language in LANGUAGES else None,
        task="transcribe",
        condition_on_previous_text=locale != "ar-ma",
        word_timestamps=True,
        fp16=False,
        verbose=None,
    )
    words = []
    for segment in result["segments"]:
        for word in segment.get("words", []):
            token = word["word"].strip()
            start, end = float(word["start"]), float(word["end"])
            if token and math.isfinite(start) and math.isfinite(end) and end > start:
                words.append({"word": token, "start": round(start, 3), "end": round(end, 3)})
    json.dump({"text": result["text"].strip(), "words": words}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
