"""Build the pinned large Darija model for CPU inference, once during image build.

The model is OpenAI's whisper-large-v3-turbo with anaszil's Moroccan Darija
LoRA adapter (MIT licence) merged in, converted to CTranslate2 INT8 for
faster-whisper. On real Darija conversation it writes readable Darija where
the small Darija fine-tune is often garbled; it takes about three times as
long.

Memory stays low enough for a small build machine: the weights are merged
tensor by tensor in half precision and loaded as float16 for the conversion.
The 1.6 GB downloads are deleted afterwards; only the INT8 model is kept.
"""

import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile

BASE_REPO = "openai/whisper-large-v3-turbo"
BASE_REVISION = "41f01f3fe87f28c78e2fbf8b568835947dd65ed9"
BASE_SHA256 = "542566a422ae4f3fd23f1ba11add198fca01bbf82e66e6a2857b3f608b1eb9d1"
ADAPTER_REPO = "anaszil/whisper-large-v3-turbo-darija"
ADAPTER_REVISION = "924059161e5093f33410b2c6daf7113f40185c8d"
ADAPTER_SHA256 = "fefe5d9fa874c63f8329babb29a4e8559cdf8d2c4a904374cec4815cc5193e31"
BASE_FILES = [
    "config.json", "generation_config.json", "preprocessor_config.json", "tokenizer.json",
    "tokenizer_config.json", "vocab.json", "merges.txt", "normalizer.json", "added_tokens.json",
    "special_tokens_map.json", "model.safetensors",
]


def model_path() -> Path:
    cache = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "whisper"
    target = cache / "darija-turbo-9240591-int8"
    if (target / "model.bin").is_file():
        return target
    cache.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=cache) as directory:
        work = Path(directory)
        source = download(work / "downloads")
        merged = work / "merged"
        merge(source, merged)
        shutil.rmtree(work / "downloads")
        convert(merged, work / "model")
        try:
            (work / "model").rename(target)
        except OSError:
            if not (target / "model.bin").is_file():
                raise
    return target


def checksum(path: Path, expected: str, what: str) -> None:
    with path.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != expected:
            raise RuntimeError(f"The {what} failed its checksum.")


def download(folder: Path) -> dict:
    from huggingface_hub import hf_hub_download

    base = folder / "base"
    for name in BASE_FILES:
        hf_hub_download(BASE_REPO, name, revision=BASE_REVISION, local_dir=base)
    adapter = folder / "adapter"
    for name in ["adapter_config.json", "adapter_model.safetensors"]:
        hf_hub_download(ADAPTER_REPO, name, revision=ADAPTER_REVISION, local_dir=adapter)
    checksum(base / "model.safetensors", BASE_SHA256, "Whisper large-v3-turbo checkpoint")
    checksum(adapter / "adapter_model.safetensors", ADAPTER_SHA256, "Darija adapter")
    return {"base": base, "adapter": adapter}


def merge(source: dict, output: Path) -> None:
    """W += (B @ A) * alpha / r for every LoRA pair, written as a plain
    Transformers checkpoint."""
    import torch
    from safetensors import safe_open
    from safetensors.torch import save_file

    config = json.loads((source["adapter"] / "adapter_config.json").read_text())
    if config.get("peft_type") != "LORA" or config.get("use_dora") or config.get("modules_to_save"):
        raise RuntimeError("Unexpected adapter type.")
    rank = int(config["r"])
    alpha = float(config.get("lora_alpha", rank))
    scale = alpha / (rank ** 0.5) if config.get("use_rslora") else alpha / rank

    # Only the small A and B matrices are kept; each full-size change is made
    # when its base weight comes up, so memory stays near one copy of the model.
    pairs = {}
    with safe_open(str(source["adapter"] / "adapter_model.safetensors"), "pt") as adapter:
        for name in adapter.keys():
            if ".lora_A." not in name:
                if ".lora_B." not in name:
                    raise RuntimeError(f"Unexpected adapter tensor {name}.")
                continue
            target = name.split(".lora_A.")[0].removeprefix("base_model.model.") + ".weight"
            pairs[target] = (adapter.get_tensor(name), adapter.get_tensor(name.replace(".lora_A.", ".lora_B.")))

    tensors = {}
    with safe_open(str(source["base"] / "model.safetensors"), "pt") as base:
        for name in base.keys():
            tensor = base.get_tensor(name)
            pair = pairs.pop(name, None)
            if pair is not None:
                a, b = pair
                delta = (b.float() @ a.float()) * scale
                if config.get("fan_in_fan_out"):
                    delta = delta.T
                tensor = (tensor.float() + delta).to(tensor.dtype)
                del delta
            tensors[name] = tensor.contiguous()
    if pairs:
        raise RuntimeError(f"Adapter weights with no base weight: {sorted(pairs)[:3]}")

    output.mkdir(parents=True)
    save_file(tensors, str(output / "model.safetensors"), metadata={"format": "pt"})
    del tensors
    for name in BASE_FILES:
        if name != "model.safetensors":
            shutil.copy(source["base"] / name, output / name)


def convert(merged: Path, output: Path) -> None:
    from ctranslate2.converters import TransformersConverter

    TransformersConverter(
        str(merged), copy_files=["tokenizer.json", "preprocessor_config.json"],
        load_as_float16=True, low_cpu_mem_usage=True,
    ).convert(str(output), quantization="int8")


if __name__ == "__main__":
    print(model_path())
