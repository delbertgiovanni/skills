import { readFileSync } from 'node:fs';
import { deflateSync, gunzipSync } from 'node:zlib';

export function loadAtlas(path) {
  const raw = gunzipSync(readFileSync(path));
  const n = raw.readUInt32LE(0);
  const header = JSON.parse(raw.subarray(4, 4 + n).toString('utf8'));
  const data = raw.subarray(4 + n);
  const S = header.scale;
  const faces = {};
  for (const [name, f] of Object.entries(header.faces)) {
    const glyphs = new Map();
    for (const [cp, g] of Object.entries(f.glyphs)) {
      glyphs.set(Number(cp), { adv: g[0], x0: g[1], y0: g[2], w: g[3], h: g[4], off: g[5] });
    }
    faces[name] = new Face(name, S, f.ascent / S, f.descent / S, glyphs, data);
  }
  return { scale: S, faces };
}

export const missing = new Set();

class Face {
  constructor(name, S, ascent, descent, glyphs, data) {
    Object.assign(this, { name, S, ascent, descent, glyphs, data });
    this.height = ascent + descent;
    this.fallback = glyphs.get(63);
  }

  glyph(cp) {
    const g = this.glyphs.get(cp);
    if (g) return g;
    missing.add(String.fromCodePoint(cp));
    return this.fallback;
  }

  width(str) {
    let w = 0;
    for (const ch of str) w += this.glyph(ch.codePointAt(0)).adv;
    return w / this.S;
  }
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function hex(v) {
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function roundRectSdf(x, y, w, h, r) {
  const cx = x + w / 2, cy = y + h / 2, hx = w / 2, hy = h / 2;
  const rr = Math.max(0, Math.min(r, hx, hy));
  return (px, py) => {
    const qx = Math.abs(px - cx) - hx + rr, qy = Math.abs(py - cy) - hy + rr;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rr;
  };
}

function segmentSdf(x1, y1, x2, y2, half) {
  const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy || 1;
  return (px, py) => {
    const t = clamp01(((px - x1) * dx + (py - y1) * dy) / len2);
    return Math.hypot(px - x1 - t * dx, py - y1 - t * dy) - half;
  };
}

export class Layer {
  constructor(w, h) {
    this.w = Math.max(1, Math.ceil(w));
    this.h = Math.max(1, Math.ceil(h));
    this.a = new Float32Array(this.w * this.h);
  }

  text(face, str, x, baseline) {
    let pen = x;
    for (const ch of str) {
      const g = face.glyph(ch.codePointAt(0));
      const gx = Math.round(pen + g.x0), gy = Math.round(baseline + g.y0);
      for (let j = 0; j < g.h; j++) {
        const y = gy + j;
        if (y < 0 || y >= this.h) continue;
        for (let i = 0; i < g.w; i++) {
          const xx = gx + i;
          if (xx < 0 || xx >= this.w) continue;
          const k = y * this.w + xx;
          this.a[k] = Math.min(1, this.a[k] + face.data[g.off + j * g.w + i] / 255);
        }
      }
      pen += g.adv;
    }
  }

  boxBlur(r) {
    const { w, h } = this, size = 2 * r + 1, tmp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let k = -r; k <= r; k++) {
          const xx = x + k;
          if (xx >= 0 && xx < w) s += this.a[y * w + xx];
        }
        tmp[y * w + x] = s / size;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let k = -r; k <= r; k++) {
          const yy = y + k;
          if (yy >= 0 && yy < h) s += tmp[yy * w + x];
        }
        this.a[y * w + x] = s / size;
      }
    }
  }
}

export class Canvas {
  constructor(x, y, w, h, scale) {
    this.S = scale;
    this.ox = x;
    this.oy = y;
    this.W = Math.ceil(w * scale);
    this.H = Math.ceil(h * scale);
    this.px = new Float32Array(this.W * this.H * 3);
    this.clipSdf = null;
  }

  dx(x) { return (x - this.ox) * this.S; }
  dy(y) { return (y - this.oy) * this.S; }

  setClipRoundRect(x, y, w, h, r) {
    this.clipSdf = roundRectSdf(this.dx(x), this.dy(y), w * this.S, h * this.S, r * this.S);
  }

  clearClip() { this.clipSdf = null; }

  blend(i, c, a) {
    if (a <= 0) return;
    const p = this.px, k = i * 3;
    p[k] += (c[0] - p[k]) * a;
    p[k + 1] += (c[1] - p[k + 1]) * a;
    p[k + 2] += (c[2] - p[k + 2]) * a;
  }

  fillSdf(x0, y0, x1, y1, sdf, color, alpha, colorAt) {
    const sx = Math.max(0, Math.floor(x0)), ex = Math.min(this.W, Math.ceil(x1));
    const sy = Math.max(0, Math.floor(y0)), ey = Math.min(this.H, Math.ceil(y1));
    const clip = this.clipSdf;
    for (let py = sy; py < ey; py++) {
      for (let px = sx; px < ex; px++) {
        const cx = px + 0.5, cy = py + 0.5;
        let cov = clamp01(0.5 - sdf(cx, cy));
        if (cov <= 0) continue;
        if (clip) cov *= clamp01(0.5 - clip(cx, cy));
        this.blend(py * this.W + px, colorAt ? colorAt(cx, cy) : color, cov * alpha);
      }
    }
  }

  fillRoundRect(x, y, w, h, r, color, alpha = 1) {
    const X = this.dx(x), Y = this.dy(y), Wd = w * this.S, Hd = h * this.S;
    this.fillSdf(X - 1, Y - 1, X + Wd + 1, Y + Hd + 1, roundRectSdf(X, Y, Wd, Hd, r * this.S), color, alpha);
  }

  fillRect(x, y, w, h, color, alpha = 1) {
    this.fillRoundRect(x, y, w, h, 0, color, alpha);
  }

  strokeRoundRect(x, y, w, h, r, lw, color, alpha = 1) {
    const X = this.dx(x), Y = this.dy(y), Wd = w * this.S, Hd = h * this.S, half = (lw * this.S) / 2;
    const inner = roundRectSdf(X, Y, Wd, Hd, r * this.S);
    this.fillSdf(X - half - 1, Y - half - 1, X + Wd + half + 1, Y + Hd + half + 1,
      (px, py) => Math.abs(inner(px, py)) - half, color, alpha);
  }

  fillCircle(cx, cy, r, color, alpha = 1) {
    const X = this.dx(cx), Y = this.dy(cy), R = r * this.S;
    this.fillSdf(X - R - 1, Y - R - 1, X + R + 1, Y + R + 1, (px, py) => Math.hypot(px - X, py - Y) - R, color, alpha);
  }

  line(x1, y1, x2, y2, lw, color, alpha = 1) {
    const X1 = this.dx(x1), Y1 = this.dy(y1), X2 = this.dx(x2), Y2 = this.dy(y2), half = (lw * this.S) / 2;
    this.fillSdf(Math.min(X1, X2) - half - 1, Math.min(Y1, Y2) - half - 1, Math.max(X1, X2) + half + 1,
      Math.max(Y1, Y2) + half + 1, segmentSdf(X1, Y1, X2, Y2, half), color, alpha);
  }

  fillGradient(x, y, w, h, from, to) {
    const X = this.dx(x), Y = this.dy(y), Wd = w * this.S, Hd = h * this.S, len2 = Wd * Wd + Hd * Hd;
    const colorAt = (px, py) => {
      const t = clamp01(((px - X) * Wd + (py - Y) * Hd) / len2);
      return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
    };
    this.fillSdf(X, Y, X + Wd, Y + Hd, roundRectSdf(X, Y, Wd, Hd, 0), null, 1, colorAt);
  }

  text(face, str, x, baseline, color, alpha = 1) {
    let pen = this.dx(x);
    const base = this.dy(baseline), clip = this.clipSdf;
    for (const ch of str) {
      const g = face.glyph(ch.codePointAt(0));
      const gx = Math.round(pen + g.x0), gy = Math.round(base + g.y0);
      for (let j = 0; j < g.h; j++) {
        const py = gy + j;
        if (py < 0 || py >= this.H) continue;
        for (let i = 0; i < g.w; i++) {
          const px = gx + i;
          if (px < 0 || px >= this.W) continue;
          let a = (face.data[g.off + j * g.w + i] / 255) * alpha;
          if (a <= 0) continue;
          if (clip) a *= clamp01(0.5 - clip(px + 0.5, py + 0.5));
          this.blend(py * this.W + px, color, a);
        }
      }
      pen += g.adv;
    }
  }

  composite(layer, x, y, color, alpha = 1) {
    const clip = this.clipSdf;
    for (let j = 0; j < layer.h; j++) {
      const py = y + j;
      if (py < 0 || py >= this.H) continue;
      for (let i = 0; i < layer.w; i++) {
        const px = x + i;
        if (px < 0 || px >= this.W) continue;
        let a = layer.a[j * layer.w + i] * alpha;
        if (a <= 0) continue;
        if (clip) a *= clamp01(0.5 - clip(px + 0.5, py + 0.5));
        this.blend(py * this.W + px, color, a);
      }
    }
  }

  compositeRotated(layer, cx, cy, angle, color, alpha = 1) {
    const cos = Math.cos(angle), sin = Math.sin(angle), hw = layer.w / 2, hh = layer.h / 2;
    const ex = Math.abs(hw * cos) + Math.abs(hh * sin), ey = Math.abs(hw * sin) + Math.abs(hh * cos);
    const sx = Math.max(0, Math.floor(cx - ex)), exx = Math.min(this.W, Math.ceil(cx + ex));
    const sy = Math.max(0, Math.floor(cy - ey)), eyy = Math.min(this.H, Math.ceil(cy + ey));
    const at = (x, y) => (x < 0 || y < 0 || x >= layer.w || y >= layer.h ? 0 : layer.a[y * layer.w + x]);
    for (let py = sy; py < eyy; py++) {
      for (let px = sx; px < exx; px++) {
        const qx = px + 0.5 - cx, qy = py + 0.5 - cy;
        const u = qx * cos + qy * sin + hw - 0.5, v = -qx * sin + qy * cos + hh - 0.5;
        const u0 = Math.floor(u), v0 = Math.floor(v), fu = u - u0, fv = v - v0;
        if (u0 < -1 || v0 < -1 || u0 >= layer.w || v0 >= layer.h) continue;
        const a = (at(u0, v0) * (1 - fu) + at(u0 + 1, v0) * fu) * (1 - fv)
          + (at(u0, v0 + 1) * (1 - fu) + at(u0 + 1, v0 + 1) * fu) * fv;
        if (a > 0) this.blend(py * this.W + px, color, a * alpha);
      }
    }
  }
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function encodePng(canvas) {
  const { W, H, px } = canvas, stride = W * 3 + 1, raw = Buffer.alloc(stride * H);
  for (let y = 0; y < H; y++) {
    raw[y * stride] = 1;
    let l0 = 0, l1 = 0, l2 = 0;
    for (let x = 0; x < W; x++) {
      const k = (y * W + x) * 3, o = y * stride + 1 + x * 3;
      const r = Math.round(px[k]), g = Math.round(px[k + 1]), b = Math.round(px[k + 2]);
      raw[o] = (r - l0) & 255;
      raw[o + 1] = (g - l1) & 255;
      raw[o + 2] = (b - l2) & 255;
      l0 = r; l1 = g; l2 = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
