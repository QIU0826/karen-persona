FROM docker.m.daocloud.io/pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime

ENV PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1

RUN sed -i "s|archive.ubuntu.com|mirrors.tuna.tsinghua.edu.cn|g; s|security.ubuntu.com|mirrors.tuna.tsinghua.edu.cn|g" /etc/apt/sources.list 2>/dev/null || true; \
    apt-get update && apt-get install -y --no-install-recommends libsndfile1 ffmpeg \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
      qwen-tts \
      fastapi \
      "uvicorn[standard]" \
      soundfile

WORKDIR /app
COPY server.py /app/server.py
EXPOSE 18101
CMD ["python", "/app/server.py"]
