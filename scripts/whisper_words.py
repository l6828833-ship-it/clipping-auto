#!/usr/bin/env python3
"""Transcribe audio with OpenAI Whisper and print JSON with word timings."""

import json
import math
import os
from pathlib import Path
import platform
import sys
import tempfile


def mlx_checkpoint(checkpoint: Path) -> Path:
    import mlx.core as mx
    import torch

    target = checkpoint.parent / f"{checkpoint.stem}-mlx"
    if target.is_dir():
        return target
    state = torch.load(checkpoint, map_location="cpu", weights_only=True)
    weights = {}
    for name, value in state["model_state_dict"].items():
        if name == "encoder.positional_embedding":
            continue  # MLX builds the encoder's fixed sinusoidal embedding.
        name = name.replace(".mlp.0.", ".mlp1.").replace(".mlp.2.", ".mlp2.")
        if name in {"encoder.conv1.weight", "encoder.conv2.weight"}:
            value = value.transpose(1, 2)
        weights[name] = mx.array(value.contiguous().numpy(), dtype=mx.float16)
    with tempfile.TemporaryDirectory(dir=checkpoint.parent) as directory:
        output = Path(directory) / "model"
        output.mkdir()
        (output / "config.json").write_text(json.dumps(state["dims"]), encoding="utf-8")
        mx.save_safetensors(str(output / "weights.safetensors"), weights)
        try:
            output.rename(target)
        except OSError:
            if not target.is_dir():
                raise
    return target


def transcribe_on_mac(audio_path: str, model_name: str, options: dict):
    import mlx.core as mx
    import mlx_whisper
    import whisper

    if not mx.metal.is_available():
        raise RuntimeError("Metal is unavailable")

    checkpoint = Path(model_name)
    if not checkpoint.is_file():
        cache = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "whisper"
        checkpoint = cache / f"{model_name}.pt"
        if not checkpoint.is_file():
            whisper.load_model(model_name, device="cpu")
    model = mlx_checkpoint(checkpoint)
    audio = whisper.load_audio(audio_path)
    sample_rate = whisper.audio.SAMPLE_RATE
    block_size = 300 * sample_rate
    for start in range(0, len(audio), block_size):
        end = min(start + block_size, len(audio))
        result = mlx_whisper.transcribe(audio[start:end], path_or_hf_repo=str(model), **options)
        yield result, start / sample_rate
        if os.environ.get("CLIP_MAKER_WHISPER_PROGRESS") == "1":
            print(f"clip-maker-progress:{end / len(audio):.4f}", file=sys.stderr, flush=True)


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
    options = {
        "language": language if language in LANGUAGES else None,
        "task": "transcribe",
        "condition_on_previous_text": locale != "ar-ma",
        "word_timestamps": True,
        "verbose": None,
    }
    results = []
    if os.environ.get("CLIP_MAKER_WHISPER_ACCELERATE") == "1" and platform.machine() == "arm64" and sys.platform == "darwin":
        try:
            results = list(transcribe_on_mac(audio_path, model_name, options))
        except Exception as exc:
            print(f"Metal transcription failed; retrying with CPU: {exc}", file=sys.stderr, flush=True)
    if not results:
        model = whisper.load_model(model_name, device="cpu")
        results = [(model.transcribe(audio_path, fp16=False, **options), 0)]

    words = []
    for result, offset in results:
        for segment in result["segments"]:
            for word in segment.get("words", []):
                token = word["word"].strip()
                start, end = float(word["start"]), float(word["end"])
                if token and math.isfinite(start) and math.isfinite(end) and end > start:
                    words.append({"word": token, "start": round(start + offset, 3), "end": round(end + offset, 3)})
    text = " ".join(result["text"].strip() for result, _ in results).strip()
    json.dump({"text": text, "words": words}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
