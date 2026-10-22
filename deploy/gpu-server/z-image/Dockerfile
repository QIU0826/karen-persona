FROM localhost/karen-qwen-image-edit:0.1

ENV PYTHONUNBUFFERED=1 \
    HF_HUB_OFFLINE=1

WORKDIR /app
COPY server.py /app/z_image_server.py
EXPOSE 18111
CMD ["python", "/app/z_image_server.py"]
