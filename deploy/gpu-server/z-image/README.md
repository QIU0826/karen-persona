# Z-Image-Turbo 服务（GPU3）

> 6B，Apache-2.0，8 步（`num_inference_steps=9` 实际 8 次 DiT），1024px；只用于场景/照片/中文文字，不负责角色一致性（角色用 Qwen-Image-Edit-2511）。

## 构建

```bash
podman build -t karen-z-image:0.1 deploy/gpu-server/z-image
```

## 权重（ModelScope）

```text
/mnt/data0/lwh/karen-stack/models/Z-Image-Turbo
```

```bash
modelscope download --model Tongyi-MAI/Z-Image-Turbo \
  --local_dir /mnt/data0/lwh/karen-stack/models/Z-Image-Turbo --max-workers 16
```

## 启动（GPU3）

```bash
podman run -d --name karen-z-image \
  --device nvidia.com/gpu=3 \
  --restart=unless-stopped \
  -p 127.0.0.1:18111:18111 \
  -e ZIMAGE_MODEL_DIR=/workspace/models/Z-Image-Turbo \
  -v /mnt/data0/lwh/karen-stack:/workspace \
  karen-z-image:0.1
```

## 测试

```bash
curl -s http://127.0.0.1:18111/health
curl -s -X POST http://127.0.0.1:18111/generate \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"傍晚的城市屋顶，暖色天空，手机随手拍，自然光","width":832,"height":1216,"steps":9}' \
  -o /tmp/z-image.png
```

## 说明

- 输出未经过 `image-guard`；接入主路径时必须先 `image:audit`，不合格回退。
- 主要用途：场景图/草稿/中文文字；"同一个人"仍走 Qwen-Image-Edit-2511。
- 先只占 GPU3，不动 GPU2 的 VoxCPM2 + Qwen-Image-Edit。

## 实测（2026-10-22）

- GPU3 加载后 20.5GB；推理约 25.5GB。
- 832×1216、9 步：首张 5.9s，热图 4.8–4.9s。
- `KAREN_IMAGE_BACKEND=z-image` + `KAREN_IMAGE_GUARD=on` 产品路径实测 `ok=true` 4.9s。
- 场景图质检需传 `expectCharacter=false`（`generateImage` 已自动传）。
