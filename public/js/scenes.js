// ─────────────────────────────────────────────────────────────
// scenes.js — drawable backdrops for the canvas.
//
// Every scene is drawn procedurally (no image files, nothing to
// download) and deterministically: any randomness comes from a
// seeded generator, so every player renders identical pixels.
//
// Colours are deliberately pale — the artist draws ON TOP of these,
// so a scene must never compete with the strokes.
//
//   window.MiviScenes = {
//     list()            -> [{ id, name, emoji }]
//     has(id)           -> boolean
//     draw(ctx, id, w, h)   paints the scene, returns true if it did
//   }
// ─────────────────────────────────────────────────────────────
(function () {
  'use strict';

  // Tiny deterministic PRNG (mulberry32) so stars/clouds match everywhere.
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function vgrad(c, w, h, stops) {
    const g = c.createLinearGradient(0, 0, 0, h);
    for (const [at, col] of stops) g.addColorStop(at, col);
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  }

  function fillRect(c, col, x, y, w, h) {
    c.fillStyle = col;
    c.fillRect(x, y, w, h);
  }

  function circle(c, col, x, y, r) {
    c.fillStyle = col;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
  }

  // A rolling hill silhouette across the whole width.
  function hill(c, col, w, baseY, amp, seed) {
    const r = rng(seed);
    c.fillStyle = col;
    c.beginPath();
    c.moveTo(0, baseY);
    const steps = 6;
    for (let i = 0; i <= steps; i++) {
      const x = (w / steps) * i;
      const y = baseY - amp * (0.4 + r() * 0.6) * Math.sin((i / steps) * Math.PI);
      if (i === 0) c.lineTo(x, y);
      else c.quadraticCurveTo(x - w / steps / 2, y - amp * 0.15, x, y);
    }
    c.lineTo(w, baseY);
    c.lineTo(w, 100000);
    c.lineTo(0, 100000);
    c.closePath();
    c.fill();
  }

  function tree(c, x, groundY, size, trunk, leaf) {
    fillRect(c, trunk, x - size * 0.08, groundY - size * 0.55, size * 0.16, size * 0.55);
    circle(c, leaf, x, groundY - size * 0.72, size * 0.3);
    circle(c, leaf, x - size * 0.22, groundY - size * 0.55, size * 0.22);
    circle(c, leaf, x + size * 0.22, groundY - size * 0.55, size * 0.22);
  }

  function cloud(c, x, y, s, col) {
    circle(c, col, x, y, s * 0.5);
    circle(c, col, x - s * 0.55, y + s * 0.1, s * 0.36);
    circle(c, col, x + s * 0.55, y + s * 0.1, s * 0.4);
    fillRect(c, col, x - s * 0.55, y + s * 0.05, s * 1.1, s * 0.45);
  }

  const SCENES = [
    {
      id: 'meadow', name: 'Meadow', emoji: '🌄',
      draw(c, w, h) {
        vgrad(c, w, h, [[0, '#DCF0FF'], [1, '#F2FBFF']]);
        circle(c, '#FFF3C4', w * 0.8, h * 0.2, h * 0.09);
        const r = rng(11);
        for (let i = 0; i < 4; i++) cloud(c, w * (0.1 + r() * 0.8), h * (0.1 + r() * 0.2), h * 0.07, '#FFFFFF');
        hill(c, '#DFF0D8', w, h * 0.72, h * 0.12, 3);
        hill(c, '#CFE8C4', w, h * 0.84, h * 0.1, 7);
        fillRect(c, '#E8F6E0', 0, h * 0.84, w, h);
      },
    },
    {
      id: 'city', name: 'City', emoji: '🏙️',
      draw(c, w, h) {
        vgrad(c, w, h, [[0, '#DDEBFA'], [1, '#F6FAFE']]);
        const r = rng(21);
        let x = 0;
        while (x < w) {
          const bw = w * (0.05 + r() * 0.06);
          const bh = h * (0.18 + r() * 0.38);
          fillRect(c, r() > 0.5 ? '#D3DDEA' : '#C7D3E3', x, h * 0.82 - bh, bw - 4, bh);
          for (let wy = h * 0.82 - bh + 12; wy < h * 0.78; wy += 22) {
            for (let wx = x + 8; wx < x + bw - 14; wx += 20) {
              if (r() > 0.45) fillRect(c, '#EEF4FB', wx, wy, 8, 10);
            }
          }
          x += bw;
        }
        fillRect(c, '#E3E8EF', 0, h * 0.82, w, h);
        fillRect(c, '#D5DBE4', 0, h * 0.86, w, 3);
      },
    },
    {
      id: 'nightcity', name: 'City at night', emoji: '🌃',
      draw(c, w, h) {
        vgrad(c, w, h, [[0, '#2B3357'], [1, '#5A5C86']]);
        const r = rng(29);
        for (let i = 0; i < 60; i++) circle(c, '#FFFFFF', r() * w, r() * h * 0.5, r() * 1.6 + 0.5);
        circle(c, '#FFF6D8', w * 0.15, h * 0.16, h * 0.06);
        let x = 0;
        while (x < w) {
          const bw = w * (0.05 + r() * 0.07);
          const bh = h * (0.2 + r() * 0.4);
          fillRect(c, '#1E2340', x, h * 0.84 - bh, bw - 4, bh);
          for (let wy = h * 0.84 - bh + 12; wy < h * 0.8; wy += 22) {
            for (let wx = x + 8; wx < x + bw - 14; wx += 20) {
              if (r() > 0.5) fillRect(c, '#FFE9A8', wx, wy, 8, 10);
            }
          }
          x += bw;
        }
        fillRect(c, '#171B32', 0, h * 0.84, w, h);
      },
    },
    {
      id: 'beach', name: 'Beach', emoji: '🏖️',
      draw(c, w, h) {
        vgrad(c, w, h * 0.6, [[0, '#CFEEFF'], [1, '#EAF8FF']]);
        fillRect(c, '#EAF8FF', 0, 0, w, h * 0.55);
        circle(c, '#FFEFB8', w * 0.78, h * 0.16, h * 0.08);
        fillRect(c, '#BFE4F2', 0, h * 0.55, w, h * 0.18);
        for (let i = 0; i < 5; i++) {
          fillRect(c, '#D7EFF8', 0, h * (0.57 + i * 0.032), w, 3);
        }
        fillRect(c, '#F6E9C9', 0, h * 0.73, w, h);
        const r = rng(41);
        for (let i = 0; i < 14; i++) circle(c, '#EFDFB8', r() * w, h * (0.76 + r() * 0.22), 3);
      },
    },
    {
      id: 'forest', name: 'Forest', emoji: '🌲',
      draw(c, w, h) {
        vgrad(c, w, h, [[0, '#E4F2E6'], [1, '#F4FAF3']]);
        const r = rng(53);
        for (let i = 0; i < 7; i++) {
          const x = w * (0.05 + (i / 7) * 0.92 + r() * 0.03);
          const s = h * (0.3 + r() * 0.16);
          c.fillStyle = '#CFE4CC';
          c.beginPath();
          c.moveTo(x, h * 0.72 - s);
          c.lineTo(x - s * 0.3, h * 0.72);
          c.lineTo(x + s * 0.3, h * 0.72);
          c.closePath();
          c.fill();
        }
        fillRect(c, '#DDEEDA', 0, h * 0.72, w, h);
        for (let i = 0; i < 4; i++) tree(c, w * (0.12 + i * 0.26), h * 0.9, h * 0.26, '#C9B49A', '#BFDDB8');
      },
    },
    {
      id: 'mountains', name: 'Mountains', emoji: '🏔️',
      draw(c, w, h) {
        vgrad(c, w, h, [[0, '#DCEBFA'], [1, '#F5FAFE']]);
        const peaks = [[0.2, 0.62], [0.5, 0.5], [0.8, 0.66]];
        for (const [px, py] of peaks) {
          c.fillStyle = '#D4DEEA';
          c.beginPath();
          c.moveTo(w * px, h * py);
          c.lineTo(w * px - h * 0.34, h * 0.84);
          c.lineTo(w * px + h * 0.34, h * 0.84);
          c.closePath();
          c.fill();
          c.fillStyle = '#FFFFFF';
          c.beginPath();
          c.moveTo(w * px, h * py);
          c.lineTo(w * px - h * 0.08, h * (py + 0.08));
          c.lineTo(w * px + h * 0.08, h * (py + 0.08));
          c.closePath();
          c.fill();
        }
        fillRect(c, '#E6EDF4', 0, h * 0.84, w, h);
      },
    },
    {
      id: 'space', name: 'Space', emoji: '🚀',
      draw(c, w, h) {
        vgrad(c, w, h, [[0, '#2E2A55'], [1, '#4C4176']]);
        const r = rng(67);
        for (let i = 0; i < 120; i++) circle(c, '#FFFFFF', r() * w, r() * h, r() * 1.8 + 0.4);
        circle(c, '#8E86C9', w * 0.18, h * 0.24, h * 0.11);
        circle(c, '#A79FDA', w * 0.82, h * 0.72, h * 0.16);
        c.strokeStyle = '#C7BFF0';
        c.lineWidth = 4;
        c.beginPath();
        c.ellipse(w * 0.82, h * 0.72, h * 0.26, h * 0.07, -0.35, 0, Math.PI * 2);
        c.stroke();
      },
    },
    {
      id: 'desert', name: 'Desert', emoji: '🌵',
      draw(c, w, h) {
        vgrad(c, w, h, [[0, '#FFE9CC'], [1, '#FFF6E8']]);
        circle(c, '#FFD79A', w * 0.72, h * 0.2, h * 0.1);
        hill(c, '#F4DCB4', w, h * 0.74, h * 0.08, 13);
        fillRect(c, '#F8E6C6', 0, h * 0.82, w, h);
        const gy = h * 0.86;
        fillRect(c, '#CFE0BC', w * 0.16, gy - h * 0.2, h * 0.045, h * 0.2);
        fillRect(c, '#CFE0BC', w * 0.16 - h * 0.06, gy - h * 0.15, h * 0.06, h * 0.03);
        fillRect(c, '#CFE0BC', w * 0.16 - h * 0.06, gy - h * 0.15, h * 0.028, h * 0.07);
      },
    },
    {
      id: 'underwater', name: 'Underwater', emoji: '🐠',
      draw(c, w, h) {
        vgrad(c, w, h, [[0, '#BFE7F5'], [1, '#7FC6E0']]);
        const r = rng(83);
        for (let i = 0; i < 26; i++) {
          const x = r() * w, y = r() * h * 0.9, s = r() * 9 + 3;
          c.strokeStyle = 'rgba(255,255,255,0.65)';
          c.lineWidth = 2;
          c.beginPath();
          c.arc(x, y, s, 0, Math.PI * 2);
          c.stroke();
        }
        hill(c, '#E8DCC0', w, h * 0.9, h * 0.06, 5);
        for (let i = 0; i < 5; i++) {
          const x = w * (0.1 + i * 0.2);
          c.strokeStyle = '#8FC79C';
          c.lineWidth = 8;
          c.beginPath();
          c.moveTo(x, h);
          c.quadraticCurveTo(x + 24, h * 0.8, x, h * 0.62);
          c.stroke();
        }
      },
    },
    {
      id: 'farm', name: 'Farm', emoji: '🚜',
      draw(c, w, h) {
        vgrad(c, w, h, [[0, '#DFF1FF'], [1, '#F6FBFF']]);
        cloud(c, w * 0.25, h * 0.16, h * 0.07, '#FFFFFF');
        cloud(c, w * 0.7, h * 0.12, h * 0.06, '#FFFFFF');
        fillRect(c, '#E2F0D6', 0, h * 0.62, w, h);
        for (let i = 0; i < 8; i++) fillRect(c, '#D3E8C2', 0, h * (0.66 + i * 0.045), w, 4);
        fillRect(c, '#F2CFC6', w * 0.62, h * 0.4, w * 0.22, h * 0.24);
        c.fillStyle = '#E4B4A9';
        c.beginPath();
        c.moveTo(w * 0.6, h * 0.4);
        c.lineTo(w * 0.73, h * 0.28);
        c.lineTo(w * 0.86, h * 0.4);
        c.closePath();
        c.fill();
      },
    },
    {
      id: 'road', name: 'Open road', emoji: '🛣️',
      draw(c, w, h) {
        vgrad(c, w, h, [[0, '#DCEEFF'], [1, '#F6FBFF']]);
        fillRect(c, '#DCEAD2', 0, h * 0.55, w, h);
        c.fillStyle = '#DCE1E8';
        c.beginPath();
        c.moveTo(w * 0.42, h * 0.55);
        c.lineTo(w * 0.58, h * 0.55);
        c.lineTo(w, h);
        c.lineTo(0, h);
        c.closePath();
        c.fill();
        c.strokeStyle = '#FFFFFF';
        c.lineWidth = 6;
        c.setLineDash([26, 26]);
        c.beginPath();
        c.moveTo(w * 0.5, h * 0.56);
        c.lineTo(w * 0.5, h);
        c.stroke();
        c.setLineDash([]);
      },
    },
    {
      id: 'snow', name: 'Snowy day', emoji: '❄️',
      draw(c, w, h) {
        vgrad(c, w, h, [[0, '#E6EFF8'], [1, '#F8FBFE']]);
        hill(c, '#FFFFFF', w, h * 0.78, h * 0.1, 17);
        fillRect(c, '#FAFCFF', 0, h * 0.86, w, h);
        const r = rng(97);
        for (let i = 0; i < 60; i++) circle(c, '#FFFFFF', r() * w, r() * h * 0.85, r() * 3 + 1.5);
        for (let i = 0; i < 3; i++) {
          const x = w * (0.2 + i * 0.3);
          c.fillStyle = '#DCE9DA';
          c.beginPath();
          c.moveTo(x, h * 0.5);
          c.lineTo(x - h * 0.1, h * 0.8);
          c.lineTo(x + h * 0.1, h * 0.8);
          c.closePath();
          c.fill();
        }
      },
    },
    {
      id: 'sunset', name: 'Sunset', emoji: '🌇',
      draw(c, w, h) {
        vgrad(c, w, h, [[0, '#FFD9C0'], [0.5, '#FFE9D4'], [1, '#FFF3E4']]);
        circle(c, '#FFC79A', w * 0.5, h * 0.52, h * 0.14);
        fillRect(c, '#F6C7A8', 0, h * 0.62, w, h);
        for (let i = 0; i < 6; i++) fillRect(c, '#FFDCC0', 0, h * (0.64 + i * 0.05), w, 5);
      },
    },
    {
      id: 'rain', name: 'Rainy street', emoji: '🌧️',
      draw(c, w, h) {
        vgrad(c, w, h, [[0, '#D9E1E8'], [1, '#EEF2F6']]);
        cloud(c, w * 0.3, h * 0.16, h * 0.09, '#C8D2DC');
        cloud(c, w * 0.68, h * 0.13, h * 0.08, '#CFD8E1');
        const r = rng(103);
        c.strokeStyle = 'rgba(150,175,200,0.55)';
        c.lineWidth = 2;
        for (let i = 0; i < 70; i++) {
          const x = r() * w, y = r() * h * 0.85;
          c.beginPath();
          c.moveTo(x, y);
          c.lineTo(x - 5, y + 16);
          c.stroke();
        }
        fillRect(c, '#DDE4EA', 0, h * 0.82, w, h);
        c.fillStyle = '#CCD6DE';
        c.beginPath();
        c.ellipse(w * 0.35, h * 0.92, w * 0.12, h * 0.025, 0, 0, Math.PI * 2);
        c.fill();
      },
    },
    {
      id: 'castle', name: 'Castle', emoji: '🏰',
      draw(c, w, h) {
        vgrad(c, w, h, [[0, '#E2ECFA'], [1, '#F7FAFE']]);
        hill(c, '#DCEBD5', w, h * 0.82, h * 0.1, 23);
        const bx = w * 0.34, bw = w * 0.32, by = h * 0.4;
        fillRect(c, '#DFDCE6', bx, by, bw, h * 0.4);
        fillRect(c, '#D3D0DC', bx - w * 0.07, by - h * 0.06, w * 0.08, h * 0.46);
        fillRect(c, '#D3D0DC', bx + bw - w * 0.01, by - h * 0.06, w * 0.08, h * 0.46);
        for (let i = 0; i < 5; i++) fillRect(c, '#DFDCE6', bx + i * (bw / 5), by - h * 0.04, bw / 9, h * 0.04);
        fillRect(c, '#C4C0D2', bx + bw / 2 - w * 0.035, h * 0.62, w * 0.07, h * 0.18);
      },
    },
    {
      id: 'track', name: 'Race track', emoji: '🏁',
      draw(c, w, h) {
        fillRect(c, '#E4F0DA', 0, 0, w, h);
        c.strokeStyle = '#D8DDE3';
        c.lineWidth = h * 0.18;
        c.beginPath();
        c.ellipse(w * 0.5, h * 0.58, w * 0.36, h * 0.3, 0, 0, Math.PI * 2);
        c.stroke();
        c.strokeStyle = '#FFFFFF';
        c.lineWidth = 3;
        c.setLineDash([20, 20]);
        c.beginPath();
        c.ellipse(w * 0.5, h * 0.58, w * 0.36, h * 0.3, 0, 0, Math.PI * 2);
        c.stroke();
        c.setLineDash([]);
        for (let i = 0; i < 8; i++) {
          fillRect(c, i % 2 ? '#FFFFFF' : '#C9CED6', w * 0.46 + (i % 2) * 12, h * 0.2 + Math.floor(i / 2) * 12, 12, 12);
        }
      },
    },
    {
      id: 'pitch', name: 'Football pitch', emoji: '⚽',
      draw(c, w, h) {
        fillRect(c, '#DCEFCF', 0, 0, w, h);
        for (let i = 0; i < 8; i++) if (i % 2) fillRect(c, '#D3E9C3', 0, (h / 8) * i, w, h / 8);
        c.strokeStyle = '#FFFFFF';
        c.lineWidth = 4;
        c.strokeRect(w * 0.06, h * 0.08, w * 0.88, h * 0.84);
        c.beginPath();
        c.moveTo(w * 0.5, h * 0.08);
        c.lineTo(w * 0.5, h * 0.92);
        c.stroke();
        c.beginPath();
        c.arc(w * 0.5, h * 0.5, h * 0.14, 0, Math.PI * 2);
        c.stroke();
        c.strokeRect(w * 0.06, h * 0.3, w * 0.1, h * 0.4);
        c.strokeRect(w * 0.84, h * 0.3, w * 0.1, h * 0.4);
      },
    },
    {
      id: 'classroom', name: 'Classroom', emoji: '🏫',
      draw(c, w, h) {
        fillRect(c, '#F3EEE4', 0, 0, w, h);
        fillRect(c, '#DCE8DC', w * 0.1, h * 0.12, w * 0.8, h * 0.5);
        c.strokeStyle = '#C6D6C6';
        c.lineWidth = 8;
        c.strokeRect(w * 0.1, h * 0.12, w * 0.8, h * 0.5);
        fillRect(c, '#E6D9C3', 0, h * 0.72, w, h);
        fillRect(c, '#D9C9AE', 0, h * 0.72, w, 6);
      },
    },
    {
      id: 'kitchen', name: 'Kitchen', emoji: '🍳',
      draw(c, w, h) {
        fillRect(c, '#F6F2EA', 0, 0, w, h);
        for (let y = 0; y < h * 0.68; y += 44) {
          for (let x = 0; x < w; x += 44) {
            c.strokeStyle = '#E7E0D4';
            c.lineWidth = 2;
            c.strokeRect(x, y, 44, 44);
          }
        }
        fillRect(c, '#E2D7C4', 0, h * 0.68, w, h * 0.06);
        fillRect(c, '#EFE7D8', 0, h * 0.74, w, h);
      },
    },
    {
      id: 'stage', name: 'On stage', emoji: '🎭',
      draw(c, w, h) {
        fillRect(c, '#F1E6EC', 0, 0, w, h);
        c.fillStyle = '#E7D3DC';
        for (let i = 0; i < 5; i++) fillRect(c, i % 2 ? '#E7D3DC' : '#DFC7D3', w * 0.02 + i * (w * 0.045), 0, w * 0.045, h * 0.86);
        for (let i = 0; i < 5; i++) fillRect(c, i % 2 ? '#E7D3DC' : '#DFC7D3', w * 0.755 + i * (w * 0.045), 0, w * 0.045, h * 0.86);
        c.fillStyle = 'rgba(255,246,214,0.75)';
        c.beginPath();
        c.moveTo(w * 0.5, 0);
        c.lineTo(w * 0.22, h * 0.86);
        c.lineTo(w * 0.78, h * 0.86);
        c.closePath();
        c.fill();
        fillRect(c, '#D9C2A8', 0, h * 0.86, w, h);
      },
    },
    {
      id: 'clouds', name: 'Up in the clouds', emoji: '☁️',
      draw(c, w, h) {
        vgrad(c, w, h, [[0, '#CFE7FB'], [1, '#EFF8FF']]);
        const r = rng(131);
        for (let i = 0; i < 8; i++) cloud(c, r() * w, h * (0.15 + r() * 0.7), h * (0.06 + r() * 0.07), '#FFFFFF');
      },
    },
    {
      id: 'paper', name: 'Blank page', emoji: '📄',
      draw(c, w, h) {
        fillRect(c, '#FFFFFF', 0, 0, w, h);
        fillRect(c, '#FDF4F4', 0, 0, w * 0.09, h);
        c.strokeStyle = '#F3C9C9';
        c.lineWidth = 2;
        c.beginPath();
        c.moveTo(w * 0.09, 0);
        c.lineTo(w * 0.09, h);
        c.stroke();
        c.strokeStyle = '#DFEAF6';
        for (let y = h * 0.08; y < h; y += h * 0.075) {
          c.beginPath();
          c.moveTo(0, y);
          c.lineTo(w, y);
          c.stroke();
        }
      },
    },
  ];

  const byId = {};
  for (const s of SCENES) byId[s.id] = s;

  const MiviScenes = {
    list: () => SCENES.map(s => ({ id: s.id, name: s.name, emoji: s.emoji })),
    ids: () => SCENES.map(s => s.id),
    has: (id) => Object.prototype.hasOwnProperty.call(byId, id),
    draw(ctx, id, w, h) {
      const s = byId[id];
      if (!s || !ctx) return false;
      ctx.save();
      try { s.draw(ctx, w, h); } finally { ctx.restore(); }
      return true;
    },
  };

  if (typeof window !== 'undefined') window.MiviScenes = MiviScenes;
  if (typeof module !== 'undefined' && module.exports) module.exports = MiviScenes;
})();
