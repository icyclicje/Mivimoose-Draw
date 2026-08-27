/*!
 * Mivimoose Draw - gif.js
 * Self-contained animated GIF89a encoder for the browser.
 * No dependencies, no workers, no CDN. Plain ES2019 script (not a module).
 *
 * Global API:
 *   window.MiviGIF.encode(frames, opts) -> Promise<Blob>   // type: "image/gif"
 *
 *   frames : Array of HTMLCanvasElement | ImageData | {width,height,data:RGBA}
 *            (also accepts <img>, ImageBitmap, OffscreenCanvas - anything drawImage takes)
 *   opts   : {
 *              width       : output width  (default: first frame's width)
 *              height      : output height (default: first frame's height)
 *              delay       : centiseconds per frame (default 100 = 1s)
 *              repeat      : 0 = loop forever (default), n>0 = loop n extra times,
 *                            -1 = play once (no NETSCAPE block)
 *              onProgress  : function(fraction 0..1)
 *            }
 *
 * Frames whose size differs from the output size are scaled to fit with the
 * aspect ratio preserved and letterboxed with white.
 */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Growable byte writer
   * ------------------------------------------------------------------ */

  function Writer(initial) {
    this.buf = new Uint8Array(initial > 0 ? initial : 65536);
    this.len = 0;
  }
  Writer.prototype.ensure = function (n) {
    var need = this.len + n;
    if (need <= this.buf.length) return;
    var cap = this.buf.length;
    while (cap < need) cap *= 2;
    var nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  };
  Writer.prototype.byte = function (b) {
    this.ensure(1);
    this.buf[this.len++] = b & 0xff;
  };
  Writer.prototype.bytes = function (arr) {
    this.ensure(arr.length);
    this.buf.set(arr, this.len);
    this.len += arr.length;
  };
  Writer.prototype.short = function (v) {
    this.ensure(2);
    this.buf[this.len++] = v & 0xff;
    this.buf[this.len++] = (v >> 8) & 0xff;
  };
  Writer.prototype.string = function (s) {
    this.ensure(s.length);
    for (var i = 0; i < s.length; i++) this.buf[this.len++] = s.charCodeAt(i) & 0xff;
  };
  Writer.prototype.result = function () {
    return this.buf.slice(0, this.len);
  };

  /* ------------------------------------------------------------------ *
   * LZW (GIF flavour)
   *
   * Variable code width starting at minCodeSize+1 bits, LSB-first packing,
   * Clear Code / End-Of-Information codes, width growth handled exactly the
   * way the reference GIF encoder does it (grow *after* emitting a code, when
   * the next free entry passes the current max code), table flush + Clear Code
   * when the table reaches 4096 entries, output written as sub-blocks of at
   * most 255 bytes, terminated with a 0x00 block terminator.
   * ------------------------------------------------------------------ */

  var LZW_MAX_BITS = 12;
  var LZW_MAX_CODE = 1 << LZW_MAX_BITS; // 4096
  var lzwTable = null; // reused across frames: 4096 prefixes x 256 suffixes

  function lzwEncode(pixels, minCodeSize, out) {
    if (minCodeSize < 2) minCodeSize = 2;
    if (minCodeSize > 8) minCodeSize = 8;

    var initBits = minCodeSize + 1;
    var clearCode = 1 << minCodeSize;
    var eofCode = clearCode + 1;

    if (lzwTable === null) lzwTable = new Int32Array(LZW_MAX_CODE * 256);
    var table = lzwTable;
    table.fill(0); // 0 == empty; entries are stored as code+1

    var nBits = initBits;
    var maxcode = (1 << nBits) - 1;
    var freeEnt = clearCode + 2;
    var clearFlag = false;

    var block = new Uint8Array(255);
    var blockLen = 0;
    var curAccum = 0;
    var curBits = 0;

    function flushBlock() {
      if (blockLen > 0) {
        out.byte(blockLen);
        out.bytes(block.subarray(0, blockLen));
        blockLen = 0;
      }
    }
    function emitByte(b) {
      block[blockLen++] = b;
      if (blockLen === 255) flushBlock();
    }
    function output(code) {
      curAccum |= (code << curBits);
      curBits += nBits;
      while (curBits >= 8) {
        emitByte(curAccum & 0xff);
        curAccum >>= 8;
        curBits -= 8;
      }
      if (freeEnt > maxcode || clearFlag) {
        if (clearFlag) {
          nBits = initBits;
          maxcode = (1 << nBits) - 1;
          clearFlag = false;
        } else {
          nBits++;
          maxcode = (nBits === LZW_MAX_BITS) ? LZW_MAX_CODE : ((1 << nBits) - 1);
        }
      }
    }
    function resetTable() {
      table.fill(0);
      freeEnt = clearCode + 2;
      clearFlag = true;
      output(clearCode); // emitted at the *current* width, then the width resets
    }

    var n = pixels.length;
    output(clearCode);

    if (n > 0) {
      var ent = pixels[0];
      for (var i = 1; i < n; i++) {
        var c = pixels[i];
        var key = (c << LZW_MAX_BITS) | ent; // ent < 4096, c < 256
        var hit = table[key];
        if (hit !== 0) {
          ent = hit - 1;
          continue;
        }
        output(ent);
        ent = c;
        if (freeEnt < LZW_MAX_CODE) {
          table[key] = freeEnt + 1;
          freeEnt++;
        } else {
          resetTable();
        }
      }
      output(ent);
    }

    output(eofCode);
    if (curBits > 0) emitByte(curAccum & 0xff);
    flushBlock();
    out.byte(0); // block terminator
  }

  /* ------------------------------------------------------------------ *
   * Colour quantization: median cut over a 5-bit-per-channel histogram
   * that also carries full-precision colour sums, so a flat colour that
   * ends up alone in a box is reproduced *exactly*.
   * ------------------------------------------------------------------ */

  var HIST_SIZE = 32768;  // 5-bit-per-channel fallback histogram
  var EXACT_MAX = 32768;  // distinct colours tracked losslessly before falling back
  var EX_SLOTS = 131072;  // open-addressed hash slots for the exact set

  function computeBox(order, start, end, ar, ag, ab, cnt) {
    var rmin = Infinity, rmax = -Infinity;
    var gmin = Infinity, gmax = -Infinity;
    var bmin = Infinity, bmax = -Infinity;
    var sR = 0, sG = 0, sB = 0, total = 0;
    for (var i = start; i < end; i++) {
      var k = order[i];
      var r = ar[k], g = ag[k], b = ab[k], c = cnt[k];
      if (r < rmin) rmin = r;
      if (r > rmax) rmax = r;
      if (g < gmin) gmin = g;
      if (g > gmax) gmax = g;
      if (b < bmin) bmin = b;
      if (b > bmax) bmax = b;
      sR += r * c; sG += g * c; sB += b * c; total += c;
    }
    var rr = rmax - rmin, gr = gmax - gmin, br = bmax - bmin;
    var axis = 0, range = rr;
    if (gr > range) { axis = 1; range = gr; }
    if (br > range) { axis = 2; range = br; }
    return {
      start: start, end: end, count: total,
      axis: axis, range: range,
      sR: sR, sG: sG, sB: sB,
      score: (end - start > 1 && range > 0) ? range * Math.sqrt(total) : -1
    };
  }

  /**
   * Median cut over m colour entries (ar/ag/ab = colour, cnt = pixel weight).
   * Writes at most maxColors entries into `palette` and returns how many.
   */
  function medianCut(ar, ag, ab, cnt, m, maxColors, palette) {
    var order = new Int32Array(m);
    var k;
    for (k = 0; k < m; k++) order[k] = k;

    var boxes = [computeBox(order, 0, m, ar, ag, ab, cnt)];
    while (boxes.length < maxColors) {
      var bestI = -1, bestScore = 0;
      for (var i = 0; i < boxes.length; i++) {
        if (boxes[i].score > bestScore) { bestScore = boxes[i].score; bestI = i; }
      }
      if (bestI < 0) break; // nothing left worth splitting

      var box = boxes[bestI];
      var s = box.start, e = box.end;
      var A = box.axis === 0 ? ar : (box.axis === 1 ? ag : ab);
      var sub = Array.from(order.subarray(s, e));
      sub.sort(function (x, y) {
        var dd = A[x] - A[y];
        return dd !== 0 ? dd : (x - y);
      });
      order.set(sub, s);

      var half = box.count / 2;
      var acc = 0, cut = -1;
      for (var j = s; j < e - 1; j++) {
        acc += cnt[order[j]];
        if (acc >= half) { cut = j + 1; break; }
      }
      if (cut <= s || cut >= e) cut = e - 1;
      if (cut <= s) cut = s + 1;

      boxes[bestI] = computeBox(order, s, cut, ar, ag, ab, cnt);
      boxes.push(computeBox(order, cut, e, ar, ag, ab, cnt));
    }

    for (var q = 0; q < boxes.length; q++) {
      var bx = boxes[q];
      var c = bx.count > 0 ? bx.count : 1;
      palette[q * 3] = clamp255(Math.round(bx.sR / c));
      palette[q * 3 + 1] = clamp255(Math.round(bx.sG / c));
      palette[q * 3 + 2] = clamp255(Math.round(bx.sB / c));
    }
    return boxes.length;
  }

  /**
   * @param {Array<Uint8Array>} rgbFrames packed RGB (3 bytes/pixel) buffers
   * @param {number} maxColors  <= 256
   * @returns {{palette:Uint8Array, size:number}} palette is 256*3 bytes
   */
  function buildPalette(rgbFrames, maxColors) {
    if (!(maxColors > 0)) maxColors = 256;
    if (maxColors > 256) maxColors = 256;

    var counts = new Uint32Array(HIST_SIZE);
    var sr = new Float64Array(HIST_SIZE);
    var sg = new Float64Array(HIST_SIZE);
    var sb = new Float64Array(HIST_SIZE);
    var firstRGB = new Int32Array(HIST_SIZE);
    var pure = new Uint8Array(HIST_SIZE);
    var nonEmpty = 0;
    var f, p, d, r, g, b, bi, rgb;

    // Exact distinct-colour set with per-colour counts, abandoned once it
    // exceeds EXACT_MAX. While it survives the palette is derived from real
    // colours rather than histogram cells - which is what keeps flat drawings
    // (and things like 256 distinct greys) lossless.
    var EX_MASK = EX_SLOTS - 1;
    var exKeys = new Int32Array(EX_SLOTS).fill(-1);
    var exSlot = new Int32Array(EX_SLOTS);
    var exList = new Int32Array(EXACT_MAX);
    var exCnt = new Float64Array(EXACT_MAX);
    var exCount = 0;
    var exactOK = true;
    var prevRGB = -1, prevSlot = -1;
    var hh;

    for (f = 0; f < rgbFrames.length; f++) {
      d = rgbFrames[f];
      for (p = 0; p + 2 < d.length; p += 3) {
        r = d[p]; g = d[p + 1]; b = d[p + 2];
        bi = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        rgb = (r << 16) | (g << 8) | b;
        if (counts[bi] === 0) {
          nonEmpty++;
          firstRGB[bi] = rgb;
          pure[bi] = 1;
        } else if (pure[bi] === 1 && firstRGB[bi] !== rgb) {
          pure[bi] = 0;
        }
        counts[bi]++;
        sr[bi] += r; sg[bi] += g; sb[bi] += b;

        if (exactOK) {
          if (rgb === prevRGB && prevSlot >= 0) {
            exCnt[prevSlot]++;
          } else {
            hh = (Math.imul(rgb, 2654435761) >>> 15) & EX_MASK;
            while (exKeys[hh] !== -1 && exKeys[hh] !== rgb) hh = (hh + 1) & EX_MASK;
            if (exKeys[hh] === -1) {
              if (exCount >= EXACT_MAX) { exactOK = false; prevSlot = -1; }
              else {
                exKeys[hh] = rgb; exSlot[hh] = exCount;
                exList[exCount] = rgb; exCnt[exCount] = 1;
                prevSlot = exCount;
                exCount++;
              }
            } else {
              prevSlot = exSlot[hh];
              exCnt[prevSlot]++;
            }
          }
        }
        prevRGB = rgb;
      }
    }

    var palette = new Uint8Array(256 * 3);
    var q;
    if (nonEmpty === 0) {
      // no pixels at all - single white entry keeps the file valid
      palette[0] = palette[1] = palette[2] = 255;
      return { palette: palette, size: 1 };
    }

    if (exactOK) {
      // <= maxColors distinct colours: reproduce every one of them exactly.
      if (exCount <= maxColors) {
        for (q = 0; q < exCount; q++) {
          rgb = exList[q];
          palette[q * 3] = (rgb >> 16) & 0xff;
          palette[q * 3 + 1] = (rgb >> 8) & 0xff;
          palette[q * 3 + 2] = rgb & 0xff;
        }
        return { palette: palette, size: exCount };
      }
      // Otherwise median-cut the *exact* colours: any colour that ends up
      // alone in a box still comes back byte-for-byte.
      var xr = new Float64Array(exCount);
      var xg = new Float64Array(exCount);
      var xb = new Float64Array(exCount);
      for (q = 0; q < exCount; q++) {
        rgb = exList[q];
        xr[q] = (rgb >> 16) & 0xff;
        xg[q] = (rgb >> 8) & 0xff;
        xb[q] = rgb & 0xff;
      }
      return {
        palette: palette,
        size: medianCut(xr, xg, xb, exCnt, exCount, maxColors, palette)
      };
    }

    var m = nonEmpty;
    var idx = new Int32Array(m);
    var ar = new Float64Array(m);
    var ag = new Float64Array(m);
    var ab = new Float64Array(m);
    var cnt = new Float64Array(m);
    var k = 0;
    for (bi = 0; bi < HIST_SIZE; bi++) {
      if (counts[bi] !== 0) {
        idx[k] = bi;
        cnt[k] = counts[bi];
        ar[k] = sr[bi] / counts[bi];
        ag[k] = sg[bi] / counts[bi];
        ab[k] = sb[bi] / counts[bi];
        k++;
      }
    }

    // Few enough distinct buckets: emit them directly (exact for flat art).
    if (m <= maxColors) {
      for (k = 0; k < m; k++) {
        bi = idx[k];
        if (pure[bi] === 1) {
          rgb = firstRGB[bi];
          palette[k * 3] = (rgb >> 16) & 0xff;
          palette[k * 3 + 1] = (rgb >> 8) & 0xff;
          palette[k * 3 + 2] = rgb & 0xff;
        } else {
          palette[k * 3] = Math.round(ar[k]);
          palette[k * 3 + 1] = Math.round(ag[k]);
          palette[k * 3 + 2] = Math.round(ab[k]);
        }
      }
      return { palette: palette, size: m };
    }

    // ---- median cut over the 5-bit histogram (very colour-rich sources) ----
    return {
      palette: palette,
      size: medianCut(ar, ag, ab, cnt, m, maxColors, palette)
    };
  }

  function clamp255(v) { return v < 0 ? 0 : (v > 255 ? 255 : v); }

  /**
   * Nearest-palette-entry lookup.
   * Exact palette colours hit an open-addressed hash (so flat art round-trips
   * losslessly); everything else falls back to a linear nearest search cached
   * per 5-bit RGB bucket.
   */
  function makeMapper(palette, size) {
    var HS = 2048, HMASK = HS - 1;
    var hk = new Int32Array(HS).fill(-1);
    var hv = new Int32Array(HS);
    var i, rgb, h;
    for (i = 0; i < size; i++) {
      rgb = (palette[i * 3] << 16) | (palette[i * 3 + 1] << 8) | palette[i * 3 + 2];
      h = (Math.imul(rgb, 2654435761) >>> 20) & HMASK;
      while (hk[h] !== -1 && hk[h] !== rgb) h = (h + 1) & HMASK;
      if (hk[h] === -1) { hk[h] = rgb; hv[h] = i; }
    }
    var cache = new Int16Array(HIST_SIZE).fill(-1);

    return function nearest(r, g, b) {
      var key = (r << 16) | (g << 8) | b;
      var hh = (Math.imul(key, 2654435761) >>> 20) & HMASK;
      while (hk[hh] !== -1) {
        if (hk[hh] === key) return hv[hh];
        hh = (hh + 1) & HMASK;
      }
      var bi = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      var cached = cache[bi];
      if (cached >= 0) return cached;
      var best = 0, bestD = Infinity;
      for (var q = 0; q < size; q++) {
        var dr = r - palette[q * 3];
        var dg = g - palette[q * 3 + 1];
        var db = b - palette[q * 3 + 2];
        var dist = dr * dr * 299 + dg * dg * 587 + db * db * 114;
        if (dist < bestD) {
          bestD = dist; best = q;
          if (dist === 0) break;
        }
      }
      cache[bi] = best;
      return best;
    };
  }

  function quantizeFrame(rgb, mapper) {
    var n = (rgb.length / 3) | 0;
    var out = new Uint8Array(n);
    for (var i = 0, p = 0; i < n; i++, p += 3) {
      out[i] = mapper(rgb[p], rgb[p + 1], rgb[p + 2]);
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * GIF89a stream assembly
   * ------------------------------------------------------------------ */

  function paletteDepth(size) {
    var depth = 2; // GIF needs an LZW min code size of at least 2
    while ((1 << depth) < size && depth < 8) depth++;
    return depth;
  }

  function writeHeader(out, width, height, palette, size, depth, repeat) {
    // Header
    out.string('GIF89a');
    // Logical Screen Descriptor
    out.short(width);
    out.short(height);
    out.byte(0x80 | ((depth - 1) << 4) | (depth - 1)); // GCT present, colour res, GCT size
    out.byte(0);  // background colour index
    out.byte(0);  // pixel aspect ratio
    // Global Color Table (2^depth entries, zero padded)
    var entries = 1 << depth;
    out.ensure(entries * 3);
    for (var i = 0; i < entries; i++) {
      if (i < size) {
        out.byte(palette[i * 3]);
        out.byte(palette[i * 3 + 1]);
        out.byte(palette[i * 3 + 2]);
      } else {
        out.byte(0); out.byte(0); out.byte(0);
      }
    }
    // NETSCAPE2.0 Application Extension (looping)
    if (repeat >= 0) {
      out.byte(0x21); out.byte(0xff); out.byte(0x0b);
      out.string('NETSCAPE2.0');
      out.byte(0x03); out.byte(0x01);
      out.short(repeat & 0xffff);
      out.byte(0x00);
    }
  }

  function writeFrame(out, indices, width, height, delay, depth) {
    // Graphic Control Extension
    out.byte(0x21); out.byte(0xf9); out.byte(0x04);
    out.byte(0x04);            // disposal = 1 (do not dispose), no transparency
    out.short(delay & 0xffff); // centiseconds
    out.byte(0x00);            // transparent colour index (unused)
    out.byte(0x00);            // block terminator
    // Image Descriptor
    out.byte(0x2c);
    out.short(0); out.short(0);
    out.short(width); out.short(height);
    out.byte(0x00);            // no local colour table, not interlaced
    // Image data
    out.byte(depth);           // LZW minimum code size
    lzwEncode(indices, depth, out);
  }

  /* ------------------------------------------------------------------ *
   * Frame normalisation
   * ------------------------------------------------------------------ */

  function isImageDataLike(src) {
    return !!src && typeof src === 'object' &&
      typeof src.width === 'number' && typeof src.height === 'number' &&
      src.data && typeof src.data.length === 'number' &&
      src.data.length >= src.width * src.height * 4;
  }

  function rgbaToRgb(data, pixels) {
    var out = new Uint8Array(pixels * 3);
    for (var i = 0, j = 0, k = 0; i < pixels; i++, j += 4, k += 3) {
      var a = data[j + 3];
      if (a === 255) {
        out[k] = data[j]; out[k + 1] = data[j + 1]; out[k + 2] = data[j + 2];
      } else if (a === 0) {
        out[k] = 255; out[k + 1] = 255; out[k + 2] = 255; // composite over white
      } else {
        var f = a / 255, inv = 255 * (1 - f);
        out[k] = clamp255(Math.round(data[j] * f + inv));
        out[k + 1] = clamp255(Math.round(data[j + 1] * f + inv));
        out[k + 2] = clamp255(Math.round(data[j + 2] * f + inv));
      }
    }
    return out;
  }

  function makeCanvas(w, h) {
    if (typeof document !== 'undefined' && document.createElement) {
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      return c;
    }
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    return null;
  }

  var scratch = null, scratchSrc = null;
  function scratchCanvas(w, h) {
    if (!scratch || scratch.width !== w || scratch.height !== h) {
      scratch = makeCanvas(w, h);
      if (!scratch) return null;
      scratch.width = w; scratch.height = h;
    }
    return scratch;
  }
  function sourceCanvas(w, h) {
    if (!scratchSrc || scratchSrc.width !== w || scratchSrc.height !== h) {
      scratchSrc = makeCanvas(w, h);
      if (!scratchSrc) return null;
      scratchSrc.width = w; scratchSrc.height = h;
    }
    return scratchSrc;
  }

  function realImageData(src) {
    if (typeof ImageData === 'undefined') return null;
    if (src instanceof ImageData && src.data.length === src.width * src.height * 4) return src;
    // ImageData's constructor demands data.length === width*height*4 exactly.
    var need = src.width * src.height * 4;
    if (!(need > 0)) return null;
    var copy = new Uint8ClampedArray(need);
    var d = src.data;
    var n = d.length < need ? d.length : need;
    // `data` may be a plain Array as well as a typed array - no .subarray there.
    if (typeof d.subarray === 'function') {
      copy.set(d.subarray(0, n));
    } else {
      for (var i = 0; i < n; i++) copy[i] = d[i];
    }
    return new ImageData(copy, src.width, src.height);
  }

  // <img> exposes layout size on .width; .naturalWidth is the real pixel size.
  function srcWidth(src) { return src.naturalWidth || src.videoWidth || src.width || 0; }
  function srcHeight(src) { return src.naturalHeight || src.videoHeight || src.height || 0; }

  function normalizeFrame(src, w, h, index) {
    if (src == null) {
      throw new Error('MiviGIF.encode: frame ' + index + ' is null or undefined');
    }
    // Fast, DOM-free path: ImageData already at the output size.
    if (isImageDataLike(src) && src.width === w && src.height === h) {
      return rgbaToRgb(src.data, w * h);
    }

    // Validate the source size *before* touching any canvas, so a sizeless frame
    // reports a MiviGIF error instead of an IndexSizeError from ImageData/canvas.
    var isID = isImageDataLike(src);
    var sw = isID ? src.width : srcWidth(src);
    var sh = isID ? src.height : srcHeight(src);
    if (!(sw > 0) || !(sh > 0)) {
      throw new Error('MiviGIF.encode: frame ' + index + ' has no usable dimensions');
    }

    var canvas = scratchCanvas(w, h);
    if (!canvas) {
      throw new Error('MiviGIF.encode: frame ' + index + ' is ' + (isID
        ? 'not the output size and no canvas is available to rescale it'
        : 'not an ImageData and no canvas is available to draw it'));
    }
    var ctx = canvas.getContext('2d', { willReadFrequently: true }) || canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    var drawable;
    if (isID) {
      var tmp = sourceCanvas(sw, sh);
      var id = realImageData(src);
      if (!tmp || !id) throw new Error('MiviGIF.encode: cannot rescale frame ' + index);
      tmp.getContext('2d').putImageData(id, 0, 0);
      drawable = tmp;
    } else {
      drawable = src;
    }

    var scale = Math.min(w / sw, h / sh);
    var dw = Math.max(1, Math.round(sw * scale));
    var dh = Math.max(1, Math.round(sh * scale));
    var dx = Math.floor((w - dw) / 2);
    var dy = Math.floor((h - dh) / 2);
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(drawable, 0, 0, sw, sh, dx, dy, dw, dh);

    return rgbaToRgb(ctx.getImageData(0, 0, w, h).data, w * h);
  }

  /* ------------------------------------------------------------------ *
   * Public encode pipeline
   * ------------------------------------------------------------------ */

  function nextTick() {
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
  }

  function normalizeOpts(frames, opts) {
    opts = opts || {};
    var f0 = frames[0];
    var w = Math.round(opts.width > 0 ? opts.width : (f0 ? srcWidth(f0) : 0));
    var h = Math.round(opts.height > 0 ? opts.height : (f0 ? srcHeight(f0) : 0));
    if (!(w > 0) || !(h > 0)) {
      throw new Error('MiviGIF.encode: could not determine output size - pass opts.width and opts.height');
    }
    if (w > 65535 || h > 65535) {
      throw new Error('MiviGIF.encode: output size must be at most 65535 x 65535');
    }
    var delay = opts.delay;
    delay = (typeof delay === 'number' && isFinite(delay)) ? Math.round(delay) : 100;
    if (delay < 0) delay = 0;
    if (delay > 65535) delay = 65535;
    var repeat = opts.repeat;
    repeat = (typeof repeat === 'number' && isFinite(repeat)) ? Math.round(repeat) : 0;
    if (repeat > 65535) repeat = 65535;
    if (repeat < 0) repeat = -1;
    return {
      width: w, height: h, delay: delay, repeat: repeat,
      onProgress: typeof opts.onProgress === 'function' ? opts.onProgress : null
    };
  }

  function report(cb, value) {
    if (!cb) return;
    try { cb(value < 0 ? 0 : (value > 1 ? 1 : value)); } catch (e) { /* never let a callback break encoding */ }
  }

  /**
   * Encode to raw GIF bytes.
   * @returns {Promise<Uint8Array>}
   */
  function encodeBytes(frames, opts) {
    return Promise.resolve().then(function () {
      if (!frames || typeof frames.length !== 'number') {
        throw new Error('MiviGIF.encode: `frames` must be an array of canvases or ImageData');
      }
      if (frames.length === 0) {
        throw new Error('MiviGIF.encode: `frames` is empty - at least one frame is required');
      }
      var o = normalizeOpts(frames, opts);
      var count = frames.length;
      var rgbFrames = new Array(count);

      report(o.onProgress, 0);

      // Phase 1 (0 -> 0.45): normalise every frame to packed RGB at output size.
      var chain = Promise.resolve();
      for (var i = 0; i < count; i++) {
        (function (i) {
          chain = chain.then(function () {
            rgbFrames[i] = normalizeFrame(frames[i], o.width, o.height, i);
            report(o.onProgress, 0.45 * (i + 1) / count);
            return nextTick();
          });
        })(i);
      }

      // Phase 2 (0.45 -> 0.55): shared 256-colour palette across all frames.
      return chain.then(function () {
        var pal = buildPalette(rgbFrames, 256);
        var depth = paletteDepth(pal.size);
        var mapper = makeMapper(pal.palette, pal.size);
        report(o.onProgress, 0.55);

        var out = new Writer(Math.max(65536, o.width * o.height));
        writeHeader(out, o.width, o.height, pal.palette, pal.size, depth, o.repeat);

        // Phase 3 (0.55 -> 1): quantize + LZW per frame, yielding between frames.
        var c2 = nextTick();
        for (var j = 0; j < count; j++) {
          (function (j) {
            c2 = c2.then(function () {
              var indices = quantizeFrame(rgbFrames[j], mapper);
              rgbFrames[j] = null; // release as we go
              writeFrame(out, indices, o.width, o.height, o.delay, depth);
              report(o.onProgress, 0.55 + 0.45 * (j + 1) / count);
              return nextTick();
            });
          })(j);
        }
        return c2.then(function () {
          out.byte(0x3b); // trailer
          report(o.onProgress, 1);
          return out.result();
        });
      });
    });
  }

  /**
   * Encode to an image/gif Blob.
   * @returns {Promise<Blob>}
   */
  function encode(frames, opts) {
    return encodeBytes(frames, opts).then(function (bytes) {
      if (typeof Blob === 'undefined') return bytes; // non-browser fallback
      return new Blob([bytes], { type: 'image/gif' });
    });
  }

  var MiviGIF = {
    version: '1.0.0',
    encode: encode,
    encodeBytes: encodeBytes
  };

  if (global && typeof global === 'object') global.MiviGIF = MiviGIF;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = MiviGIF;
    module.exports.MiviGIF = MiviGIF;
    module.exports._internals = {
      Writer: Writer,
      lzwEncode: lzwEncode,
      buildPalette: buildPalette,
      makeMapper: makeMapper,
      quantizeFrame: quantizeFrame,
      paletteDepth: paletteDepth,
      writeHeader: writeHeader,
      writeFrame: writeFrame,
      rgbaToRgb: rgbaToRgb,
      normalizeOpts: normalizeOpts
    };
  }
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null));
