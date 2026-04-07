FROM node:20-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    libgl1 libglib2.0-0 libgomp1 \
    ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/venv

ENV PATH="/opt/venv/bin:$PATH"
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1

COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir -r /app/backend/requirements.txt

COPY backend /app/backend
RUN mkdir -p /app/backend/models && \
    curl -fL --retry 3 --retry-delay 2 -o /app/backend/models/yolov3-tiny.cfg https://raw.githubusercontent.com/AlexeyAB/darknet/master/cfg/yolov3-tiny.cfg && \
    curl -fL --retry 3 --retry-delay 2 -o /app/backend/models/coco.names https://raw.githubusercontent.com/pjreddie/darknet/master/data/coco.names && \
    curl -fL --retry 3 --retry-delay 2 -o /app/backend/models/yolov3-tiny.weights https://sourceforge.net/projects/yolov3.mirror/files/v8/yolov3-tiny.weights/download

COPY --from=builder /app/.next/standalone /app/web
COPY --from=builder /app/.next/static /app/web/.next/static
COPY --from=builder /app/public /app/web/public

COPY start.sh /app/start.sh
RUN sed -i 's/\r$//' /app/start.sh && chmod +x /app/start.sh

ENV BACKEND_URL=http://127.0.0.1:8000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000

CMD ["/app/start.sh"]
