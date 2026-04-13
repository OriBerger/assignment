"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";

const LIVE_INTERVALS = [350, 500, 750, 1000, 1500, 2000];
/** COCO class id 0 name — matches backend/models/coco.names */
const COCO_PERSON_LABEL = "person";
/** Long-edge cap for captured frames; lower = smaller payloads and less UI lag. Matches backend `MAX_FRAME_EDGE`. */
const CAPTURE_MAX_EDGE_PX = 480;
const CAPTURE_JPEG_QUALITY = 0.65;
const MEMORY_CHART_WIDTH = 130;
const MEMORY_CHART_HEIGHT = 38;
const MEMORY_CHART_MAX_MB = 1024;
const MEMORY_CHART_PAD = { top: 2, right: 2, bottom: 2, left: 28 };

/** Shallow-clone detection objects so overlay state updates without mutating gallery frame references. */
function cloneDetections(detections) {
  return detections.map((d) => ({ ...d }));
}

/**
 * Formats MP4 playback time (HTMLMediaElement.currentTime) as H:MM:SS or M:SS for labels and thumbnails.
 */
function formatVideoPlaybackClock(totalSeconds) {
  if (typeof totalSeconds !== "number" || Number.isNaN(totalSeconds)) {
    return null;
  }
  const t = Math.max(0, totalSeconds);
  const whole = Math.floor(t);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  // Pads minutes and seconds to two digits for stable clock display.
  const pad2 = (n) => String(n).padStart(2, "0");
  if (h > 0) {
    return `${h}:${pad2(m)}:${pad2(s)}`;
  }
  return `${m}:${pad2(s)}`;
}

/** Builds a human-readable label with frame id and optional video clock for UI and accessibility text. */
function formatFrameWithVideoTime(frame) {
  if (!frame || typeof frame.frameId !== "number") {
    return "";
  }
  const clock = formatVideoPlaybackClock(frame.videoTimeSec);
  return clock
    ? `Frame #${frame.frameId} time: ${clock}`
    : `Frame #${frame.frameId}`;
}

/** Turns raw detection rows into one short natural-language summary line for status and gallery meta. */
function summarizeDetections(detections) {
  if (!detections.length) {
    return "No objects detected in this frame.";
  }
  const counts = {};
  detections.forEach((d) => {
    counts[d.label] = (counts[d.label] || 0) + 1;
  });
  const sentence = Object.entries(counts)
    .map(([label, count]) => `${count} ${label}${count > 1 ? "s" : ""}`)
    .join(", ");
  return `The AI analysis of this frame found ${sentence}.`;
}

/** Returns whether the frame has a COCO "person" detection and no backend error (for the people strip). */
function frameHasPerson(frame) {
  if (!frame?.detections?.length || frame.error) {
    return false;
  }
  return frame.detections.some((d) => d.label === COCO_PERSON_LABEL);
}

/** Memoized row thumbnail: image, time label, AI summary, and keyboard-accessible selection. */
const FrameGalleryThumb = memo(
  function FrameGalleryThumb({ frame, selected, onSelect, lazyImage = false }) {
    return (
      <div
        className={`thumb ${selected ? "selected" : ""}`}
        onClick={() => onSelect(frame.frameId)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(frame.frameId);
          }
        }}
        role="button"
        tabIndex={0}
        aria-current={selected ? "true" : undefined}
        aria-label={formatFrameWithVideoTime(frame)}
      >
        <img
          src={frame.imageData}
          alt={formatFrameWithVideoTime(frame)}
          loading={lazyImage ? "lazy" : "eager"}
          decoding="async"
        />
        <div className="meta">{formatFrameWithVideoTime(frame)}</div>
        <div className="meta aiResultText">{summarizeDetections(frame.detections)}</div>
      </div>
    );
  },
  // Re-render only when selection, frame reference, or lazy-loading mode changes (avoids thumb flicker).
  (prev, next) =>
    prev.selected === next.selected &&
    prev.frame === next.frame &&
    prev.lazyImage === next.lazyImage
);

/** Formats backend memory JSON into a compact RAM string for the header pill (used vs limit and percent). */
function formatMemoryStatus(memory) {
  if (!memory?.ok || typeof memory.usedMB !== "number") {
    return "RAM: --";
  }
  const used = `${memory.usedMB.toFixed(1)}MB`;
  if (typeof memory.limitMB === "number" && memory.limitMB > 0) {
    const percent =
      typeof memory.usagePercent === "number"
        ? ` (${memory.usagePercent.toFixed(1)}%)`
        : "";
    return `RAM: ${used} / ${memory.limitMB.toFixed(1)}MB${percent}`;
  }
  return `RAM: ${used}`;
}

/** Maps memory payload to a CSS class for green, warn, high, or offline styling on the RAM pill. */
function getMemoryPillClass(memory) {
  if (!memory?.ok || typeof memory.usedMB !== "number") {
    return "memoryPill memoryPillOffline";
  }
  if (typeof memory.usagePercent !== "number") {
    return "memoryPill";
  }
  if (memory.usagePercent >= 85) {
    return "memoryPill memoryPillHigh";
  }
  if (memory.usagePercent >= 65) {
    return "memoryPill memoryPillWarn";
  }
  return "memoryPill memoryPillGood";
}

/** Converts a series of MB samples into SVG polyline point coordinates inside the chart padding box. */
function buildSparklinePoints(values, width, height, maxMb, pad) {
  if (!values.length) {
    return "";
  }
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  return values
    .map((v, i) => {
      const clamped = Math.max(0, Math.min(maxMb, v));
      const normalized = clamped / maxMb;
      const x =
        pad.left +
        (values.length === 1 ? innerW : (i / (values.length - 1)) * innerW);
      const y = pad.top + (1 - normalized) * innerH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

/** Draws normalized detection boxes and confidence labels on a 2D canvas over video or still preview. */
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

/** Side-panel preview: shows the selected frame image with a resizable overlay canvas for bounding boxes. */
function FramePreview({ frame }) {
  const previewCanvasRef = useRef(null);
  useEffect(() => {
    if (!frame) {
      return;
    }
    const canvas = previewCanvasRef.current;
    // Match canvas bitmap size to CSS size and redraw boxes on window resize.
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
        <img src={frame.imageData} alt={formatFrameWithVideoTime(frame)} />
        <canvas ref={previewCanvasRef} />
      </div>
      <div className="statusText frameTimeLabel">{formatFrameWithVideoTime(frame)}</div>
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
  const [memoryInfo, setMemoryInfo] = useState(null);
  const [memoryHistory, setMemoryHistory] = useState([]);

  const selectedFrame = useMemo(
    () => (selectedFrameId ? historyMap[selectedFrameId] : null),
    [selectedFrameId, historyMap]
  );
  const sortedHistory = useMemo(
    () => [...history].sort((a, b) => a.frameId - b.frameId),
    [history]
  );
  const personHistory = useMemo(
    () => sortedHistory.filter(frameHasPerson),
    [sortedHistory]
  );
  const selectedFrameIndex = useMemo(
    () => sortedHistory.findIndex((item) => item.frameId === selectedFrameId),
    [selectedFrameId, sortedHistory]
  );
  const canGoPrev = selectedFrameIndex > 0;
  const canGoNext = selectedFrameIndex >= 0 && selectedFrameIndex < sortedHistory.length - 1;
  const canGoPrevPerson =
    personHistory.length > 0 &&
    (selectedFrameId == null || personHistory.some((item) => item.frameId < selectedFrameId));
  const canGoNextPerson =
    personHistory.length > 0 &&
    (selectedFrameId == null || personHistory.some((item) => item.frameId > selectedFrameId));

  // Sizes the video overlay canvas to the video element and redraws the latest detection boxes.
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

  // Keeps the video overlay canvas sized and redrawn when the window resizes or overlay detections change.
  useEffect(() => {
    resizeOverlay();
    window.addEventListener("resize", resizeOverlay);
    return () => window.removeEventListener("resize", resizeOverlay);
  }, [currentOverlay]);

  // Grabs the current video frame, JPEG-encodes it, POSTs to enqueue, and tracks pending frame ids.
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

      const rawW = video.videoWidth || 854;
      const rawH = video.videoHeight || 480;
      const scale = CAPTURE_MAX_EDGE_PX / Math.max(rawW, rawH);
      const targetScale = Math.min(1, scale);
      const width = Math.max(1, Math.floor(rawW * targetScale));
      const height = Math.max(1, Math.floor(rawH * targetScale));

      const captureCanvas = captureCanvasRef.current;
      captureCanvas.width = width;
      captureCanvas.height = height;
      const ctx = captureCanvas.getContext("2d");
      ctx.drawImage(video, 0, 0, width, height);

      const imageData = captureCanvas.toDataURL("image/jpeg", CAPTURE_JPEG_QUALITY);
      const response = await fetch("/api/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageData,
          timestamp: Date.now(),
          videoTimeSec: video.currentTime
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

  // While live mode is on, fires capture on a fixed interval and backs off when too many frames are in flight.
  useEffect(() => {
    if (!liveEnabled) {
      return;
    }
    const interval = setInterval(() => {
      captureFrame();
    }, liveIntervalMs);
    return () => clearInterval(interval);
  }, [liveEnabled, liveIntervalMs, pendingFrameIds.length]);

  // One-shot bootstrap: hydrate gallery from any results already on the server after navigation or reload.
  useEffect(() => {
    let canceled = false;

    // On mount, loads the last chunk of server results so a refresh keeps gallery state when possible.
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

  // Polls the results API whenever there is work in flight or live mode; faster interval when live is enabled.
  useEffect(() => {
    if (!liveEnabled && pendingFrameIds.length === 0) {
      return undefined;
    }

    const pollMs = liveEnabled ? 700 : 1000;
    // Polls for new results after lastFetchedId, merges history, updates overlay from newest, drains pending ids.
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
            : `${formatFrameWithVideoTime(newest)} — ${summarizeDetections(newest.detections)}`
        );
        setLastFetchedId(newest.frameId);
      } finally {
        pollInFlightRef.current = false;
      }
    }, pollMs);

    return () => clearInterval(poll);
  }, [lastFetchedId, liveEnabled, pendingFrameIds.length]);

  // Memory HUD: initial read plus periodic samples for the header pill and sparkline (runs for the page lifetime).
  useEffect(() => {
    let canceled = false;

    // Fetches cgroup-style RAM from the backend proxy and appends samples for the sparkline chart.
    const fetchMemory = async () => {
      try {
        const response = await fetch("/api/runtime/memory", { cache: "no-store" });
        if (!response.ok || canceled) {
          return;
        }
        const data = await response.json();
        if (!canceled) {
          setMemoryInfo(data);
          if (data?.ok && typeof data.usedMB === "number") {
            setMemoryHistory((prev) => [...prev, data.usedMB].slice(-40));
          }
        }
      } catch {
        if (!canceled) {
          setMemoryInfo({ ok: false });
        }
      }
    };

    fetchMemory();
    const interval = setInterval(fetchMemory, 2000);
    return () => {
      canceled = true;
      clearInterval(interval);
    };
  }, []);

  // Moves gallery selection to the previous or next frame in sorted history (Prev/Next buttons).
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

  // Jumps to previous/next frame containing a detected person (independent from regular gallery navigation).
  const moveSelectedPerson = (direction) => {
    if (!personHistory.length) {
      return;
    }
    if (selectedFrameId == null) {
      setSelectedFrameId(
        direction < 0
          ? personHistory[personHistory.length - 1].frameId
          : personHistory[0].frameId
      );
      return;
    }
    const target =
      direction < 0
        ? [...personHistory].reverse().find((item) => item.frameId < selectedFrameId)
        : personHistory.find((item) => item.frameId > selectedFrameId);
    if (target) {
      setSelectedFrameId(target.frameId);
    }
  };

  // Clears detection boxes on the video overlay in manual mode (disabled while live analysis runs).
  const clearOverlay = () => {
    if (liveEnabled) {
      return;
    }
    setCurrentOverlay([]);
  };

  // Calls backend session clear, then resets local history, selection, and polling cursor (manual mode only).
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

  // Precomputes SVG point string for the RAM sparkline from the rolling MB history buffer.
  const sparklinePoints = useMemo(
    () =>
      buildSparklinePoints(
        memoryHistory,
        MEMORY_CHART_WIDTH,
        MEMORY_CHART_HEIGHT,
        MEMORY_CHART_MAX_MB,
        MEMORY_CHART_PAD
      ),
    [memoryHistory]
  );

  return (
    <main className="dashboard">
      <header className="appHeader">
        <div>
          <h1>Jetson AI Dashboard</h1>
          <p>Real-time computer vision insights from your video stream</p>
        </div>
        <div className="memoryHud">
          <div className={getMemoryPillClass(memoryInfo)}>{formatMemoryStatus(memoryInfo)}</div>
          <div className="memorySparkline" aria-label="RAM usage over time">
            <svg
              viewBox={`0 0 ${MEMORY_CHART_WIDTH} ${MEMORY_CHART_HEIGHT}`}
              preserveAspectRatio="none"
            >
              <defs>
                <linearGradient id="ramLine" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#33e4ff" />
                  <stop offset="100%" stopColor="#7c4dff" />
                </linearGradient>
                <linearGradient id="ramFill" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="rgba(51, 228, 255, 0.3)" />
                  <stop offset="100%" stopColor="rgba(51, 228, 255, 0.02)" />
                </linearGradient>
              </defs>
              <line
                x1={MEMORY_CHART_PAD.left - 1}
                y1={MEMORY_CHART_PAD.top}
                x2={MEMORY_CHART_PAD.left - 1}
                y2={MEMORY_CHART_HEIGHT - MEMORY_CHART_PAD.bottom}
                className="sparklineAxis"
              />
              <line
                x1={MEMORY_CHART_PAD.left}
                y1={MEMORY_CHART_PAD.top}
                x2={MEMORY_CHART_WIDTH - MEMORY_CHART_PAD.right}
                y2={MEMORY_CHART_PAD.top}
                className="sparklineGrid"
              />
              <line
                x1={MEMORY_CHART_PAD.left}
                y1={MEMORY_CHART_PAD.top + (MEMORY_CHART_HEIGHT - MEMORY_CHART_PAD.top - MEMORY_CHART_PAD.bottom) / 2}
                x2={MEMORY_CHART_WIDTH - MEMORY_CHART_PAD.right}
                y2={MEMORY_CHART_PAD.top + (MEMORY_CHART_HEIGHT - MEMORY_CHART_PAD.top - MEMORY_CHART_PAD.bottom) / 2}
                className="sparklineGrid"
              />
              <line
                x1={MEMORY_CHART_PAD.left}
                y1={MEMORY_CHART_HEIGHT - MEMORY_CHART_PAD.bottom}
                x2={MEMORY_CHART_WIDTH - MEMORY_CHART_PAD.right}
                y2={MEMORY_CHART_HEIGHT - MEMORY_CHART_PAD.bottom}
                className="sparklineBase"
              />
              <text x="2" y={MEMORY_CHART_PAD.top + 4} className="sparklineYLabel">
                1024mb
              </text>
              <text
                x="2"
                y={MEMORY_CHART_PAD.top + (MEMORY_CHART_HEIGHT - MEMORY_CHART_PAD.top - MEMORY_CHART_PAD.bottom) / 2 + 3}
                className="sparklineYLabel"
              >
                512mb
              </text>
              {sparklinePoints ? (
                <>
                  <polygon
                    points={`${sparklinePoints} ${MEMORY_CHART_WIDTH - MEMORY_CHART_PAD.right},${MEMORY_CHART_HEIGHT - MEMORY_CHART_PAD.bottom} ${MEMORY_CHART_PAD.left},${MEMORY_CHART_HEIGHT - MEMORY_CHART_PAD.bottom}`}
                    fill="url(#ramFill)"
                    className="sparklineArea"
                  />
                  <polyline
                    points={sparklinePoints}
                    fill="none"
                    stroke="url(#ramLine)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="sparklineLine"
                  />
                </>
              ) : (
                <text x="65" y="23" textAnchor="middle" className="sparklineEmpty">
                  collecting...
                </text>
              )}
            </svg>
          </div>
        </div>
      </header>
      <section className="topRow">
        <article className="videoCard">
          <div className="videoWrap">
            <video ref={videoRef} src="/placeholder.mp4" autoPlay muted loop playsInline controls />
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
          <div className="statusText aiResultText">{currentStatus}</div>
          <canvas ref={captureCanvasRef} style={{ display: "none" }} />
        </article>

        <article className="sideCard">
          <h3 className="sectionTitle">
            Selected Gallery Frame
            {selectedFrame ? ` — ${formatFrameWithVideoTime(selectedFrame)}` : ""}
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
          <div className="controls">
            <button onClick={() => moveSelectedPerson(-1)} disabled={!canGoPrevPerson}>
              Prev person
            </button>
            <button onClick={() => moveSelectedPerson(1)} disabled={!canGoNextPerson}>
              Next person
            </button>
          </div>
        </article>
      </section>

      <section className="galleryCard" aria-labelledby="all-frames-title">
        <h3 className="sectionTitle" id="all-frames-title">
          Gallery
        </h3>
        {sortedHistory.length === 0 ? (
          <p className="statusText galleryEmptyHint">No frames in gallery yet.</p>
        ) : (
          <div className="thumbRow">
            {sortedHistory.map((frame) => (
              <FrameGalleryThumb
                key={frame.frameId}
                frame={frame}
                selected={selectedFrameId === frame.frameId}
                onSelect={setSelectedFrameId}
                lazyImage={false}
              />
            ))}
          </div>
        )}
      </section>

      <section className="galleryCard" aria-labelledby="person-frames-title">
        <h3 className="sectionTitle" id="person-frames-title">
          People frames
        </h3>
        {personHistory.length === 0 ? (
          <p className="statusText galleryEmptyHint">
            No frames with a detected person yet.
          </p>
        ) : (
          <div className="thumbRow">
            {personHistory.map((frame) => (
              <FrameGalleryThumb
                key={frame.frameId}
                frame={frame}
                selected={selectedFrameId === frame.frameId}
                onSelect={setSelectedFrameId}
                lazyImage
              />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
