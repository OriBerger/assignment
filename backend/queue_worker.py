from collections import OrderedDict
from queue import Empty, Full, Queue
from threading import Event, Lock, Thread
from time import time

import cv2

from backend.yolo import TinyYoloDetector, decode_image_from_base64

# Long-edge cap before inference; keep aligned with dashboard `CAPTURE_MAX_EDGE_PX`.
MAX_FRAME_EDGE = 480


class DetectionQueueWorker:
    """Background thread that drains a bounded queue of frames, runs YOLO, and stores ordered results."""

    def __init__(self, max_queue_size: int = 32, max_history: int = 100):
        """Configure queue capacity, max retained results, and start a daemon thread (call `start` to run)."""
        self.queue: Queue = Queue(maxsize=max_queue_size)
        self.results = OrderedDict()
        self.max_history = max_history
        self.stop_event = Event()
        self.state_lock = Lock()
        self.detector = None
        self.detector_error = None
        self.next_frame_id = 1
        self.enqueue_lock = Lock()
        self.thread = Thread(target=self._run, daemon=True)

    def start(self) -> None:
        """Start the worker thread that processes queued frames."""
        self.thread.start()

    def stop(self) -> None:
        """Ask the worker loop to exit and join the thread with a short timeout."""
        self.stop_event.set()
        if self.thread.is_alive():
            self.thread.join(timeout=1.0)

    def enqueue(self, payload: dict) -> int | None:
        """Assign a monotonic frame id, push payload onto the queue if not full, or return None."""
        with self.enqueue_lock:
            if self.queue.full():
                return None
            frame_id = self.next_frame_id
            self.next_frame_id += 1
            queued = {**payload, "frameId": frame_id}
            try:
                self.queue.put_nowait(queued)
                return frame_id
            except Full:
                return None

    def get_results_after(self, after_id: int) -> list[dict]:
        """Return all stored results with frame id strictly greater than `after_id`, in insertion order."""
        with self.state_lock:
            return [value for key, value in self.results.items() if key > after_id]

    def clear_session(self) -> None:
        """Drain the pending queue, clear result history, and reset the next frame id to one."""
        with self.enqueue_lock:
            while True:
                try:
                    self.queue.get_nowait()
                    self.queue.task_done()
                except Empty:
                    break
            with self.state_lock:
                self.results.clear()
                self.next_frame_id = 1

    def _run(self) -> None:
        """Worker loop: dequeue frames, decode and resize, run detector once lazily, append bounded results."""
        while not self.stop_event.is_set():
            try:
                payload = self.queue.get(timeout=0.2)
            except Exception:
                continue
            frame_id = payload["frameId"]
            created_at = payload.get("timestamp", int(time() * 1000))
            image_data = payload["imageData"]
            frame = decode_image_from_base64(image_data)
            frame = self._resize_max_edge(frame)
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
                "videoTimeSec": payload.get("videoTimeSec"),
                "processedAt": int(time() * 1000),
                "detections": detections,
                "imageData": image_data,
                "error": error,
            }
            with self.state_lock:
                self.results[frame_id] = result
                while len(self.results) > self.max_history:
                    self.results.popitem(last=False)
            self.queue.task_done()

    @staticmethod
    def _resize_max_edge(frame):
        """Downscale the image so its longest side is at most MAX_FRAME_EDGE pixels."""
        h, w = frame.shape[:2]
        if max(h, w) <= MAX_FRAME_EDGE:
            return frame
        scale = MAX_FRAME_EDGE / max(h, w)
        return cv2.resize(frame, (int(w * scale), int(h * scale)))
