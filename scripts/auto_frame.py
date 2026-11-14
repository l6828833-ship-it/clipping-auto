#!/usr/bin/env python3
"""Choose 9:16 framing for a clip by following the speaker's face.

usage: auto_frame.py <video> <start> <duration> <src-width> <src-height>

Samples the clip a few times a second, finds faces, splits the clip at camera
cuts, and prints JSON framing segments (clip-relative seconds, the same shape
the editor's timeline stores):

  {"segments": [{"start", "end", "zoom", "offsetX", "offsetY", "to"?, "ease"?}],
   "faceCoverage": 0..1, "shots": n}

A shot where the subject holds still gets one fixed crop. A shot where the
subject moves gets a chain of short panning pieces that follow them. A shot
with no face keeps the centre crop.

Needs numpy and onnxruntime, and ffmpeg (CLIP_MAKER_FFMPEG or PATH).
"""

import json
import os
from pathlib import Path
import subprocess
import sys

import numpy as np

SAMPLE_FPS = 4
NET_W, NET_H = 320, 240
MODEL = Path(__file__).resolve().parent.parent / "assets" / "models" / "face-rfb-320.onnx"
SCORE_MIN = 0.75
CUT_DIFF = 26.0        # mean absolute luma change (0-255) that marks a camera cut
PAN_SPEED = 0.3        # fastest camera glide, in source widths per second
MIN_GLIDE = 0.7        # seconds; shorter moves read as a jolt
MIN_SHOT = 0.75


def read_frames(video, start, duration, width, height):
    """Yields RGB frames scaled to fit the detector's input, without distortion."""
    scale = min(NET_W / width, NET_H / height)
    w = max(2, int(round(width * scale / 2)) * 2)
    h = max(2, int(round(height * scale / 2)) * 2)
    w, h = min(w, NET_W), min(h, NET_H)
    ffmpeg = os.environ.get("CLIP_MAKER_FFMPEG") or "ffmpeg"
    process = subprocess.Popen(
        [ffmpeg, "-v", "error", "-ss", f"{start:.3f}", "-i", video, "-t", f"{duration:.3f}", "-an",
         "-vf", f"fps={SAMPLE_FPS},scale={w}:{h}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    size = w * h * 3
    try:
        while True:
            raw = process.stdout.read(size)
            if len(raw) < size:
                break
            yield np.frombuffer(raw, np.uint8).reshape(h, w, 3)
    finally:
        process.stdout.close()
        error = process.stderr.read().decode("utf-8", "replace").strip()
        if process.wait() != 0 and error:
            raise RuntimeError(error[-300:])


def nms(boxes, scores, limit=0.3):
    keep = []
    order = np.argsort(-scores)
    while order.size:
        i = order[0]
        keep.append(i)
        rest = order[1:]
        x1 = np.maximum(boxes[i, 0], boxes[rest, 0])
        y1 = np.maximum(boxes[i, 1], boxes[rest, 1])
        x2 = np.minimum(boxes[i, 2], boxes[rest, 2])
        y2 = np.minimum(boxes[i, 3], boxes[rest, 3])
        inter = np.clip(x2 - x1, 0, None) * np.clip(y2 - y1, 0, None)
        area = lambda b: (b[..., 2] - b[..., 0]) * (b[..., 3] - b[..., 1])
        iou = inter / (area(boxes[i]) + area(boxes[rest]) - inter + 1e-9)
        order = rest[iou <= limit]
    return keep


def detect(session, frame):
    """Faces as (centre-x, centre-y, area), all as fractions of the frame."""
    h, w, _ = frame.shape
    canvas = np.zeros((NET_H, NET_W, 3), np.float32)
    canvas[:h, :w] = frame
    blob = ((canvas - 127.0) / 128.0).transpose(2, 0, 1)[None]
    scores, boxes = session.run(None, {session.get_inputs()[0].name: blob})
    scores, boxes = scores[0][:, 1], boxes[0]
    mask = scores > SCORE_MIN
    if not mask.any():
        return []
    scores, boxes = scores[mask], boxes[mask]
    faces = []
    for i in nms(boxes, scores):
        x1, y1, x2, y2 = boxes[i] * [NET_W / w, NET_H / h, NET_W / w, NET_H / h]
        if x2 <= x1 or y2 <= y1:
            continue
        faces.append(((x1 + x2) / 2, (y1 + y2) / 2, (x2 - x1) * (y2 - y1) * float(scores[i])))
    return faces


def main_face(faces, previous):
    """The subject: the largest face, but stay on the one already being
    followed while it is still comparable in size, so two people in frame do
    not make the crop flip back and forth."""
    if not faces:
        return None
    largest = max(faces, key=lambda f: f[2])
    if previous is not None:
        near = min(faces, key=lambda f: abs(f[0] - previous))
        if abs(near[0] - previous) < 0.12 and near[2] >= 0.45 * largest[2]:
            return near
    return largest


def smooth(values, radius=2):
    out = []
    for i in range(len(values)):
        window = [v for v in values[max(0, i - radius): i + radius + 1] if v is not None]
        out.append(float(np.median(window)) if window else None)
    return out


def fill(values):
    """Carries the nearest known position across frames with no detection."""
    known = [i for i, v in enumerate(values) if v is not None]
    if not known:
        return None
    return [values[min(known, key=lambda k: abs(k - i))] for i in range(len(values))]


def calm(pieces):
    """Turns stop-start camera bursts into single smooth moves.

    Same-direction glides separated by a hold shorter than a second become
    one glide, a quick move out and back is dropped, and a
    glide too quick to read as a camera move borrows time from the hold next
    to it."""
    length = lambda p: p["end"] - p["start"]
    merged = []
    for piece in pieces:
        bursts = ("to" in piece and len(merged) >= 2 and "to" in merged[-2]
                  and "to" not in merged[-1] and length(merged[-1]) < 1.0)
        if bursts:
            first = merged[-2]
            delta = lambda p: p["to"]["offsetX"] - p["offsetX"]
            if delta(first) * delta(piece) > 0:
                # Same direction: one continuous move.
                merged.pop()
                first["end"], first["to"] = piece["end"], piece["to"]
                continue
            if abs(piece["to"]["offsetX"] - first["offsetX"]) < 0.1:
                # There and straight back: the subject only swayed. Stay put.
                merged.pop()
                first["end"] = piece["end"]
                del first["to"]
                continue
        merged.append(dict(piece))
    # Dropping a sway can leave two holds side by side at the same framing.
    joined = []
    for piece in merged:
        last = joined[-1] if joined else None
        if last and "to" not in last and "to" not in piece and abs(last["offsetX"] - piece["offsetX"]) < 1e-6:
            last["end"] = piece["end"]
        else:
            joined.append(piece)
    merged = joined
    for k, piece in enumerate(merged):
        if "to" not in piece:
            continue
        piece["ease"] = "inOut"
        need = MIN_GLIDE - length(piece)
        if need <= 0:
            continue
        after = merged[k + 1] if k + 1 < len(merged) else None
        before = merged[k - 1] if k > 0 else None
        if after and "to" not in after and length(after) >= need + 0.3:
            piece["end"] = after["start"] = round(piece["end"] + need, 2)
        elif before and "to" not in before and length(before) >= need + 0.3:
            piece["start"] = before["end"] = round(piece["start"] - need, 2)
    return merged


def main():
    if len(sys.argv) < 6:
        raise ValueError("usage: auto_frame.py <video> <start> <duration> <src-width> <src-height>")
    video = sys.argv[1]
    start, duration = float(sys.argv[2]), float(sys.argv[3])
    width, height = int(float(sys.argv[4])), int(float(sys.argv[5]))
    if not os.path.isfile(video):
        raise FileNotFoundError(video)
    if width <= 0 or height <= 0 or duration <= 0:
        raise ValueError("width, height and duration must be positive")

    # Fraction of the source width a 9:16 crop keeps. 1 or more means the
    # source is already as narrow as the output, so there is nothing to pan.
    kept = (9 / 16) / (width / height)
    if kept >= 0.98:
        json.dump({"segments": [], "faceCoverage": 0, "shots": 0, "reason": "source is already vertical"}, sys.stdout)
        return

    import onnxruntime as ort

    options = ort.SessionOptions()
    options.log_severity_level = 3
    options.intra_op_num_threads = int(os.environ.get("AUTO_FRAME_THREADS", "2"))
    session = ort.InferenceSession(str(MODEL), options, providers=["CPUExecutionProvider"])

    centres, cuts = [], [0]
    previous_luma, previous_x = None, None
    for index, frame in enumerate(read_frames(video, start, duration, width, height)):
        luma = frame.mean(axis=2)
        if previous_luma is not None and float(np.abs(luma - previous_luma).mean()) > CUT_DIFF:
            cuts.append(index)
            previous_x = None
        previous_luma = luma
        face = main_face(detect(session, frame), previous_x)
        previous_x = face[0] if face else previous_x
        centres.append(face[0] if face else None)
    total = len(centres)
    if total == 0:
        raise RuntimeError("no frames could be read from the clip")

    def to_offset(x):
        return round(max(-1.0, min(1.0, (x - 0.5) / ((1 - kept) / 2))), 3)

    # Shots, with very short ones folded into the one before.
    bounds = []
    for a, b in zip(cuts, cuts[1:] + [total]):
        if bounds and (b - a) / SAMPLE_FPS < MIN_SHOT:
            bounds[-1] = (bounds[-1][0], b)
        else:
            bounds.append((a, b))

    def t(index):
        return round(min(duration, index / SAMPLE_FPS), 2)

    segments = []
    for a, b in bounds:
        seen = [c for c in centres[a:b] if c is not None]
        base = {"start": t(a), "end": duration if b == total else t(b), "zoom": 1, "offsetY": 0}
        if base["end"] - base["start"] < 0.05:
            continue
        path = fill(smooth(centres[a:b])) if len(seen) >= max(2, 0.25 * (b - a)) else None
        if path is None:
            segments.append({**base, "offsetX": 0})
            continue
        # A virtual camera with a dead zone: it holds still while the subject
        # stays near the middle of the crop and glides to re-centre only when
        # they leave it. Following every small movement looks restless.
        tolerance = 0.22 * kept
        speed = PAN_SPEED / SAMPLE_FPS
        camera, position, moving = [], path[0], False
        for x in path:
            if not moving and abs(x - position) > tolerance:
                moving = True
            if moving:
                position += max(-speed, min(speed, x - position))
                moving = abs(x - position) > tolerance * 0.25
            camera.append(position)
        camera.append(camera[-1])
        # Runs of "holding" and "gliding" become fixed and panning pieces.
        pieces, i = [], 0
        while i < len(path):
            gliding = abs(camera[i + 1] - camera[i]) > 1e-6
            j = i + 1
            while j < len(path) and (abs(camera[j + 1] - camera[j]) > 1e-6) == gliding:
                j += 1
            piece = {"start": t(a + i), "end": duration if a + j == total else t(a + j),
                     "zoom": 1, "offsetY": 0, "offsetX": to_offset(camera[i])}
            if gliding:
                piece["to"] = {"zoom": 1, "offsetX": to_offset(camera[j]), "offsetY": 0}
            if piece["end"] - piece["start"] >= 0.05:
                pieces.append(piece)
            i = j
        segments.extend(calm(pieces))

    coverage = sum(c is not None for c in centres) / total
    json.dump({"segments": segments, "faceCoverage": round(coverage, 3), "shots": len(bounds)}, sys.stdout)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
