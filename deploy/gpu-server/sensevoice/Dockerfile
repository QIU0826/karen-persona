FROM localhost/karen-qwen-image-edit:0.1

ENV PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    HF_HUB_OFFLINE=1

RUN pip install --no-cache-dir funasr modelscope torchaudio

WORKDIR /app
COPY server.py /app/sensevoice_server.py
EXPOSE 18112
CMD ["python", "/app/sensevoice_server.py"]
