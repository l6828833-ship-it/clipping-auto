"""Build the pinned Darija model for CPU inference, once during image build."""

import hashlib
import os
from pathlib import Path
import tempfile

from darija_whisper import MODEL_SHA256

REVISION = "d3c4fd5048c5f182dea49e4af8670037a699cfe6"


def model_path() -> Path:
    cache = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "whisper"
    target = cache / "darija-small-d3c4fd5-int8"
    if (target / "model.bin").is_file():
        return target
    from huggingface_hub import snapshot_download
    from ctranslate2.converters import TransformersConverter
    from transformers import AutoTokenizer

    source = snapshot_download(
        "Anass-Srk/fine-tuned-whisper-small-darija", revision=REVISION,
        allow_patterns=["*.json", "merges.txt", "vocab.json", "model.safetensors"],
    )
    with open(Path(source) / "model.safetensors", "rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != MODEL_SHA256:
            raise RuntimeError("The Darija checkpoint failed its checksum.")
    cache.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=cache) as directory:
        output = Path(directory) / "model"
        TransformersConverter(source, copy_files=["preprocessor_config.json"]).convert(
            str(output), quantization="int8",
        )
        # This fine-tune publishes the slow tokenizer files. Materialise the
        # fast tokenizer so runtime never needs another Hugging Face download.
        AutoTokenizer.from_pretrained(source).save_pretrained(output)
        try:
            output.rename(target)
        except OSError:
            if not (target / "model.bin").is_file():
                raise
    return target


if __name__ == "__main__":
    print(model_path())
