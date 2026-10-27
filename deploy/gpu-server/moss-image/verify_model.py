#!/usr/bin/env python3
"""校验 MOSS-Image-SFT 模型目录：逐个文件对比 ModelScope 远端 Size。

背景：aria2c 断线续传/重试可能产生比远端更大的文件（多段写入叠加），只看 HTTP 200
会漏掉；加载时才在 safetensors 处报错，浪费一次完整的模型加载时间。
用法：python3 verify_model.py [model_dir]
退出码：0 全部一致；1 有缺失/大小不一致。
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request

MODEL = "openmoss/MOSS-Image-SFT"
DEFAULT_DIR = "/mnt/data0/lwh/karen-stack/models/MOSS-Image-SFT"
LIST_URL = f"https://www.modelscope.cn/api/v1/models/{MODEL}/repo/files?Revision=master&Recursive=true"


def main() -> int:
    model_dir = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DIR
    with urllib.request.urlopen(LIST_URL, timeout=60) as resp:
        data = json.load(resp)
    bad = []
    total = 0
    for f in data["Data"]["Files"]:
        if f.get("Type") != "blob":
            continue
        path, size = f["Path"], f.get("Size", 0)
        local = os.path.join(model_dir, path)
        have = os.path.getsize(local) if os.path.exists(local) else -1
        total += size
        if have != size:
            bad.append((path, size, have))
    print(f"checked total_gb={total / 1e9:.2f} mismatched={len(bad)}")
    for path, size, have in bad:
        print(f"  BAD {path} remote={size} local={have}")
    return 0 if not bad else 1


if __name__ == "__main__":
    sys.exit(main())
