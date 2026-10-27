# MOSS-Image-SFT 服务镜像（可选路径）
#
# 说明：当前 GPU7 采用「基础镜像 + /mnt/data0 venv 直跑」的方式（根分区只剩 ~11GB，
# 不构建镜像）；本 Dockerfile 仅记录可复现的容器化方式，构建前请确认根分区有余量。
#
# 构建：
#   podman build -t karen-moss-image:0.1 deploy/gpu-server/moss-image
#
# 运行（GPU7）：
#   podman run -d --name karen-moss-image \
#     --device nvidia.com/gpu=7 \
#     --restart=unless-stopped \
#     -p 127.0.0.1:18114:18114 -p 127.0.0.1:18115:18115 \
#     -e MOSS_IMAGE_MODEL_DIR=/workspace/models/MOSS-Image-SFT \
#     -v /mnt/data0/lwh/karen-stack:/workspace \
#     karen-moss-image:0.1
#
# 基础镜像已带 PyTorch 2.8.0+cu128 / diffusers 0.39.0 / Python 3.11；
# MOSS 官方要求 torch>=2.9，本项目在该镜像上实测可用（见 README「已知差异」）。
FROM localhost/karen-qwen-image-edit:0.1

ENV PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    HF_HUB_OFFLINE=1

RUN pip install --no-cache-dir \
      "diffusers>=0.38" \
      "transformers>=5.3" \
      "accelerate>=1.10" \
      "safetensors>=0.6" \
      "Pillow>=10"

WORKDIR /app
COPY server.py /app/moss_image_server.py
EXPOSE 18114 18115
CMD ["python", "/app/moss_image_server.py"]
