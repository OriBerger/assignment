import base64
from pathlib import Path

import cv2
import numpy as np


MODELS_DIR = Path(__file__).parent / "models"
CFG_PATH = MODELS_DIR / "yolov3-tiny.cfg"
WEIGHTS_PATH = MODELS_DIR / "yolov3-tiny.weights"
LABELS_PATH = MODELS_DIR / "coco.names"


def ensure_model_files() -> None:
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    missing = []
    if not CFG_PATH.exists():
        missing.append(str(CFG_PATH))
    if not WEIGHTS_PATH.exists():
        missing.append(str(WEIGHTS_PATH))
    if missing:
        joined = ", ".join(missing)
        raise RuntimeError(
            f"Missing YOLO model files: {joined}. "
            "Expected these files to exist in backend/models."
        )


def decode_image_from_base64(data_url: str) -> np.ndarray:
    payload = data_url.split(",", 1)[-1]
    image_bytes = base64.b64decode(payload)
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if frame is None:
        raise ValueError("Could not decode input image")
    return frame


class TinyYoloDetector:
    def __init__(self, conf_threshold: float = 0.2, nms_threshold: float = 0.35):
        ensure_model_files()
        self.labels = [
            line.strip()
            for line in LABELS_PATH.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        self.net = cv2.dnn.readNetFromDarknet(str(CFG_PATH), str(WEIGHTS_PATH))
        self.output_layers = self.net.getUnconnectedOutLayersNames()
        self.conf_threshold = conf_threshold
        self.nms_threshold = nms_threshold

    def detect(self, frame: np.ndarray) -> list[dict]:
        h, w = frame.shape[:2]
        blob = cv2.dnn.blobFromImage(
            frame,
            scalefactor=1 / 255.0,
            size=(416, 416),
            swapRB=True,
            crop=False,
        )
        self.net.setInput(blob)
        layer_outputs = self.net.forward(self.output_layers)

        boxes = []
        confidences = []
        class_ids = []

        for output in layer_outputs:
            for detection in output:
                scores = detection[5:]
                class_id = int(np.argmax(scores))
                objectness = float(detection[4])
                confidence = float(scores[class_id]) * objectness
                if confidence < self.conf_threshold:
                    continue
                center_x = int(detection[0] * w)
                center_y = int(detection[1] * h)
                box_w = int(detection[2] * w)
                box_h = int(detection[3] * h)
                x = int(center_x - box_w / 2)
                y = int(center_y - box_h / 2)
                boxes.append([x, y, box_w, box_h])
                confidences.append(confidence)
                class_ids.append(class_id)

        indices = cv2.dnn.NMSBoxes(
            boxes, confidences, self.conf_threshold, self.nms_threshold
        )

        detections = []
        if len(indices) == 0:
            return detections

        for idx in indices.flatten():
            x, y, bw, bh = boxes[idx]
            label = self.labels[class_ids[idx]] if class_ids[idx] < len(self.labels) else "unknown"
            detections.append(
                {
                    "label": label,
                    "confidence": round(confidences[idx], 3),
                    "x": max(0.0, min(1.0, x / w)),
                    "y": max(0.0, min(1.0, y / h)),
                    "w": max(0.0, min(1.0, bw / w)),
                    "h": max(0.0, min(1.0, bh / h)),
                }
            )
        return detections
