from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from backend.queue_worker import DetectionQueueWorker


app = FastAPI(title="Jetson YOLO Backend")
worker = DetectionQueueWorker(max_queue_size=32, max_history=120)


class EnqueueFrameRequest(BaseModel):
    frameId: int
    imageData: str
    timestamp: int


@app.on_event("startup")
def on_startup():
    worker.start()


@app.on_event("shutdown")
def on_shutdown():
    worker.stop()


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/enqueue")
def enqueue_frame(body: EnqueueFrameRequest):
    accepted = worker.enqueue(body.model_dump())
    if not accepted:
        raise HTTPException(status_code=429, detail="Frame queue is full")
    return {"accepted": True, "frameId": body.frameId}


@app.get("/results")
def get_results(afterId: int = 0):
    return {"results": worker.get_results_after(afterId)}
