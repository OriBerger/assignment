"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const LIVE_INTERVALS = [350, 500, 750, 1000, 1500, 2000];

function cloneDetections(detections) {
  return detections.map((d) => ({ ...d }));
}

function summarizeDetections(detections) {
  if (!detections.length) {
    return "The results of this frame are: no objects detected.";
  }
  const counts = {};
  detections.forEach((d) => {
    counts[d.label] = (counts[d.label] || 0) + 1;
  });
  const sentence = Object.entries(counts)
    .map(([label, count]) => `${count} ${label}`)
    .join(", ");
  return `The results of this frame are: ${sentence}.`;
}

function drawDetections(canvas, detections) {
  if (!canvas) {
    return;
  }
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = "#5fd0ff";
  ctx.lineWidth = 2;
  ctx.font = "12px Arial";
  ctx.fillStyle = "#5fd0ff";

  detections.forEach((d) => {
    const x = d.x * width;
    const y = d.y * height;
    const w = d.w * width;
    const h = d.h * height;
    ctx.strokeRect(x, y, w, h);
    const text = `${d.label} ${(d.confidence * 100).toFixed(1)}%`;
    ctx.fillText(text, x + 2, Math.max(12, y - 4));
  });
}

function FramePreview({ frame }) {
  const previewCanvasRef = useRef(null);
  useEffect(() => {
    if (!frame) {
      return;
    }
    const canvas = previewCanvasRef.current;
    const syncSize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width;
      canvas.height = rect.height;
      drawDetections(canvas, frame.detections);
    };
    syncSize();
    window.addEventListener("resize", syncSize);
    return () => window.removeEventListener("resize", syncSize);
  }, [frame]);

  if (!frame) {
    return <div className="statusText">No gallery frame selected.</div>;
  }

  return (
    <>
      <div className="previewWrap">
        <img src={frame.imageData} alt={`Frame ${frame.frameId}`} />
        <canvas ref={previewCanvasRef} />
      </div>
      <div className="statusText">{summarizeDetections(frame.detections)}</div>
    </>
  );
}

export default function HomePage() {
  const videoRef = useRef(null);
  const overlayCanvasRef = useRef(null);
  const captureCanvasRef = useRef(null);
  const captureInFlightRef = useRef(false);
  const pollInFlightRef = useRef(false);
  const [liveEnabled, setLiveEnabled] = useState(false);
  const [liveIntervalMs, setLiveIntervalMs] = useState(1000);
  const [lastFetchedId, setLastFetchedId] = useState(0);
  const [pendingFrameIds, setPendingFrameIds] = useState([]);
  const [history, setHistory] = useState([]);
  const [historyMap, setHistoryMap] = useState({});
  const [selectedFrameId, setSelectedFrameId] = useState(null);
  const [currentOverlay, setCurrentOverlay] = useState([]);
  const [currentStatus, setCurrentStatus] = useState("Waiting for first analysis result.");

  const selectedFrame = useMemo(
    () => (selectedFrameId ? historyMap[selectedFrameId] : null),
    [selectedFrameId, historyMap]
  );
  const sortedHistory = useMemo(
    () => [...history].sort((a, b) => a.frameId - b.frameId),
    [history]
  );
  const selectedFrameIndex = useMemo(
    () => sortedHistory.findIndex((item) => item.frameId === selectedFrameId),
    [selectedFrameId, sortedHistory]
  );
  const canGoPrev = selectedFrameIndex > 0;
  const canGoNext = selectedFrameIndex >= 0 && selectedFrameIndex < sortedHistory.length - 1;

  const resizeOverlay = () => {
    const video = videoRef.current;
    const canvas = overlayCanvasRef.current;
    if (!video || !canvas) {
      return;
    }
    const rect = video.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    drawDetections(canvas, currentOverlay);
  };

  useEffect(() => {
    resizeOverlay();
    window.addEventListener("resize", resizeOverlay);
    return () => window.removeEventListener("resize", resizeOverlay);
  }, [currentOverlay]);

  const captureFrame = async () => {
    if (captureInFlightRef.current) {
      return;
    }
    if (liveEnabled && pendingFrameIds.length >= 2) {
      return;
    }
    captureInFlightRef.current = true;
    try {
      const video = videoRef.current;
      if (!video || video.readyState < 2) {
        return;
      }

      const rawW = video.videoWidth || 640;
      const rawH = video.videoHeight || 360;
      const scale = 640 / Math.max(rawW, rawH);
      const targetScale = Math.min(1, scale);
      const width = Math.max(1, Math.floor(rawW * targetScale));
      const height = Math.max(1, Math.floor(rawH * targetScale));

      const captureCanvas = captureCanvasRef.current;
      captureCanvas.width = width;
      captureCanvas.height = height;
      const ctx = captureCanvas.getContext("2d");
      ctx.drawImage(video, 0, 0, width, height);

      const imageData = captureCanvas.toDataURL("image/jpeg", 0.72);
      const response = await fetch("/api/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageData,
          timestamp: Date.now()
        })
      });
      if (response.ok) {
        const data = await response.json();
        if (typeof data.frameId === "number") {
          setPendingFrameIds((prev) => [...prev, data.frameId]);
        }
      } else if (response.status === 429) {
        setCurrentStatus("Queue is full. Increase interval or wait for processing.");
      }
    } finally {
      captureInFlightRef.current = false;
    }
  };

  useEffect(() => {
    if (!liveEnabled) {
      return;
    }
    const interval = setInterval(() => {
      captureFrame();
    }, liveIntervalMs);
    return () => clearInterval(interval);
  }, [liveEnabled, liveIntervalMs, pendingFrameIds.length]);

  useEffect(() => {
    let canceled = false;

    const fetchInitialHistory = async () => {
      try {
        const response = await fetch("/api/results?afterId=0", { cache: "no-store" });
        if (!response.ok || canceled) {
          return;
        }
        const data = await response.json();
        const incoming = (data.results || []).sort((a, b) => a.frameId - b.frameId);
        if (!incoming.length || canceled) {
          return;
        }

        const recent = incoming.slice(-250);
        const nextMap = {};
        recent.forEach((item) => {
          nextMap[item.frameId] = item;
        });

        setHistory(recent);
        setHistoryMap(nextMap);
        setSelectedFrameId(recent[recent.length - 1].frameId);
        setLastFetchedId(recent[recent.length - 1].frameId);
      } catch {
        // Ignore bootstrap errors and rely on regular polling.
      }
    };

    fetchInitialHistory();

    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    if (!liveEnabled && pendingFrameIds.length === 0) {
      return undefined;
    }

    const pollMs = liveEnabled ? 700 : 1000;
    const poll = setInterval(async () => {
      if (pollInFlightRef.current) {
        return;
      }
      pollInFlightRef.current = true;
      try {
        const response = await fetch(`/api/results?afterId=${lastFetchedId}`, { cache: "no-store" });
        if (!response.ok) {
          return;
        }
        const data = await response.json();
        const incoming = (data.results || []).sort((a, b) => a.frameId - b.frameId);
        if (!incoming.length) {
          return;
        }

        setHistory((prev) => {
          const combined = [...prev, ...incoming];
          return combined.slice(-250);
        });
        setHistoryMap((prev) => {
          const next = { ...prev };
          incoming.forEach((item) => {
            next[item.frameId] = item;
          });
          const ids = Object.keys(next).map(Number).sort((a, b) => a - b);
          while (ids.length > 250) {
            const first = ids.shift();
            delete next[first];
          }
          return next;
        });
        setPendingFrameIds((prev) => {
          const done = new Set(incoming.map((item) => item.frameId));
          return prev.filter((id) => !done.has(id));
        });

        const newest = incoming[incoming.length - 1];
        // Keep video overlay state independent from gallery frame objects.
        setCurrentOverlay(cloneDetections(newest.detections));
        setCurrentStatus(
          newest.error
            ? `Detection backend error: ${newest.error}`
            : summarizeDetections(newest.detections)
        );
        setLastFetchedId(newest.frameId);
      } finally {
        pollInFlightRef.current = false;
      }
    }, pollMs);

    return () => clearInterval(poll);
  }, [lastFetchedId, liveEnabled, pendingFrameIds.length]);

  const moveSelected = (direction) => {
    if (!selectedFrameId || !sortedHistory.length) {
      return;
    }
    const nextIdx = selectedFrameIndex + direction;
    if (nextIdx < 0 || nextIdx >= sortedHistory.length) {
      return;
    }
    setSelectedFrameId(sortedHistory[nextIdx].frameId);
  };

  const clearOverlay = () => {
    if (liveEnabled) {
      return;
    }
    setCurrentOverlay([]);
  };

  const clearSession = async () => {
    if (liveEnabled) {
      return;
    }
    const response = await fetch("/api/session/clear", {
      method: "POST",
      cache: "no-store"
    });
    if (!response.ok) {
      setCurrentStatus("Unable to clear session history.");
      return;
    }
    setPendingFrameIds([]);
    setHistory([]);
    setHistoryMap({});
    setSelectedFrameId(null);
    setCurrentOverlay([]);
    setLastFetchedId(0);
    setCurrentStatus("Session cleared. Ready for new analysis.");
  };

  return (
    <main className="dashboard">
      <section className="topRow">
        <article className="videoCard">
          <div className="videoWrap">
            <video ref={videoRef} src="/placeholder.mp4" autoPlay muted loop playsInline />
            <canvas ref={overlayCanvasRef} />
          </div>
          <div className="controls">
            <button onClick={() => setLiveEnabled((x) => !x)}>
              {liveEnabled ? "Stop Live Analysis" : "Start Live Analysis"}
            </button>
            <select value={liveIntervalMs} onChange={(e) => setLiveIntervalMs(Number(e.target.value))}>
              {LIVE_INTERVALS.map((value) => (
                <option key={value} value={value}>
                  {value} ms
                </option>
              ))}
            </select>
            <button onClick={captureFrame} disabled={liveEnabled}>
              Capture Frame
            </button>
            <button onClick={clearOverlay} disabled={liveEnabled}>
              Clear Overlay
            </button>
            <button onClick={clearSession} disabled={liveEnabled}>
              Clear Session
            </button>
          </div>
          <div className="statusText">{currentStatus}</div>
          <canvas ref={captureCanvasRef} style={{ display: "none" }} />
        </article>

        <article className="sideCard">
          <h3>
            Selected Gallery Frame
            {selectedFrame ? ` (#${selectedFrame.frameId})` : ""}
          </h3>
          <FramePreview frame={selectedFrame} />
          <div className="controls">
            <button onClick={() => moveSelected(-1)} disabled={!canGoPrev}>
              Prev
            </button>
            <button onClick={() => moveSelected(1)} disabled={!canGoNext}>
              Next
            </button>
          </div>
        </article>
      </section>

      <section className="galleryCard">
        <h3>Frames History</h3>
        <div className="thumbRow">
          {sortedHistory.map((frame) => (
              <div
                key={frame.frameId}
                className={`thumb ${selectedFrameId === frame.frameId ? "selected" : ""}`}
                onClick={() => setSelectedFrameId(frame.frameId)}
              >
                <img src={frame.imageData} alt={`Frame ${frame.frameId}`} />
                <div className="meta">Frame #{frame.frameId}</div>
                <div className="meta">{summarizeDetections(frame.detections)}</div>
              </div>
            ))}
        </div>
      </section>
    </main>
  );
}
