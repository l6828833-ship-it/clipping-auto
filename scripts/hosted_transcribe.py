"""Hosted transcription text with local word timings.

OpenAI's current transcription model (gpt-transcribe) writes better text than
local Whisper, Moroccan Darija included, in seconds, but it gives no word
timings, and captions need a start and an end for every word. So each speech
piece (at most 28 seconds, cut in pauses) is sent on its own, and the words it
comes back with are placed on the audio by a small local Whisper model
(forced alignment: the model reads the given text against the sound instead of
guessing the text). Placing known text is cheap: one encoder pass per piece
with Whisper "base", against a full decode with the large model. On Darija
clips, "base" put words within 0.02 s (median) of where the large Darija model
put the same words.

Used by whisper_words.py when the server sets CLIP_MAKER_HOSTED_TEXT=openai
(it does that only with CLIP_MAKER_TRANSCRIBE=openai and OPENAI_API_KEY).

Environment:
  OPENAI_API_KEY                 the API key
  OPENAI_BASE_URL                optional, a compatible endpoint or a test stand-in
  OPENAI_TRANSCRIBE_MODEL        default "gpt-transcribe"
  OPENAI_TRANSCRIBE_PARALLEL     requests in flight (default 6)
  WHISPER_ALIGN_MODEL            the model that places the words (default "base")
  CLIP_MAKER_STT_KEYWORDS        names and terms to spell right, one per line
                                 (the server passes the video's title)
"""

from concurrent.futures import ThreadPoolExecutor
import io
import json
import os
import random
import re
import time
import urllib.error
import urllib.request
import uuid
import wave

import numpy as np

SAMPLE_RATE = 16000
# A few everyday Darija words in Arabic script. The model reads the prompt as
# earlier speech, which keeps it writing Darija as Darija instead of turning
# it into Modern Standard Arabic.
DARIJA_PROMPT = "واش، بزاف، ديال، هادشي، دابا، غادي، كاين، شنو، علاش، مزيان، بغيت، كيفاش، صافي، ماشي."
# Statuses that will not get better by asking again: bad key, no credit,
# unknown model, a request the API refuses.
FATAL = {400, 401, 402, 403, 404, 413, 415, 422}


class HostedError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def model_name() -> str:
    return os.environ.get("OPENAI_TRANSCRIBE_MODEL", "").strip() or "gpt-transcribe"


def wav_bytes(samples: np.ndarray) -> bytes:
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(SAMPLE_RATE)
        out.writeframes(pcm.tobytes())
    return buffer.getvalue()


def multipart(fields: list[tuple[str, str]], audio: bytes) -> tuple[bytes, str]:
    boundary = f"clip-maker-{uuid.uuid4().hex}"
    body = io.BytesIO()
    for name, value in fields:
        body.write(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        body.write(value.encode("utf-8"))
        body.write(b"\r\n")
    body.write(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\n'
               "Content-Type: audio/wav\r\n\r\n".encode())
    body.write(audio)
    body.write(f"\r\n--{boundary}--\r\n".encode())
    return body.getvalue(), f"multipart/form-data; boundary={boundary}"


def request_fields(language: str | None, darija: bool, keywords: list[str]) -> list[tuple[str, str]]:
    model = model_name()
    fields = [("model", model), ("response_format", "json"), ("temperature", "0")]
    # gpt-transcribe takes a list of possible languages and keywords; the
    # older models take one language and no keywords.
    current = model.startswith("gpt-transcribe")
    if language:
        fields.append(("languages[]", language) if current else ("language", language))
    if current:
        # The API refuses the whole request over a "<", ">" or line break in a keyword.
        fields += [("keywords[]", k) for k in (re.sub(r"[<>\s]+", " ", k).strip() for k in keywords) if k]
    if darija:
        fields.append(("prompt", DARIJA_PROMPT))
    return fields


def transcribe_piece(audio: bytes, fields, attempts: int = 4) -> str:
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not key:
        raise HostedError("OPENAI_API_KEY is not set.")
    base = (os.environ.get("OPENAI_BASE_URL", "").strip() or "https://api.openai.com/v1").rstrip("/")
    body, content_type = multipart(fields, audio)
    for attempt in range(attempts):
        request = urllib.request.Request(f"{base}/audio/transcriptions", data=body, method="POST", headers={
            "Authorization": f"Bearer {key}", "Content-Type": content_type,
        })
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return str(json.loads(response.read()).get("text") or "").strip()
        except urllib.error.HTTPError as error:
            # OpenAI quotes part of a wrong key back; keep it out of the logs.
            detail = re.sub(r"sk-[\w*-]+", "sk-…", error.read()[:300].decode("utf-8", "replace"))
            # "insufficient_quota" also arrives as 429; waiting does not help.
            if error.code in FATAL or (error.code == 429 and "quota" in detail):
                raise HostedError(f"OpenAI transcription {error.code}: {detail}", error.code) from None
            if attempt == attempts - 1:
                raise HostedError(f"OpenAI transcription {error.code}: {detail}", error.code) from None
            try:
                wait = float(error.headers.get("retry-after") or 0)
            except ValueError:  # an HTTP date instead of seconds
                wait = 0
            time.sleep(min(wait or 2 ** attempt + random.random(), 30))
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            if attempt == attempts - 1:
                raise HostedError(f"OpenAI transcription unreachable: {error}") from None
            time.sleep(2 ** attempt + random.random())
    raise HostedError("OpenAI transcription failed.")


def hosted_texts(audio, pieces, language, darija, keywords, report=None, sounds_darija=None):
    """Text for every piece, in order. With `sounds_darija` (auto-detect on
    Arabic), the first wave goes without the Darija prompt and the rest get it
    when that text reads as Darija. Returns (texts, darija)."""
    parallel = max(1, int(os.environ.get("OPENAI_TRANSCRIBE_PARALLEL") or 6))
    # Each piece's WAV is made when it is sent: an hour of audio is 115 MB of them.
    clip = lambda i: wav_bytes(audio[int(pieces[i][0] * SAMPLE_RATE): int(pieces[i][1] * SAMPLE_RATE)])  # noqa: E731
    texts: list[str | None] = [None] * len(pieces)
    done = 0
    with ThreadPoolExecutor(max_workers=parallel) as pool:
        start = 0
        if sounds_darija is not None and not darija:
            first = list(range(min(parallel, len(pieces))))
            fields = request_fields(language, False, keywords)
            for i, text in zip(first, pool.map(lambda i: transcribe_piece(clip(i), fields), first)):
                texts[i] = text
            done = len(first)
            if report:
                report(done / len(pieces))
            darija = sounds_darija(" ".join(t for t in texts if t))
            start = len(first)
        fields = request_fields(language, darija, keywords)
        rest = list(range(start, len(pieces)))
        futures = {i: pool.submit(lambda i: transcribe_piece(clip(i), fields), i) for i in rest}
        try:
            for i in rest:
                texts[i] = futures[i].result()
                done += 1
                if report:
                    report(done / len(pieces))
        except BaseException:
            # One refusal (a bad key, no credit) answers for all: do not send the rest.
            pool.shutdown(wait=False, cancel_futures=True)
            raise
    return texts, darija


PREPEND = "\"'“¿([{-"
APPEND = "\"'.。,，!！?？:：”)]}、،؛؟"


def align_segments(model, audio, pieces, texts, language: str, batch: int = 8, report=None):
    """Whisper-style segments (one per piece, words timed on the whole
    recording) for text that is already known."""
    from faster_whisper.tokenizer import Tokenizer
    from faster_whisper.transcribe import merge_punctuations

    tokenizer = Tokenizer(model.hf_tokenizer, model.model.is_multilingual, task="transcribe", language=language)
    frames = model.feature_extractor.nb_max_frames
    # Room for the start-of-transcript tokens within Whisper's 448.
    max_tokens = model.max_length - len(tokenizer.sot_sequence) - 8
    jobs = [i for i, text in enumerate(texts) if text and text.strip()]
    segments = []
    for group_start in range(0, len(jobs), batch):
        group = jobs[group_start: group_start + batch]
        features, tokens, sizes = [], [], []
        for i in group:
            a, b = pieces[i]
            chunk = audio[int(a * SAMPLE_RATE): int(b * SAMPLE_RATE)]
            mel = model.feature_extractor(chunk)[..., :-1][:, :frames]
            features.append(np.pad(mel, ((0, 0), (0, frames - mel.shape[-1]))))
            tokens.append(tokenizer.encode(" " + re.sub(r"\s+", " ", texts[i]).strip())[:max_tokens])
            sizes.append(min(frames, mel.shape[-1]))
        encoder_output = model.encode(np.stack(features))
        alignments = model.find_alignment(tokenizer, tokens, encoder_output, sizes)
        for i, alignment in zip(group, alignments):
            merge_punctuations(alignment, PREPEND, APPEND)
            a, b = pieces[i]
            words = [
                {"word": w["word"], "start": a + float(w["start"]), "end": a + float(w["end"]),
                 "probability": float(w["probability"])}
                for w in alignment if w["word"].strip()
            ]
            # Text the alignment could not place (cut past the token limit)
            # has no timing, so it is left out rather than guessed.
            segments.append({"start": a, "end": b, "text": texts[i], "words": words,
                             "no_speech_prob": 0.0, "avg_logprob": 0.0})
        if report:
            report(min(1.0, (group_start + len(group)) / len(jobs)))
    segments.sort(key=lambda s: s["start"])
    return segments
