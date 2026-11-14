#!/usr/bin/env python3
"""Transcribe audio with Whisper and print JSON with word timings.

usage: whisper_words.py <audio-path> [language] [model]

`language` is "auto", an ISO code ("en", "ar") or a locale ("ar-ma" for
Moroccan Darija). `model` is the default Whisper model; Arabic picks its own
model (see `pick_model`) because the small models are not usable for it.

Environment:
  WHISPER_MODEL                 default model when none is passed (base)
  WHISPER_MODEL_ARABIC          model for Arabic and Darija (default: by RAM)
  WHISPER_MODEL_DARIJA          model for Darija only; "darija-finetune" selects
                                the small Darija fine-tune in darija_whisper.py
  WHISPER_BEAM_SIZE             beam width on the CPU engine (default 5 for Arabic)
  WHISPER_THREADS               CPU threads for PyTorch (default 2)
  CLIP_MAKER_WHISPER_ACCELERATE "0" disables Apple-GPU (MLX) transcription
  CLIP_MAKER_WHISPER_PROGRESS   "1" prints clip-maker-progress:<0..1> on stderr
"""

import json
import math
import os
from pathlib import Path
import platform
import re
import sys
import tempfile

SAMPLE_RATE = 16000
BLOCK_SECONDS = 300
DARIJA_FINETUNE = "darija-finetune"

# A short prompt in the target script keeps Whisper from drifting into Latin
# transliteration or another language on code-switched speech.
PROMPTS = {
    "ar-ma": "هادي هضرة بالدارجة المغربية، مكتوبة بالحروف العربية.",
    "ar": "هذا تسجيل باللغة العربية.",
}

# Text Whisper invents over silence and music in Arabic audio. These come from
# subtitle credits in its training data, not from the speaker.
ALWAYS_HALLUCINATED = re.compile(r"ترجمة\s+نانسي|نانسي\s+قنقر|ترجمة\s+وتدقيق|Subtitles by|Amara\.org", re.I)
OFTEN_HALLUCINATED = re.compile(r"اشتركوا في القناة|شكرا(?:ً)? (?:على|ل)المشاهدة|لا تنسوا الاشتراك|thanks for watching", re.I)


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def total_ram_gb() -> float:
    try:
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 2**30
    except (ValueError, OSError, AttributeError):
        return 0.0


def can_accelerate() -> bool:
    if os.environ.get("CLIP_MAKER_WHISPER_ACCELERATE") == "0":
        return False
    if not (platform.machine() == "arm64" and sys.platform == "darwin"):
        return False
    try:
        import mlx.core as mx
        import mlx_whisper  # noqa: F401

        return bool(mx.metal.is_available())
    except Exception:
        return False


def pick_model(locale: str, language: str | None, default: str) -> str:
    """The model for this language. Arabic needs far more capacity than the
    tiny/base models that are fine for English."""
    if default.endswith(".en") and language not in {"en", "english"}:
        default = default.removesuffix(".en")
    if language != "ar":
        return default
    darija = locale == "ar-ma"
    chosen = (darija and os.environ.get("WHISPER_MODEL_DARIJA")) or os.environ.get("WHISPER_MODEL_ARABIC")
    if not chosen:
        ram = total_ram_gb()
        if ram >= 7.5:
            chosen = "large-v3-turbo"
        elif darija:
            chosen = DARIJA_FINETUNE
        elif ram >= 3.5 and default in {"tiny", "base"}:
            chosen = "small"
        else:
            chosen = default
    if chosen == DARIJA_FINETUNE and not darija:
        chosen = default
    return chosen


def speech_spans(audio):
    """Speech regions in seconds from Silero VAD, or None when it isn't installed."""
    try:
        from faster_whisper.vad import VadOptions, get_speech_timestamps
    except Exception:
        return None
    try:
        options = VadOptions(min_silence_duration_ms=500, speech_pad_ms=200)
        return [(s["start"] / SAMPLE_RATE, s["end"] / SAMPLE_RATE) for s in get_speech_timestamps(audio, options)]
    except Exception as exc:
        log(f"VAD failed; transcribing without it: {exc}")
        return None


def split_points(duration: float, spans, block: float):
    """Block boundaries near every `block` seconds, moved into a pause when the
    VAD found one so no word is cut in half."""
    points, cursor = [0.0], 0.0
    while duration - cursor > block * 1.2:
        target = cursor + block
        best = target
        if spans:
            gaps = [(a_end + b_start) / 2 for (_, a_end), (b_start, _) in zip(spans, spans[1:]) if b_start - a_end >= 0.3]
            near = [g for g in gaps if abs(g - target) <= 20]
            if near:
                best = min(near, key=lambda g: abs(g - target))
        points.append(best)
        cursor = best
    points.append(duration)
    return points


def speech_chunks(spans, limit: float = 18.0):
    """Merges VAD spans into chunks no longer than `limit` seconds. Fine-tuned
    checkpoints are trained on short utterances and drop text on long windows."""
    chunks = []
    for start, end in spans:
        while end - start > limit:
            chunks.append((start, start + limit))
            start += limit
        if chunks and end - chunks[-1][0] <= limit and start - chunks[-1][1] < 0.6:
            chunks[-1] = (chunks[-1][0], end)
        else:
            chunks.append((start, end))
    return chunks


class Engine:
    """One loaded model. `run(audio, **options)` returns Whisper's result dict."""

    def __init__(self, model_name: str):
        import whisper

        self.name = model_name
        self.finetune = model_name == DARIJA_FINETUNE
        heads_key = "small" if self.finetune else model_name
        self.heads = whisper._ALIGNMENT_HEADS.get(heads_key)
        if self.finetune:
            from darija_whisper import model_path

            self.source = str(model_path())
        else:
            self.source = model_name
        self.mlx_path = None
        self.torch_model = None
        if can_accelerate():
            try:
                self.mlx_path = self._prepare_mlx()
            except Exception as exc:
                log(f"Metal transcription unavailable; using CPU: {exc}")

    def _prepare_mlx(self) -> str:
        import mlx.core as mx
        import whisper
        from mlx_whisper.transcribe import ModelHolder

        checkpoint = Path(self.source)
        if not checkpoint.is_file():
            cache = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "whisper"
            url = whisper._MODELS[self.source]
            checkpoint = cache / os.path.basename(url)
            if not checkpoint.is_file():
                whisper._download(url, str(cache), False)
        path = str(mlx_checkpoint(checkpoint))
        model = ModelHolder.get_model(path, mx.float16)
        # Word timings come from specific cross-attention heads. A converted
        # checkpoint carries none, so set the ones published for this size.
        if self.heads:
            model.set_alignment_heads(self.heads)
        return path

    def run(self, audio, **options):
        if self.mlx_path:
            import mlx_whisper

            options.pop("beam_size", None)  # MLX decodes greedily.
            try:
                return mlx_whisper.transcribe(audio, path_or_hf_repo=self.mlx_path, **options)
            except Exception as exc:
                log(f"Metal transcription failed; retrying with CPU: {exc}")
                self.mlx_path = None
        if self.torch_model is None:
            import torch
            import whisper

            torch.set_num_threads(int(os.environ.get("WHISPER_THREADS", "2")))
            self.torch_model = whisper.load_model(self.source, device="cpu")
            if self.heads and self.finetune:
                self.torch_model.set_alignment_heads(self.heads)
        return self.torch_model.transcribe(audio, fp16=False, **options)


def mlx_checkpoint(checkpoint: Path) -> Path:
    """Converts an OpenAI-format checkpoint to an MLX model directory (cached)."""
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
        weights[name] = mx.array(value.contiguous().float().numpy(), dtype=mx.float16)
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


def detect_language(engine: Engine, audio, spans) -> str | None:
    """Votes over up to three windows. Whisper's own detection only hears the
    first 30 seconds, which is often an intro jingle."""
    duration = len(audio) / SAMPLE_RATE
    starts = [spans[0][0] if spans else 0.0]
    if duration > 90:
        starts += [duration * 0.4, duration * 0.7]
    votes = {}
    for start in starts:
        window = audio[int(start * SAMPLE_RATE): int((start + 30) * SAMPLE_RATE)]
        if len(window) < SAMPLE_RATE:
            continue
        result = engine.run(window, language=None, task="transcribe", word_timestamps=False,
                            condition_on_previous_text=False, verbose=None, temperature=0.0)
        if result.get("text", "").strip():
            language = result.get("language")
            votes[language] = votes.get(language, 0) + 1
    return max(votes, key=votes.get) if votes else None


def is_hallucination(segment) -> bool:
    text = segment.get("text", "")
    if ALWAYS_HALLUCINATED.search(text):
        return True
    unsure = segment.get("no_speech_prob", 0) > 0.35 or segment.get("avg_logprob", 0) < -0.9
    if unsure and OFTEN_HALLUCINATED.search(text):
        return True
    return segment.get("no_speech_prob", 0) > 0.8 and segment.get("avg_logprob", 0) < -1.0


def collect_words(result, offset: float, limit: float, words: list) -> None:
    """Appends clean timed words from one result. `limit` is the end of the
    audio this result covers; decoder timestamps past it are bogus."""
    for segment in result.get("segments", []):
        if is_hallucination(segment):
            continue
        first = True
        for word in segment.get("words", []):
            raw = word["word"]
            token = raw.strip()
            start, end = float(word["start"]) + offset, float(word["end"]) + offset
            if not token or not (math.isfinite(start) and math.isfinite(end)) or end <= start or start >= limit:
                continue
            # Whisper marks a new word with a leading space. A piece without
            # one ("'hui" after "Aujourd") continues the previous word.
            if not first and not raw.startswith(" ") and words:
                words[-1]["word"] += token
                words[-1]["end"] = round(min(max(end, words[-1]["end"]), limit), 3)
                continue
            first = False
            # A decoder stuck in a loop repeats one word; keep at most three.
            if len(words) >= 3 and all(w["word"] == token for w in words[-3:]):
                continue
            if words and start < words[-1]["end"]:
                start = min(words[-1]["end"], end - 0.02)
            words.append({"word": token, "start": round(start, 3), "end": round(min(end, limit), 3)})


def main() -> None:
    if len(sys.argv) < 2:
        raise ValueError("usage: whisper_words.py <audio-path> [language] [model]")

    audio_path = sys.argv[1]
    if not os.path.isfile(audio_path):
        raise FileNotFoundError(audio_path)

    locale = sys.argv[2].strip().lower() if len(sys.argv) > 2 else "auto"
    default_model = sys.argv[3] if len(sys.argv) > 3 else os.environ.get("WHISPER_MODEL", "base")

    import whisper
    from whisper.tokenizer import LANGUAGES

    audio = whisper.load_audio(audio_path)
    duration = len(audio) / SAMPLE_RATE
    spans = speech_spans(audio)
    if spans is not None and not spans:
        json.dump({"text": "", "words": [], "language": None}, sys.stdout, ensure_ascii=False)
        return

    language = locale.split("-", 1)[0]
    language = language if language in LANGUAGES else None
    engine = None
    if language is None:
        engine = Engine(pick_model(locale, None, default_model))
        language = detect_language(engine, audio, spans)
    model_name = pick_model(locale, language, default_model)
    if engine is None or engine.name != model_name:
        engine = Engine(model_name)
    log(f"whisper: model={model_name} language={language or 'auto'} engine={'metal' if engine.mlx_path else 'cpu'}")

    options = {
        "language": language,
        "task": "transcribe",
        # Feeding earlier text back in is what turns one mistake into a loop.
        "condition_on_previous_text": False,
        "word_timestamps": True,
        "verbose": None,
        "compression_ratio_threshold": 2.2,
        "no_speech_threshold": 0.6,
    }
    if not engine.finetune:
        options["hallucination_silence_threshold"] = 2.0
        prompt = PROMPTS.get(locale) or PROMPTS.get(language or "")
        if prompt:
            options["initial_prompt"] = prompt
    beam = os.environ.get("WHISPER_BEAM_SIZE") or ("5" if language == "ar" else "")
    if beam.isdigit() and int(beam) > 1:
        options["beam_size"] = int(beam)

    if engine.finetune and spans:
        pieces = speech_chunks(spans)
    else:
        points = split_points(duration, spans, BLOCK_SECONDS)
        pieces = list(zip(points, points[1:]))

    words, texts = [], []
    report = os.environ.get("CLIP_MAKER_WHISPER_PROGRESS") == "1"
    for start, end in pieces:
        chunk = audio[int(start * SAMPLE_RATE): int(end * SAMPLE_RATE)]
        if len(chunk) >= SAMPLE_RATE // 5:
            result = engine.run(chunk, **options)
            before = len(words)
            collect_words(result, start, end, words)
            if len(words) > before:
                texts.append(" ".join(w["word"] for w in words[before:]))
        if report:
            log(f"clip-maker-progress:{end / duration:.4f}")

    json.dump({"text": " ".join(texts).strip(), "words": words, "language": language, "model": model_name},
              sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
