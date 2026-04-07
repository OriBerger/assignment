from collections import OrderedDict
from queue import Full, Queue
from threading import Event, Thread
from time import time

import cv2

from backend.yolo import TinyYoloDetector, decode_image_from_base64


class DetectionQueueWorker:
    def __init__(self, max_queue_size: int = 32, max_history: int = 100):
        self.queue: Queue = Queue(maxsize=max_queue_size)
        self.results = OrderedDict()
        self.max_history = max_history
        self.stop_event = Event()
        self.detector = None
        self.detector_error = None
        self.thread = Thread(target=self._run, daemon=True)

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        if self.thread.is_alive():
            self.thread.join(timeout=1.0)

    def enqueue(self, payload: dict) -> bool:
        try:
            self.queue.put_nowait(payload)
            return True
        except Full:
            return False

    def get_results_after(self, after_id: int) -> list[dict]:
        return [value for key, value in self.results.items() if key > after_id]

    def _run(self) -> None:
        while not self.stop_event.is_set():
            try:
                payload = self.queue.get(timeout=0.2)
            except Exception:
                continue
            frame_id = payload["frameId"]
            created_at = payload.get("timestamp", int(time() * 1000))
            image_data = payload["imageData"]
            frame = decode_image_from_base64(image_data)
            frame = self._resize_max_640(frame)
            detections = []
            error = None
            try:
                if self.detector is None and self.detector_error is None:
                    self.detector = TinyYoloDetector()
                if self.detector is not None:
                    detections = self.detector.detect(frame)
            except Exception as exc:
                self.detector_error = str(exc)
                error = self.detector_error
            result = {
                "frameId": frame_id,
                "timestamp": created_at,
                "processedAt": int(time() * 1000),
                "detections": detections,
                "imageData": image_data,
                "error": error,
            }
            self.results[frame_id] = result
            while len(self.results) > self.max_history:
                self.results.popitem(last=False)
            self.queue.task_done()

    @staticmethod
    def _resize_max_640(frame):
        h, w = frame.shape[:2]
        if max(h, w) <= 640:
            return frame
        scale = 640.0 / max(h, w)
        return cv2.resize(frame, (int(w * scale), int(h * scale)))
