/*
 * Mivimoose Draw — paint bucket / flood fill.
 *
 *   window.MiviFill.floodFill(ctx, startX, startY, fillHex, opts) -> boolean
 *
 * Plain (non-module) ES2019-era script. No dependencies, no build step.
 *
 * ---------------------------------------------------------------------------
 * How this differs from a naive stack fill
 * ---------------------------------------------------------------------------
 * 1. Scanline (span) flood fill. Each popped seed grows a whole horizontal run
 *    at once and then only seeds the *starts of contiguous runs* on the rows
 *    above/below. Every pixel is colour-tested exactly once (memoised in a
 *    Uint8Array state map), so a full 1000x750 fill is a handful of ms.
 *
 * 2. Perceptual-ish, alpha-aware colour distance instead of |dr|+|dg|+|db|:
 *
 *      rm   = (r1 + r2) / 2
 *      rgb2 = (2 + rm/256)*dr^2 + 4*dg^2 + (2 + (255-rm)/256)*db^2
 *      dist = sqrt(rgb2 * min(a1,a2)/255 + 9*da^2) / 3
 *
 *    The /3 normalises it so `dist` lives on the same 0..255 scale as a single
 *    channel (a pure grey difference of N maps to exactly N), which is what
 *    makes a `tolerance` in 0..255 mean something intuitive. Comparisons are
 *    done on the un-square-rooted value (9*dist^2), so sqrt() only ever runs
 *    for the handful of pixels that land in the feather band.
 *
 * 3. Anti-aliasing / halos. A pen stroke's edge is a gradient from the stroke
 *    colour to the background, so a hard threshold either stops short (leaving
 *    a 1-2px ring of un-recoloured background — the halo) or punches through
 *    the soft edge into the neighbouring region (the leak). Here each pixel
 *    gets a *match weight*:
 *
 *      dist <= tolerance                  -> w = 1     (region: filled solid)
 *      tolerance < dist < tolerance+band  -> w = 1 - (dist - tolerance)/band
 *      otherwise                          -> w = 0     (untouched)
 *
 *    and the fill colour is composited source-over with alpha w. For a
 *    two-colour anti-aliased edge, dist is proportional to the stroke's
 *    coverage a, so `1 - dist/D` is exactly the `1 - a` that correct
 *    recompositing wants — the ramp reconstructs the anti-aliasing against the
 *    new colour instead of leaving a rim of the old one.
 *
 *    Crucially, only pixels with dist <= tolerance *propagate*. Weighted
 *    pixels are terminal: by construction the only pixels that ever get a
 *    partial weight are the 4-connected rim of the filled region, exactly one
 *    pixel deep. So the blend cannot walk across a stroke.
 *
 *    Distance alone is not enough to decide *how much* of a rim pixel to
 *    recolour, though: a solid outline whose colour happens to sit just past
 *    the tolerance is a barrier, while an anti-aliased pixel at the very same
 *    distance is background showing through, and w must be 0 for the first
 *    and ~1 for the second. So every rim pixel is also checked against its own
 *    neighbours (see capVia): a real edge pixel lies on a gradient, part way
 *    along a straight blend from the region colour towards a neighbour that is
 *    further out. A flat barrier has no such gradient and is left alone. That
 *    cap only ever lowers w, so it cannot cause a leak — it stops the fill
 *    repainting the first pixel of an outline, and stops repeated fills of one
 *    region from eating through it a pixel at a time.
 *
 *    Rim weights are therefore all computed from untouched pixel data before
 *    any of them is written (the rim pass), which also makes the result
 *    independent of the order the rim was discovered in — it has to be, since
 *    every client replays the same fill and the pixels must match.
 *
 *    Propagation is 4-connected, which is also what makes a 1px anti-aliased
 *    diagonal an actual barrier: a diagonal staircase of stroke pixels is
 *    8-connected, and an 8-connected barrier blocks a 4-connected fill.
 *
 * 4. Only the touched pixels are written, and putImageData is called once with
 *    the dirty rectangle of everything that actually changed.
 */
(function () {
  'use strict';

  var DEFAULT_TOLERANCE = 32;   // 0..255
  var BAND_BASE = 64;           // feather band = min(160, BAND_BASE + tolerance)
  var BAND_MAX = 160;
  var NOOP_EPSILON = 2;         // start pixel this close to the fill colour -> no-op

  // -------------------------------------------------------------------------
  // Colour parsing: '#rgb', '#rgba', '#rrggbb', '#rrggbbaa' (with or without
  // the '#'), 'rgb(r,g,b)', 'rgba(r,g,b,a)', or {r,g,b,a}. Returns null when
  // unparseable so the caller can no-op instead of throwing.
  // -------------------------------------------------------------------------
  function parseColor(c) {
    if (c == null) return null;

    if (typeof c === 'object') {
      if (!num(c.r) || !num(c.g) || !num(c.b)) return null;
      return {
        r: byte(c.r), g: byte(c.g), b: byte(c.b),
        a: typeof c.a === 'number' ? unit(c.a > 1 ? c.a / 255 : c.a) : 1
      };
    }

    var s = String(c).trim().toLowerCase();
    if (!s) return null;

    if (s.charAt(0) === '#') s = s.slice(1);

    if (/^[0-9a-f]+$/.test(s)) {
      if (s.length === 3 || s.length === 4) {
        var r3 = parseInt(s.charAt(0), 16), g3 = parseInt(s.charAt(1), 16), b3 = parseInt(s.charAt(2), 16);
        var a3 = s.length === 4 ? parseInt(s.charAt(3), 16) : 15;
        return { r: r3 * 17, g: g3 * 17, b: b3 * 17, a: (a3 * 17) / 255 };
      }
      if (s.length === 6 || s.length === 8) {
        return {
          r: parseInt(s.substr(0, 2), 16),
          g: parseInt(s.substr(2, 2), 16),
          b: parseInt(s.substr(4, 2), 16),
          a: s.length === 8 ? parseInt(s.substr(6, 2), 16) / 255 : 1
        };
      }
      return null;
    }

    var m = s.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      var parts = m[1].split(/[\s,\/]+/).filter(function (t) { return t.length > 0; });
      if (parts.length < 3) return null;
      var pr = channel(parts[0]), pg = channel(parts[1]), pb = channel(parts[2]);
      if (pr === null || pg === null || pb === null) return null;
      var pa = 1;
      if (parts.length > 3) {
        var t = parts[3];
        var av = parseFloat(t);
        if (isNaN(av)) return null;
        pa = unit(t.indexOf('%') >= 0 ? av / 100 : av);
      }
      return { r: pr, g: pg, b: pb, a: pa };
    }

    return null;
  }

  function channel(t) {
    var v = parseFloat(t);
    if (isNaN(v)) return null;
    if (t.indexOf('%') >= 0) v = v * 2.55;
    return byte(v);
  }

  function num(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function byte(v) {
    if (!num(v)) return 0;
    v = Math.round(v);
    return v < 0 ? 0 : (v > 255 ? 255 : v);
  }

  function unit(v) {
    if (typeof v !== 'number' || !isFinite(v)) return 1;
    return v < 0 ? 0 : (v > 1 ? 1 : v);
  }

  // -------------------------------------------------------------------------
  // 9 * dist^2 between two straight-alpha RGBA colours (see header).
  // Kept un-rooted: every threshold is pre-squared and pre-scaled to match.
  // -------------------------------------------------------------------------
  function rawDist(r1, g1, b1, a1, r2, g2, b2, a2) {
    var dr = r1 - r2, dg = g1 - g2, db = b1 - b2, da = a1 - a2;
    var rm = (r1 + r2) >> 1;
    var am = (a1 < a2 ? a1 : a2) * (1 / 255);
    return ((((512 + rm) * dr * dr) >> 8) + 4 * dg * dg + (((767 - rm) * db * db) >> 8)) * am
      + 9 * da * da;
  }

  /**
   * Paint-bucket fill.
   *
   * @param {CanvasRenderingContext2D} ctx  2D context (willReadFrequently recommended)
   * @param {number} startX                 seed x, rounded and clamped into the canvas
   * @param {number} startY                 seed y, rounded and clamped into the canvas
   * @param {string|Object} fillHex         '#rrggbb' (also #rgb/#rrggbbaa/rgb()/rgba()/{r,g,b,a})
   * @param {Object} [opts]
   * @param {number}  [opts.tolerance=32]     0..255, how far a pixel may stray from the
   *                                          seed colour and still count as the region
   * @param {boolean} [opts.contiguous=true]  false = global replace across the whole canvas
   * @param {boolean} [opts.featherEdges=true] blend the anti-aliased rim instead of leaving a halo
   * @returns {boolean} true if any pixel actually changed
   */
  function floodFill(ctx, startX, startY, fillHex, opts) {
    opts = opts || {};

    if (!ctx || typeof ctx.getImageData !== 'function' || typeof ctx.putImageData !== 'function') {
      return false;
    }
    var canvas = ctx.canvas;
    if (!canvas) return false;

    var W = canvas.width | 0;
    var H = canvas.height | 0;
    if (W <= 0 || H <= 0) return false;

    var fill = parseColor(fillHex);
    if (!fill) return false;

    var fR = fill.r, fG = fill.g, fB = fill.b, fA = fill.a;

    // --- options -----------------------------------------------------------
    var tol = opts.tolerance;
    if (typeof tol !== 'number' || !isFinite(tol)) tol = DEFAULT_TOLERANCE;
    if (tol < 0) tol = 0; else if (tol > 255) tol = 255;

    var contiguous = opts.contiguous !== false;
    var band = (opts.featherEdges !== false) ? Math.min(BAND_MAX, BAND_BASE + tol) : 0;

    // --- seed point --------------------------------------------------------
    var sx = Math.round(startX), sy = Math.round(startY);
    if (!isFinite(sx)) sx = 0;
    if (!isFinite(sy)) sy = 0;
    if (sx < 0) sx = 0; else if (sx > W - 1) sx = W - 1;
    if (sy < 0) sy = 0; else if (sy > H - 1) sy = H - 1;

    var img;
    try {
      img = ctx.getImageData(0, 0, W, H);
    } catch (e) {
      return false;                       // tainted / zero-sized canvas
    }
    if (!img || !img.data) return false;
    var d = img.data;

    var si = (sy * W + sx) * 4;
    var tR = d[si], tG = d[si + 1], tB = d[si + 2], tA = d[si + 3];

    // Already that colour (within epsilon)? Nothing to do.
    if (rawDist(tR, tG, tB, tA, fR, fG, fB, 255) <= 9 * NOOP_EPSILON * NOOP_EPSILON) {
      return false;
    }

    // Pre-squared thresholds (values compared against are 9 * dist^2).
    var tolRaw = 9 * tol * tol;
    var edge = tol + band;
    var edgeRaw = 9 * edge * edge;
    var invBand = band > 0 ? 1 / band : 0;

    var changed = false;
    var minX = W, minY = H, maxX = -1, maxY = -1;

    // --- pixel writer: source-over the fill colour with alpha `w` -----------
    // w === 1 (opaque fill) collapses to a plain replace; a partial w
    // reconstructs the anti-aliased edge against the new colour; w <= 0 is a
    // no-op so an over-eager rim costs nothing.
    function paint(i, x, y, w) {
      if (w <= 0) return;

      if (w >= 1) {
        if (!changed && (d[i] !== fR || d[i + 1] !== fG || d[i + 2] !== fB || d[i + 3] !== 255)) {
          changed = true;
        }
        d[i] = fR; d[i + 1] = fG; d[i + 2] = fB; d[i + 3] = 255;
      } else {
        var or = d[i], og = d[i + 1], ob = d[i + 2], oa = d[i + 3];
        var a0 = oa * (1 / 255);
        var ia = (1 - w) * a0;
        var outA = w + ia;
        if (outA <= 0) return;
        var inv = 1 / outA;
        d[i] = (fR * w + or * ia) * inv;
        d[i + 1] = (fG * w + og * ia) * inv;
        d[i + 2] = (fB * w + ob * ia) * inv;
        d[i + 3] = outA * 255;
        if (!changed && (d[i] !== or || d[i + 1] !== og || d[i + 2] !== ob || d[i + 3] !== oa)) {
          changed = true;
        }
      }

      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }

    // --- classify + paint one pixel; true when it belongs to the region -----
    function weightOf(raw) {
      // raw is 9*dist^2 and is known to be > tolRaw here.
      if (band <= 0 || raw >= edgeRaw) return 0;
      return 1 - (Math.sqrt(raw) / 3 - tol) * invBand;
    }

    // -----------------------------------------------------------------------
    // state[p]: 0 = untested (or beyond the feather band)
    //           1 = in region, painted, not yet grown into a span
    //           2 = rim: out of region, close enough to be a feather candidate
    //           3 = in region, already covered by a span
    //
    // Rim pixels are deliberately NOT painted while the region is being
    // discovered. Deciding how much of one to recolour needs the *final* state
    // map and the *original* colours of its own neighbours, so they are only
    // collected here and resolved in the rim pass below.
    // -----------------------------------------------------------------------
    var state = new Uint8Array(W * H);

    var rimCap = 1024;
    var rim = new Int32Array(rimCap);
    var rimN = 0;

    function rawAt(p) {
      var i = p * 4;
      var r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
      var rm = (r + tR) >> 1;
      var dr = r - tR, dg = g - tG, db = b - tB, da = a - tA;
      var am = (a < tA ? a : tA) * (1 / 255);
      return ((((512 + rm) * dr * dr) >> 8) + 4 * dg * dg + (((767 - rm) * db * db) >> 8)) * am
        + 9 * da * da;
    }

    function addRim(p) {
      if (rimN === rimCap) {
        rimCap = rimCap << 1;
        var grownRim = new Int32Array(rimCap);
        grownRim.set(rim);
        rim = grownRim;
      }
      rim[rimN++] = p;
    }

    // Cap contributed by ONE neighbour of a rim pixel.
    //
    // A partial-coverage (anti-aliased) pixel always sits on a gradient: at
    // least one of its own non-region neighbours is *further* from the region
    // colour than it is, because the stroke keeps getting more opaque as you
    // walk away from the region. `1 - distP/distNeighbour` is that pixel's
    // uncovered fraction, and for the 1px transition canvas anti-aliasing
    // actually produces it is exact.
    //
    // A *solid* barrier has no such gradient — an outline pixel's neighbours
    // along the outline are the same colour it is — so the cap comes out 0 and
    // the pixel is left completely alone, however close its colour happens to
    // be to the region's. Without this cap the band alone gives w ~ 1 to
    // anything a hair outside the tolerance, so a single click repaints the
    // first pixel of a dark outline around a dark region (measured: a solid
    // black outline next to a #500000 fill came out 93% green), and repeated
    // fills then eat through it one pixel at a time.
    //
    // The cap can only ever *reduce* w, so it can never introduce a leak.
    //
    // Returns:
    //   -1  the neighbour is part of the region — it says nothing either way
    //    0  no evidence that this pixel is a partial-coverage edge
    //   >0  the uncovered fraction implied by that neighbour
    //   -1  the neighbour is part of the region — it says nothing either way
    //    0  no evidence that this pixel is a partial-coverage edge
    //   >0  the uncovered fraction implied by that neighbour
    function capVia(p, rawP, nq) {
      var st = state[nq];
      if (st === 1 || st === 3) return -1;
      var rn = rawAt(nq);
      if (rn <= rawP) return 0;          // no outward gradient: flat barrier

      var sP = Math.sqrt(rawP);          // 3 * dist(region, pixel)
      var sN = Math.sqrt(rn);            // 3 * dist(region, neighbour)
      var i = p * 4, j = nq * 4;
      var sPN = Math.sqrt(rawDist(d[i], d[i + 1], d[i + 2], d[i + 3],
                                  d[j], d[j + 1], d[j + 2], d[j + 3]));

      // The pixel must lie *between* the region colour and this neighbour. A
      // genuine anti-aliased pixel is a straight blend of the two, so its two
      // legs add up to the whole (this metric is additive along a blend to
      // well under a percent). A pixel that merely happens to sit nearer the
      // region colour than its neighbour does — a dark outline with the white
      // page behind it, say — fails this and is left alone.
      if (sP + sPN > sN * 1.15 + 18) return 0;
      return 1 - sP / sN;
    }

    // How much of this rim pixel is plausibly the region colour showing through?
    // The most barrier-like neighbour wins, and a pixel with no non-region
    // neighbour at all (a speck enclosed by the region) is not a barrier, so
    // the band weight stands.
    function edgeCapOf(p, rawP) {
      var py = (p / W) | 0, pxx = p - py * W;
      var lim = 0, sawOut = false, c;
      if (pxx > 0)     { c = capVia(p, rawP, p - 1); if (c >= 0) { sawOut = true; if (c > lim) lim = c; } }
      if (pxx < W - 1) { c = capVia(p, rawP, p + 1); if (c >= 0) { sawOut = true; if (c > lim) lim = c; } }
      if (py > 0)      { c = capVia(p, rawP, p - W); if (c >= 0) { sawOut = true; if (c > lim) lim = c; } }
      if (py < H - 1)  { c = capVia(p, rawP, p + W); if (c >= 0) { sawOut = true; if (c > lim) lim = c; } }
      return sawOut ? lim : 1;
    }

    if (!contiguous) {
      // ---------------------------------------------------------------------
      // Global replace: same tolerance + feather rules, no propagation.
      // ---------------------------------------------------------------------
      for (var gy = 0; gy < H; gy++) {
        var gbase = gy * W;
        for (var gx = 0; gx < W; gx++) {
          var gp = gbase + gx;
          var graw = rawAt(gp);
          if (graw <= tolRaw) { state[gp] = 1; paint(gp * 4, gx, gy, fA); }
          else if (graw < edgeRaw) { state[gp] = 2; addRim(gp); }
        }
      }
    } else {
      // ---------------------------------------------------------------------
      // Contiguous scanline (span) flood fill.
      //
      // Because every pixel that reaches state 2 is tested only as a direct
      // 4-neighbour of a region pixel, "state 2" is exactly the one-pixel-deep
      // rim — which is what keeps the feather blend from crossing a stroke.
      // ---------------------------------------------------------------------
      var cap = 2048;
      var stack = new Int32Array(cap);
      var sp = 0;

      var test = function (p, x, y) {
        var raw = rawAt(p);
        if (raw <= tolRaw) {
          state[p] = 1;
          paint(p * 4, x, y, fA);
          return true;
        }
        state[p] = 2;
        if (raw < edgeRaw) addRim(p);
        return false;
      };

      var push = function (p) {
        if (sp === cap) {
          cap = cap << 1;
          var grown = new Int32Array(cap);
          grown.set(stack);
          stack = grown;
        }
        stack[sp++] = p;
      };

      // Seed the runs of the row `base` that lie under/over the span [lx..rx].
      var scanRow = function (lx, rx, base, ny) {
        var run = false;
        for (var nx = lx; nx <= rx; nx++) {
          var q = base + nx;
          var st = state[q];
          if (st === 0) st = test(q, nx, ny) ? 1 : 2;
          if (st === 1) {
            if (!run) { push(q); run = true; }
          } else {
            run = false;
          }
        }
      };

      var startP = sy * W + sx;
      if (test(startP, sx, sy)) push(startP);

      while (sp > 0) {
        var p = stack[--sp];
        if (state[p] !== 1) continue;     // already swallowed by another span

        var y = (p / W) | 0;
        var rowBase = y * W;
        var x = p - rowBase;
        state[p] = 3;

        var lx = x;
        while (lx > 0) {
          var ql = rowBase + lx - 1;
          var sl = state[ql];
          if (sl === 0) { if (!test(ql, lx - 1, y)) break; sl = 1; }
          if (sl !== 1) break;
          state[ql] = 3;
          lx--;
        }

        var rx = x;
        while (rx < W - 1) {
          var qr = rowBase + rx + 1;
          var sr = state[qr];
          if (sr === 0) { if (!test(qr, rx + 1, y)) break; sr = 1; }
          if (sr !== 1) break;
          state[qr] = 3;
          rx++;
        }

        if (y > 0) scanRow(lx, rx, rowBase - W, y - 1);
        if (y < H - 1) scanRow(lx, rx, rowBase + W, y + 1);
      }
    }

    // --- rim pass ----------------------------------------------------------
    // Two sweeps on purpose: every weight is decided from untouched pixel data
    // before the first rim pixel is written, so the result cannot depend on the
    // order the rim happened to be discovered in (which matters — every client
    // replays the same fill and the pixels have to match).
    if (rimN > 0) {
      var rimW = new Float64Array(rimN);
      var ri, rp, rw, rawP, lim;
      for (ri = 0; ri < rimN; ri++) {
        rp = rim[ri];
        rawP = rawAt(rp);
        rw = weightOf(rawP);
        if (rw > 0) {
          lim = edgeCapOf(rp, rawP);
          if (lim < rw) rw = lim;
        }
        rimW[ri] = rw;
      }
      for (ri = 0; ri < rimN; ri++) {
        rw = rimW[ri] * fA;
        if (rw > 0) {
          rp = rim[ri];
          var rpy = (rp / W) | 0;
          paint(rp * 4, rp - rpy * W, rpy, rw);
        }
      }
    }
    if (!changed || maxX < minX || maxY < minY) return false;

    var dw = maxX - minX + 1;
    var dh = maxY - minY + 1;
    try {
      ctx.putImageData(img, 0, 0, minX, minY, dw, dh);
    } catch (e2) {
      try { ctx.putImageData(img, 0, 0); } catch (e3) { return false; }
    }
    return true;
  }

  var MiviFill = { floodFill: floodFill };

  if (typeof window !== 'undefined') window.MiviFill = MiviFill;
  if (typeof module !== 'undefined' && module.exports) module.exports = MiviFill;
})();
