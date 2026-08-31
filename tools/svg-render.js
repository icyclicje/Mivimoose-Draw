// ─────────────────────────────────────────────────────────────
// svg-render.js — rasterise a useful subset of SVG to RGBA + PNG.
//
// Enough of the format for a flat vector logo: rect (with rx), circle,
// ellipse, polygon, polyline and path (M L H V C Q Z, absolute or
// relative), linear gradients, groups, and translate/rotate/scale
// transforms. Curves are flattened to polylines and everything is filled
// by point-in-polygon with 4x4 supersampling.
//
// Deliberately dependency-free — the whole point is that the brand assets
// can be regenerated on any machine with just Node.
// ─────────────────────────────────────────────────────────────
const zlib = require('zlib');
const { crc32 } = require('../lib/zip');

// ── tiny XML reader (attributes only, no entities beyond the basics) ──
function parseNodes(svg) {
  const nodes = [];
  const stack = [{ children: nodes, attrs: {} }];
  const tagRe = /<\s*(\/?)([a-zA-Z][\w:-]*)((?:\s+[\w:-]+\s*=\s*"[^"]*")*)\s*(\/?)\s*>/g;
  let m;
  while ((m = tagRe.exec(svg))) {
    const [, closing, name, attrText, selfClose] = m;
    if (closing) { if (stack.length > 1) stack.pop(); continue; }
    const attrs = {};
    const aRe = /([\w:-]+)\s*=\s*"([^"]*)"/g;
    let a;
    while ((a = aRe.exec(attrText))) attrs[a[1]] = a[2];
    const node = { name, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  return nodes;
}

// ── transforms, as [a b c d e f] (x' = a·x + c·y + e) ──
const I = [1, 0, 0, 1, 0, 0];
function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
function apply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}
function parseTransform(text) {
  let m = I;
  if (!text) return m;
  const re = /(translate|rotate|scale|matrix)\s*\(([^)]*)\)/g;
  let t;
  while ((t = re.exec(text))) {
    const n = t[2].trim().split(/[\s,]+/).map(Number);
    if (t[1] === 'translate') m = mul(m, [1, 0, 0, 1, n[0] || 0, n[1] || 0]);
    else if (t[1] === 'scale') m = mul(m, [n[0] || 1, 0, 0, n.length > 1 ? n[1] : (n[0] || 1), 0, 0]);
    else if (t[1] === 'matrix') m = mul(m, n);
    else {
      const a = ((n[0] || 0) * Math.PI) / 180;
      const cx = n[1] || 0, cy = n[2] || 0;
      m = mul(m, [1, 0, 0, 1, cx, cy]);
      m = mul(m, [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]);
      m = mul(m, [1, 0, 0, 1, -cx, -cy]);
    }
  }
  return m;
}

// ── shapes → polygons (rings of points, already in root space) ──
const CURVE_STEPS = 24;

function arcCorner(out, cx, cy, r, from, to) {
  const steps = Math.max(3, Math.ceil(CURVE_STEPS / 4));
  for (let i = 0; i <= steps; i++) {
    const a = from + (to - from) * (i / steps);
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
}

function rectRings(at) {
  const x = +at.x || 0, y = +at.y || 0;
  const w = +at.width || 0, h = +at.height || 0;
  let rx = at.rx !== undefined ? +at.rx : (at.ry !== undefined ? +at.ry : 0);
  rx = Math.min(rx, w / 2, h / 2);
  if (!rx) return [[[x, y], [x + w, y], [x + w, y + h], [x, y + h]]];
  const p = [];
  arcCorner(p, x + w - rx, y + rx, rx, -Math.PI / 2, 0);
  arcCorner(p, x + w - rx, y + h - rx, rx, 0, Math.PI / 2);
  arcCorner(p, x + rx, y + h - rx, rx, Math.PI / 2, Math.PI);
  arcCorner(p, x + rx, y + rx, rx, Math.PI, Math.PI * 1.5);
  return [p];
}

function ellipseRings(cx, cy, rx, ry) {
  const p = [];
  const steps = CURVE_STEPS * 2;
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    p.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return [p];
}

function pointsRings(text) {
  const n = String(text || '').trim().split(/[\s,]+/).map(Number);
  const p = [];
  for (let i = 0; i + 1 < n.length; i += 2) p.push([n[i], n[i + 1]]);
  return p.length ? [p] : [];
}

// M L H V C Q Z, absolute and relative. Curves flattened.
function pathRings(d) {
  const rings = [];
  let ring = [];
  let cx = 0, cy = 0, sx = 0, sy = 0;
  const tok = String(d || '').match(/[MmLlHhVvCcSsQqTtZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
  let i = 0;
  let cmd = '';
  let lastC = null;
  const num = () => parseFloat(tok[i++]);
  const push = (x, y) => ring.push([x, y]);
  const bez3 = (x1, y1, x2, y2, x3, y3, x4, y4) => {
    for (let s = 1; s <= CURVE_STEPS; s++) {
      const t = s / CURVE_STEPS, u = 1 - t;
      push(
        u * u * u * x1 + 3 * u * u * t * x2 + 3 * u * t * t * x3 + t * t * t * x4,
        u * u * u * y1 + 3 * u * u * t * y2 + 3 * u * t * t * y3 + t * t * t * y4,
      );
    }
  };
  const bez2 = (x1, y1, x2, y2, x3, y3) => {
    for (let s = 1; s <= CURVE_STEPS; s++) {
      const t = s / CURVE_STEPS, u = 1 - t;
      push(u * u * x1 + 2 * u * t * x2 + t * t * x3, u * u * y1 + 2 * u * t * y2 + t * t * y3);
    }
  };

  while (i < tok.length) {
    if (/[MmLlHhVvCcSsQqTtZz]/.test(tok[i])) cmd = tok[i++];
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();

    if (C === 'M') {
      if (ring.length > 2) rings.push(ring);
      ring = [];
      const x = num(), y = num();
      cx = rel ? cx + x : x; cy = rel ? cy + y : y;
      sx = cx; sy = cy;
      push(cx, cy);
      cmd = rel ? 'l' : 'L';                 // implicit lineto for extra pairs
    } else if (C === 'L') {
      const x = num(), y = num();
      cx = rel ? cx + x : x; cy = rel ? cy + y : y;
      push(cx, cy);
    } else if (C === 'H') {
      const x = num();
      cx = rel ? cx + x : x;
      push(cx, cy);
    } else if (C === 'V') {
      const y = num();
      cy = rel ? cy + y : y;
      push(cx, cy);
    } else if (C === 'C' || C === 'S') {
      let x1, y1;
      if (C === 'C') { x1 = num(); y1 = num(); if (rel) { x1 += cx; y1 += cy; } }
      else { x1 = lastC ? 2 * cx - lastC[0] : cx; y1 = lastC ? 2 * cy - lastC[1] : cy; }
      let x2 = num(), y2 = num(), x3 = num(), y3 = num();
      if (rel) { x2 += cx; y2 += cy; x3 += cx; y3 += cy; }
      bez3(cx, cy, x1, y1, x2, y2, x3, y3);
      lastC = [x2, y2];
      cx = x3; cy = y3;
    } else if (C === 'Q' || C === 'T') {
      let x1, y1;
      if (C === 'Q') { x1 = num(); y1 = num(); if (rel) { x1 += cx; y1 += cy; } }
      else { x1 = lastC ? 2 * cx - lastC[0] : cx; y1 = lastC ? 2 * cy - lastC[1] : cy; }
      let x2 = num(), y2 = num();
      if (rel) { x2 += cx; y2 += cy; }
      bez2(cx, cy, x1, y1, x2, y2);
      lastC = [x1, y1];
      cx = x2; cy = y2;
    } else if (C === 'Z') {
      if (ring.length > 2) rings.push(ring);
      ring = [];
      cx = sx; cy = sy;
    } else {
      i++;                                    // unknown token — skip rather than hang
    }
    if (C !== 'C' && C !== 'S' && C !== 'Q' && C !== 'T') lastC = null;
  }
  if (ring.length > 2) rings.push(ring);
  return rings;
}

// ── colour ──
function parseColor(v, gradients) {
  if (!v || v === 'none') return null;
  const s = String(v).trim();
  const g = s.match(/^url\(#([^)]+)\)$/);
  if (g) return { gradient: gradients[g[1]] || null };
  if (s[0] === '#') {
    const hex = s.slice(1);
    if (hex.length === 3) {
      return [parseInt(hex[0] + hex[0], 16), parseInt(hex[1] + hex[1], 16), parseInt(hex[2] + hex[2], 16)];
    }
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }
  const named = { white: [255, 255, 255], black: [0, 0, 0], none: null };
  return named[s.toLowerCase()] !== undefined ? named[s.toLowerCase()] : [0, 0, 0];
}

// Gradients are evaluated in the shape's own bounding box (objectBoundingBox,
// which is the SVG default and all this project's logo uses).
function gradientAt(grad, x, y, bbox) {
  const w = bbox.maxX - bbox.minX || 1;
  const h = bbox.maxY - bbox.minY || 1;
  const fx = (x - bbox.minX) / w;
  const fy = (y - bbox.minY) / h;
  const dx = grad.x2 - grad.x1, dy = grad.y2 - grad.y1;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((fx - grad.x1) * dx + (fy - grad.y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  // Walk the stops.
  const st = grad.stops;
  for (let i = 0; i < st.length - 1; i++) {
    if (t <= st[i + 1].o || i === st.length - 2) {
      const span = st[i + 1].o - st[i].o || 1;
      const k = Math.max(0, Math.min(1, (t - st[i].o) / span));
      return [
        st[i].c[0] + (st[i + 1].c[0] - st[i].c[0]) * k,
        st[i].c[1] + (st[i + 1].c[1] - st[i].c[1]) * k,
        st[i].c[2] + (st[i + 1].c[2] - st[i].c[2]) * k,
      ];
    }
  }
  return st[0] ? st[0].c : [0, 0, 0];
}

// ── flatten the tree into a paint list ──
function collect(nodes, gradients, matrix, inherited, out) {
  for (const node of nodes) {
    const at = node.attrs;
    const m = mul(matrix, parseTransform(at.transform));
    const fill = at.fill !== undefined ? at.fill : inherited.fill;
    const opacity = at.opacity !== undefined ? +at.opacity : 1;

    if (node.name === 'defs') continue;
    if (node.name === 'g' || node.name === 'svg') {
      collect(node.children, gradients, m, { fill, opacity: opacity * inherited.opacity }, out);
      continue;
    }

    let rings = null;
    if (node.name === 'rect') rings = rectRings(at);
    else if (node.name === 'circle') rings = ellipseRings(+at.cx || 0, +at.cy || 0, +at.r || 0, +at.r || 0);
    else if (node.name === 'ellipse') rings = ellipseRings(+at.cx || 0, +at.cy || 0, +at.rx || 0, +at.ry || 0);
    else if (node.name === 'polygon' || node.name === 'polyline') rings = pointsRings(at.points);
    else if (node.name === 'path') rings = pathRings(at.d);
    if (!rings || !rings.length) continue;

    const paint = parseColor(fill, gradients);
    if (paint === null) continue;

    const worldRings = rings.map(r => r.map(([x, y]) => apply(m, x, y)));
    const bbox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const r of worldRings) {
      for (const [x, y] of r) {
        if (x < bbox.minX) bbox.minX = x;
        if (y < bbox.minY) bbox.minY = y;
        if (x > bbox.maxX) bbox.maxX = x;
        if (y > bbox.maxY) bbox.maxY = y;
      }
    }
    out.push({ rings: worldRings, paint, bbox, opacity: opacity * inherited.opacity });
  }
  return out;
}

// Even-odd fill — correct for every shape a flat logo needs, and it makes
// "hole" rings (a counter in a letter, say) work for free.
function inRings(rings, px, py) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/**
 * Rasterise an SVG string to an RGBA buffer.
 * Returns { data, width, height }.
 */
function rasterize(svg, size, opts = {}) {
  const SS = opts.supersample || 4;
  const nodes = parseNodes(svg);
  const root = nodes.find(n => n.name === 'svg') || { attrs: {}, children: nodes };
  const vb = String(root.attrs.viewBox || '0 0 64 64').trim().split(/[\s,]+/).map(Number);
  const [vx, vy, vw, vh] = vb;

  // Gradients.
  const gradients = {};
  (function scan(list) {
    for (const n of list) {
      if (n.name === 'linearGradient' && n.attrs.id) {
        gradients[n.attrs.id] = {
          x1: n.attrs.x1 !== undefined ? +n.attrs.x1 : 0,
          y1: n.attrs.y1 !== undefined ? +n.attrs.y1 : 0,
          x2: n.attrs.x2 !== undefined ? +n.attrs.x2 : 1,
          y2: n.attrs.y2 !== undefined ? +n.attrs.y2 : 0,
          stops: n.children
            .filter(c => c.name === 'stop')
            .map(c => ({
              o: c.attrs.offset ? parseFloat(c.attrs.offset) / (String(c.attrs.offset).includes('%') ? 100 : 1) : 0,
              c: parseColor(c.attrs['stop-color'] || '#000000', {}),
            })),
        };
      }
      if (n.children) scan(n.children);
    }
  })(nodes);

  const shapes = collect(root.children, gradients, I, { fill: '#000000', opacity: 1 }, []);

  const W = size, H = Math.round((size * vh) / vw);
  const data = Buffer.alloc(W * H * 4);
  const stepX = vw / (W * SS);
  const stepY = vh / (H * SS);
  const samples = SS * SS;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0, cov = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = vx + (x * SS + sx + 0.5) * stepX;
          const uy = vy + (y * SS + sy + 0.5) * stepY;
          // Composite from the top down, so a translucent shape lets what is
          // under it through instead of replacing it.
          let sr = 0, sg = 0, sb = 0, sa = 0;
          for (let s = shapes.length - 1; s >= 0 && sa < 0.999; s--) {
            const sh = shapes[s];
            if (ux < sh.bbox.minX || ux > sh.bbox.maxX || uy < sh.bbox.minY || uy > sh.bbox.maxY) continue;
            if (!inRings(sh.rings, ux, uy)) continue;
            const a = sh.opacity * (1 - sa);
            if (a <= 0) continue;
            const c = sh.paint.gradient ? gradientAt(sh.paint.gradient, ux, uy, sh.bbox) : sh.paint;
            sr += c[0] * a; sg += c[1] * a; sb += c[2] * a;
            sa += a;
          }
          if (sa <= 0) continue;
          // Un-premultiply so partly-transparent samples keep their true hue.
          r += sr / sa; g += sg / sa; b += sb / sa;
          cov += sa;
        }
      }
      if (cov <= 0) continue;
      const i = (y * W + x) * 4;
      data[i] = Math.max(0, Math.min(255, Math.round(r / cov)));
      data[i + 1] = Math.max(0, Math.min(255, Math.round(g / cov)));
      data[i + 2] = Math.max(0, Math.min(255, Math.round(b / cov)));
      data[i + 3] = Math.max(0, Math.min(255, Math.round((cov / samples) * 255)));
    }
  }
  return { data, width: W, height: H };
}

// ── PNG ──
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function toPng({ data, width, height }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const src = y * width * 4;
    const dst = y * (width * 4 + 1);
    raw[dst] = 0;
    data.copy(raw, dst + 1, src, src + width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function renderToPng(svg, size, opts) {
  return toPng(rasterize(svg, size, opts));
}

module.exports = { rasterize, toPng, renderToPng, parseNodes };
