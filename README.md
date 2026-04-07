# Jetson YOLO Dashboard

A full-stack dashboard that runs object detection with YOLO and displays results in a Next.js UI.

This project is packaged as a single Docker container that runs:
- **Frontend:** Next.js 14 (production standalone build)
- **Backend:** FastAPI + OpenCV YOLO worker

## Features

- Real-time frame enqueue + detection result polling
- Queue-based backend processing to avoid blocking API requests
- Single-container deployment for easy local/demo setup
- Multi-stage Docker build optimized for smaller runtime image

## Tech Stack

- Next.js 14 / React 18
- FastAPI / Uvicorn
- OpenCV + YOLOv3-tiny
- Docker + Docker Compose

## Project Structure

- `src/app` - Next.js app routes and UI
- `backend/app.py` - FastAPI endpoints (`/health`, `/enqueue`, `/results`)
- `backend/queue_worker.py` - async queue + detection loop
- `backend/yolo.py` - image decode + YOLO inference
- `Dockerfile` - multi-stage production image
- `docker-compose.yml` - local container orchestration
- `start.sh` - starts backend, waits for health, then starts frontend

## Quick Start (Docker Recommended)

### Prerequisites

- Docker Desktop (Windows/Mac) or Docker Engine (Linux)

### Run

```bash
docker compose up --build
```

Open:
- App: [http://localhost:3000](http://localhost:3000)

### Stop

```bash
docker compose down
```

## How It Works

1. Frontend sends frame payloads to `POST /api/enqueue` (proxied to backend).
2. Backend enqueues frames and processes them in a background worker.
3. Frontend polls `GET /api/results?afterId=<id>` for new detections.
4. Results include bounding boxes and confidence scores.

## API Endpoints (Backend)

- `GET /health` -> service health check
- `POST /enqueue` -> enqueue a frame for detection
- `GET /results?afterId=0` -> fetch processed results after a frame id

## Docker Notes

- The runtime image is based on `node:20-bookworm-slim`.
- Build downloads YOLO files into `backend/models`:
  - `yolov3-tiny.cfg`
  - `yolov3-tiny.weights`
  - `coco.names`
- Startup waits for backend health before booting Next.js to prevent early `ECONNREFUSED` errors.

## Troubleshooting

- **`fetch failed` / `ECONNREFUSED 127.0.0.1:8000` on startup**
  - Usually a startup race; already handled by `start.sh` health wait.
  - Rebuild once if using old image layers:
  ```bash
  docker compose build --no-cache
  docker compose up
  ```

- **`No such file or directory: /app/backend/models/coco.names`**
  - Rebuild image so model assets are re-downloaded:
  ```bash
  docker compose build --no-cache
  ```

- **Out-of-memory or slow model load**
  - Keep compose memory limit at 1GB+ (currently `mem_limit: 1g`).

## Development Notes

- Main app scripts:
  - `npm run dev`
  - `npm run build`
  - `npm run start`
- If running without Docker, install both Node and Python dependencies manually.

## License

For assignment/demo use.
