#!/usr/bin/env python3
"""Transcribe audio with Whisper and print JSON with word timings.

usage: whisper_words.py <audio-path> [language] [model]

`language` is "auto", an ISO code ("en", "ar") or a locale ("ar-ma" for
Moroccan Darija). `model` is the default Whisper model; Arabic picks its own
model (see `pick_model`) because the small models are not usable for it.

Environment:
  WHISPER_MODEL                 default model when none is passed (base)
  WHISPER_MODEL_ARABIC          model for Arabic (does not override Darija)
  WHISPER_MODEL_DARIJA          model for Darija only (default "darija-turbo",
                                large-v3-turbo with a Darija adapter; about real
                                time on 4 CPU threads). "darija-finetune" is the
                                small Darija model: 3x faster, far less accurate
  WHISPER_BEAM_SIZE             beam width (default 5 for Arabic and the small
                                Darija model; 1 for large models on the int8 engine)
  WHISPER_CHUNK_SECONDS         longest speech piece sent at once (default 28)
  WHISPER_CHUNK_GAP             longest pause kept inside one piece, in seconds
                                (default 3); a longer one starts a new piece
  WHISPER_VAD_THRESHOLD         speech probability that counts as speech
                                (default 0.25)
  WHISPER_DETECT_EACH           "1" re-detects the language in every piece
                                (slower; for heavily code-switched speech)
  WHISPER_BATCH                 on the int8 CPU engine, pieces decoded together
                                per encoder pass (default 8 for both Darija
                                models, 0 = one at a time for other models)
  WHISPER_DETECT_DARIJA         "0" stops auto-detect from checking whether
                                Arabic speech is Moroccan Darija
  WHISPER_THREADS               CPU threads (default: the CPUs this container may
                                use, up to 8)
  CLIP_MAKER_WHISPER_CPU        "int8" enables faster-whisper on Linux
  CLIP_MAKER_WHISPER_ACCELERATE "0" disables Apple-GPU (MLX and Metal) transcription
  CLIP_MAKER_WHISPER_PROGRESS   "1" prints clip-maker-progress:<0..1> on stderr
  CLIP_MAKER_HOSTED_TEXT        "openai": the text comes from OpenAI and only the
                                word timings are worked out here (see
                                hosted_transcribe.py). The server sets it.
"""

import bisect
import json
import math
import os
from pathlib import Path
import platform
import re
import sys
import tempfile
import zlib

import numpy as np

SAMPLE_RATE = 16000
BLOCK_SECONDS = 30
DARIJA_FINETUNE = "darija-finetune"
# whisper-large-v3-turbo with a Moroccan Darija adapter merged in, built into
# the image by scripts/darija_turbo_int8.py. INT8 (faster-whisper) only.
DARIJA_TURBO = "darija-turbo"
DARIJA_MODELS = (DARIJA_FINETUNE, DARIJA_TURBO)

# A short prompt in the target script keeps Whisper from drifting into Latin
# transliteration or another language on code-switched speech.
PROMPTS = {
    "ar-ma": "واش، ديال، بزاف، دابا، شنو، علاش، مزيان، كيفاش.",
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


def available_cpus() -> int:
    """CPUs this process may use: a container's CPU quota rather than the
    host's core count. Too many threads on two vCPUs is slower than two."""
    try:
        quota, period = Path("/sys/fs/cgroup/cpu.max").read_text().split()[:2]
        if quota != "max":
            return max(1, int(int(quota) / int(period)))
    except (OSError, ValueError):
        pass
    try:
        quota = int(Path("/sys/fs/cgroup/cpu/cpu.cfs_quota_us").read_text())
        period = int(Path("/sys/fs/cgroup/cpu/cpu.cfs_period_us").read_text())
        if quota > 0 and period > 0:
            return max(1, quota // period)
    except (OSError, ValueError):
        pass
    try:
        return len(os.sched_getaffinity(0))
    except AttributeError:
        return os.cpu_count() or 2


def ct2_device() -> tuple[str, str]:
    """Device and number format for the CTranslate2 engine (faster-whisper).
    CTranslate2 has no fast int8 kernels for Apple CPUs: on an M3 the large
    Darija model took 40 s per 30 seconds of audio in int8, 8 s in float32 and
    3 s on the GPU (Metal), with the same text."""
    if sys.platform != "darwin":
        return "cpu", "int8"
    if os.environ.get("CLIP_MAKER_WHISPER_ACCELERATE") != "0":
        try:
            import ctranslate2

            if ctranslate2.get_mps_device_count() > 0:
                return "mps", "float16"
        except Exception:
            pass
    return "cpu", "float32"


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
    # The container sets WHISPER_MODEL_ARABIC=small. It must not override an
    # explicit choice of Darija, which has its own checkpoint and setting.
    # Darija defaults to the large Darija model. Plain large-v3-turbo rewrote
    # Darija as formal Arabic (another wording, not what was said); the small
    # Darija fine-tune is three times faster but garbled real conversation.
    chosen = (os.environ.get("WHISPER_MODEL_DARIJA") or DARIJA_TURBO) if darija else os.environ.get("WHISPER_MODEL_ARABIC")
    if not chosen:
        ram = total_ram_gb()
        if ram >= 7.5:
            chosen = "large-v3-turbo"
        elif ram >= 3.5 and default in {"tiny", "base"}:
            chosen = "small"
        else:
            chosen = default
    if chosen in DARIJA_MODELS and not darija:
        chosen = default
    return chosen


def speech_spans(audio):
    """Speech regions in seconds from Silero VAD, or None when it isn't installed.

    Silero's usual threshold (0.5) misses speech it is unsure of: telephone
    audio, speech under music, heavy compression. On Moroccan radio call-ins
    it kept 8 to 57% of clips that were speech from end to end, and the words
    in the rest were never transcribed. 0.25 keeps them; music and silence
    still fall well below it."""
    try:
        from faster_whisper.vad import VadOptions, get_speech_timestamps
    except Exception:
        return None
    try:
        threshold = float(os.environ.get("WHISPER_VAD_THRESHOLD") or 0.25)
        options = VadOptions(threshold=threshold, min_silence_duration_ms=500, speech_pad_ms=200)
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


def quiet_point(audio, start: float, end: float) -> float:
    """The quietest moment between `start` and `end` (seconds), where a cut is
    least likely to split a word."""
    window, hop = int(0.2 * SAMPLE_RATE), int(0.02 * SAMPLE_RATE)
    segment = audio[int(start * SAMPLE_RATE): int(end * SAMPLE_RATE)]
    if len(segment) <= window:
        return end
    total = np.concatenate([[0.0], np.cumsum(segment.astype(np.float64) ** 2)])
    energy = (total[window:] - total[:-window])[::hop]  # sum over each 0.2-s window
    return start + (int(np.argmin(energy)) * hop + window / 2) / SAMPLE_RATE


def speech_chunks(spans, limit: float = 28.0, gap: float | None = None, audio=None):
    """Packs VAD spans into pieces of at most `limit` seconds.

    Every piece costs one full 30-second encoder pass however short it is, so
    spans are joined across pauses shorter than `gap`. Joining only across
    pauses under 0.6 s left a third of the pieces under 5 seconds: 77 encoder
    passes for 16 minutes of Darija instead of 53, and the extra cuts lost
    words (WER 41.1% against 38.6% packed). A longer pause (music, an intro)
    still starts a new piece, so it is not sent to the model. Speech longer
    than `limit` is cut at its quietest moment near the limit when `audio` is
    given."""
    gap = float(os.environ.get("WHISPER_CHUNK_GAP") or 3.0) if gap is None else gap
    chunks = []
    for start, end in spans:
        while end - start > limit:
            cut = start + limit
            if audio is not None:
                cut = quiet_point(audio, start + limit * 0.75, start + limit)
            chunks.append((start, cut))
            start = cut
        if chunks and end - chunks[-1][0] <= limit and start - chunks[-1][1] < gap:
            chunks[-1] = (chunks[-1][0], end)
        else:
            chunks.append((start, end))
    return chunks


def speech_within(spans, start: float, end: float) -> float:
    """Seconds of VAD speech between `start` and `end`."""
    return sum(max(0.0, min(b, end) - max(a, start)) for a, b in spans or [])


def split_piece(piece, spans, audio, target: float = 10.0):
    """Cuts one piece into parts of about `target` seconds, in its pauses where
    it has them, else at quiet moments."""
    start, end = piece
    inner = [(max(a, start), min(b, end)) for a, b in spans or [] if b > start and a < end]
    parts = speech_chunks(inner or [piece], limit=target, gap=0.6, audio=audio)
    return [p for p in parts if p[1] - p[0] >= 0.3] or [piece]


def compression_ratio(text: str) -> float:
    data = text.encode("utf-8")
    return len(data) / max(1, len(zlib.compress(data)))


class Engine:
    """One loaded model. `run(audio, **options)` returns Whisper's result dict."""

    def __init__(self, model_name: str, accelerate: bool = True):
        import whisper

        self.name = model_name
        self.finetune = model_name == DARIJA_FINETUNE
        self.turbo_darija = model_name == DARIJA_TURBO
        # Either Darija model: trained on Darija without prompts.
        self.darija = self.finetune or self.turbo_darija
        heads_key = "small" if self.finetune else model_name
        self.heads = whisper._ALIGNMENT_HEADS.get(heads_key)
        if self.finetune:
            from darija_whisper import model_path

            self.source = str(model_path())
        elif self.turbo_darija:
            # Built into the image; elsewhere this downloads and builds it once.
            from darija_turbo_int8 import model_path

            self.source = str(model_path())
        else:
            self.source = model_name
        self.mlx_path = None
        self.torch_model = None
        self.int8_model = None
        self.device = "cpu"
        # The large Darija model exists only in the CTranslate2 format, which
        # faster-whisper also runs on a Mac (on its GPU, see ct2_device).
        self.use_int8 = self.turbo_darija or (
            sys.platform == "linux"
            and os.environ.get("CLIP_MAKER_WHISPER_CPU") == "int8"
            and (self.finetune or model_name in whisper._MODELS)
        )
        self.threads = int(os.environ.get("WHISPER_THREADS") or min(8, available_cpus()))
        if accelerate and can_accelerate() and not self.turbo_darija:
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
        if self.use_int8:
            try:
                return self.run_int8(audio, **options)
            except Exception as exc:
                if self.turbo_darija:
                    raise  # There is no PyTorch copy of this model.
                log(f"INT8 transcription failed; retrying with PyTorch: {exc}")
                self.use_int8 = False
                self.int8_model = None
        if self.torch_model is None:
            import torch
            import whisper

            torch.set_num_threads(self.threads)
            self.torch_model = whisper.load_model(self.source, device="cpu")
            if self.heads and self.finetune:
                self.torch_model.set_alignment_heads(self.heads)
        return self.torch_model.transcribe(audio, fp16=False, **options)

    def ct2(self):
        """The model in faster-whisper (CTranslate2), loaded on first use."""
        if self.int8_model is None:
            from faster_whisper import WhisperModel

            source = self.name
            if self.finetune:
                from darija_int8 import model_path
                source = str(model_path())
            elif self.turbo_darija:
                source = self.source
            device, compute = ct2_device()
            try:
                self.int8_model = WhisperModel(source, device=device, compute_type=compute, cpu_threads=self.threads)
            except Exception as exc:
                if device == "cpu":
                    raise
                log(f"whisper: Metal unavailable for {self.name}, using the CPU: {exc}")
                device, compute = "cpu", "float32"
                self.int8_model = WhisperModel(source, device=device, compute_type=compute, cpu_threads=self.threads)
            self.device = device
        return self.int8_model

    def on_cpu_after(self, exc) -> bool:
        """After a failure on the Mac GPU, reloads the model on the CPU. True
        when there is a CPU copy to retry with."""
        if self.device == "cpu":
            return False
        log(f"whisper: Metal transcription failed, retrying on the CPU: {exc}")
        os.environ["CLIP_MAKER_WHISPER_ACCELERATE"] = "0"
        self.int8_model = None
        self.ct2()
        return True

    @staticmethod
    def ct2_options(options: dict) -> dict:
        options = dict(options)
        options.pop("verbose", None)
        if "logprob_threshold" in options:
            options["log_prob_threshold"] = options.pop("logprob_threshold")
        options.setdefault("beam_size", 1)
        return options

    def run_int8(self, audio, **options):
        from dataclasses import asdict

        options = self.ct2_options(options)
        try:
            segments, info = self.ct2().transcribe(audio, **options)
            segments = [asdict(segment) for segment in segments]
        except Exception as exc:
            if not self.on_cpu_after(exc):
                raise
            segments, info = self.ct2().transcribe(audio, **options)
            segments = [asdict(segment) for segment in segments]
        return {
            "language": info.language,
            "text": "".join(segment["text"] for segment in segments),
            "segments": segments,
        }

    def run_batched(self, audio, pieces, batch_size, report=None, **options):
        """All pieces through the CTranslate2 model, `batch_size` windows per
        encoder call. Returns segment dicts with times on the whole recording."""
        try:
            return self._run_batched(audio, pieces, batch_size, report, options)
        except Exception as exc:
            if not self.on_cpu_after(exc):
                raise
            return self._run_batched(audio, pieces, batch_size, report, options)

    def _run_batched(self, audio, pieces, batch_size, report, options):
        from dataclasses import asdict
        from faster_whisper import BatchedInferencePipeline

        pipeline = BatchedInferencePipeline(model=self.ct2())
        segments, _ = pipeline.transcribe(
            audio, batch_size=batch_size, vad_filter=False,
            clip_timestamps=[{"start": a, "end": b} for a, b in pieces], **self.ct2_options(options),
        )
        items = []
        for segment in segments:
            item = asdict(segment)
            if report:
                report(item["end"])
            items.append(item)
        return items


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


# Everyday Moroccan words that other Arabic (formal, Egyptian, Gulf, Levantine)
# rarely uses. Words shared with those, such as كنت, شي or اخويا, are left out.
DARIJA_WORDS = set("""
بزاف واش دابا غادي غادين غادية كاين كاينة كاينين كاينش مكاينش ماكاينش شنو شنوا علاش
مزيان مزيانة مزيانين هادشي هاداك هاديك هادوك كيفاش بغيت بغيتي بغا بغات بغينا بغيتو
صافي والو خاصك خصك خصني خاصني خاصو خصو نتا نتوما حيت عافاك بلاصة زعما واخا
شحال بشحال شكون فوقاش دغيا ديما هنايا تما كاع باش خايب خايبة سيمانة سيمان
كندير كيدير كتدير كنقول كيقول كتقول كنشوف كيشوف كتشوف كنعرف كيعرف كتعرف
""".split())
# Darija forms its future with غ- (غنمشي، غيدير، غتقول). غير and words such
# as غياب or غناء are ordinary Arabic and do not count.
DARIJA_FUTURE = re.compile(r"^غ[نيت][؀-ۿ]{2,}$")
NOT_FUTURE = ("غير", "غيا", "غيب", "غيو", "غيم", "غيث", "غيظ", "غين", "غنا", "غني", "غنم", "غتي")


def darija_hits(text: str) -> int:
    """How many words of `text` only Moroccan Darija would use."""
    hits = 0
    for token in re.findall(r"[؀-ۿ]+", text):
        # و (and), ف (so), ب (with), ل (to) are written onto the next word.
        # The غ- future only follows و or ف: لغتنا is "our language".
        forms = [(token, True)]
        if len(token) > 3 and token[0] in "وفبل":
            forms.append((token[1:], token[0] in "وف"))
        for form, verb in forms:
            if (form in DARIJA_WORDS or form.startswith("ديال")
                    or (verb and DARIJA_FUTURE.match(form) and not form.startswith(NOT_FUTURE))):
                hits += 1
                break
    return hits


def sounds_darija(engine: "Engine", audio, spans) -> bool:
    """Whether Arabic speech is Moroccan Darija. Whisper only reports "Arabic",
    and the general models rewrite Darija as formal Arabic, so this listens to
    up to three 30-second samples with the Darija model and counts words that
    only Darija uses. It stops as soon as it has heard two."""
    duration = len(audio) / SAMPLE_RATE
    starts = [spans[0][0] if spans else 0.0]
    if duration > 90:
        starts += [duration * 0.4, duration * 0.7]
    found, total = 0, 0
    for start in starts:
        window = audio[int(start * SAMPLE_RATE): int((start + 30) * SAMPLE_RATE)]
        if len(window) < SAMPLE_RATE:
            continue
        text = engine.run(window, language="ar", task="transcribe", word_timestamps=False,
                          condition_on_previous_text=False, verbose=None, temperature=0.0).get("text", "")
        found += darija_hits(text)
        total += len(text.split())
        if found >= 2:
            break
    log(f"whisper: {found} Darija words in {total} sampled words")
    return found >= 2


def is_hallucination(segment) -> bool:
    text = segment.get("text", "")
    if ALWAYS_HALLUCINATED.search(text):
        return True
    unsure = segment.get("no_speech_prob", 0) > 0.35 or segment.get("avg_logprob", 0) < -0.9
    if unsure and OFTEN_HALLUCINATED.search(text):
        return True
    return segment.get("no_speech_prob", 0) > 0.8 and segment.get("avg_logprob", 0) < -1.0


def collect_words(result, offset: float, limit: float, words: list, spans=None) -> None:
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
            # Do not turn music or silent gaps into captions. VAD spans are
            # already padded, so a word needs real overlap with one of them.
            if spans is not None and not any(start < b and min(end, limit) > a for a, b in spans):
                first = True
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


def drop_loops(words: list, keep: int = 2) -> list:
    """Removes a phrase the decoder repeated more than `keep` times in a row
    ("لا يوجد صراحة. لا يوجد صراحة. لا يوجد صراحة..."), a known Whisper
    failure on unclear audio. Natural repetition rarely goes past twice."""
    norm = [re.sub(r"[^\w]", "", w["word"]) for w in words]
    out_idx = list(range(len(words)))
    for size in range(8, 0, -1):
        result, i = [], 0
        seq = [norm[k] for k in out_idx]
        while i < len(out_idx):
            phrase = seq[i:i + size]
            if len(phrase) == size and any(phrase):
                runs = 1
                while seq[i + runs * size:i + (runs + 1) * size] == phrase:
                    runs += 1
                if runs > keep:
                    result.extend(out_idx[i:i + keep * size])
                    i += runs * size
                    continue
            result.append(out_idx[i])
            i += 1
        out_idx = result
    return [words[k] for k in out_idx]


def words_by_piece(segments, pieces, spans) -> list[tuple[list, bool]]:
    """Clean timed words of batched segments, grouped by the piece each came from."""
    starts = [a for a, _ in pieces]
    grouped = [[] for _ in pieces]
    for segment in segments:
        middle = (segment["start"] + segment["end"]) / 2
        grouped[min(len(pieces) - 1, max(0, bisect.bisect_right(starts, middle) - 1))].append(segment)
    out = []
    for (start, end), group in zip(pieces, grouped):
        words = []
        collect_words({"segments": group}, 0.0, end, words, spans)
        # Arabic text compresses well: sound 25-second pieces of Darija
        # scored 2.0 to 2.5, so only far above that is a loop.
        looped = any(compression_ratio(s.get("text", "")) > 3.0 for s in group)
        out.append((words, looped))
    return out


def needs_reread(words, looped: bool, speech: float) -> bool:
    """A piece the decoder gave up on: it wrote far fewer words than its
    speech holds, or looped badly. Sound Darija pieces ran at 1.3 to 2.7
    words per second of speech; one that lost its second half after a loop
    had 0.7."""
    kept = len(drop_loops(words))
    return speech >= 6 and (looped or kept / speech < 0.8 or (len(words) - kept >= 3 and kept / speech < 1.2))


def decode_batched(engine, audio, pieces, batch, spans, options, progress=None) -> list:
    """Words of all pieces, decoded `batch` windows at a time.

    Without timestamps the decoder writes a whole piece in one go. When it
    falls into a loop ("يبقوا يبقوا يبقوا ...") the rest of that piece is
    lost: the repeats are removed later, but the speech after them never
    comes back (14 of 19 seconds in one Darija test clip). Such pieces are
    read again in parts of about 10 seconds, and the second reading is kept
    when it has more words."""
    segments = engine.run_batched(audio, pieces, batch, progress, **options)
    results = words_by_piece(segments, pieces, spans)
    suspects = [i for i, ((words, looped), (a, b)) in enumerate(zip(results, pieces))
                if needs_reread(words, looped, speech_within(spans, a, b) if spans else b - a)]
    if suspects:
        parts, owners = [], []
        for i in suspects:
            for part in split_piece(pieces[i], spans, audio):
                parts.append(part)
                owners.append(i)
        log(f"whisper: reading {len(suspects)} of {len(pieces)} pieces again in {len(parts)} shorter parts")
        reread = words_by_piece(engine.run_batched(audio, parts, batch, None, **options), parts, spans)
        replaced = 0
        for i in suspects:
            words = [w for (part_words, _), owner in zip(reread, owners) if owner == i for w in part_words]
            if len(drop_loops(words)) > len(drop_loops(results[i][0])):
                results[i] = (words, False)
                replaced += 1
        log(f"whisper: kept the second reading for {replaced} of them")
    return [w for words, _ in results for w in words]


def transcribe_hosted(audio, spans, locale: str, language: str | None) -> dict:
    """Text from OpenAI, word timings from a small local model (see
    hosted_transcribe.py)."""
    import hosted_transcribe as hosted

    duration = len(audio) / SAMPLE_RATE
    limit = float(os.environ.get("WHISPER_CHUNK_SECONDS") or 28)
    if spans:
        pieces = speech_chunks(spans, limit, audio=audio)
    else:
        points = split_points(duration, spans, limit)
        pieces = list(zip(points, points[1:]))
    aligner = Engine(os.environ.get("WHISPER_ALIGN_MODEL") or "base", accelerate=False)
    aligner.use_int8 = True  # alignment needs the faster-whisper engine
    if language is None:
        language = detect_language(aligner, audio, spans) or "en"
    darija = locale == "ar-ma"
    check = None
    if locale == "auto" and language == "ar" and os.environ.get("WHISPER_DETECT_DARIJA", "1") != "0":
        check = lambda text: darija_hits(text) >= 2  # noqa: E731
    keywords = [k.strip() for k in os.environ.get("CLIP_MAKER_STT_KEYWORDS", "").splitlines() if k.strip()][:20]
    show = os.environ.get("CLIP_MAKER_WHISPER_PROGRESS") == "1"

    def progress(fraction: float) -> None:
        if show:
            log(f"clip-maker-progress:{min(1.0, fraction):.4f}")

    log(f"whisper: text from {hosted.model_name()} in {len(pieces)} pieces, timings from {aligner.name} "
        f"language={language}")
    texts, darija = hosted.hosted_texts(audio, pieces, language if len(language) == 2 else None, darija,
                                        keywords, report=lambda f: progress(0.8 * f), sounds_darija=check)
    segments = hosted.align_segments(aligner.ct2(), audio, pieces, texts, language,
                                     report=lambda f: progress(0.8 + 0.2 * f))
    if spans:
        # Alignment can stretch a word over the pause next to it ("كاين"
        # lasting 1.5 s), which shows its caption early or holds it late.
        # Keep each word inside the speech it overlaps.
        # When it straddles a pause, it belongs with the side it overlaps most.
        starts = [a for a, _ in spans]
        for segment in segments:
            for word in segment["words"]:
                first = max(0, bisect.bisect_right(starts, word["start"]) - 1)
                last = bisect.bisect_left(starts, word["end"])
                near = spans[first:max(first + 1, last)]
                best = max(near, key=lambda s: min(s[1], word["end"]) - max(s[0], word["start"]))
                start, end = max(word["start"], best[0]), min(word["end"], best[1])
                if end - start >= 0.05:
                    word["start"], word["end"] = start, end
    words = []
    collect_words({"segments": segments}, 0.0, duration, words)
    words = drop_loops(words)
    return {"text": " ".join(w["word"] for w in words), "words": words,
            "language": "ar-ma" if darija else language, "model": f"openai:{hosted.model_name()}"}


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
    if os.environ.get("CLIP_MAKER_HOSTED_TEXT") == "openai":
        json.dump(transcribe_hosted(audio, spans, locale, language), sys.stdout, ensure_ascii=False)
        return
    engine = None
    if language is None:
        engine = Engine(pick_model(locale, None, default_model))
        language = detect_language(engine, audio, spans)
        # "Auto-detect" on Moroccan speech: Whisper says only "Arabic", which
        # picked the slow general model and turned Darija into formal Arabic.
        if language == "ar" and locale == "auto" and os.environ.get("WHISPER_DETECT_DARIJA", "1") != "0":
            try:
                darija_engine = Engine(DARIJA_FINETUNE)
                if sounds_darija(darija_engine, audio, spans):
                    locale, engine = "ar-ma", darija_engine
            except Exception as exc:
                log(f"whisper: Darija check failed, keeping Arabic: {exc}")
    model_name = pick_model(locale, language, default_model)
    if engine is None or engine.name != model_name:
        try:
            engine = Engine(model_name)
        except Exception as exc:
            if model_name != DARIJA_TURBO:
                raise
            # The large Darija model could not be built here: keep going
            # with the small one rather than fail the video.
            log(f"whisper: large Darija model unavailable, using the small one: {exc}")
            model_name = DARIJA_FINETUNE
            if engine is None or engine.name != model_name:
                engine = Engine(model_name)
    engine_name = "metal" if engine.mlx_path else ("ctranslate2-" + "-".join(ct2_device())) if engine.use_int8 else "cpu"
    log(f"whisper: model={model_name} language={language or 'auto'} engine={engine_name} threads={engine.threads}")

    options = {
        # Darija frequently switches to English/French within one sentence.
        # Re-detect per short chunk rather than force those passages into
        # Arabic. An explicitly requested monolingual fine-tune stays Arabic.
        # The language is known by now (asked for, or detected once above).
        # Re-detecting it in every piece ran the model twice per piece; only
        # WHISPER_DETECT_EACH=1 does that, for heavily code-switched speech.
        "language": None if os.environ.get("WHISPER_DETECT_EACH") == "1" and locale in {"auto", "ar-ma"} and not engine.darija else language,
        "task": "transcribe",
        # Feeding earlier text back in is what turns one mistake into a loop.
        "condition_on_previous_text": False,
        "word_timestamps": True,
        "verbose": None,
        "compression_ratio_threshold": 2.2,
        "no_speech_threshold": 0.6,
        # Retry a window only when the text loops (compression ratio), never
        # for low confidence. Dialects such as Darija always score low, so
        # the confidence rule re-decoded nearly every window up to six times
        # and made a 30-minute video take longer than it lasts.
        "logprob_threshold": None,
        # Sampling retries can invent fluent dialogue over unclear audio.
        "temperature": 0.0,
    }
    if not engine.darija:
        prompt = PROMPTS.get(locale) or PROMPTS.get(language or "")
        if prompt:
            options["initial_prompt"] = prompt
    # On the server's CPU engine a 5-wide beam cost several times the time of
    # greedy decoding for little gain with large-v3-turbo; GPU/Metal runs keep
    # the wider beam for Arabic. The small Darija fine-tune keeps it everywhere:
    # it got noticeably more words right for about a third more time. The
    # large Darija model gave nearly the same text with beam 1, 17% faster.
    beam = os.environ.get("WHISPER_BEAM_SIZE") or (
        "5" if engine.finetune else "1" if engine.use_int8 else "5" if language == "ar" else "")
    if beam.isdigit() and int(beam) > 1:
        options["beam_size"] = int(beam)

    if spans:
        # Apply speech gating to every model, not just the Darija checkpoint.
        # Every piece is padded to Whisper's 30-second window, so a 12-second
        # piece costs as much as a full one. Fill each window instead.
        pieces = speech_chunks(spans, float(os.environ.get("WHISPER_CHUNK_SECONDS") or 28), audio=audio)
    else:
        points = split_points(duration, spans, BLOCK_SECONDS)
        pieces = list(zip(points, points[1:]))

    words, texts = [], []
    report = os.environ.get("CLIP_MAKER_WHISPER_PROGRESS") == "1"
    # The Darija models batch by default: on 4 CPU threads, 5 minutes of
    # Darija took the small model 102 s batched against 176 s one piece at a
    # time, with the same beam.
    batch = int(os.environ.get("WHISPER_BATCH") or (8 if engine.darija else 0))
    if engine.use_int8 and batch > 1 and pieces:
        # Batched: one encoder pass for several pieces. Same model and
        # settings; the windows go through together instead of one by one.
        progress = (lambda t: log(f"clip-maker-progress:{min(1.0, t / duration):.4f}")) if report else None
        words = decode_batched(engine, audio, pieces, batch, spans, options, progress)
        texts.append(" ".join(w["word"] for w in words))
        pieces = []
    for start, end in pieces:
        chunk = audio[int(start * SAMPLE_RATE): int(end * SAMPLE_RATE)]
        if len(chunk) >= SAMPLE_RATE // 5:
            result = engine.run(chunk, **options)
            before = len(words)
            collect_words(result, start, end, words, spans)
            if len(words) > before:
                texts.append(" ".join(w["word"] for w in words[before:]))
        if report:
            log(f"clip-maker-progress:{end / duration:.4f}")

    cleaned = drop_loops(words)
    if len(cleaned) < len(words):
        log(f"whisper: dropped {len(words) - len(cleaned)} repeated words")
        words = cleaned
        texts = [" ".join(w["word"] for w in words)]
    # "ar-ma" when the speech is Darija, so titles and later captions follow it.
    json.dump({"text": " ".join(texts).strip(), "words": words,
               "language": "ar-ma" if locale == "ar-ma" else language, "model": model_name},
              sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        status = getattr(exc, "status", None)
        if type(exc).__name__ == "HostedError":
            # The server falls back to local transcription on exit code 3.
            print(f"clip-maker-hosted-error:{status or 0}", file=sys.stderr)
            print(f"{exc}", file=sys.stderr)
            sys.exit(3)
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
