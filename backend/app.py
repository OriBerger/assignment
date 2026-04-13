from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from backend.queue_worker import DetectionQueueWorker


app = FastAPI(title="Jetson YOLO Backend")
worker = DetectionQueueWorker(max_queue_size=32, max_history=250)


def _read_int_file(path: str) -> int | None:
    """Read a text file containing a single integer and return it, or None if missing or invalid."""
    try:
        raw = Path(path).read_text(encoding="utf-8").strip()
        return int(raw)
    except Exception:
        return None


def _memory_stat_field_bytes(stat_path: str, field: str) -> int | None:
    """Parse a cgroup memory.stat line and return the byte value for the given field name."""
    try:
        for line in Path(stat_path).read_text(encoding="utf-8").splitlines():
            parts = line.split()
            if len(parts) >= 2 and parts[0] == field:
                return int(parts[1])
    except Exception:
        return None
    return None


def _memory_working_set_bytes() -> int | None:
    """Estimate process or cgroup working-set memory in bytes, aligned with Docker-style usage.

    Tries cgroup v2/v1 usage minus inactive file cache, then falls back to VmRSS from proc.
    """
    # cgroup v2
    raw = _read_int_file("/sys/fs/cgroup/memory.current")
    if raw is not None:
        inactive = _memory_stat_field_bytes("/sys/fs/cgroup/memory.stat", "inactive_file")
        if inactive is not None and inactive < raw:
            return raw - inactive
        return raw
    # cgroup v1
    raw = _read_int_file("/sys/fs/cgroup/memory/memory.usage_in_bytes")
    if raw is not None:
        inactive = _memory_stat_field_bytes(
            "/sys/fs/cgroup/memory/memory.stat", "total_inactive_file"
        )
        if inactive is not None and inactive < raw:
            return raw - inactive
        return raw
    # Linux process RSS fallback
    try:
        for line in Path("/proc/self/status").read_text(encoding="utf-8").splitlines():
            if line.startswith("VmRSS:"):
                parts = line.split()
                if len(parts) >= 2:
                    return int(parts[1]) * 1024
    except Exception:
        return None
    return None


def _memory_limit_bytes() -> int | None:
    """Return cgroup memory limit in bytes if capped, or None if unlimited or unknown."""
    # cgroup v2
    try:
        raw = Path("/sys/fs/cgroup/memory.max").read_text(encoding="utf-8").strip()
        if raw != "max":
            return int(raw)
    except Exception:
        pass
    # cgroup v1
    value = _read_int_file("/sys/fs/cgroup/memory/memory.limit_in_bytes")
    if value is not None:
        return value
    return None


class EnqueueFrameRequest(BaseModel):
    """JSON body for enqueue: base64 image data URL, client timestamp, and optional video timeline position."""

    imageData: str
    timestamp: int
    videoTimeSec: float | None = None  # MP4 timeline: HTMLMediaElement.currentTime at capture


@app.on_event("startup")
def on_startup():
    """Preload YOLO and start the background detection worker thread."""
    worker.preload_detector()
    worker.start()


@app.on_event("shutdown")
def on_shutdown():
    """Signal the worker to stop and wait briefly for the thread to exit on process shutdown."""
    worker.stop()


@app.get("/health")
def health():
    """Liveness probe: returns a simple OK payload for load balancers and orchestration."""
    return {"ok": True}


@app.post("/enqueue")
def enqueue_frame(body: EnqueueFrameRequest):
    """Accept a frame for async YOLO processing; returns assigned frame id or 429 if the queue is full."""
    frame_id = worker.enqueue(body.model_dump())
    if frame_id is None:
        raise HTTPException(status_code=429, detail="Frame queue is full")
    return {"accepted": True, "frameId": frame_id}


@app.get("/results")
def get_results(afterId: int = 0):
    """Return detection results for all frames with id greater than the given cursor (polling API)."""
    return {"results": worker.get_results_after(afterId)}


@app.post("/session/clear")
def clear_session():
    worker.clear_session()
    return {"cleared": True}


@app.get("/runtime/memory")
def runtime_memory():
    """Expose working-set and limit in megabytes plus usage percent for dashboard memory HUD."""
    used_bytes = _memory_working_set_bytes()
    limit_bytes = _memory_limit_bytes()

    if used_bytes is None:
        return {"ok": False, "error": "memory usage unavailable"}

    used_mb = round(used_bytes / (1024 * 1024), 1)
    limit_mb = (
        round(limit_bytes / (1024 * 1024), 1)
        if limit_bytes is not None and limit_bytes > 0
        else None
    )
    percent = (
        round((used_bytes / limit_bytes) * 100, 1)
        if limit_bytes is not None and limit_bytes > 0
        else None
    )

    return {
        "ok": True,
        "usedMB": used_mb,
        "limitMB": limit_mb,
        "usagePercent": percent,
    }
