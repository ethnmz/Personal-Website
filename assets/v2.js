(function () {
  'use strict';

  var FPS = 8;
  var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var state = { party: false, frame: 0 };
  var bannerEl = document.querySelector('.path-bar[data-scene]');
  var pageName = bannerEl ? bannerEl.getAttribute('data-scene') : 'home';

  function isNight() { return document.body.classList.contains('dark'); }
  function musicPlaying() { return !!document.querySelector('.np-disc.playing'); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function smoothstep(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

  /* ---------- color, randomness, bitmaps ---------- */

  function rgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    var c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    c.css = hex;
    return c;
  }

  function palette(obj) {
    var out = {};
    Object.keys(obj).forEach(function (k) {
      out[k] = Array.isArray(obj[k]) ? obj[k].map(rgb) : rgb(obj[k]);
    });
    return out;
  }

  function random(seed) {
    return function () {
      seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  function dither(x, y) { return (BAYER[((y & 3) << 2) | (x & 3)] + 0.5) / 16; }

  function Bitmap(w, h) {
    this.w = w;
    this.h = h;
    this.d = new Uint8ClampedArray(w * h * 4);
  }
  Bitmap.prototype.put = function (x, y, c) {
    x = Math.floor(x);
    y = Math.floor(y);
    if (!c || x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    var i = (y * this.w + x) << 2, d = this.d;
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
  };
  Bitmap.prototype.painter = function () {
    var self = this;
    return function (x, y, c) { self.put(x, y, c); };
  };
  Bitmap.prototype.canvas = function () {
    var cv = document.createElement('canvas');
    cv.width = this.w;
    cv.height = this.h;
    cv.getContext('2d').putImageData(new ImageData(this.d, this.w, this.h), 0, 0);
    return cv;
  };

  function ctxPainter(ctx) {
    return function (x, y, c) {
      if (!c) return;
      ctx.fillStyle = c.css;
      ctx.fillRect(Math.floor(x), Math.floor(y), 1, 1);
    };
  }

  /* ---------- drawing primitives ---------- */

  function rect(put, x, y, w, h, c) {
    for (var j = 0; j < h; j++) for (var i = 0; i < w; i++) put(x + i, y + j, c);
  }

  function disc(put, cx, cy, r, c) {
    for (var dy = -r; dy <= r; dy++) {
      for (var dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy <= r * r + r * 0.8) put(cx + dx, cy + dy, c);
      }
    }
  }

  function halo(put, cx, cy, r0, r1, c, minY) {
    for (var dy = -r1; dy <= r1; dy++) {
      for (var dx = -r1; dx <= r1; dx++) {
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d <= r0 || d > r1 || (minY !== undefined && cy + dy < minY)) continue;
        var t = 1 - (d - r0) / (r1 - r0);
        if (t * 0.9 > dither(cx + dx, cy + dy)) put(cx + dx, cy + dy, c);
      }
    }
  }

  function vgrad(put, x0, x1, y0, y1, stops) {
    var n = stops.length - 1, span = Math.max(1, y1 - y0);
    for (var y = y0; y < y1; y++) {
      var t = (y - y0) / span * n, b = Math.min(n - 1, Math.floor(t)), f = t - b;
      for (var x = x0; x < x1; x++) put(x, y, f > dither(x, y) ? stops[b + 1] : stops[b]);
    }
  }

  function line(put, x0, y0, x1, y1, c, dotted) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    var dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    var sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, err = dx + dy, n = 0;
    for (;;) {
      if (!dotted || (n++ & 1) === 0) put(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      var e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  function ridge(n, r, rough) {
    var size = 1;
    while (size < n) size <<= 1;
    var a = new Array(size + 1);
    a[0] = r() - 0.5;
    a[size] = r() - 0.5;
    var amp = 1;
    for (var step = size; step > 1; step >>= 1) {
      var half = step >> 1;
      for (var i = half; i < size; i += step) a[i] = (a[i - half] + a[i + half]) / 2 + (r() - 0.5) * amp;
      amp *= rough;
    }
    return a.slice(0, n);
  }

  function normalize(a) {
    var lo = Infinity, hi = -Infinity;
    a.forEach(function (v) { if (v < lo) lo = v; if (v > hi) hi = v; });
    var span = hi - lo || 1;
    return a.map(function (v) { return (v - lo) / span; });
  }

  function smooth(a, k) {
    return a.map(function (_, i) {
      var s = 0, c = 0;
      for (var j = i - k; j <= i + k; j++) if (j >= 0 && j < a.length) { s += a[j]; c++; }
      return s / c;
    });
  }

  function pine(put, x, base, h, lit, shade, trunk) {
    var top = base - h;
    for (var i = 0; i < h - 1; i++) {
      var hw = Math.floor(i * 0.55);
      if (i >= 4 && i % 3 === 0) hw -= 1;
      for (var dx = -hw; dx <= hw; dx++) put(x + dx, top + i, dx <= 0 ? lit : shade);
    }
    put(x, base - 1, trunk || shade);
  }

  function roundTree(put, x, base, r, cols, trunk, rnd) {
    var th = Math.max(2, Math.round(r * 0.8));
    for (var i = 0; i < th; i++) put(x, base - 1 - i, trunk);
    var cy = base - th - r;
    for (var dy = -r; dy <= r; dy++) {
      for (var dx = -r - 1; dx <= r + 1; dx++) {
        if ((dx * dx) / ((r + 1) * (r + 1)) + (dy * dy) / (r * r) > 1) continue;
        var c = cols[1];
        if (dx + dy < -r * 0.45) c = cols[0];
        else if (dx + dy > r * 0.55) c = cols[2];
        if (rnd && rnd() < 0.09) c = cols[rnd() < 0.5 ? 0 : 2];
        put(x + dx, cy + dy, c);
      }
    }
  }

  function makeStars(r, w, h, n) {
    var out = [];
    for (var i = 0; i < n; i++) {
      out.push({ x: Math.floor(r() * w), y: Math.floor(r() * h), b: r() < 0.18 ? 0 : r() < 0.55 ? 1 : 2 });
    }
    return out;
  }

  function twinkle(put, list, f, P, count) {
    if (!list.length) return;
    for (var i = 0; i < count; i++) {
      var s = list[(f * 7 + i * 131) % list.length];
      put(s.x, s.y, (f + i) % 3 === 0 ? P.star[2] : P.star[0]);
    }
  }

  function cloudCanvas(r, P, size) {
    var w = Math.round(size * (1.8 + r())), h = Math.round(size * 0.75) + 1;
    var mask = new Uint8Array(w * h), base = h - 1, blobs = 3 + Math.floor(r() * 3);
    for (var i = 0; i < blobs; i++) {
      var rad = Math.max(2, Math.round(size * (0.28 + r() * 0.22)));
      var cx = rad + Math.floor(r() * Math.max(1, w - 2 * rad)), cy = base - Math.floor(rad * 0.6);
      for (var dy = -rad; dy <= rad; dy++) {
        for (var dx = -rad; dx <= rad; dx++) {
          var x = cx + dx, y = cy + dy;
          if (y > base || y < 0 || x < 0 || x >= w || dx * dx + dy * dy > rad * rad + rad * 0.6) continue;
          mask[y * w + x] = 1;
        }
      }
    }
    var bmp = new Bitmap(w, h), put = bmp.painter();
    for (var yy = 0; yy < h; yy++) {
      for (var xx = 0; xx < w; xx++) {
        if (!mask[yy * w + xx]) continue;
        var top = yy === 0 || !mask[(yy - 1) * w + xx];
        put(xx, yy, yy >= base - 1 ? P.cloudShade : top ? P.cloudLit : P.cloud);
      }
    }
    return bmp.canvas();
  }

  /* ---------- the moon (real phase) ---------- */

  var SYNODIC = 29.530588853;
  var NEW_MOON_REF = Date.UTC(2000, 0, 6, 18, 14);
  var PHASES = ['new moon', 'waxing crescent', 'first quarter', 'waxing gibbous', 'full moon', 'waning gibbous', 'last quarter', 'waning crescent'];

  function moonPhase(d) {
    var days = (d.getTime() - NEW_MOON_REF) / 86400000;
    var p = (days % SYNODIC) / SYNODIC;
    return p < 0 ? p + 1 : p;
  }
  function illumination(p) { return (1 - Math.cos(2 * Math.PI * p)) / 2; }
  function phaseName(p) { return PHASES[Math.floor(p * 8 + 0.5) % 8]; }

  function drawMoon(put, cx, cy, r, p, P) {
    var k = Math.cos(2 * Math.PI * p), waxing = p < 0.5;
    function lit(dx, dy) {
      var nx = dx / (r + 0.5), ny = dy / (r + 0.5), half = Math.sqrt(Math.max(0, 1 - ny * ny));
      return waxing ? nx > half * k : nx < -half * k;
    }
    for (var dy = -r; dy <= r; dy++) {
      for (var dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r + r * 0.8) continue;
        put(cx + dx, cy + dy, lit(dx, dy) ? P.moon : P.moonDark);
      }
    }
    if (r >= 4) {
      [[-2, -1], [1, 2], [2, -2], [-1, 2]].forEach(function (o) {
        if (lit(o[0], o[1])) put(cx + o[0], cy + o[1], P.moonCrater);
      });
    }
  }

  /* ---------- sprites ---------- */

  function Sprite(rows) {
    this.rows = rows;
    this.w = rows[0].length;
    this.h = rows.length;
  }

  function drawSprite(put, s, x, y, colors, flip) {
    for (var r = 0; r < s.h; r++) {
      var row = s.rows[r];
      for (var c = 0; c < s.w; c++) {
        var ch = row.charAt(flip ? s.w - 1 - c : c);
        if (ch !== '.' && colors[ch]) put(x + c, y + r, colors[ch]);
      }
    }
  }

  var CAT = new Sprite([
    '...K.....K.',
    '...KK...KK.',
    '...KKKKKKK.',
    '...KEKKKEK.',
    '...KKKPKKK.',
    '....KWWWK..',
    '....KKWKK..',
    '...KKWWWKK.',
    '..KKKWWWKKK',
    '..KKKKWKKKK',
    '..KKKKKKKKK',
    '..KKWWKWWKK'
  ]);
  var CAT_CLOSED = new Sprite(CAT.rows.map(function (r) { return r.replace(/E/g, 'K'); }));
  var TAILS = [
    new Sprite(['...', '...', '.K.', 'K..', 'K..', 'KK.']),
    new Sprite(['...', '...', '...', '...', '...', 'KK.']),
    new Sprite(['...', '.K.', 'K..', 'K..', 'K..', '.K.'])
  ];
  var HAT = new Sprite(['..A..', '..C..', '.CBC.', 'BCBCB']);
  var HEART = new Sprite(['.H.H.', 'HHHHH', '.HHH.', '..H..']);

  var CABIN = new Sprite([
    '.........cc...',
    '......Rq.cc...',
    '.....RRqqcc...',
    '....RRRqqcc...',
    '...RRRRqqqq...',
    '..RRRRRqqqqq..',
    '.rrrrrrrrrrrr.',
    '..WWWWWWWWWW..',
    '..wGGwwwwDDw..',
    '..WGGWWWWDDW..',
    '..wwwwwwwDDw..',
    '..WWWWWWWDDW..'
  ]);

  var TENT = new Sprite([
    '......T......',
    '.....TTt.....',
    '....TTDtt....',
    '...TTTDttt...',
    '..TTTDDDttt..',
    '.TTTTDDDtttt.',
    'TTTTDDDDDtttt'
  ]);

  var SIGN = new Sprite([
    '.WWWWWWW..',
    '.WwwWwwWW.',
    '.WWWWWWW..',
    '....P.....',
    '..WWWWWWW.',
    '.WWwwWwwW.',
    '..WWWWWWW.',
    '....P.....',
    '....P.....',
    '....P.....',
    '....P.....',
    '...PPP....'
  ]);

  var LOG = new Sprite(['.WWWWWWW.', 'wWWWWWWWo', '.wwwwwww.']);
  var LOGS = new Sprite(['WW.w.WW', '.wWWWw.']);
  var PACK = new Sprite([
    '..sss..',
    '.s...s.',
    '.BBBBB.',
    'BLBBBBB',
    'BLppppB',
    'BLpZppB',
    'BLppppB',
    '.BBBBB.'
  ]);
  var FLAGS = [new Sprite(['FFF.', 'FFFF']), new Sprite(['FFFF', 'FFF.'])];
  var NOTE = new Sprite(['..NN.', '..N.N', '..N..', '..N..', 'NNN..', 'NN...']);
  var SIGN_NOTE = new Sprite(['.NN', '.N.', 'NN.']);

  /* ---------- palettes ---------- */

  var WORLD = {
    day: palette({
      sky: ['#c1c6c7', '#cacdc9', '#d3d2ca', '#dbd4c8', '#e4d6c2'],
      sun: '#f6ead4', sunHalo: '#ece0cb',
      cloud: '#ebe5dd', cloudLit: '#f4f0ea', cloudShade: '#dad1c6',
      far: '#c1bab2', farLit: '#cbc5bc', farShade: '#b6afa6', snow: '#e6e0d8',
      mid: '#b0a998', midLit: '#bab4a3', midShade: '#a59e8c', midTree: '#9c9784', midField: '#aba48f',
      water: '#c4c6c3', waterDark: '#b8bbb8', waterLit: '#dfddd4', shore: '#9a8e7f', reed: '#8a7963',
      meadow: '#a7a18a', meadowLit: '#b2ad96', bush: '#8d8a6e', bushLit: '#9c997d', bushShade: '#7d7a60',
      near: '#99907a', nearLit: '#a39b84', grass: '#b0a88c',
      tree: '#7f7a62', treeShade: '#6d6852', trunk: '#5f4d3d',
      roof: '#6f5345', roofShade: '#5c4438', wall: '#94755f', wallShade: '#82654f',
      door: '#503c30', window: '#dacdb7', chimney: '#7c6d60',
      smoke: '#ede6dd', smokeDim: '#ded6cb', glint: '#f2eee6', bird: '#7d7064'
    }),
    night: palette({
      sky: ['#0c0b0a', '#11100f', '#161412', '#1c1916', '#25201b'],
      moon: '#ebe2d2', moonDark: '#2a2622', moonCrater: '#d2c7b5', moonHalo: '#221e1b',
      star: ['#e6ddcf', '#a39a8e', '#645e56'],
      cloud: '#1b1916', cloudLit: '#221f1b', cloudShade: '#171513',
      far: '#211d1a', farLit: '#27231f', farShade: '#1c1916', snow: '#39332c',
      mid: '#1b1815', midLit: '#201c18', midShade: '#171411', midTree: '#141210', midField: '#1e1b17',
      water: '#161418', waterDark: '#111013', waterLit: '#35302b', shore: '#141210', reed: '#1c1814',
      meadow: '#181613', meadowLit: '#1c1916', bush: '#121010', bushLit: '#161412', bushShade: '#0e0c0b',
      near: '#13110f', nearLit: '#181512', grass: '#1f1b17',
      tree: '#0f0d0c', treeShade: '#0b0a09', trunk: '#0b0a09',
      roof: '#1a1612', roofShade: '#141110', wall: '#221c17', wallShade: '#1c1713',
      door: '#130f0c', window: '#e2a866', chimney: '#1d1915',
      smoke: '#2f2a25', smokeDim: '#252119', glint: '#d8cdbb',
      firefly: '#f1c878', fireflyDim: '#7d6437'
    })
  };

  var BANNER = {
    day: palette({
      sky: ['#cdc9c0', '#d7cfc0', '#e2d3bb', '#ebd7b4'],
      dusk: ['#b4a3a1', '#c6a294', '#d9a684', '#e6b67e'],
      sun: '#f7e8c9', sunHalo: '#eedbba',
      cloud: '#eee7dd', cloudLit: '#f7f2ea', cloudShade: '#dcd1c2',
      far: '#b8ac9c', farLit: '#c3b8a9', farShade: '#aa9e8e', snow: '#efe8dd',
      mtn: '#9b8b77', mtnLit: '#aa9a85', mtnShade: '#8a7a67',
      hill: '#a6957c', hillLit: '#b2a188',
      tree: '#7e6d56', treeShade: '#6b5b47', treeFar: '#9c8c73', trunk: '#594535',
      grass: '#c4a567', grassMid: '#b4935b', grassDark: '#a2824e', grassTip: '#d9be84', flower: '#f1e6cc', flower2: '#c4643a',
      leaf: '#b9693d', leafLit: '#cd8651', leafDark: '#9b5332',
      ground: '#a48f74', dirt: '#8d775e',
      road: '#8b8175', roadEdge: '#776e63', line: '#f0e7d8',
      wood: '#7b5b43', woodDark: '#5f4533', woodLit: '#91704f',
      tent: '#a95d3d', tentShade: '#8d4b31', tentDoor: '#4b3327',
      fire: '#f3c35f', fireMid: '#e08d3b', fireDark: '#bf5b2d', ember: '#f8dfa2', glow: '#caa06a',
      smoke: '#ece5db', smokeDim: '#ddd4c8',
      flag: '#b54b31', trail: '#efe6d6',
      bld: '#9d8c7c', bldAlt: '#8f7f70', bldFar: '#b3a394', bldEdge: '#7f7063',
      win: '#c9b9a2', winLit: '#ecd09a', neon: '#8f6a4a', neonLit: '#f0b870',
      antenna: '#6f6255', beacon: '#c9543a', note: '#8d5b3f',
      pack: '#6f7b5b', packDark: '#5b6549', packLit: '#86926d',
      lantern: '#f0c870', town: '#e8c890'
    }),
    night: palette({
      sky: ['#0d0c0b', '#131110', '#1a1714', '#231e19'],
      dusk: ['#0d0c0b', '#131110', '#1a1714', '#231e19'],
      moon: '#ebe2d2', moonDark: '#2a2622', moonCrater: '#d2c7b5', moonHalo: '#1f1b18',
      star: ['#e6ddcf', '#a39a8e', '#645e56'],
      cloud: '#1c1916', cloudLit: '#231f1b', cloudShade: '#181513',
      far: '#221e1a', farLit: '#29241f', farShade: '#1c1916', snow: '#3b352e',
      mtn: '#1d1a16', mtnLit: '#24201b', mtnShade: '#181511',
      hill: '#1a1714', hillLit: '#1f1b17',
      tree: '#100e0c', treeShade: '#0c0a09', treeFar: '#171411', trunk: '#0c0a09',
      grass: '#262015', grassMid: '#201b12', grassDark: '#1a160f', grassTip: '#302818',
      leaf: '#2e1d14', leafLit: '#3a2518', leafDark: '#24160f',
      ground: '#1b1814', dirt: '#16130f',
      road: '#1f1c19', roadEdge: '#191714', line: '#6f665b',
      wood: '#2a2019', woodDark: '#1e1712', woodLit: '#35291f',
      tent: '#3a2218', tentShade: '#2e1b13', tentDoor: '#e0a060',
      fire: '#f3c35f', fireMid: '#e08d3b', fireDark: '#bf5b2d', ember: '#f8dfa2', glow: '#3d2a1c',
      smoke: '#2e2924', smokeDim: '#25211d',
      flag: '#6a3020', trail: '#4a4239',
      bld: '#16130f', bldAlt: '#1a1712', bldFar: '#1f1b17', bldEdge: '#221e19',
      win: '#231e18', winLit: '#e3aa62', neon: '#4a3322', neonLit: '#f4bc6c',
      antenna: '#2a241e', beacon: '#e0503a', note: '#e0a868',
      pack: '#252a1d', packDark: '#1d2117', packLit: '#2e3424',
      lantern: '#f4c870', town: '#e8b870',
      firefly: '#f1c878', fireflyDim: '#7d6437'
    })
  };

  var CAT_COLORS = {
    day: palette({ K: '#1e1b18', W: '#f1ebe2', E: '#d9ae45', P: '#d88f8a', H: '#d86f76', A: '#f0c24e', B: '#5f86b0', C: '#c9453a' }),
    night: palette({ K: '#0c0b0a', W: '#5f5850', E: '#f2cf62', P: '#6e4a47', H: '#c9636b', A: '#f0c24e', B: '#5f86b0', C: '#c9453a' })
  };

  var SKYTIME = {
    dawn: palette({ sky: ['#b8adb6', '#d0b6ad', '#e4c5a6', '#eed5ae'], sun: '#f8e6c4', halo: '#efd6b4', hill: '#8f807b', hill2: '#7b6c67', tree: '#6a5c57' }),
    day: palette({ sky: ['#b0bec3', '#c5cfcd', '#d9dbd2', '#e6e1d4'], sun: '#fbf1dc', halo: '#eee6d4', hill: '#a39a84', hill2: '#8d846f', tree: '#76705c' }),
    dusk: palette({ sky: ['#8e7d90', '#b78e85', '#d8a27a', '#e7b98b'], sun: '#f7d9a4', halo: '#eab98a', hill: '#6f5c5c', hill2: '#5c4b4c', tree: '#4a3c3d' }),
    night: palette({ sky: ['#0d0c10', '#131119', '#1a1820', '#25211f'], hill: '#18161b', hill2: '#111014', tree: '#0c0b0e' })
  };

  var FRAME = {
    day: palette({ frame: '#8a6a50', lit: '#a58468', dark: '#6b503c', pot: '#b0643e', potDark: '#8d4b31', plant: '#7d8f5a', plantDark: '#627246' }),
    night: palette({ frame: '#3a2e24', lit: '#4b3c2f', dark: '#2a2119', pot: '#4a2a1c', potDark: '#3a2016', plant: '#2a3320', plantDark: '#202818' })
  };

  /* ---------- the cat ---------- */

  function Cat(x, y, opts) {
    opts = opts || {};
    this.x = x;
    this.y = y;
    this.flip = !!opts.flip;
    this.bob = opts.bob || false; // true bobs to the music player; a function decides for itself
    this.seed = Math.floor(Math.random() * 97);
    this.happyUntil = -1;
    this.hearts = [];
  }
  Cat.prototype.part = function (put, s, ox, oy, colors, dy) {
    var x = this.flip ? this.x + (CAT.w - ox - s.w) : this.x + ox;
    drawSprite(put, s, x, this.y + oy + dy, colors, this.flip);
  };
  Cat.prototype.draw = function (put, f, night) {
    var c = night ? CAT_COLORS.night : CAT_COLORS.day;
    var grooving = typeof this.bob === 'function' ? this.bob() : this.bob && musicPlaying();
    var dy = grooving && !reduceMotion ? (f >> 1) & 1 : 0;
    var closed = f < this.happyUntil || (!reduceMotion && (f + this.seed) % 43 === 0);
    var tail = reduceMotion ? 0 : [0, 1, 0, 2][Math.floor((f + this.seed) / 9) % 4];
    this.part(put, TAILS[tail], 0, 6, c, dy);
    this.part(put, closed ? CAT_CLOSED : CAT, 0, 0, c, dy);
    if (state.party) this.part(put, HAT, 4, -4, c, dy);
    for (var i = this.hearts.length - 1; i >= 0; i--) {
      var h = this.hearts[i];
      drawSprite(put, HEART, Math.round(h.x), Math.round(h.y), c);
      h.y -= 0.7;
      h.life -= 1;
      if (h.life <= 0) this.hearts.splice(i, 1);
    }
  };
  Cat.prototype.hit = function (ax, ay) {
    return ax >= this.x - 1 && ax <= this.x + CAT.w + 1 && ay >= this.y - 5 && ay <= this.y + CAT.h + 1;
  };
  Cat.prototype.pet = function (f) {
    this.happyUntil = f + 12;
    if (!reduceMotion) this.hearts.push({ x: this.x + (this.flip ? 2 : 4), y: this.y - (state.party ? 10 : 6), life: 10 });
  };

  var LINES = {
    all: ['mrrp.', 'meow', '*purrs*', '*slow blink*', 'pet accepted ✦', 'this is my website too'],
    home: ['welcome in ✦', 'psst. try the konami code', 'i watch the sky for you'],
    about: ['that\'s my human up there', 'i\'m the best part of this page', 'i guard the good shelf', 'put on discovery next'],
    portfolio: ['my human built all this. i supervised.', 'one day i\'ll reach the top'],
    resume: ['hire my human pls. i need treats', 'where does this road go?'],
    vgm: ['this one slaps', '*bops head*', 'turn it up'],
    edc: ['the most important carry item is me', 'no marshmallows? rude']
  };

  function pickLine() {
    var own = LINES[pageName] || [];
    var pool = LINES.all.concat(own, own);
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /* ---------- background world ---------- */

  function buildWorld(w, h, night) {
    var P = night ? WORLD.night : WORLD.day;
    var tr = random(7714), sr = random(1234);
    var back = new Bitmap(w, h), front = new Bitmap(w, h);
    var B = back.painter(), F = front.painter();
    var x, y, i;
    var horizon = Math.round(h * 0.62);
    var m = Math.max(20, (window.innerWidth - 900) / 2) / 4;

    vgrad(B, 0, w, 0, horizon, P.sky);
    rect(B, 0, horizon, w, h - horizon, P.sky[P.sky.length - 1]);

    var cx = Math.round(clamp(m * 0.5, 9, w * 0.3)), cy = Math.round(h * 0.15);
    var starList = [];
    if (night) {
      var phase = moonPhase(new Date());
      starList = makeStars(sr, w, horizon - 6, Math.round(w * h / 240));
      starList.forEach(function (s) { B(s.x, s.y, P.star[s.b]); });
      if (illumination(phase) > 0.05) halo(B, cx, cy, 7, 13, P.moonHalo);
      drawMoon(B, cx, cy, 6, phase, P);
    } else {
      halo(B, cx, cy, 8, 16, P.sunHalo);
      disc(B, cx, cy, 7, P.sun);
    }

    var farTop = normalize(ridge(w, tr, 0.56)).map(function (v) { return Math.round(horizon - h * 0.04 - v * h * 0.2); });
    var snowLine = Math.min.apply(null, farTop) + Math.round(h * 0.035);
    for (x = 0; x < w; x++) {
      var y0 = farTop[x], slope = farTop[Math.min(w - 1, x + 1)] - farTop[Math.max(0, x - 1)];
      for (y = y0; y < h; y++) {
        var d = y - y0, c = P.far;
        if (d < 4) c = slope < 0 ? P.farLit : slope > 0 ? P.farShade : P.far;
        if (y < snowLine || (y < snowLine + 2 && d < 3 && dither(x, y) > 0.5)) c = P.snow;
        F(x, y, c);
      }
    }

    var midTop = smooth(normalize(ridge(w, tr, 0.5)), 3).map(function (v) { return Math.round(horizon + h * 0.015 - v * h * 0.085); });
    for (x = 0; x < w; x++) {
      var sl = midTop[Math.min(w - 1, x + 1)] - midTop[Math.max(0, x - 1)];
      for (y = midTop[x]; y < h; y++) F(x, y, y - midTop[x] < 2 ? (sl < 0 ? P.midLit : P.midShade) : P.mid);
    }
    for (y = horizon; y < h; y++) {
      var band = Math.floor(Math.sqrt(y - horizon) * 1.7);
      var segW = 10 + band * 4, off = (band * 37) % segW;
      for (x = 0; x < w; x++) {
        if (y < midTop[x] + 4) continue;
        var hsh = (Math.floor((x + off) / segW) * 73 + band * 151) % 7;
        if (hsh < 2) F(x, y, P.midField);
        else if (hsh === 2) F(x, y, P.midShade);
      }
    }
    var forest = smooth(normalize(ridge(w, tr, 0.7)), 4);
    for (x = 1; x < w - 1; x += 2 + Math.floor(tr() * 3)) {
      if (forest[x] > 0.42) pine(F, x, midTop[x] + 2, 4 + Math.floor(tr() * 5), P.midTree, P.midTree, P.midTree);
    }

    var meadowTop = new Array(w);
    for (x = 0; x < w; x++) {
      meadowTop[x] = Math.round(h * 0.735 + Math.sin(x * 0.021 + 0.5) * h * 0.022 + Math.sin(x * 0.063 + 1.7) * h * 0.01);
    }
    for (x = 0; x < w; x++) {
      var ml = meadowTop[Math.min(w - 1, x + 1)] - meadowTop[Math.max(0, x - 1)];
      for (y = meadowTop[x]; y < h; y++) F(x, y, y === meadowTop[x] && ml <= 0 ? P.meadowLit : P.meadow);
    }

    var lakeCx = cx, lakeCy = Math.round(h * 0.84);
    var lakeRx = Math.max(8, Math.round(m * 0.42)), lakeRy = Math.max(3, Math.min(Math.round(h * 0.045), Math.round(lakeRx * 0.4)));
    var lakeBottom = lakeCy + Math.round(lakeRy * 0.35);
    var lakeL = lakeCx - lakeRx - 2, lakeR = lakeCx + lakeRx + 2;
    var cabinX = Math.round(clamp(w - m * 0.5 - CABIN.w / 2, w * 0.66, w - CABIN.w - 2));

    var groves = smooth(normalize(ridge(w, tr, 0.65)), 3);
    for (x = 2; x < w - 2; x += 3 + Math.floor(tr() * 5)) {
      if (groves[x] < 0.6 || (x > lakeL - 6 && x < lakeR + 6) || (x > cabinX - 18 && x < cabinX + CABIN.w + 18)) continue;
      roundTree(F, x, meadowTop[x] + 2 + Math.floor(tr() * 3), 2 + Math.floor(tr() * 2), [P.bushLit, P.bush, P.bushShade], P.trunk, tr);
    }

    var glints = [];
    for (y = lakeCy - lakeRy - 1; y <= lakeCy + lakeRy + 1; y++) {
      var rippled = false;
      for (x = lakeL - 1; x <= lakeR + 1; x++) {
        var ex = (x - lakeCx) / lakeRx, ey = (y - lakeCy) / lakeRy, e = ex * ex + ey * ey;
        if (e <= 1) {
          F(x, y, (y - lakeCy) % 3 === 1 ? P.waterDark : P.water);
          if (Math.abs(x - lakeCx) <= 1 + Math.floor((y - lakeCy + lakeRy) * 0.25)) glints.push([x, y]);
        } else if (e <= 1.3 && y <= lakeCy + 1) {
          F(x, y, P.shore);
        }
      }
      var half = Math.floor(lakeRx * Math.sqrt(Math.max(0, 1 - Math.pow((y - lakeCy) / lakeRy, 2))));
      if (half > 3 && tr() < 0.6 && !rippled) {
        var rx = lakeCx - half + 1 + Math.floor(tr() * (2 * half - 3));
        line(F, rx, y, rx + 1 + Math.floor(tr() * 2), y, P.waterLit);
      }
    }

    var nearTop = new Array(w);
    for (x = 0; x < w; x++) {
      var yy = h * 0.86 + Math.sin(x * 0.043) * 2.5 + Math.sin(x * 0.11 + 2) * 1.2;
      var dip = smoothstep(lakeR + 10, lakeR - 2, x) * smoothstep(lakeL - 10, lakeL + 2, x);
      nearTop[x] = Math.round(yy + dip * (lakeBottom - yy));
    }
    var cabinBase = nearTop[cabinX + (CABIN.w >> 1)];
    for (x = cabinX - 8; x < cabinX + CABIN.w + 8; x++) {
      if (x < 0 || x >= w) continue;
      var edge = Math.min(x - (cabinX - 8), cabinX + CABIN.w + 8 - x);
      nearTop[x] = Math.round(nearTop[x] + (cabinBase - nearTop[x]) * smoothstep(0, 6, edge));
    }
    for (x = 0; x < w; x++) {
      for (y = nearTop[x]; y < h; y++) F(x, y, y === nearTop[x] ? P.nearLit : P.near);
    }

    function bigPine(px, ph) {
      if (px < -4 || px > w + 4) return;
      pine(F, px, nearTop[clamp(px, 0, w - 1)] + 1, ph, P.tree, P.treeShade, P.trunk);
    }
    bigPine(cabinX - 5, 18);
    bigPine(cabinX - 11, 13);
    bigPine(cabinX + CABIN.w + 4, 21);
    bigPine(cabinX + CABIN.w + 10, 15);
    bigPine(lakeR + 7, 15);
    bigPine(lakeR + 13, 10);

    var cabinY = cabinBase - CABIN.h + 1;
    drawSprite(F, CABIN, cabinX, cabinY, {
      c: P.chimney, R: P.roof, q: P.roofShade, r: P.roofShade,
      W: P.wall, w: P.wallShade, G: P.window, D: P.door
    });

    for (x = 0; x < w; x += 1 + Math.floor(tr() * 3)) {
      if (tr() < 0.5) F(x, nearTop[x] - 1, P.grass);
      if (tr() < 0.15) F(x, nearTop[x] - 2, P.grass);
    }
    [lakeL + 1, lakeL + 3, lakeR - 2, lakeR - 4, lakeR].forEach(function (rx2) {
      if (rx2 < 0 || rx2 >= w) return;
      var rl = 2 + Math.floor(tr() * 3);
      for (var j = 1; j <= rl; j++) F(rx2, nearTop[rx2] - j, P.reed);
    });

    glints = glints.filter(function (g) { return g[1] < nearTop[g[0]]; });
    glints.forEach(function (g) { if (sr() < 0.12) F(g[0], g[1], night ? P.glint : P.waterLit); });

    var birds = [];
    if (!night) {
      for (i = 0; i < 3; i++) birds.push({ x: sr() * w, y: Math.round(h * (0.12 + sr() * 0.22)), v: 0.18 + sr() * 0.12, p: Math.floor(sr() * 4) });
    }

    var clouds = [];
    for (i = 0; i < (night ? 2 : 5); i++) {
      clouds.push({
        c: cloudCanvas(sr, P, 8 + Math.floor(sr() * 8)),
        x: sr() * w,
        y: Math.round(h * (0.05 + sr() * 0.3)),
        v: 0.05 + sr() * 0.07
      });
    }

    var fireflies = [];
    if (night) {
      for (i = 0; i < 9; i++) {
        fireflies.push({ x: sr() < 0.5 ? sr() * m : w - sr() * m, y: h * (0.66 + sr() * 0.28), p: sr() * 6.28, s: 0.25 + sr() * 0.3 });
      }
    }

    var chimX = cabinX + 9, chimY = cabinY - 1, smoke = [];
    for (i = 0; i < 8; i++) smoke.push({ x: chimX + i * 0.6, y: chimY - i * 1.3, life: i * 4 });
    var shooting = null;

    return {
      back: back,
      front: front,
      mid: function (put, f, ctx) {
        clouds.forEach(function (cl) {
          if (!reduceMotion) {
            cl.x += cl.v;
            if (cl.x > w) cl.x = -cl.c.width;
          }
          ctx.drawImage(cl.c, Math.round(cl.x), cl.y);
        });
        birds.forEach(function (b) {
          if (!reduceMotion) { b.x += b.v; if (b.x > w + 3) b.x = -3; }
          var up = reduceMotion || ((f + b.p) >> 1) & 1;
          put(b.x - 1, b.y + (up ? 0 : 1), P.bird);
          put(b.x, b.y + (up ? 1 : 0), P.bird);
          put(b.x + 1, b.y + (up ? 0 : 1), P.bird);
        });
        if (!night) return;
        if (!reduceMotion) twinkle(put, starList, f, P, 6);
        if (!shooting && !reduceMotion && Math.random() < 0.004) {
          shooting = { x: Math.random() * w * 0.8, y: Math.random() * h * 0.25, t: 0 };
        }
        if (shooting) {
          for (var j = 0; j < 5; j++) {
            var sx = shooting.x + (shooting.t - j) * 2, sy = shooting.y + (shooting.t - j);
            if (shooting.t - j >= 0) put(sx, sy, j === 0 ? P.star[0] : j < 3 ? P.star[1] : P.star[2]);
          }
          if (++shooting.t > 12) shooting = null;
        }
      },
      top: function (put, f) {
        if (!reduceMotion && f % 4 === 0) smoke.push({ x: chimX + 0.5, y: chimY, life: 0 });
        smoke.forEach(function (p) {
          if (!reduceMotion) {
            p.y -= 0.32;
            p.x += 0.14 + Math.sin((p.life + p.x) * 0.4) * 0.08;
            p.life += 1;
          }
          put(p.x, p.y, p.life < 16 ? P.smoke : P.smokeDim);
          if (p.life < 8) put(p.x + 1, p.y, P.smoke);
        });
        smoke = smoke.filter(function (p) { return p.life < 30; });

        if (night) {
          if (!reduceMotion && f % 29 < 2) {
            put(cabinX + 3, cabinY + 8, P.smoke);
          }
          fireflies.forEach(function (fl) {
            var b = Math.sin(f * fl.s + fl.p);
            var fx = fl.x + Math.sin(f * 0.05 + fl.p) * 3, fy = fl.y + Math.cos(f * 0.04 + fl.p) * 2;
            if (b > 0.2) {
              put(fx, fy, P.firefly);
              if (b > 0.75) {
                put(fx - 1, fy, P.fireflyDim); put(fx + 1, fy, P.fireflyDim);
                put(fx, fy - 1, P.fireflyDim); put(fx, fy + 1, P.fireflyDim);
              }
            }
          });
        }

        if (!reduceMotion && glints.length) {
          for (var g = 0; g < 5; g++) {
            var gl = glints[Math.floor(Math.random() * glints.length)];
            put(gl[0], gl[1], night ? P.glint : P.waterLit);
          }
        }
      }
    };
  }

  /* ---------- banner helpers ---------- */

  function bannerBase(w, h, night) {
    var back = new Bitmap(w, h), front = new Bitmap(w, h);
    return { P: night ? BANNER.night : BANNER.day, back: back, front: front, B: back.painter(), F: front.painter() };
  }

  function bannerSky(s, w, h, hz, night, sr, celX, celY, dusk) {
    var P = s.P, B = s.B;
    vgrad(B, 0, w, 0, hz, dusk ? P.dusk : P.sky);
    rect(B, 0, hz, w, h - hz, (dusk ? P.dusk : P.sky)[P.sky.length - 1]);
    var list = [];
    if (night) {
      list = makeStars(sr, w, hz - 2, Math.round(w * hz / 55));
      list.forEach(function (st) { B(st.x, st.y, P.star[st.b]); });
      var ph = moonPhase(new Date());
      if (illumination(ph) > 0.05) halo(B, celX, celY, 4, 8, P.moonHalo);
      drawMoon(B, celX, celY, 4, ph, P);
    } else {
      halo(B, celX, celY, 5, 11, P.sunHalo);
      disc(B, celX, celY, 4, P.sun);
    }
    return list;
  }

  function particles() {
    var list = [];
    return {
      add: function (p) { list.push(p); },
      step: function (put, update) {
        for (var i = list.length - 1; i >= 0; i--) {
          var p = list[i];
          if (!reduceMotion) update(p);
          if (p.life <= 0) { list.splice(i, 1); continue; }
          put(p.x, p.y, p.c);
        }
      }
    };
  }

  /* ---------- about: golden hour meadow ---------- */

  function sceneAbout(w, h, night) {
    var s = bannerBase(w, h, night), P = s.P, F = s.F;
    var tr = random(31), sr = random(32);
    var x, y;
    var hz = Math.round(h * 0.56);
    var celX = Math.round(w * 0.82), celY = night ? Math.round(h * 0.26) : hz - 3;
    var stars = bannerSky(s, w, h, hz, night, sr, celX, celY, false);

    for (x = 0; x < w; x++) {
      var t = Math.round(hz - 2 + Math.sin(x * 0.07) * 1.5 + Math.sin(x * 0.19 + 1) * 0.8);
      for (y = t; y < h; y++) F(x, y, P.far);
    }
    var hedge = smooth(normalize(ridge(w, tr, 0.6)), 2);
    for (x = 1; x < w; x += 2 + Math.floor(tr() * 3)) {
      if (hedge[x] < 0.35) continue;
      var r = 1 + Math.floor(hedge[x] * 2.5 + tr());
      var cyb = Math.round(hz - 1 + Math.sin(x * 0.07) * 1.5) - r;
      for (var dy = -r; dy <= r; dy++) {
        for (var dx = -r - 1; dx <= r + 1; dx++) {
          if ((dx * dx) / ((r + 1) * (r + 1)) + (dy * dy) / (r * r) <= 1) F(x + dx, cyb + dy, P.treeFar);
        }
      }
    }
    vgrad(F, 0, w, hz + 1, h, [P.grass, P.grassMid, P.grassDark]);
    if (!night) {
      for (var fl = 0; fl < w / 9; fl++) {
        F(Math.floor(tr() * w), hz + 3 + Math.floor(tr() * (h - hz - 5)), tr() < 0.5 ? P.flower : P.flower2);
      }
    }
    for (var i = 0; i < w / 3; i++) {
      var sx = Math.floor(tr() * w), sy = hz + 2 + Math.floor(tr() * (h - hz - 4));
      line(F, sx, sy, sx + 1 + Math.floor(tr() * 3), sy, P.grassTip);
    }

    var tx = Math.round(w * 0.64);
    roundTree(F, tx, h - 5, 7, [P.leafLit, P.leaf, P.leafDark], P.trunk, tr);
    F(tx - 5, h - 3, P.leaf); F(tx + 4, h - 2, P.leafLit); F(tx + 8, h - 4, P.leafDark);

    var cat = new Cat(Math.round(w * 0.3), h - 14);
    var blades = [];
    for (x = 0; x < w; x += 1 + Math.floor(tr() * 3)) {
      if (x > cat.x - 1 && x < cat.x + CAT.w + 1 && tr() < 0.75) continue;
      blades.push({ x: x, y: h - 1 - Math.floor(tr() * 3), l: 2 + Math.floor(tr() * 3), p: tr() * 6.28 });
    }

    var falling = particles();
    var fireflies = [];
    if (night) for (i = 0; i < 6; i++) fireflies.push({ x: sr() * w, y: hz + 4 + sr() * (h - hz - 8), p: sr() * 6.28 });

    return {
      back: s.back, front: s.front, cats: [cat],
      mid: function (put, f) { if (night && !reduceMotion) twinkle(put, stars, f, P, 4); },
      top: function (put, f) {
        blades.forEach(function (b) {
          var sw = reduceMotion ? 0 : Math.round(Math.sin(f * 0.45 + b.p + b.x * 0.05));
          for (var j = 0; j < b.l; j++) put(b.x + (j === b.l - 1 ? sw : 0), b.y - j, j === b.l - 1 ? P.grassTip : P.grassMid);
        });
        if (!reduceMotion && f % 23 === 0) {
          falling.add({ x: tx - 5 + Math.random() * 10, y: h - 22, life: 60, c: Math.random() < 0.5 ? P.leaf : P.leafLit });
        }
        falling.step(put, function (p) {
          p.y += 0.3;
          p.x += Math.sin(p.y * 0.6) * 0.4;
          p.life -= 1;
          if (p.y > h - 2) p.life = 0;
        });
        fireflies.forEach(function (fl) {
          if (Math.sin(f * 0.3 + fl.p) > 0.3) put(fl.x + Math.sin(f * 0.05 + fl.p) * 3, fl.y, P.firefly);
        });
      }
    };
  }

  /* ---------- portfolio: the climb ---------- */

  function scenePortfolio(w, h, night) {
    var s = bannerBase(w, h, night), P = s.P, F = s.F;
    var tr = random(41), sr = random(42);
    var x, y, i;
    var hz = Math.round(h * 0.8);
    var celX = Math.round(w * 0.2), celY = Math.round(h * 0.34);
    var stars = bannerSky(s, w, h, hz, night, sr, celX, celY, false);

    var clouds = [];
    if (!night) {
      for (i = 0; i < 2; i++) clouds.push({ c: cloudCanvas(sr, P, 5 + Math.floor(sr() * 4)), x: sr() * w, y: Math.round(h * (0.08 + sr() * 0.3)), v: 0.06 + sr() * 0.05 });
    }

    var fr = normalize(ridge(w, tr, 0.55));
    for (x = 0; x < w; x++) {
      var top = Math.round(hz - 3 - fr[x] * h * 0.32);
      var sl = (fr[Math.min(w - 1, x + 1)] - fr[Math.max(0, x - 1)]);
      for (y = top; y < h; y++) F(x, y, y - top < 3 ? (sl > 0 ? P.farLit : P.farShade) : P.far);
    }

    var px = Math.round(w * 0.64), py = Math.round(h * 0.14);
    var nz = ridge(w, tr, 0.6);
    for (x = 0; x < w; x++) {
      var dist = Math.abs(x - px);
      var mt = Math.round((x < px ? py + dist * 1.05 : py + dist * 0.85) + nz[x] * 2.4 * Math.min(1, dist / 6));
      for (y = mt; y < h; y++) {
        var c = x < px ? (y - mt < 2 ? P.mtnLit : P.mtn) : (y - mt < 2 ? P.mtn : P.mtnShade);
        if (y < py + 5 || (y < py + 7 && dither(x, y) > 0.55)) c = P.snow;
        F(x, y, c);
      }
    }

    var N = 5, pts = [];
    for (i = 0; i <= N; i++) {
      var yy = Math.round(h - 2 - i * (h - 2 - (py + 3)) / N);
      var left = px - (yy - py) / 1.05 + 3, right = px - 2;
      pts.push([Math.round(i % 2 === 0 ? left + (right - left) * 0.15 : right - (right - left) * 0.12), yy]);
    }
    pts[0] = [Math.round(w * 0.36), h - 1];
    pts[N] = [px, py + 2];
    for (i = 0; i < N; i++) line(F, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], P.trail, true);

    rect(F, 0, h - 4, w, 4, P.hill);
    rect(F, 0, h - 4, w, 1, P.hillLit);
    var catX = Math.round(w * 0.24);
    for (x = 2; x < w; x += 3 + Math.floor(tr() * 4)) {
      if (x > catX - 3 && x < catX + CAT.w + 3) continue;
      if (x > pts[0][0] - 3 && x < pts[0][0] + 3) continue;
      pine(F, x, h - 1, 5 + Math.floor(tr() * 6), P.tree, P.treeShade, P.trunk);
    }

    for (y = py - 5; y < py + 1; y++) F(px, y, P.woodDark);
    var cat = new Cat(catX, h - 16);

    return {
      back: s.back, front: s.front, cats: [cat],
      mid: function (put, f, ctx) {
        clouds.forEach(function (cl) {
          if (!reduceMotion) { cl.x += cl.v; if (cl.x > w) cl.x = -cl.c.width; }
          ctx.drawImage(cl.c, Math.round(cl.x), cl.y);
        });
        if (night && !reduceMotion) twinkle(put, stars, f, P, 4);
      },
      top: function (put, f) {
        drawSprite(put, FLAGS[reduceMotion ? 0 : (f >> 1) & 1], px + 1, py - 5, { F: P.flag });
        if (night && (reduceMotion || f % 12 < 8)) put(pts[2][0], pts[2][1] - 1, P.lantern);
      }
    };
  }

  /* ---------- resume: the road ahead ---------- */

  function sceneResume(w, h, night) {
    var s = bannerBase(w, h, night), P = s.P, F = s.F;
    var tr = random(61), sr = random(62);
    var x, y, i;
    var hz = Math.round(h * 0.42), vx = Math.round(w * 0.52);
    var celX = night ? Math.round(w * 0.78) : vx, celY = night ? Math.round(h * 0.2) : hz - 4;
    var stars = bannerSky(s, w, h, hz, night, sr, celX, celY, false);

    for (x = 0; x < w; x++) {
      var t0 = Math.round(hz - 1 - Math.abs(Math.sin(x * 0.05)) * 2 - Math.sin(x * 0.13) * 1);
      for (y = t0; y < h; y++) F(x, y, P.far);
    }
    if (night) {
      for (i = 0; i < 7; i++) F(vx - 14 + Math.floor(sr() * 28), hz - 1 - Math.floor(sr() * 2), P.town);
    }

    function halfW(t) { return 0.6 + t * w * 0.2; }
    for (y = hz; y < h; y++) {
      var t = (y - hz) / (h - hz);
      var band = Math.floor(0.9 / (t + 0.04)) % 2;
      for (x = 0; x < w; x++) F(x, y, band ? P.grassMid : P.grass);
      var hw = halfW(t);
      for (x = Math.round(vx - hw); x <= Math.round(vx + hw); x++) {
        F(x, y, (x === Math.round(vx - hw) || x === Math.round(vx + hw)) ? P.roadEdge : P.road);
      }
    }

    var prev = null;
    for (i = 0; i < 9; i++) {
      var tp = 0.97 * Math.pow(0.7, i);
      var py = Math.round(hz + tp * (h - hz)), ppx = Math.round(vx - halfW(tp) - 2 - tp * 10);
      var ph = Math.max(1, Math.round(tp * 7));
      for (var k = 0; k < ph; k++) F(ppx, py - k, P.wood);
      var rail = [ppx, py - Math.round(ph * 0.6)];
      if (prev) line(F, prev[0], prev[1], rail[0], rail[1], P.woodDark);
      prev = rail;
    }

    var signX = Math.round(vx + halfW(0.9) + 8);
    drawSprite(F, SIGN, signX, h - SIGN.h - 1, { W: P.woodLit, w: P.woodDark, P: P.wood });
    var cat = new Cat(signX - 13, h - 13);

    return {
      back: s.back, front: s.front, cats: [cat],
      mid: function (put, f) { if (night && !reduceMotion) twinkle(put, stars, f, P, 3); },
      top: function (put, f) {
        var shift = reduceMotion ? 0 : f * 0.16;
        for (var yy = hz + 1; yy < h; yy++) {
          var tt = (yy - hz) / (h - hz), z = 1 / (tt + 0.03);
          if (((z * 0.5 + shift) % 2) < 1) {
            put(vx, yy, P.line);
            if (tt > 0.6) put(vx - 1, yy, P.line);
          }
        }
      }
    };
  }

  /* ---------- vgm: the arcade at dusk ---------- */

  function sceneVgm(w, h, night) {
    var s = bannerBase(w, h, night), P = s.P, F = s.F;
    var tr = random(51), sr = random(52);
    var x, y, i;
    var celX = night ? Math.round(w * 0.84) : Math.round(w * 0.3);
    var celY = night ? Math.round(h * 0.22) : Math.round(h * 0.6);
    var stars = bannerSky(s, w, h, h, night, sr, celX, celY, true);

    for (x = 0; x < w;) {
      var fw = 5 + Math.floor(tr() * 8), fh = Math.round(h * (0.35 + tr() * 0.3));
      rect(F, x, h - fh, fw, fh, P.bldFar);
      x += fw;
    }

    var windows = [], beacons = [], arcade = null, catRoof = null;
    var arcadeAt = Math.round(w * 0.46), catAt = Math.round(w * 0.74);
    for (x = -2; x < w;) {
      var bw = 8 + Math.floor(tr() * 9), bh = Math.round(h * (0.34 + tr() * 0.36));
      var isArcade = !arcade && x + bw > arcadeAt;
      var isCat = !isArcade && !catRoof && x + bw > catAt;
      if (isArcade) { bw = 19; bh = Math.round(h * 0.5); }
      if (isCat) { bw = Math.max(bw, 14); bh = Math.round(h * 0.42); }
      var top = h - bh, col = tr() < 0.5 ? P.bld : P.bldAlt;
      rect(F, x, top, bw, bh, col);
      for (y = top; y < h; y++) F(x, y, P.bldEdge);
      for (var wy = top + 2; wy < h - 2; wy += 3) {
        for (var wx = x + 2; wx < x + bw - 1; wx += 2) {
          if (isArcade && wy > h - 7 && wx > x + 6 && wx < x + 13) continue;
          var lit = tr() < (night ? 0.42 : 0.14);
          F(wx, wy, lit ? P.winLit : P.win);
          if (lit) windows.push([wx, wy]);
        }
      }
      if (!isArcade && !isCat && tr() < 0.4) {
        var ax = x + 2 + Math.floor(tr() * Math.max(1, bw - 4)), al = 2 + Math.floor(tr() * 3);
        for (i = 1; i <= al; i++) F(ax, top - i, P.antenna);
        beacons.push([ax, top - al - 1]);
      }
      if (isArcade) arcade = { x: x, top: top, w: bw };
      if (isCat) catRoof = { x: x, top: top, w: bw };
      x += bw + (tr() < 0.3 ? 1 : 0);
    }

    var signX = arcade.x + 4, signY = arcade.top - 7, signW = 11;
    rect(F, signX, signY, signW, 6, P.bldEdge);
    for (i = 0; i < 3; i++) F(signX + 2 + i * 3, arcade.top - 1, P.antenna);
    var doorX = arcade.x + 8;
    rect(F, doorX, h - 5, 3, 5, night ? P.winLit : P.win);

    var cat = catRoof ? new Cat(catRoof.x + 1, catRoof.top - 12, { bob: true }) : null;
    var notes = particles();

    function sign(put, on) {
      var c = on ? P.neonLit : P.neon;
      line(put, signX, signY, signX + signW - 1, signY, c);
      line(put, signX, signY + 5, signX + signW - 1, signY + 5, c);
      line(put, signX, signY, signX, signY + 5, c);
      line(put, signX + signW - 1, signY, signX + signW - 1, signY + 5, c);
      drawSprite(put, SIGN_NOTE, signX + 4, signY + 1, { N: c });
      put(signX + 2, signY + 2, c);
      put(signX + 8, signY + 2, c);
    }

    return {
      back: s.back, front: s.front, cats: cat ? [cat] : [],
      mid: function (put, f) { if (night && !reduceMotion) twinkle(put, stars, f, P, 4); },
      top: function (put, f) {
        var playing = musicPlaying();
        var flicker = night && !reduceMotion && f % 31 === 0;
        sign(put, (night || playing) && !flicker && (!playing || reduceMotion || f % 4 < 3));
        if (!reduceMotion && night && windows.length && f % 3 === 0) {
          var wdw = windows[Math.floor(Math.random() * windows.length)];
          put(wdw[0], wdw[1], P.win);
        }
        if (night) {
          beacons.forEach(function (b, j) { if (reduceMotion || (f + j * 3) % 10 < 5) put(b[0], b[1], P.beacon); });
        }
        if (!reduceMotion && f % (playing ? 5 : 14) === 0) {
          notes.add({ x: signX + 2 + Math.random() * 7, y: signY - 2, life: 26, c: P.note, v: 0.5 + Math.random() * 0.3, p: Math.random() * 6 });
        }
        notes.step(function (nx, ny, c) {
          drawSprite(put, NOTE, Math.round(nx), Math.round(ny), { N: c });
        }, function (n) {
          n.y -= n.v;
          n.x += Math.sin(n.life * 0.35 + n.p) * 0.35;
          n.life -= 1;
        });
      }
    };
  }

  /* ---------- edc: the campsite ---------- */

  function sceneEdc(w, h, night) {
    var s = bannerBase(w, h, night), P = s.P, F = s.F;
    var tr = random(71), sr = random(72);
    var x, y;
    var hz = Math.round(h * 0.6);
    var celX = Math.round(w * 0.86), celY = Math.round(h * 0.25);
    var stars = bannerSky(s, w, h, hz, night, sr, celX, celY, false);

    for (x = -2; x < w + 2; x += 2 + Math.floor(tr() * 3)) {
      pine(F, x, hz + 3, 7 + Math.floor(tr() * 10), P.treeFar, P.treeFar, P.treeFar);
    }
    vgrad(F, 0, w, hz + 1, h, [P.hillLit, P.hill, P.ground]);

    var fx = Math.round(w * 0.5), gy = h - 4;
    if (night) halo(F, fx, gy - 1, 2, 13, P.glow, hz + 2);
    else for (x = fx - 6; x <= fx + 6; x++) F(x, gy + 1, P.dirt);

    var tentX = Math.round(w * 0.18);
    drawSprite(F, TENT, tentX, gy - TENT.h + 1, { T: P.tent, t: P.tentShade, D: P.tentDoor });
    var logX = Math.round(w * 0.6);
    drawSprite(F, LOG, logX, gy - 2, { W: P.wood, w: P.woodDark, o: P.woodLit });
    drawSprite(F, PACK, logX + 10, gy - PACK.h + 1, { s: P.woodDark, B: P.pack, L: P.packLit, p: P.packDark, Z: P.ember });
    drawSprite(F, LOGS, fx - 3, gy - 1, { W: P.wood, w: P.woodDark });
    pine(F, w - 5, h + 1, 27, P.tree, P.treeShade, P.trunk);
    pine(F, w - 14, h + 1, 19, P.tree, P.treeShade, P.trunk);

    var cat = new Cat(Math.round(w * 0.35), gy - 11);
    var sparks = particles();

    return {
      back: s.back, front: s.front, cats: [cat],
      mid: function (put, f) { if (night && !reduceMotion) twinkle(put, stars, f, P, 4); },
      top: function (put, f) {
        var r = random(reduceMotion ? 5 : f * 13 + 7);
        var heights = [1, 3, 5, 3, 1];
        for (var i = 0; i < 5; i++) {
          var hh = Math.max(1, heights[i] + (reduceMotion ? 0 : Math.floor(r() * 3) - 1));
          for (var j = 0; j < hh; j++) {
            var frac = j / hh;
            var c = frac > 0.7 ? P.fireDark : (i >= 1 && i <= 3 && frac < 0.45) ? P.fire : P.fireMid;
            put(fx - 2 + i, gy - 2 - j, c);
          }
        }
        if (!reduceMotion && f % 3 === 0) {
          sparks.add(night
            ? { x: fx - 1 + Math.random() * 3, y: gy - 7, life: 12, c: Math.random() < 0.5 ? P.ember : P.fire }
            : { x: fx + Math.random(), y: gy - 7, life: 22, c: P.smoke });
        }
        sparks.step(put, function (p) {
          p.y -= night ? 0.6 : 0.35;
          p.x += Math.sin(p.life * 0.5) * 0.3 + (night ? 0 : 0.12);
          p.life -= 1;
          if (!night && p.life < 10) p.c = P.smokeDim;
        });
      }
    };
  }

  var BANNERS = { about: sceneAbout, portfolio: scenePortfolio, resume: sceneResume, vgm: sceneVgm, edc: sceneEdc };
  var BANNER_ALT = {
    about: 'pixel art of a black cat sitting in a golden meadow beside an autumn tree',
    portfolio: 'pixel art of a cat at the foot of a mountain trail leading to a flag at the summit',
    resume: 'pixel art of a cat beside a signpost on a road stretching to the horizon',
    vgm: 'pixel art of a city skyline with an arcade sign and a cat on a rooftop',
    edc: 'pixel art of a campsite with a tent, campfire, backpack and a cat warming up by the fire'
  };

  /* ---------- sidebar window: the sky outside, right now ---------- */

  function timeOfDay(d) {
    var hr = d.getHours() + d.getMinutes() / 60;
    if (hr >= 5 && hr < 7) return 'dawn';
    if (hr >= 7 && hr < 17.5) return 'day';
    if (hr >= 17.5 && hr < 20) return 'dusk';
    return 'night';
  }

  function buildWindow(w, h, night, withCat) {
    var now = new Date(), hr = now.getHours() + now.getMinutes() / 60;
    var tod = timeOfDay(now), T = SKYTIME[tod], N = WORLD.night, WD = night ? FRAME.night : FRAME.day;
    var back = new Bitmap(w, h), front = new Bitmap(w, h), B = back.painter(), F = front.painter();
    var sr = random(Math.floor(now.getTime() / 86400000));
    var x, y;
    var gx0 = 2, gx1 = w - 2, gy0 = 2, gy1 = h - 5, gw = gx1 - gx0, gh = gy1 - gy0;

    vgrad(B, gx0, gx1, gy0, gy1, T.sky);
    var stars = [];
    if (tod === 'night') {
      stars = makeStars(sr, gw, gh - 6, Math.round(gw * gh / 40)).map(function (st) { return { x: st.x + gx0, y: st.y + gy0, b: st.b }; });
      stars.forEach(function (st) { B(st.x, st.y, N.star[st.b]); });
      var hn = (hr >= 20 ? hr - 20 : hr + 4) / 9;
      var mx = Math.round(gx0 + 6 + clamp(hn, 0, 1) * (gw - 12)), my = Math.round(gy0 + 5 + Math.abs(hn - 0.5) * gh * 0.5);
      drawMoon(B, mx, my, 3, moonPhase(now), N);
    } else {
      var t = clamp((hr - 5.5) / 14.5, 0, 1);
      var sx = Math.round(gx0 + 5 + t * (gw - 10)), sy = Math.round(gy0 + 4 + Math.pow((t - 0.5) * 2, 2) * gh * 0.55);
      halo(B, sx, sy, 3, 7, T.halo);
      disc(B, sx, sy, 3, T.sun);
    }
    for (x = gx0; x < gx1; x++) {
      var y1 = Math.round(gy1 - 6 - Math.sin(x * 0.18) * 1.5 - Math.sin(x * 0.07 + 1) * 1.5);
      for (y = y1; y < gy1; y++) B(x, y, T.hill);
      var y2 = Math.round(gy1 - 2 - Math.sin(x * 0.25 + 2));
      for (y = y2; y < gy1; y++) B(x, y, T.hill2);
    }
    pine(B, gx0 + 9, gy1 - 1, 7, T.tree, T.tree, T.tree);
    pine(B, gx0 + 13, gy1 - 1, 5, T.tree, T.tree, T.tree);

    rect(F, 0, 0, w, gy0, WD.frame);
    rect(F, 0, 0, gx0, h, WD.frame);
    rect(F, gx1, 0, w - gx1, h, WD.frame);
    rect(F, 0, gy1, w, h - gy1, WD.frame);
    rect(F, 0, 0, w, 1, WD.lit);
    var midX = Math.round((gx0 + gx1) / 2), midY = gy0 + Math.round(gh * 0.42);
    rect(F, midX, gy0, 1, gh, WD.frame);
    rect(F, gx0, midY, gw, 1, WD.frame);
    rect(F, 0, gy1, w, 1, WD.lit);
    rect(F, 0, h - 1, w, 1, WD.dark);

    rect(F, 4, gy1 - 3, 3, 3, WD.pot);
    rect(F, 4, gy1 - 1, 3, 1, WD.potDark);
    F(5, gy1 - 4, WD.plant); F(4, gy1 - 5, WD.plant); F(6, gy1 - 5, WD.plantDark); F(5, gy1 - 6, WD.plant);

    var cats = withCat ? [new Cat(w - CAT.w - 4, gy1 - CAT.h, { bob: true, flip: true })] : [];

    return {
      back: back, front: front, cats: cats,
      mid: function (put, f) { if (tod === 'night' && !reduceMotion) twinkle(put, stars, f, N, 2); },
      caption: 'your sky · ' + now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase(),
      moon: 'moon: ' + phaseName(moonPhase(now))
    };
  }

  /* ---------- about: the favorites cabinet ---------- */

  var SHELF_TOP = 18; // art rows above the cabinet for the stuff sitting on it

  var SHELF = {
    day: palette({
      out: '#4e392b', wood: '#9c7a5c', woodLit: '#b28e6c', woodDark: '#80614a', grain: '#8d6d51',
      back: '#6b5242', backSeam: '#5e4839', backDot: '#735949', shade: '#5d4739', shade2: '#523e32',
      plankTop: '#c4a07b', plank: '#a07d5d', plankDark: '#7c5e46',
      brass: '#c9a45a', brassLit: '#e6c985', brassDark: '#8f6f35',
      leaf: '#6f8a4e', leafDark: '#556e3b', leafLit: '#8fa866', pot: '#b0643e', potDark: '#8d4b31', potLit: '#c77a50',
      crt: '#d8cdb9', crtShade: '#b5a891', crtOut: '#6b5d4e', knob: '#6b5b4b',
      screen: '#26302b', screenAlt: '#2c3731', screenLit: '#a9d49a', screenPeak: '#e6f2c8', screenDim: '#4f6b4a',
      ttOut: '#3e3128', ttTop: '#7a6350', ttFront: '#624f40', vinyl: '#1f1b18', vinylLit: '#6a625a',
      label: '#c9453a', spindle: '#e8e0d0', arm: '#dcd5c8',
      caseA: '#b5523a', caseA2: '#8f3f2c', caseB: '#5f86b0', caseB2: '#476a8f', caseC: '#d9ae45', caseC2: '#b08a30', caseW: '#efe6d6',
      books: ['#b5523a', '#5f86b0', '#6f8a4e', '#d9ae45', '#8d5b8f', '#c77a50'], bookBand: '#efe6d6',
      gold: '#d9ae45', goldDark: '#a8822f', goldLit: '#f6e3a0',
      lamp: '#557a5c', lampDark: '#3f5e46', lampLit: '#6f967a', stem: '#b8964f', stemDark: '#8f7038', bulb: '#e8e0cc',
      note: '#8d5b3f'
    }),
    night: palette({
      out: '#110d0a', wood: '#35291f', woodLit: '#433428', woodDark: '#2a2019', grain: '#30251c',
      back: '#1d1713', backSeam: '#18130f', backDot: '#211a15', shade: '#16110d', shade2: '#120e0b',
      plankTop: '#4d3d2e', plank: '#3a2c21', plankDark: '#2a2019',
      led: '#f0c070', ledGlow: '#5a4128', ledGlow2: '#3a2b1d', glow: '#4a3624',
      brass: '#8a6c38', brassLit: '#a8864a', brassDark: '#5c4523',
      leaf: '#2a3520', leafDark: '#1f2818', leafLit: '#34422a', pot: '#4a2a1c', potDark: '#3a2016', potLit: '#5a3524',
      crt: '#4a443b', crtShade: '#3a352e', crtOut: '#1a1714', knob: '#1f1b17',
      screen: '#16201a', screenAlt: '#1a251e', screenLit: '#9be08a', screenPeak: '#e0ffd0', screenDim: '#3a5a36',
      ttOut: '#0f0c0a', ttTop: '#2e241c', ttFront: '#241c16', vinyl: '#0c0a09', vinylLit: '#3a342e',
      label: '#7a2e24', spindle: '#8a8276', arm: '#8a8478',
      caseA: '#5a2a1e', caseA2: '#461f16', caseB: '#2c3e52', caseB2: '#22303f', caseC: '#6a5424', caseC2: '#52411b', caseW: '#6a6258',
      books: ['#5a2a1e', '#2c3e52', '#2f3b22', '#6a5424', '#43304a', '#5a3524'], bookBand: '#6a6258',
      gold: '#8a6c30', goldDark: '#5c4820', goldLit: '#c8a860',
      lamp: '#2c4232', lampDark: '#1f3024', lampLit: '#3a5642', stem: '#6a5530', stemDark: '#4a3b22', bulb: '#fff0c0',
      note: '#e0a868'
    })
  };

  var PARTY = palette({ c: ['#e0503a', '#f0c24e', '#8fa866', '#5f86b0', '#b07ab8'] }).c;

  var PLANT = new Sprite([
    '...l..g...',
    '..glG.lg..',
    '.lgGgGgGl.',
    'gGglgGlgGg',
    '.GgGgGgGG.',
    '..gGGgGg..',
    '.rrrrrrrr.',
    '.qppppppq.',
    '..pppppq..',
    '..pppppq..',
    '..pppppq..',
    '...qqqq...'
  ]);

  var CASES = new Sprite([
    '.AAwwAAA.',
    '.aaaaaaa.',
    'BBBBwwBBB',
    'bbbbbbbbb',
    '.CCwwCCCC',
    '.cccccccc'
  ]);

  var CRT = new Sprite([
    '..a......a....',
    '...a....a.....',
    '....a..a......',
    '.....aa.......',
    '.OOOOOOOOOOOO.',
    'OccccccccccccO',
    'OcSSSSSSSSScsO',
    'OcSSSSSSSSSckO',
    'OcSSSSSSSSScsO',
    'OcSSSSSSSSSckO',
    'OcSSSSSSSSScsO',
    'OcSSSSSSSSScsO',
    'OssssssssssssO',
    '.OOOOOOOOOOOO.',
    '..OO......OO..'
  ]);

  var TURNTABLE = new Sprite([
    'OOOOOOOOOOOOOOOOOOOO',
    'OTTTTvvvvvvvTTTTTTTO',
    'OTTvvvvvvvvvvvTTmmTO',
    'OTvvvvvlLlvvvvvTTTTO',
    'OTTvvvvvvvvvvvTTTTTO',
    'OTTTTvvvvvvvTTTTkTTO',
    'OttttttttttttttttttO',
    'OOOOOOOOOOOOOOOOOOOO',
    '.OO..............OO.'
  ]);

  var TROPHY = new Sprite([
    '..YYYYY..',
    'yyYgYYYyy',
    'y.YgYYY.y',
    '.yYYYYYy.',
    '..yYYYy..',
    '...yYy...',
    '....Y....',
    '..ddddd..',
    '..DDDDD..'
  ]);

  var LAMP = new Sprite([
    '..SSSS..',
    '.ShSSSS.',
    'ShSSSSSS',
    'ssssssss',
    '........',
    '...mm...',
    '....m...',
    '....m...',
    '....m...',
    '....m...',
    '...mmm..',
    '.MMMMMM.',
    'MMMMMMMM'
  ]);

  function pingpong(n, m) { return m - Math.abs((n % (2 * m)) - m); }

  function buildShelf(w, h, night, rows, albums) {
    var P = night ? SHELF.night : SHELF.day;
    var back = new Bitmap(w, h), put = back.painter(), r = random(4242);
    var T = SHELF_TOP, xL = 1, xR = w - 2, inL = xL + 4, inR = xR - 4;
    var baseTop = clamp(rows.length ? rows[rows.length - 1] : h - 12, T + 8, h - 9);
    var x, y, i;

    // back wall: vertical boards with a few knots
    for (y = T + 4; y < baseTop; y++) {
      for (x = inL; x <= inR; x++) {
        var seam = (x - inL) % 16 === 15;
        put(x, y, seam ? P.backSeam : r() < 0.04 ? P.backDot : P.back);
      }
    }
    for (y = T + 4; y < baseTop; y++) {
      put(inL, y, P.shade2);
      put(inR, y, P.shade2);
      if (dither(inL + 1, y) < 0.5) put(inL + 1, y, P.shade);
      if (dither(inR - 1, y) < 0.5) put(inR - 1, y, P.shade);
    }

    // light (night) or shadow (day) falling under the crown and every plank
    function under(y0) {
      for (var k = 0; k < 3; k++) {
        for (var xx = inL; xx <= inR; xx++) {
          var d = dither(xx, y0 + k);
          if (night) {
            if (d < [0.75, 0.5, 0.25][k]) put(xx, y0 + k, k ? P.ledGlow2 : P.ledGlow);
          } else if (d < [1, 0.6, 0.3][k]) {
            put(xx, y0 + k, k ? P.shade : P.shade2);
          }
        }
      }
    }
    under(T + 4);

    // planks (the last row sits on the base instead)
    rows.slice(0, -1).forEach(function (b) {
      under(b + 4);
      for (var xx = inL; xx <= inR; xx++) {
        put(xx, b, P.plankTop);
        put(xx, b + 1, P.plank);
        put(xx, b + 2, r() < 0.15 ? P.plankDark : P.plank);
        put(xx, b + 3, night ? (xx & 1 ? P.led : P.ledGlow) : P.plankDark);
      }
      [[inL, 1], [inR, -1]].forEach(function (e) {
        for (var k = 0; k < 3; k++) for (var j = 0; j < 3 - k; j++) put(e[0] + j * e[1], b + 4 + k, P.woodDark);
        put(e[0] + e[1], b + 1, P.brass);
      });
    });

    // side frames, with a little wandering grain
    for (i = 0; i < 2; i++) {
      var cols = i ? [xR, xR - 1, xR - 2, xR - 3] : [xL, xL + 1, xL + 2, xL + 3];
      var tones = i ? [P.out, P.woodDark, P.wood, P.woodDark] : [P.out, P.woodLit, P.wood, P.woodDark];
      for (var c = 0; c < 4; c++) {
        var on = false;
        for (y = T + 4; y < h - 2; y++) {
          if (r() < 0.12) on = !on;
          put(cols[c], y, on && c > 0 && c < 3 ? P.grain : tones[c]);
        }
      }
    }

    // crown, overhanging by a pixel each side
    for (x = 0; x < w; x++) {
      var edge = x === 0 || x === w - 1;
      put(x, T, P.out);
      put(x, T + 1, edge ? P.out : P.woodLit);
      put(x, T + 2, edge ? P.out : r() < 0.2 ? P.grain : P.wood);
      put(x, T + 3, edge ? P.out : P.woodDark);
    }

    // the base: bottom shelf, front panel, brass plaque, feet
    for (x = inL; x <= inR; x++) {
      put(x, baseTop, P.plankTop);
      put(x, baseTop + 1, P.plankDark);
      for (y = baseTop + 2; y < h - 3; y++) put(x, y, r() < 0.12 ? P.grain : P.wood);
    }
    for (x = xL; x <= xR; x++) put(x, h - 3, P.out);
    [xL + 1, xR - 4].forEach(function (fx) {
      for (var k = 0; k < 4; k++) { put(fx + k, h - 2, P.woodDark); put(fx + k, h - 1, P.out); }
      put(fx - 1, h - 2, P.out);
      put(fx + 4, h - 2, P.out);
    });
    var pw = Math.min(w - 16, Math.max(80, Math.round(w * 0.62)));
    var plate = { x: Math.floor((w - pw) / 2), y: baseTop + 3, w: pw, h: Math.max(3, h - 5 - (baseTop + 3) + 1) };
    for (y = plate.y; y < plate.y + plate.h; y++) {
      for (x = plate.x; x < plate.x + plate.w; x++) {
        var rim = y === plate.y || y === plate.y + plate.h - 1 || x === plate.x || x === plate.x + plate.w - 1;
        put(x, y, rim ? P.brassDark : y === plate.y + 1 ? P.brassLit : P.brass);
      }
    }
    var mid = plate.y + (plate.h >> 1);
    put(plate.x + 2, mid, P.brassDark);
    put(plate.x + plate.w - 3, mid, P.brassDark);

    // what's sitting on top
    var L = {
      plant: 3,
      cases: w >= 150 ? 15 : -1,
      crt: Math.round(w * 0.28),
      books: w >= 170 ? Math.round(w * 0.6) : -1,
      lamp: w - 28,
      cat: w - 15
    };
    L.tt = L.crt + 17;
    L.trophy = L.books + 17;
    var crt = { x: L.crt, y: T - CRT.h };
    var tt = { x: L.tt, y: T - TURNTABLE.h };
    var lamp = { x: L.lamp, y: T - LAMP.h };

    if (night) halo(put, lamp.x + 4, lamp.y + 4, 1, 14, P.glow, lamp.y + 4);

    if (L.cases >= 0) {
      drawSprite(put, CASES, L.cases, T - CASES.h, {
        A: P.caseA, a: P.caseA2, B: P.caseB, b: P.caseB2, C: P.caseC, c: P.caseC2, w: P.caseW
      });
    }
    drawSprite(put, CRT, crt.x, crt.y, { a: P.crtOut, O: P.crtOut, c: P.crt, s: P.crtShade, k: P.knob, S: P.screen });
    drawSprite(put, TURNTABLE, tt.x, tt.y, {
      O: P.ttOut, T: P.ttTop, t: P.ttFront, v: P.vinyl, l: P.label, L: P.spindle, m: P.arm, k: P.arm
    });
    if (L.books >= 0) {
      var heights = [9, 11, 10, 8, 11, 9];
      heights.forEach(function (bh, k) {
        var bx = L.books + k * 2, col = P.books[k % P.books.length];
        rect(put, bx, T - bh, 2, bh, col);
        put(bx, T - bh + 2, P.bookBand);
        put(bx + 1, T - bh + 2, P.bookBand);
        if (k & 1) { put(bx, T - 3, P.bookBand); put(bx + 1, T - 3, P.bookBand); }
      });
      var endX = L.books + heights.length * 2;
      rect(put, endX, T - 6, 1, 6, P.woodDark);
      rect(put, endX + 1, T - 2, 2, 2, P.woodDark);
      drawSprite(put, TROPHY, L.trophy, T - TROPHY.h, { Y: P.gold, y: P.goldDark, g: P.goldLit, d: P.woodDark, D: P.out });
    }
    drawSprite(put, LAMP, lamp.x, lamp.y, { S: P.lamp, s: P.lampDark, h: P.lampLit, m: P.stem, M: P.stemDark });
    drawSprite(put, PLANT, L.plant, T - PLANT.h, {
      l: P.leafLit, g: P.leaf, G: P.leafDark, r: P.potLit, p: P.pot, q: P.potDark
    });
    // a pothos vine trailing down the side of the cabinet
    x = L.plant + 1;
    for (i = 0, y = T - 6; i < 28; i++, y++) {
      put(x, y, P.leafDark);
      if (i % 3 === 1) {
        var side = (i / 3) & 1 ? 1 : -1;
        put(x + side, y, P.leaf);
        put(x + side, y - 1, P.leafLit);
      }
      if (i % 5 === 4) x = clamp(x + (r() < 0.5 ? -1 : 1), 1, 4);
    }

    var cat = new Cat(L.cat, T - CAT.h, { bob: albums });

    return {
      back: back,
      plate: plate,
      cats: [cat],
      mid: function (p, f) {
        var playing = albums(), still = reduceMotion ? 3 : f;
        var lit = state.party ? PARTY[f % PARTY.length] : P.screenLit;

        // the crt plays pong for games and a visualizer for albums
        var sx = crt.x + 2, sy = crt.y + 6;
        for (var row = 0; row < 6; row++) rect(p, sx, sy + row, 9, 1, row & 1 ? P.screenAlt : P.screen);
        if (playing) {
          for (var k = 0; k < 5; k++) {
            var bh = reduceMotion ? 2 + (k % 3) : 1 + Math.round((Math.sin(f * 0.9 + k * 1.3) * Math.cos(f * 0.31 + k) * 0.5 + 0.5) * 5);
            for (var j = 0; j < bh; j++) p(sx + k * 2, sy + 5 - j, j === bh - 1 ? P.screenPeak : lit);
          }
        } else {
          var bx = 1 + pingpong(still, 6), by = pingpong(still + 2, 5);
          for (var d = 0; d < 6; d += 2) p(sx + 4, sy + d, P.screenDim);
          rect(p, sx, sy + clamp(by - 1, 0, 4), 1, 2, lit);
          rect(p, sx + 8, sy + clamp(pingpong(still + 3, 5) - 1, 0, 4), 1, 2, lit);
          p(sx + bx, sy + by, P.screenPeak);
        }

        // the record spins while the albums are out
        var a = playing ? f * 0.9 : -0.6;
        p(tt.x + 8 + Math.round(4.5 * Math.cos(a)), tt.y + 3 + Math.round(1.5 * Math.sin(a)), P.vinylLit);
        p(tt.x + 8 - Math.round(4.5 * Math.cos(a)), tt.y + 3 - Math.round(1.5 * Math.sin(a)), P.vinylLit);
        if (playing) {
          line(p, tt.x + 16, tt.y + 3, tt.x + 12, tt.y + 4, P.arm);
          p(tt.x + 11, tt.y + 4, P.spindle);
        } else {
          line(p, tt.x + 17, tt.y + 3, tt.x + 17, tt.y + 5, P.arm);
        }

        var bulb = state.party ? PARTY[(f >> 1) % PARTY.length] : P.bulb;
        if (night || state.party) { p(lamp.x + 3, lamp.y + 4, bulb); p(lamp.x + 4, lamp.y + 4, bulb); }
      },
      top: function (p, f) {
        if (!albums() || reduceMotion) return;
        for (var k = 0; k < 3; k++) {
          var age = (f + k * 4) % 12;
          var nx = tt.x + 5 + k * 3 + Math.round(Math.sin((f + k * 4) * 0.5));
          drawSprite(p, SIGN_NOTE, nx, tt.y - 3 - Math.floor(age / 2), { N: state.party ? PARTY[k] : P.note });
        }
      }
    };
  }

  /* ---------- views + render loop ---------- */

  var views = [];

  function mountView(v) {
    var size = v.size();
    var round = v.fit === 'floor' ? Math.floor : Math.ceil;
    var w = Math.max(1, round(size.w / v.scale)), h = Math.max(1, round(size.h / v.scale));
    v.canvas.width = w;
    v.canvas.height = h;
    v.canvas.style.width = w * v.scale + 'px';
    v.canvas.style.height = h * v.scale + 'px';
    v.ctx = v.canvas.getContext('2d');
    v.ctx.imageSmoothingEnabled = false;
    v.put = ctxPainter(v.ctx);
    v.scene = v.build(w, h, isNight());
    v.backC = v.scene.back ? v.scene.back.canvas() : null;
    v.frontC = v.scene.front ? v.scene.front.canvas() : null;
    if (v.onMount) v.onMount(v.scene);
    render(v);
  }

  function render(v) {
    var c = v.ctx, s = v.scene, f = state.frame, night = isNight();
    c.clearRect(0, 0, v.canvas.width, v.canvas.height);
    if (v.backC) c.drawImage(v.backC, 0, 0);
    if (s.mid) s.mid(v.put, f, c);
    if (v.frontC) c.drawImage(v.frontC, 0, 0);
    if (s.cats) s.cats.forEach(function (cat) { cat.draw(v.put, f, night); });
    if (s.top) s.top(v.put, f, c);
  }

  function addView(v) {
    v.visible = true;
    views.push(v);
    mountView(v);
    if (v.observe && 'IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) { v.visible = entries[0].isIntersecting; }).observe(v.el);
    }
    if (v.resizeWith && 'ResizeObserver' in window) {
      var last = v.resizeWith.clientWidth, timer;
      new ResizeObserver(function () {
        if (v.resizeWith.clientWidth === last) return;
        last = v.resizeWith.clientWidth;
        clearTimeout(timer);
        timer = setTimeout(function () { mountView(v); }, 120);
      }).observe(v.resizeWith);
    }
    return v;
  }

  function say(v, cat, text) {
    var old = v.el.querySelector('.cat-bubble');
    if (old) old.remove();
    var b = document.createElement('div');
    b.className = 'cat-bubble';
    b.setAttribute('role', 'status');
    b.textContent = text;
    var cx = (cat.x + CAT.w / 2) * v.scale + v.canvas.offsetLeft;
    var cy = (cat.y - (state.party ? 5 : 1)) * v.scale + v.canvas.offsetTop;
    b.style.left = cx + 'px';
    b.style.top = cy + 'px';
    v.el.appendChild(b);
    var overflow = b.getBoundingClientRect();
    if (overflow.left < 4) b.style.left = (cx + 4 - overflow.left) + 'px';
    if (overflow.right > window.innerWidth - 4) b.style.left = (cx - (overflow.right - window.innerWidth + 4)) + 'px';
    setTimeout(function () {
      b.classList.add('out');
      setTimeout(function () { b.remove(); }, 400);
    }, 2600);
  }

  function enableCats(v) {
    function catAt(e) {
      var r = v.canvas.getBoundingClientRect();
      var ax = (e.clientX - r.left) / v.scale, ay = (e.clientY - r.top) / v.scale;
      var cats = (v.scene && v.scene.cats) || [];
      for (var i = 0; i < cats.length; i++) if (cats[i].hit(ax, ay)) return cats[i];
      return null;
    }
    v.canvas.addEventListener('click', function (e) {
      var cat = catAt(e);
      if (!cat) return;
      cat.pet(state.frame);
      say(v, cat, pickLine());
      render(v);
    });
    v.canvas.addEventListener('mousemove', function (e) {
      v.canvas.style.cursor = catAt(e) ? 'pointer' : '';
    });
  }

  function setupWorld() {
    var cv = document.createElement('canvas');
    cv.id = 'world-bg';
    cv.className = 'pixel-canvas';
    cv.setAttribute('aria-hidden', 'true');
    document.body.insertBefore(cv, document.body.firstChild);
    addView({
      el: cv, canvas: cv, scale: 4,
      size: function () { return { w: window.innerWidth, h: window.innerHeight }; },
      build: buildWorld
    });
  }

  function setupBanner() {
    var build = bannerEl && BANNERS[pageName];
    if (!build) return;
    bannerEl.classList.add('has-banner');
    var art = document.createElement('div');
    art.className = 'banner-art';
    var cv = document.createElement('canvas');
    cv.className = 'pixel-canvas';
    cv.setAttribute('role', 'img');
    cv.setAttribute('aria-label', BANNER_ALT[pageName]);
    art.appendChild(cv);
    bannerEl.insertBefore(art, bannerEl.firstChild);
    var v = addView({
      el: bannerEl, canvas: cv, scale: 3, observe: true, resizeWith: bannerEl,
      size: function () { return { w: bannerEl.clientWidth, h: bannerEl.clientHeight }; },
      build: build
    });
    enableCats(v);
  }

  var windowView = null;

  function setupWindow() {
    var box = document.getElementById('sky-window');
    if (!box) return;
    var wrap = document.createElement('div');
    wrap.className = 'sky-view';
    var cv = document.createElement('canvas');
    cv.className = 'pixel-canvas';
    cv.setAttribute('role', 'img');
    var cap = document.createElement('p');
    cap.className = 'sky-caption';
    wrap.appendChild(cv);
    box.appendChild(wrap);
    box.appendChild(cap);
    windowView = addView({
      el: wrap, canvas: cv, scale: 3, fit: 'floor', observe: true, resizeWith: box,
      size: function () { return { w: box.clientWidth - 22, h: 96 }; },
      build: function (w, h, night) { return buildWindow(w, h, night, pageName === 'home'); },
      onMount: function (scene) {
        cap.innerHTML = '';
        cap.appendChild(document.createTextNode(scene.caption));
        cap.appendChild(document.createElement('br'));
        cap.appendChild(document.createTextNode(scene.moon));
        cv.setAttribute('aria-label', 'pixel art window showing the sky right now. ' + scene.caption + ', ' + scene.moon);
      }
    });
    enableCats(windowView);
  }

  function setupShelf() {
    var box = document.getElementById('fav-case');
    if (!box) return;
    var plaque = box.querySelector('.fav-plaque');
    var art = document.createElement('div');
    art.className = 'fav-art';
    var cv = document.createElement('canvas');
    cv.className = 'pixel-canvas';
    cv.setAttribute('aria-hidden', 'true');
    art.appendChild(cv);
    box.insertBefore(art, box.firstChild);

    function albums() { return box.getAttribute('data-tab') === 'albums'; }

    // planks go wherever the covers actually landed, in 3px art rows
    function shelfRows() {
      var panel = box.querySelector('.fav-panel:not([hidden])'), rows = [];
      if (!panel) return rows;
      Array.prototype.forEach.call(panel.children, function (el) {
        var b = Math.round((panel.offsetTop + el.offsetTop + el.offsetHeight) / 3);
        if (rows.indexOf(b) < 0) rows.push(b);
      });
      return rows.sort(function (a, b) { return a - b; });
    }

    var v = addView({
      el: box, canvas: cv, scale: 3, fit: 'floor', observe: true, resizeWith: box,
      size: function () { return { w: box.clientWidth, h: box.clientHeight }; },
      build: function (w, h, night) { return buildShelf(w, h, night, shelfRows(), albums); },
      onMount: function (scene) {
        var p = scene.plate;
        plaque.style.left = (p.x + 3) * 3 + 'px';
        plaque.style.top = p.y * 3 + 'px';
        plaque.style.width = (p.w - 6) * 3 + 'px';
        plaque.style.height = plaque.style.lineHeight = p.h * 3 + 'px';
        plaque.style.right = plaque.style.bottom = 'auto';
      }
    });
    enableCats(v);
    box.addEventListener('shelfchange', function () { mountView(v); });
  }

  /* ---------- little extras ---------- */

  function toast(text) {
    var t = document.createElement('div');
    t.className = 'v2-toast';
    t.setAttribute('role', 'status');
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(function () {
      t.classList.add('out');
      setTimeout(function () { t.remove(); }, 400);
    }, 2400);
  }

  function setupClock() {
    var clock = document.querySelector('.top-header .local-time');
    if (!clock) return;
    clock.title = 'my local time';
    var fmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });
    function update() { clock.textContent = fmt.format(new Date()).toLowerCase() + ' in texas'; }
    update();
    return update;
  }

  function setupKonami() {
    var seq = ['arrowup', 'arrowup', 'arrowdown', 'arrowdown', 'arrowleft', 'arrowright', 'arrowleft', 'arrowright', 'b', 'a'];
    var pos = 0;
    document.addEventListener('keydown', function (e) {
      var k = (e.key || '').toLowerCase();
      pos = k === seq[pos] ? pos + 1 : k === seq[0] ? 1 : 0;
      if (pos < seq.length) return;
      pos = 0;
      state.party = !state.party;
      document.documentElement.classList.toggle('party', state.party);
      var overlay = document.querySelector('.crt-overlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'crt-overlay';
        overlay.setAttribute('aria-hidden', 'true');
        document.body.appendChild(overlay);
      }
      toast(state.party ? 'cheat code accepted ✦ party mode on' : 'party mode off. back to work');
      views.forEach(render);
    });
  }

  /* ---------- boot ---------- */

  setupWorld();
  setupBanner();
  setupWindow();
  setupShelf();
  var updateClock = setupClock();
  setupKonami();

  var lastNight = isNight();
  new MutationObserver(function () {
    if (isNight() === lastNight) return;
    lastNight = isNight();
    views.forEach(mountView);
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { mountView(views[0]); }, 180);
  });

  setInterval(function () {
    if (updateClock) updateClock();
    if (windowView) mountView(windowView);
  }, 30000);

  if (reduceMotion) return;
  var last = 0;
  requestAnimationFrame(function loop(t) {
    if (t - last >= 1000 / FPS) {
      last = t;
      state.frame += 1;
      for (var i = 0; i < views.length; i++) if (views[i].visible) render(views[i]);
    }
    requestAnimationFrame(loop);
  });
})();
