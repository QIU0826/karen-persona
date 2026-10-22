FROM localhost/karen-qwen3tts:0.1

ENV PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1

RUN pip install --no-cache-dir voxcpm

WORKDIR /app
COPY server.py /app/voxcpm_server.py
EXPOSE 18102
CMD ["python", "/app/voxcpm_server.py"]
