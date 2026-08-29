// Screen-capture OCR: watches a cropped region of the ESPN draft room
// (point it at the pick ticker / pick history panel) and emits player
// names it sees that weren't visible in the previous frame.
import { createWorker } from "tesseract.js";

const norm = (s) =>
  (s || "")
    .toLowerCase()
    .replace(/[.'’\-]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

export class DraftWatcher {
  constructor({ onDetect, onStatus, intervalMs = 4000 }) {
    this.onDetect = onDetect;
    this.onStatus = onStatus || (() => {});
    this.intervalMs = intervalMs;
    this.stream = null;
    this.video = null;
    this.worker = null;
    this.timer = null;
    this.crop = null; // {x,y,w,h} in video pixel coords
    this.prevText = "";
    this.seen = new Set(); // names already reported this session
  }

  async start() {
    this.onStatus("requesting screen…");
    this.stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 2 },
      audio: false,
    });
    this.video = document.createElement("video");
    this.video.srcObject = this.stream;
    this.video.muted = true;
    await this.video.play();
    this.stream.getVideoTracks()[0].addEventListener("ended", () => this.stop());
    this.onStatus("loading OCR engine…");
    this.worker = await createWorker("eng");
    this.onStatus("capturing");
    return this.video; // caller can render preview for crop selection
  }

  setCrop(crop) {
    this.crop = crop;
    this.prevText = "";
  }

  grabFrame() {
    const v = this.video;
    if (!v || v.videoWidth === 0) return null;
    const c = this.crop || { x: 0, y: 0, w: v.videoWidth, h: v.videoHeight };
    const canvas = document.createElement("canvas");
    // upscale small crops for better OCR
    const scale = c.w < 700 ? 2 : 1;
    canvas.width = c.w * scale;
    canvas.height = c.h * scale;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(v, c.x, c.y, c.w, c.h, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  // players: [{id, name, pos}] — pass UNDRAFTED players only
  watch(getUndrafted) {
    this.timer = setInterval(async () => {
      if (!this.worker || !this.video) return;
      const frame = this.grabFrame();
      if (!frame) return;
      try {
        const { data } = await this.worker.recognize(frame);
        const text = norm(data.text);
        if (!text || text === this.prevText) return;
        const fresh = [];
        for (const p of getUndrafted()) {
          const n = norm(p.name);
          if (n.length < 5) continue;
          if (text.includes(n) && !this.prevText.includes(n) && !this.seen.has(n)) {
            this.seen.add(n);
            fresh.push(p);
          }
        }
        this.prevText = text;
        if (fresh.length) this.onDetect(fresh);
      } catch (_) {
        /* skip frame */
      }
    }, this.intervalMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.worker) this.worker.terminate();
    this.stream = this.video = this.worker = null;
    this.onStatus("stopped");
  }
}
