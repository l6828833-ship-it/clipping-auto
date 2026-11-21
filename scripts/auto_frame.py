#!/usr/bin/env python3
"""Choose 9:16 framing for a clip by following the speaker's face.

usage: auto_frame.py <video> <start> <duration> <src-width> <src-height> [people|dual]

With "people" as the last argument it prints {"people": [...]} instead: one
entry per person's face position, for the split-screen layouts.

With "dual" it prints the usual framing segments, except that a camera shot
with two people in it becomes one segment carrying "dual": the two face
positions, left person first. The renderer stacks those two; shots with one
person keep the normal full-height framing.

Samples the clip a few times a second, finds faces, splits the clip at camera
cuts, and prints JSON framing segments (clip-relative seconds, the same shape
the editor's timeline stores):

  {"segments": [{"start", "end", "zoom", "offsetX", "offsetY", "to"?, "ease"?}],
   "faceCoverage": 0..1, "shots": n}

When two people share a shot, the automatic crop widens to include both.

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
DETAIL = 2             # frames are read this many times larger than the detector needs,
                       # so a small face still has enough pixels to see its mouth move
SPEAK_MIN = 1.2        # mouth movement (luma units) below this is not speech
SPEAK_LEAD = 1.35      # how much more a second person must move to take the shot
SPEAK_CONFIRM = 1.0    # seconds they must keep that lead
SPEAK_HOLD = 2.0       # shortest time on one person


def read_frames(video, start, duration, width, height, detail=1, crop=None):
    """Yields RGB frames scaled to fit the detector's input, without distortion.
    With `detail` above 1 the frames are that many times larger; take every
    `detail`-th pixel for the detector. `crop` (w, h, x, y in source pixels)
    reads only that region; `width` and `height` are then its size."""
    scale = min(NET_W / width, NET_H / height)
    w = max(2, int(round(width * scale / 2)) * 2)
    h = max(2, int(round(height * scale / 2)) * 2)
    w, h = min(w, NET_W) * detail, min(h, NET_H) * detail
    ffmpeg = os.environ.get("CLIP_MAKER_FFMPEG") or "ffmpeg"
    region = f"crop={crop[0]}:{crop[1]}:{crop[2]}:{crop[3]}," if crop else ""
    process = subprocess.Popen(
        [ffmpeg, "-v", "error", "-ss", f"{start:.3f}", "-i", video, "-t", f"{duration:.3f}", "-an",
         "-vf", f"fps={SAMPLE_FPS},{region}scale={w}:{h}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
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
    """Faces as (centre-x, centre-y, weighted area, width, height), all as
    fractions of the frame."""
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
        faces.append(((x1 + x2) / 2, (y1 + y2) / 2, (x2 - x1) * (y2 - y1) * float(scores[i]), x2 - x1, y2 - y1))
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


def mouth_motion(luma, previous, face):
    """How much the mouth moved since the last frame, beyond the movement of
    the face as a whole (a nod or a camera shake moves both)."""
    if previous is None:
        return 0.0
    h, w = luma.shape
    cx, cy, _, fw, fh = face
    x1, x2 = int((cx - fw * 0.3) * w), int((cx + fw * 0.3) * w)
    top, middle, bottom = int((cy - fh * 0.4) * h), int((cy + fh * 0.1) * h), int((cy + fh * 0.5) * h)
    x1, x2 = max(0, x1), min(w, x2)
    top, bottom = max(0, top), min(h, bottom)
    if x2 - x1 < 3 or middle - top < 2 or bottom - middle < 2:
        return 0.0
    change = np.abs(luma - previous)
    return max(0.0, float(change[middle:bottom, x1:x2].mean()) - float(change[top:middle, x1:x2].mean()))


def group_faces(frames):
    """Sorts the faces of one shot into people by horizontal position.
    Each person is {"x": [...], "area": [...], "at": {frame index: face}}."""
    groups = []
    for index, faces in enumerate(frames):
        for face in faces:
            group = next((g for g in groups if abs(float(np.median(g["x"])) - face[0]) < 0.12), None)
            if group is None:
                group = {"x": [], "at": {}, "area": []}
                groups.append(group)
            if index not in group["at"]:
                group["x"].append(face[0])
                group["area"].append(face[2])
                group["at"][index] = face
    return groups


def two_people(frames):
    """The two people a shot is about, left one first, as face boxes
    {"cx", "cy", "w", "h"} (fractions of the frame). None unless two people
    are on screen for a good part of the shot."""
    count = len(frames)
    # People are told apart by where their face is in both directions. By
    # sideways position alone, a false hit below a face (a hand, a microphone)
    # joins that person and drags the box down off the face.
    groups = []
    for index, faces in enumerate(frames):
        for face in faces:
            group = next((g for g in groups
                          if abs(float(np.median(g["x"])) - face[0]) < 0.12
                          and abs(float(np.median(g["y"])) - face[1]) < 0.14), None)
            if group is None:
                group = {"x": [], "y": [], "area": [], "at": {}}
                groups.append(group)
            if index not in group["at"]:
                group["x"].append(face[0])
                group["y"].append(face[1])
                group["area"].append(face[2])
                group["at"][index] = face
    present = [g for g in groups if len(g["at"]) >= max(3, 0.4 * count)]
    # Two "faces" one above the other are one person and something that only
    # looks like a face. Keep the upper one, unless the lower is seen far more.
    people = []
    for group in sorted(present, key=lambda g: float(np.median(g["y"]))):
        above = next((p for p in people if abs(float(np.median(p["x"])) - float(np.median(group["x"]))) < 0.12), None)
        if above is None:
            people.append(group)
        elif len(group["at"]) >= 3 * len(above["at"]):
            people[people.index(above)] = group
    if len(people) < 2:
        return None
    biggest = max(float(np.median(g["area"])) for g in people)
    # A small face far behind is audience, not the second speaker.
    people = [g for g in people if float(np.median(g["area"])) >= 0.25 * biggest]
    if len(people) < 2:
        return None
    pair = sorted(people, key=lambda g: (-len(g["at"]), -float(np.median(g["area"]))))[:2]
    boxes = []
    for group in pair:
        faces = list(group["at"].values())
        boxes.append({key: round(float(np.median([f[i] for f in faces])), 4)
                      for key, i in (("cx", 0), ("cy", 1), ("w", 3), ("h", 4))})
    return sorted(boxes, key=lambda person: person["cx"])


def keep_pair_in_frame(pair, kept):
    """Use one wider crop when both people can share it."""
    if kept >= 0.98:
        return {"offsetX": 0, "zoom": 1}
    left = max(0.0, min(face["cx"] - face["w"] for face in pair))
    right = min(1.0, max(face["cx"] + face["w"] for face in pair))
    width = max(kept, right - left)
    zoom = kept / width
    if zoom <= 0.5 or width >= 0.998:
        return {"offsetX": 0, "zoom": 0.5}
    centre = max(width / 2, min(1 - width / 2, (left + right) / 2))
    return {"offsetX": round((centre - 0.5) / ((1 - width) / 2), 3), "zoom": round(zoom, 4)}


def follow_speaker(frames, kept):
    """For one shot, picks who the crop follows in each frame.

    `frames` is a list of face lists, each face (cx, cy, area, w, h, motion).
    Returns (centres, switches): the followed face's centre-x per frame (None
    where it was not found) and the frame indexes where the crop should cut to
    another person. One person, or people close enough to share a crop, gives
    the plain "largest face" behaviour and no switches."""
    count = len(frames)
    groups = group_faces(frames)
    present = [g for g in groups if len(g["at"]) >= max(3, 0.3 * count)]
    if present:
        biggest = max(float(np.median(g["area"])) for g in present)
        # A face far in the background is audience, not a second speaker.
        present = [g for g in present if float(np.median(g["area"])) >= 0.25 * biggest]
    spread = max((float(np.median(g["x"])) for g in present), default=0) - min((float(np.median(g["x"])) for g in present), default=0)
    if len(present) < 2 or spread < 0.55 * kept:
        centres, previous = [], None
        for faces in frames:
            face = main_face(faces, previous)
            previous = face[0] if face else previous
            centres.append(face[0] if face else None)
        return centres, []

    radius = max(1, int(round(0.75 * SAMPLE_FPS)))
    scores = []
    for group in present:
        raw = [group["at"][i][5] if i in group["at"] else 0.0 for i in range(count)]
        scores.append([float(np.mean(raw[max(0, i - radius): i + radius + 1])) for i in range(count)])
    opening = min(count, int(2 * SAMPLE_FPS))
    active = max(range(len(present)), key=lambda p: (sum(scores[p][:opening]), float(np.median(present[p]["area"]))))
    chosen, switches, lead, last = [], [], 0, 0
    confirm, hold = int(round(SPEAK_CONFIRM * SAMPLE_FPS)), int(round(SPEAK_HOLD * SAMPLE_FPS))
    for i in range(count):
        rival = max(range(len(present)), key=lambda p: scores[p][i])
        ahead = rival != active and scores[rival][i] > SPEAK_MIN and scores[rival][i] > SPEAK_LEAD * scores[active][i]
        lead = lead + 1 if ahead else 0
        chosen.append(active)
        if lead >= confirm and i - last >= hold:
            # Cut back to where they started talking, not where it was confirmed.
            begin = max(last + hold, i - lead + 1)
            for k in range(begin, i + 1):
                chosen[k] = rival
            switches.append(begin)
            active, last, lead = rival, begin, 0
    centres = [present[p]["at"][i][0] if i in present[p]["at"] else None for i, p in enumerate(chosen)]
    return centres, switches


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


def load_detector():
    import onnxruntime as ort

    options = ort.SessionOptions()
    options.log_severity_level = 3
    options.intra_op_num_threads = int(os.environ.get("AUTO_FRAME_THREADS", "2"))
    return ort.InferenceSession(str(MODEL), options, providers=["CPUExecutionProvider"])


def people(video, start, duration, width, height, stationary=False):
    """Where each person's face sits across the clip, for split-screen
    layouts. Faces are grouped by horizontal position; each group is one
    person: {"cx", "cy", "w", "h"} as fractions of the frame, plus "share",
    the fraction of sampled frames they appear in. Most present first."""
    session = load_detector()
    groups, total = [], 0
    for frame in read_frames(video, start, duration, width, height):
        total += 1
        seen = set()
        for face in detect(session, frame):
            tolerance = 0.075 if stationary else 0.12
            match = next((g for g in groups if abs(float(np.median(g["cx"])) - face[0]) < tolerance
                          and (not stationary or abs(float(np.median(g["cy"])) - face[1]) < tolerance)), None)
            if match is None:
                match = {"cx": [], "cy": [], "w": [], "h": [], "frames": 0}
                groups.append(match)
            for key, value in zip(("cx", "cy", "w", "h"), (face[0], face[1], face[3], face[4])):
                match[key].append(float(value))
            if id(match) not in seen:
                seen.add(id(match))
                match["frames"] += 1
    if total == 0:
        raise RuntimeError("no frames could be read from the clip")
    result = [{**{k: round(float(np.median(g[k])), 4) for k in ("cx", "cy", "w", "h")}, "share": round(g["frames"] / total, 3)}
              for g in groups]
    result = [p for p in result if p["share"] >= 0.2]
    result.sort(key=lambda p: -p["share"])
    return result


FACECAM_TOLERANCE = 0.075   # how far (in frame fractions) a facecam face may wander
# Share of sampled frames. The whole-frame pass misses a 20-pixel face in
# about two frames of three, and the streamer may go full screen for part of
# the clip, so a candidate needs little; the enlarged look at its region then
# has to find the face in a quarter of all frames.
FACECAM_MIN_SHARE = 0.12
FACECAM_CONFIRM_SHARE = 0.25
GAMING_WINDOW = SAMPLE_FPS  # frames per decision (one second)
MIN_SPLIT_RUN = 2           # seconds; shorter switches are flicker
MIN_FULL_RUN = 1           # preserve quick, confirmed switches to the camera


def is_corner_face(face):
    cx, cy, _, w, h = face[:5]
    return 0 < w <= 0.24 and 0 < h <= 0.4 and min(cx, 1 - cx, cy, 1 - cy) <= 0.27


def facecam_of(found, total):
    """The streamer's facecam: a small face that keeps the same place near an
    edge of the frame. Returns {"cx", "cy", "w", "h", "share"} or None."""
    groups = []
    for index, faces in enumerate(found):
        for face in faces:
            if not is_corner_face(face):
                continue
            group = next((g for g in groups if abs(g["mx"] - face[0]) < FACECAM_TOLERANCE
                          and abs(g["my"] - face[1]) < FACECAM_TOLERANCE), None)
            if group is None:
                group = {"cx": [], "cy": [], "w": [], "h": [], "frames": set()}
                groups.append(group)
            if index in group["frames"]:
                continue
            group["frames"].add(index)
            for key, value in zip(("cx", "cy", "w", "h"), (face[0], face[1], face[3], face[4])):
                group[key].append(float(value))
            group["mx"], group["my"] = float(np.median(group["cx"])), float(np.median(group["cy"]))
    best = max(groups, key=lambda g: len(g["frames"]), default=None)
    if best is None or len(best["frames"]) < max(6, FACECAM_MIN_SHARE * total):
        return None
    return {**{k: round(float(np.median(best[k])), 4) for k in ("cx", "cy", "w", "h")},
            "share": round(len(best["frames"]) / total, 3)}


EDGE_STEP = 8          # luma step (0-255) between neighbouring pixels that counts as an edge
EDGE_PERSIST = 0.5     # share of frames an edge must be there in to be part of the overlay
BOX_SUPPORT = 0.6      # share of each side of the facecam box that must be such an edge


def facecam_box(ex, ey, cam):
    """The rectangle of the facecam overlay, from the edges that stay put
    while the game moves behind them. `ex` and `ey` give, per pixel, the
    share of frames with a sideways and an up-down luma step there. Returns
    {"x", "y", "w", "h"} (fractions of the frame) or None when no rectangle
    around the face is clear enough; a side on the frame's own edge needs no
    line."""
    hx, wx = ex.shape
    hy, wy = ey.shape
    strong_x, strong_y = ex >= EDGE_PERSIST, ey >= EDGE_PERSIST
    fx, fy, fw, fh = cam["cx"] * wy, cam["cy"] * hx, cam["w"] * wy, cam["h"] * hx
    band_rows = slice(max(0, int(fy - 2 * fh)), min(hx, int(fy + 2 * fh) + 1))
    band_cols = slice(max(0, int(fx - 1.5 * fw)), min(wy, int(fx + 1.5 * fw) + 1))

    def peaks(scores, lo, hi, limit=4):
        lo, hi = max(0, lo), min(len(scores), hi)
        found = sorted(range(lo, hi), key=lambda i: -scores[i])
        picked = []
        for i in found:
            if scores[i] < 0.5 or len(picked) >= limit:
                break
            if all(abs(i - p) > 2 for p in picked):
                picked.append(i)
        return picked

    col_scores = strong_x[band_rows].mean(axis=0)
    row_scores = strong_y[:, band_cols].mean(axis=1)
    # Positions are pixel boundaries: column c of `ex` lies between pixels c and c + 1.
    lefts = [None] + [c + 1 for c in peaks(col_scores, int(fx - 10 * fw), int(fx - 1.2 * fw))]
    rights = [None] + [c + 1 for c in peaks(col_scores, int(fx + 1.2 * fw), int(fx + 10 * fw))]
    tops = [None] + [r + 1 for r in peaks(row_scores, int(fy - 8 * fh), int(fy - 1.2 * fh))]
    bottoms = [None] + [r + 1 for r in peaks(row_scores, int(fy + 1.2 * fh), int(fy + 8 * fh))]

    def side(strong, line, a, b):
        if line is None:
            return 1.0
        return float(strong[line - 1, a:b].mean()) if b - a >= 3 else 0.0

    best, best_score = None, BOX_SUPPORT
    for left in lefts:
        x1 = 0 if left is None else left
        for right in rights:
            x2 = wy if right is None else right
            for top in tops:
                y1 = 0 if top is None else top
                for bottom in bottoms:
                    y2 = hx if bottom is None else bottom
                    w, h = (x2 - x1) / wy, (y2 - y1) / hx
                    # An overlay, not most of the screen; and on the frame's
                    # edge at most on two sides, which must not be opposite.
                    if w > 0.5 or h > 0.65 or w * h < 6 * cam["w"] * cam["h"]:
                        continue
                    if (left is None and right is None) or (top is None and bottom is None):
                        continue
                    score = min(
                        side(strong_y, top, x1, x2), side(strong_y, bottom, x1, x2),
                        side(strong_x.T, left, y1, y2), side(strong_x.T, right, y1, y2),
                    )
                    if score > best_score:
                        best, best_score = (x1, y1, x2, y2), score
    if best is None:
        return None
    x1, y1, x2, y2 = best
    return {"x": round(x1 / wy, 4), "y": round(y1 / hx, 4), "w": round((x2 - x1) / wy, 4), "h": round((y2 - y1) / hx, 4)}


def at_facecam(face, cam):
    return abs(face[0] - cam["cx"]) < FACECAM_TOLERANCE and abs(face[1] - cam["cy"]) < FACECAM_TOLERANCE


def facecam_companion(found, cam):
    """Find a second face consistently next to the primary face in the inset."""
    candidates = []
    for faces in found:
        if not any(abs(f[0] - cam["cx"]) <= cam["w"] * 0.65 and at_facecam(f, cam) for f in faces):
            continue
        candidates.append([
            f for f in faces
            if 0.75 * max(f[3], cam["w"]) < abs(f[0] - cam["cx"]) <= max(0.09, 4 * cam["w"])
            and abs(f[1] - cam["cy"]) <= cam["h"]
            and 0.5 * cam["h"] <= f[4] <= 1.8 * cam["h"]
        ])
    return facecam_of(candidates, len(candidates))


def facecam_presence(session, video, start, duration, width, height, cam):
    """Per sampled frame, whether the streamer's face is in the facecam. The
    region around the facecam is read at full resolution and enlarged: in a
    480p stream the face is about 20 pixels wide, too small for the detector
    on the whole frame in a third of the frames."""
    rw, rh = min(1.0, 6 * cam["w"]), min(1.0, 5 * cam["h"])
    rx = min(max(0.0, cam["cx"] - rw / 2), 1 - rw)
    ry = min(max(0.0, cam["cy"] - rh / 2), 1 - rh)
    even = lambda n: max(2, int(n // 2) * 2)
    px, py, pw, ph = even(rx * width), even(ry * height), even(rw * width), even(rh * height)
    seen = []
    for frame in read_frames(video, start, duration, pw, ph, crop=(pw, ph, px, py)):
        faces = detect(session, frame)
        seen.append(any(0.15 < f[0] < 0.85 and 0.1 < f[1] < 0.9 for f in faces))
    return seen


def gaming_timeline(found, seen, cam, kept, duration):
    """Splits the clip into "split" stretches (gameplay with the facecam over
    it) and "full" stretches (the camera fills the screen: the streamer talks
    to chat, stands up, shows something), one second at a time. A full
    stretch carries the crop that keeps the streamer in the picture."""
    total = len(found)
    states = []
    for a in range(0, total, GAMING_WINDOW):
        frames = range(a, min(total, a + GAMING_WINDOW))
        in_cam = sum(1 for i in frames if (seen[i] if i < len(seen) else False)
                     or any(at_facecam(f, cam) for f in found[i]))
        # A missed inset face or a character in the game is not a camera
        # change. Only a sustained, much larger face is evidence that the
        # source has switched away from the gameplay layout.
        elsewhere = sum(1 for i in frames if any(
            not at_facecam(f, cam) and f[4] >= max(0.16, 2.2 * cam["h"])
            and f[3] >= 1.7 * cam["w"] for f in found[i]))
        if in_cam * 2 >= len(frames):
            states.append("split")
        elif elsewhere * 2 >= len(frames):
            states.append("full")
        else:
            states.append(None)  # no face anywhere: decided by its neighbours
    known = [s for s in states if s]
    if not known:
        return [{"start": 0, "end": round(duration, 2), "split": True}]
    last = "split"
    for i, s in enumerate(states):
        states[i] = s or last
        last = states[i]
    runs = []
    for i, s in enumerate(states):
        if runs and runs[-1][0] == s:
            runs[-1][2] = i + 1
        else:
            runs.append([s, i, i + 1])
    # Keep confirmed opening and closing split shots, even when brief.
    # Between other camera shots, fold short flicker into its neighbours.
    while len(runs) > 1:
        short = [k for k, r in enumerate(runs)
                 if r[2] - r[1] < (MIN_FULL_RUN if r[0] == "full" else MIN_SPLIT_RUN)
                 and not (r[0] == "split" and k in (0, len(runs) - 1))]
        if not short:
            break
        k = min(short, key=lambda k: runs[k][2] - runs[k][1])
        if k == 0:
            other = 1
        elif k == len(runs) - 1:
            other = k - 1
        else:
            other = k - 1 if runs[k - 1][2] - runs[k - 1][1] >= runs[k + 1][2] - runs[k + 1][1] else k + 1
        runs[other][1], runs[other][2] = min(runs[other][1], runs[k][1]), max(runs[other][2], runs[k][2])
        del runs[k]
        merged = []
        for r in runs:
            if merged and merged[-1][0] == r[0]:
                merged[-1][2] = r[2]
            else:
                merged.append(r)
        runs = merged

    def to_offset(x):
        return round(max(-1.0, min(1.0, (x - 0.5) / ((1 - kept) / 2))), 3) if kept < 0.98 else 0

    out = []
    for state, a, b in runs:
        start = round(a * GAMING_WINDOW / SAMPLE_FPS, 2)
        end = round(duration if b == len(states) else min(duration, b * GAMING_WINDOW / SAMPLE_FPS), 2)
        if state == "split":
            out.append({"start": start, "end": end, "split": True})
            continue
        other_frames = [[f for f in faces if not at_facecam(f, cam)]
                        for faces in found[a * GAMING_WINDOW:min(total, b * GAMING_WINDOW)]]
        pair = two_people(other_frames)
        if pair:
            out.append({"start": start, "end": end, "split": False, **keep_pair_in_frame(pair, kept)})
            continue
        xs = [max(faces, key=lambda f: f[2])[0] for faces in other_frames if faces]
        out.append({"start": start, "end": end, "split": False,
                    "offsetX": to_offset(float(np.median(xs))) if xs else 0})
    return out


def main():
    if len(sys.argv) > 6 and sys.argv[6] in {"people", "facecam"}:
        found = people(sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), int(float(sys.argv[4])),
                       int(float(sys.argv[5])), stationary=sys.argv[6] == "facecam")
        json.dump({"people": found}, sys.stdout)
        return
    if len(sys.argv) < 6:
        raise ValueError("usage: auto_frame.py <video> <start> <duration> <src-width> <src-height>")
    dual_mode = len(sys.argv) > 6 and sys.argv[6] == "dual"
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
    if kept >= 0.98 and not dual_mode:
        json.dump({"segments": [], "faceCoverage": 0, "shots": 0, "reason": "source is already vertical"}, sys.stdout)
        return

    session = load_detector()

    found, cuts = [], [0]
    previous_luma = None
    # How often each pixel has an edge: an overlay's border stays put.
    edges_x = edges_y = None
    edge_frames = 0
    for index, frame in enumerate(read_frames(video, start, duration, width, height, DETAIL)):
        luma = frame.mean(axis=2)
        faces = detect(session, frame[::DETAIL, ::DETAIL])
        # Only frames that may show a facecam: a full-screen camera stretch
        # would otherwise thin out the overlay's border.
        if not dual_mode and any(is_corner_face(f) for f in faces):
            step_x = np.abs(np.diff(luma, axis=1)) > EDGE_STEP
            step_y = np.abs(np.diff(luma, axis=0)) > EDGE_STEP
            edges_x = step_x.astype(np.float32) if edges_x is None else edges_x + step_x
            edges_y = step_y.astype(np.float32) if edges_y is None else edges_y + step_y
            edge_frames += 1
        cut = previous_luma is not None and float(np.abs(luma - previous_luma).mean()) > CUT_DIFF
        if cut:
            cuts.append(index)
        # Nothing to compare a mouth against on the first frame of a shot.
        found.append([(*face, mouth_motion(luma, None if cut else previous_luma, face)) for face in faces])
        previous_luma = luma
    total = len(found)
    if total == 0:
        raise RuntimeError("no frames could be read from the clip")

    # A game stream with a facecam: the plan for Facecam + Gameplay, which
    # switches to the full camera while it fills the screen. The facecam's
    # face is then left out of the normal framing, which otherwise slid
    # between the game and that small face in the corner.
    gaming = None
    cam = None if dual_mode else facecam_of(found, total)
    if cam:
        seen = facecam_presence(session, video, start, duration, width, height, cam)
        if sum(seen) >= FACECAM_CONFIRM_SHARE * total:
            cam["share"] = round(max(cam["share"], sum(seen) / total), 3)
            box = facecam_box(edges_x / edge_frames, edges_y / edge_frames, cam) if edge_frames >= 4 else None
            if box:
                cam["box"] = box
            else:
                companion = facecam_companion(found, cam)
                if companion:
                    cam["companion"] = companion
            gaming = {"facecam": cam, "runs": gaming_timeline(found, seen, cam, kept, duration)}
            found = [[f for f in faces if not at_facecam(f, cam)] for faces in found]

    # Who to follow in each camera shot. A change of speaker inside a shot is
    # treated as a cut of its own: the crop jumps rather than sweeping across.
    centres, speaker_cuts, pairs = [], [], {}
    for a, b in zip(cuts, cuts[1:] + [total]):
        pair = two_people(found[a:b])
        if pair:
            # Both people are shown, so there is no speaker to follow.
            pairs[a] = pair
            centres.extend([None] * (b - a))
            continue
        shot, switches = follow_speaker(found[a:b], kept)
        centres.extend(shot)
        speaker_cuts.extend(a + k for k in switches)
    cuts = sorted(set(cuts) | set(speaker_cuts))

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
        if a in pairs:
            framing = {"offsetX": 0, "dual": pairs[a]} if dual_mode else keep_pair_in_frame(pairs[a], kept)
            segments.append({**base, **framing})
            continue
        if kept >= 0.98:
            # Already as narrow as the output: nothing to pan.
            segments.append({**base, "offsetX": 0})
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

    coverage = sum(1 for faces in found if faces) / total
    json.dump({"segments": segments, "faceCoverage": round(coverage, 3), "shots": len(bounds),
               "speakerChanges": len(speaker_cuts), **({"gaming": gaming} if gaming else {})}, sys.stdout)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
