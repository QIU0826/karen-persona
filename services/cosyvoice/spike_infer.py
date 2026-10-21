"""Fun-CosyVoice3-0.5B 本机 CPU 推理 spike（v0.9.16 可行性验证用，非产品服务）。

用法：
  services/cosyvoice/.venv/bin/python services/cosyvoice/spike_infer.py \
      --ref <参考音.wav> --ref-text "<参考音文本>" --out <输出.wav> [--text ...] [--speed 1.0]
"""
import argparse
import os
import resource
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "third_party", "Matcha-TTS"))

import torch  # noqa: E402

from cosyvoice.cli.cosyvoice import CosyVoice3  # noqa: E402
from cosyvoice.utils.file_utils import load_wav  # noqa: E402


def rss_mb() -> float:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1024 * 1024)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", default=os.path.expanduser(
        "~/Library/Application Support/karen/models/Fun-CosyVoice3-0.5B"))
    parser.add_argument("--ref", required=True)
    parser.add_argument("--ref-text", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--text", default="今天店里人不多，我给自己做了杯拿铁，拉花歪了。")
    parser.add_argument("--speed", type=float, default=1.0)
    args = parser.parse_args()

    t0 = time.time()
    model = CosyVoice3(args.model_dir, load_trt=False, load_vllm=False, fp16=False)
    load_s = time.time() - t0
    print(f"[load] {load_s:.1f}s  sr={model.sample_rate}  rss={rss_mb():.0f}MB", flush=True)

    prompt_wav = load_wav(args.ref, 16000)
    print(f"[ref] {args.ref} -> {prompt_wav.shape[-1] / 16000:.2f}s", flush=True)

    t1 = time.time()
    chunks = []
    for out in model.inference_zero_shot(
        args.text, args.ref_text, args.ref, stream=False, speed=args.speed
    ):
        chunks.append(out["tts_speech"])
    synth_s = time.time() - t1
    speech = torch.cat(chunks, dim=1)
    duration = speech.shape[1] / model.sample_rate
    import soundfile as sf

    sf.write(args.out, speech.squeeze(0).cpu().numpy(), model.sample_rate)
    print(
        f"[synth] {synth_s:.1f}s for {duration:.2f}s audio  RTF={synth_s / max(duration, 1e-6):.2f}x  "
        f"rss_peak={rss_mb():.0f}MB  out={args.out}",
        flush=True,
    )


if __name__ == "__main__":
    main()
