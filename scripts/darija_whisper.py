"""Prepare the pinned Darija Whisper checkpoint for OpenAI's runtime."""

import hashlib
import os
from pathlib import Path
import tempfile
from urllib.request import urlretrieve

MODEL_URL = (
    "https://huggingface.co/Anass-Srk/fine-tuned-whisper-small-darija/resolve/"
    "d3c4fd5048c5f182dea49e4af8670037a699cfe6/model.safetensors"
)
MODEL_SHA256 = "1e015c7f6dba2ceeb12da5f5ab23d480caba557f919d956d382c37a78144d4ba"


def model_path() -> Path:
    cache = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "whisper"
    target = cache / "darija-small-d3c4fd5.pt"
    if target.is_file():
        return target

    cache.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=cache) as directory:
        source = Path(directory) / "model.safetensors"
        urlretrieve(MODEL_URL, source)
        with source.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != MODEL_SHA256:
                raise RuntimeError("The downloaded Darija checkpoint failed its checksum.")
        converted = Path(directory) / "darija.pt"
        convert_checkpoint(source, converted)
        converted.replace(target)
    return target


def convert_checkpoint(source: Path, target: Path) -> None:
    import torch
    from safetensors import safe_open

    torch.set_num_threads(2)
    # The fine-tune retains Whisper small's multilingual tokenizer and tied
    # output embedding. Map the published Transformers keys to OpenAI Whisper.
    names = (
        (".layers.", ".blocks."),
        (".self_attn.", ".attn."),
        (".encoder_attn.", ".cross_attn."),
        (".q_proj.", ".query."),
        (".k_proj.", ".key."),
        (".v_proj.", ".value."),
        (".out_proj.", ".out."),
        (".self_attn_layer_norm.", ".attn_ln."),
        (".encoder_attn_layer_norm.", ".cross_attn_ln."),
        (".final_layer_norm.", ".mlp_ln."),
        (".fc1.", ".mlp.0."),
        (".fc2.", ".mlp.2."),
        ("encoder.layer_norm.", "encoder.ln_post."),
        ("decoder.layer_norm.", "decoder.ln."),
        (".embed_positions.weight", ".positional_embedding"),
        (".embed_tokens.", ".token_embedding."),
    )
    weights = {}
    with safe_open(source, framework="pt", device="cpu") as checkpoint:
        for key in checkpoint.keys():
            if not key.startswith("model."):
                raise RuntimeError(f"Unexpected Darija checkpoint tensor {key}")
            name = key.removeprefix("model.")
            for original, replacement in names:
                name = name.replace(original, replacement)
            weights[name] = checkpoint.get_tensor(key).to(torch.float16)

    dims = {
        "n_mels": 80,
        "n_audio_ctx": 1500,
        "n_audio_state": 768,
        "n_audio_head": 12,
        "n_audio_layer": 12,
        "n_vocab": 51865,
        "n_text_ctx": 448,
        "n_text_state": 768,
        "n_text_head": 12,
        "n_text_layer": 12,
    }
    torch.save({"dims": dims, "model_state_dict": weights}, target)


if __name__ == "__main__":
    print(model_path())
