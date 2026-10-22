FROM localhost/karen-sensevoice:0.1

ENV PYTHONUNBUFFERED=1 \
    HF_HUB_OFFLINE=1

WORKDIR /app
COPY server.py /app/qwen_omni_server.py
EXPOSE 18113
CMD ["python", "/app/qwen_omni_server.py"]
