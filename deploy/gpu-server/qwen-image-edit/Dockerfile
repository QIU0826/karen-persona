FROM localhost/karen-voxcpm2:0.1

ENV PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    HF_HUB_OFFLINE=1

RUN pip install --no-cache-dir \
      diffusers \
      accelerate \
      sentencepiece \
      protobuf \
      pillow \
      torchvision \
      "huggingface-hub>=0.34,<1.0"

WORKDIR /app
COPY server.py /app/qwen_image_server.py
EXPOSE 18110
CMD ["python", "/app/qwen_image_server.py"]
