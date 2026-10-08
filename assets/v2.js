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

  function moonPhase(d) {
    var days = (d.getTime() - NEW_MOON_REF) / 86400000;
    var p = (days % SYNODIC) / SYNODIC;
    return p < 0 ? p + 1 : p;
  }
  function illumination(p) { return (1 - Math.cos(2 * Math.PI * p)) / 2; }

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

  var CAT_COLORS = {
    day: palette({ K: '#1e1b18', W: '#f1ebe2', E: '#d9ae45', P: '#d88f8a', H: '#d86f76', A: '#f0c24e', B: '#5f86b0', C: '#c9453a' }),
    night: palette({ K: '#0c0b0a', W: '#5f5850', E: '#f2cf62', P: '#6e4a47', H: '#c9636b', A: '#f0c24e', B: '#5f86b0', C: '#c9453a' })
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
    var hat = state.party ? 'party' : state.hat;
    if (hat) {
      var H = HATS[hat];
      this.part(put, H.s, H.ox, H.oy, hat === 'party' ? c : HAT_COLORS[night ? 'night' : 'day'], dy);
    }
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
    if (!reduceMotion) this.hearts.push({ x: this.x + (this.flip ? 2 : 4), y: this.y - (state.party || state.hat ? 11 : 6), life: 10 });
  };

  var LINES = {
    all: ['mrrp.', 'meow', '*purrs*', '*slow blink*', 'pet accepted ✦', 'this is my website too'],
    home: ['welcome in ✦', 'psst. try the konami code', 'i watch the sky for you'],
    about: ['that\'s my human up there', 'i\'m the best part of this page', 'i guard the good shelf', 'put on discovery next', 'we\'ve come a long way', 'what\'s next?'],
    portfolio: ['my human built all this. i supervised.', 'one day i\'ll reach the top'],
    resume: ['hire my human pls. i need treats', 'where does this road go?'],
    vgm: ['this one slaps', '*bops head*', 'turn it up'],
    edc: ['the most important carry item is me', 'no marshmallows? rude'],
    apps: ['did you check your to-do list?', '*sits on the keyboard*', 'i have 99+ unread messages']
  };

  function pickLine() {
    var own = LINES[pageName] || [];
    var pool = LINES.all.concat(own, own);
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /* ---------- the calendar: real seasons + holidays, in texas time ---------- */

  // ?date=2026-10-31 previews another day for the rest of the visit; ?date=today goes back
  function today() {
    var forced = null;
    try {
      var q = new URLSearchParams(location.search).get('date');
      if (q === 'today') sessionStorage.removeItem('v2-date');
      else if (q && /^\d{4}-\d{2}-\d{2}$/.test(q)) sessionStorage.setItem('v2-date', q);
      forced = sessionStorage.getItem('v2-date');
    } catch (e) {}
    var ymd = forced || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    var p = ymd.split('-').map(Number);
    return { y: p[0], m: p[1], d: p[2] };
  }

  function almanac(t) {
    var md = t.m * 100 + t.d, holiday = null;
    if (md >= 1231 || md <= 101) holiday = 'newyear';
    else if (md >= 1201) holiday = 'december';
    else if (md >= 1024 && md <= 1031) holiday = 'halloween';
    else if (md >= 213 && md <= 214) holiday = 'valentine';
    else if (md >= 703 && md <= 704) holiday = 'july4';
    else if (md === 712) holiday = 'birthday';
    return {
      year: t.y,
      season: t.m >= 3 && t.m <= 5 ? 'spring' : t.m >= 6 && t.m <= 8 ? 'summer' : t.m >= 9 && t.m <= 11 ? 'fall' : 'winter',
      holiday: holiday
    };
  }

  var cal = almanac(today());
  var PARTY_DAYS = { newyear: 1, july4: 1, birthday: 1 };
  state.hat = { halloween: 'witch', december: 'santa', newyear: 'party', july4: 'party', birthday: 'party' }[cal.holiday] || null;

  var HATS = {
    party: { s: HAT, ox: 4, oy: -4 },
    witch: { s: new Sprite(['....M..', '...MM..', '..MMM..', '..OOO..', 'MMMMMMM']), ox: 2, oy: -5 },
    santa: { s: new Sprite(['...W...', '..RRR..', '.RRRRR.', 'WWWWWWW']), ox: 2, oy: -4 }
  };
  var HAT_COLORS = {
    day: palette({ M: '#5a3d7a', O: '#e08d3b', R: '#c9453a', W: '#f1ebe2' }),
    night: palette({ M: '#6a4a90', O: '#f0a050', R: '#c9453a', W: '#e8e0d4' })
  };

  // how each season repaints the background world
  var SEASON_TINT = {
    spring: {
      day: { meadow: '#9fae82', meadowLit: '#adbb8f', bush: '#7f9464', bushLit: '#93a877', bushShade: '#6c8054', midField: '#a5ad88', grass: '#aab98c', near: '#95977a', nearLit: '#a1a384', blossom: '#ecaec0' },
      night: { meadow: '#161a13', bush: '#101410', bushLit: '#141913', midField: '#1b1e17', grass: '#1d2218', blossom: '#4a2e36' }
    },
    fall: {
      day: { meadow: '#b0a07c', meadowLit: '#bdad88', bush: '#b87a45', bushLit: '#cc8d55', bushShade: '#955f37', midField: '#b59b6c', midTree: '#9c8568', grass: '#bda67a', reed: '#8f6f4b', red: '#b0553a', redLit: '#c86a4a', redShade: '#8e432e' },
      night: { meadow: '#1b1711', bush: '#2a1b11', bushLit: '#332114', bushShade: '#20150d', midField: '#221c14', grass: '#261e14', red: '#26140f', redLit: '#2e1812', redShade: '#1e100c' }
    },
    winter: {
      day: {
        meadow: '#dcdcd6', meadowLit: '#e9e9e4', near: '#d4d5cf', nearLit: '#e7e8e3', grass: '#b3ab98',
        mid: '#c9c9c3', midLit: '#d7d7d1', midShade: '#bdbdb7', midField: '#d2d2cc', midTree: '#8d9087',
        bush: '#8e867a', bushLit: '#a39b8f', bushShade: '#7a7266', tree: '#dfe4df', treeShade: '#56634f',
        water: '#cad6dc', waterDark: '#bcc8cf', waterLit: '#eef3f5', shore: '#b9b9b1', reed: '#9b8f7a',
        roof: '#e6e6e1', roofShade: '#cfcfc9', far: '#cfcac3', farLit: '#d9d4cd', farShade: '#c4bfb8'
      },
      night: {
        meadow: '#2a2c31', meadowLit: '#33363c', near: '#25272c', nearLit: '#2f3237', grass: '#3a3b3e',
        mid: '#212328', midLit: '#262930', midShade: '#1d1f24', midField: '#26282d', midTree: '#16181b',
        bush: '#1b1816', tree: '#3a3e44', treeShade: '#111412', water: '#1d2329', waterDark: '#181d22',
        roof: '#3b3e44', roofShade: '#2f3237'
      }
    }
  };

  function seasonal(P, night) {
    var tint = SEASON_TINT[cal.season], over = tint && tint[night ? 'night' : 'day'];
    if (!over) return P;
    var out = {};
    Object.keys(P).forEach(function (k) { out[k] = P[k]; });
    Object.keys(over).forEach(function (k) { out[k] = rgb(over[k]); });
    return out;
  }

  /* ---------- weather: petals, leaves, snow, confetti ---------- */

  var WEATHER_COLORS = {
    snow: { day: ['#ffffff', '#eef2f4', '#dfe6ea'], night: ['#c8ccd0', '#a3a8ad', '#7c8187'] },
    leaves: { day: ['#c8793d', '#b0553a', '#d9ae45'], night: ['#5a3a22', '#4a2a1c', '#5c4a26'] },
    petals: { day: ['#f3c0cc', '#ecaec0', '#fbe3e8'], night: ['#5a3a44', '#4a2e36', '#6a4a52'] },
    confetti: { day: ['#e0503a', '#f0c24e', '#5f86b0', '#8fa866', '#b07ab8'], night: ['#ff6b6b', '#ffd166', '#6bb8ff', '#8dff9a', '#d49cff'] },
    usa: { day: ['#c9453a', '#f4f1ea', '#3d5f9e'], night: ['#ff6b6b', '#ffffff', '#6b9bff'] }
  };
  Object.keys(WEATHER_COLORS).forEach(function (k) {
    WEATHER_COLORS[k] = { day: WEATHER_COLORS[k].day.map(rgb), night: WEATHER_COLORS[k].night.map(rgb) };
  });

  function weatherKind() {
    if (PARTY_DAYS[cal.holiday] && !isNight()) return cal.holiday === 'july4' ? 'usa' : 'confetti';
    return { spring: 'petals', fall: 'leaves', winter: 'snow' }[cal.season] || null;
  }

  function Weather(w, h, kind, ground) {
    this.w = w;
    this.h = h;
    this.kind = kind;
    this.ground = ground || function () { return h; };
    var per = { snow: 240, leaves: 1100, petals: 1500, confetti: 420, usa: 420 }[kind];
    this.list = [];
    for (var i = Math.round(w * h / per); i > 0; i--) this.list.push(this.spawn(true));
  }
  Weather.prototype.spawn = function (anywhere) {
    var snow = this.kind === 'snow';
    return {
      x: Math.random() * this.w,
      y: anywhere ? Math.random() * this.h : -1 - Math.random() * 8,
      v: snow ? 0.18 + Math.random() * 0.3 : 0.25 + Math.random() * 0.3,
      drift: snow ? 0.05 : this.kind === 'leaves' ? 0.25 : 0.12,
      s: Math.random() * 6.28,
      c: Math.floor(Math.random() * 5)
    };
  };
  Weather.prototype.draw = function (put, f) {
    var cols = WEATHER_COLORS[this.kind][isNight() ? 'night' : 'day'], self = this;
    this.list.forEach(function (p, i) {
      if (!reduceMotion) {
        p.y += p.v;
        p.x += p.drift + Math.sin(f * 0.15 + p.s) * (self.kind === 'snow' ? 0.15 : 0.35);
        if (p.x > self.w + 2) p.x = -2;
        if (p.y > self.ground(Math.round(clamp(p.x, 0, self.w - 1)))) self.list[i] = p = self.spawn(false);
      }
      var c = cols[p.c % cols.length];
      put(p.x, p.y, c);
      if (self.kind === 'leaves' && ((f + i) >> 1) & 1) put(p.x + 1, p.y, c);
      if (self.kind === 'snow' && p.c === 0) put(p.x + 1, p.y, c);
    });
  };

  /* ---------- fireworks for new year's, july 4th, and the site's birthday ---------- */

  var SPARK = ['#ff6b6b', '#ffd166', '#6bd1ff', '#b98cff', '#8dff9a', '#ffffff'].map(rgb);

  function Fireworks(w, h) {
    this.w = w;
    this.h = h;
    this.rockets = [];
    this.sparks = [];
  }
  Fireworks.prototype.draw = function (put, f) {
    var self = this;
    if (!reduceMotion && f % 14 === 0 && Math.random() < 0.8) {
      this.rockets.push({ x: this.w * (0.15 + Math.random() * 0.7), y: this.h * 0.7, top: this.h * (0.08 + Math.random() * 0.22), c: SPARK[Math.floor(Math.random() * SPARK.length)] });
    }
    this.rockets = this.rockets.filter(function (r) {
      r.y -= 2.2;
      put(r.x, r.y, r.c);
      put(r.x, r.y + 1, SPARK[1]);
      if (r.y > r.top) return true;
      for (var k = 0; k < 18; k++) {
        var a = k / 18 * 6.283, sp = 0.7 + Math.random() * 0.5;
        self.sparks.push({ x: r.x, y: r.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 14 + Math.floor(Math.random() * 6), c: r.c });
      }
      return false;
    });
    this.sparks = this.sparks.filter(function (s) {
      s.x += s.vx;
      s.y += s.vy;
      s.vy += 0.05;
      s.vx *= 0.96;
      s.life -= 1;
      if (s.life > 3 || (s.life & 1)) put(s.x, s.y, s.c);
      return s.life > 0;
    });
  };

  /* ---------- holiday props ---------- */

  var PUMPKIN = new Sprite(['..s..', '.OOO.', 'OeOeO', '.OoO.']);
  var SNOWMAN = new Sprite(['.KKK.', 'KKKKK', '.www.', '.wen.', '.www.', 'wwwww', 'wwwww', 'wwwww', '.www.']);
  var BAT = [new Sprite(['K...K', '.KKK.']), new Sprite(['.KKK.', 'K...K'])];
  var TINY_HEART = new Sprite(['H.H', 'HHH', '.H.']);
  var BULBS = ['#e0503a', '#6fbf5a', '#f0c24e', '#5f86ff'].map(rgb);
  var PROPS = {
    day: palette({ O: '#e07a2e', s: '#5a6e3a', e: '#5a2e10', w: '#f4f4f0', K: '#2a2622', n: '#e07a2e', bat: '#3a2a30', heart: '#e06b86' }),
    night: palette({ O: '#9a5220', s: '#2e3a1e', e: '#ffd166', w: '#7a7d82', K: '#141210', n: '#b0561e', bat: '#6a5480', heart: '#f08aa0' })
  };

  /* ---------- background world ---------- */

  function buildWorld(w, h, night) {
    var P = seasonal(night ? WORLD.night : WORLD.day, night), PR = night ? PROPS.night : PROPS.day;
    var tr = random(7714), sr = random(1234), dr = random(4242);
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
    var snowLine = Math.min.apply(null, farTop) + Math.round(h * (cal.season === 'winter' ? 0.12 : 0.035));
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
      var gy = meadowTop[x] + 2 + Math.floor(tr() * 3), gr = 2 + Math.floor(tr() * 2);
      var leaves = P.red && dr() < 0.35 ? [P.redLit, P.red, P.redShade] : [P.bushLit, P.bush, P.bushShade];
      roundTree(F, x, gy, gr, leaves, P.trunk, tr);
      if (P.blossom) {
        var crown = gy - Math.max(2, Math.round(gr * 0.8)) - gr;
        for (var bl = 0; bl < 4; bl++) F(x + Math.floor(dr() * (2 * gr + 1)) - gr, crown + Math.floor(dr() * (2 * gr + 1)) - gr, P.blossom);
      }
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

    if (cal.season === 'winter') {
      var smx = cabinX - 22;
      if (smx > lakeR + 4) drawSprite(F, SNOWMAN, smx, nearTop[smx + 2] - SNOWMAN.h + 1, PR);
    }
    if (cal.holiday === 'halloween') {
      [cabinX + 13, cabinX - 5].forEach(function (px) {
        if (px < 0 || px > w - 6) return;
        var py = nearTop[px + 2] - PUMPKIN.h + 1;
        if (night) halo(F, px + 2, py + 2, 2, 6, rgb('#3a2616'));
        drawSprite(F, PUMPKIN, px, py, PR);
      });
    }

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

    var bats = [];
    if (cal.holiday === 'halloween') {
      for (i = 0; i < 5; i++) bats.push({ x: dr() * w, y: h * (0.08 + dr() * 0.3), v: 0.3 + dr() * 0.3, p: dr() * 6.28 });
    }
    var fireworks = night && PARTY_DAYS[cal.holiday] ? new Fireworks(w, h) : null;

    var chimX = cabinX + 9, chimY = cabinY - 1, smoke = [];
    for (i = 0; i < 8; i++) smoke.push({ x: chimX + i * 0.6, y: chimY - i * 1.3, life: i * 4 });
    var shooting = null;

    return {
      back: back,
      front: front,
      ground: function (gx) { return nearTop[gx]; },
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
        bats.forEach(function (b) {
          if (!reduceMotion) { b.x += b.v; if (b.x > w + 5) b.x = -5; }
          drawSprite(put, BAT[reduceMotion ? 0 : (f >> 1) & 1], Math.round(b.x), Math.round(b.y + Math.sin(f * 0.3 + b.p) * 2), { K: PR.bat });
        });
        if (fireworks) fireworks.draw(put, f);
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
        smoke.forEach(function (p, n) {
          if (!reduceMotion) {
            p.y -= 0.32;
            p.x += 0.14 + Math.sin((p.life + p.x) * 0.4) * 0.08;
            p.life += 1;
          }
          if (cal.holiday === 'valentine') {
            if (n % 3 === 0) drawSprite(put, TINY_HEART, Math.round(p.x) - 1, Math.round(p.y), { H: PR.heart });
            return;
          }
          put(p.x, p.y, p.life < 16 ? P.smoke : P.smokeDim);
          if (p.life < 8) put(p.x + 1, p.y, P.smoke);
        });

        if (cal.holiday === 'december') {
          for (var lx = 2, k = 0; lx <= 11; lx += 2, k++) {
            var on = !night || reduceMotion || (k + (f >> 2)) % 5 !== 0;
            put(cabinX + lx, cabinY + 7, on ? BULBS[k % 4] : P.wallShade);
          }
        }
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

  /* ---------- home: the bulletin board ---------- */

  var CORK = {
    day: palette({ cork: '#c49a6c', corkDark: '#b0875b', corkDeep: '#9d764c', corkLight: '#d3ab7e', hole: '#6e5238' }),
    night: palette({ cork: '#3f3124', corkDark: '#35291e', corkDeep: '#2c2219', corkLight: '#4a3a2b', hole: '#1a130d' })
  };

  function buildBoard(w, h, night) {
    var P = night ? CORK.night : CORK.day, W = night ? SHELF.night : SHELF.day;
    var back = new Bitmap(w, h), put = back.painter(), r = random(1717);
    var x, y, i;

    // cork: speckled granules plus a few clumps
    for (y = 4; y < h - 4; y++) {
      for (x = 4; x < w - 4; x++) {
        var v = r();
        put(x, y, v < 0.12 ? P.corkDark : v < 0.16 ? P.corkLight : v < 0.18 ? P.corkDeep : P.cork);
      }
    }
    for (i = w * h / 60; i > 0; i--) {
      var cx = 4 + Math.floor(r() * (w - 8)), cy = 4 + Math.floor(r() * (h - 8)), c = r() < 0.6 ? P.corkDark : P.corkLight;
      put(cx, cy, c);
      put(cx + 1, cy, c);
      put(cx, cy + 1, c);
    }
    // old pin holes from photos that came and went
    for (i = w * h / 420; i > 0; i--) put(4 + Math.floor(r() * (w - 8)), 4 + Math.floor(r() * (h - 8)), P.hole);
    for (y = 4; y < h - 4; y++) {
      put(4, y, P.corkDeep);
      if (dither(5, y) < 0.5) put(5, y, P.corkDeep);
    }
    for (x = 4; x < w - 4; x++) {
      put(x, 4, P.corkDeep);
      if (dither(x, 5) < 0.5) put(x, 5, P.corkDeep);
    }

    // the frame: lit from the top left, grain on the middle ring
    for (var ring = 0; ring < 4; ring++) {
      for (x = ring; x < w - ring; x++) {
        for (var side = 0; side < 2; side++) {
          y = side ? h - 1 - ring : ring;
          put(x, y, [W.out, side ? W.woodDark : W.woodLit, r() < 0.2 ? W.grain : W.wood, W.woodDark][ring]);
        }
      }
      for (y = ring; y < h - ring; y++) {
        for (side = 0; side < 2; side++) {
          x = side ? w - 1 - ring : ring;
          put(x, y, [W.out, side ? W.woodDark : W.woodLit, r() < 0.2 ? W.grain : W.wood, W.woodDark][ring]);
        }
      }
    }
    [[1, 1, 1, 1], [w - 2, 1, -1, 1], [1, h - 2, 1, -1], [w - 2, h - 2, -1, -1]].forEach(function (k) {
      for (var j = 0; j < 3; j++) {
        put(k[0] + j * k[2], k[1], W.brass);
        put(k[0], k[1] + j * k[3], W.brass);
      }
      put(k[0], k[1], W.brassLit);
    });

    return { back: back };
  }

  /* ---------- about: the road so far ---------- */

  // one grass/tree set per era: spring for middle school, golden for high school, evergreen for college
  var ROAD = {
    day: palette({
      grass: ['#9bb46a', '#b9a760', '#7f9a62'], grassDark: ['#88a05b', '#a6944f', '#6d8853'], grassLight: ['#aec67e', '#cab874', '#91ab73'],
      treeA: ['#8fa866', '#6f8a4e', '#566e3b'], treeB: ['#e0a05a', '#c9793d', '#a95f2e'], treeC: ['#6f8a5a', '#4f6e45', '#3e5a37'],
      flower: ['#f1e6cc', '#e8a0b4', '#f3d77a', '#8a2a2a'],
      path: '#dcc9a1', pathEdge: '#a8916a', pebble: '#c2ad86', rock: '#a39c92', rockDark: '#857e74', trunk: '#6b5040',
      out: '#3a2f27', career: '#5f86b0', careerLit: '#9dbcdf', fun: '#e08d3b', funLit: '#f6c283', gold: '#d9ae45', goldLit: '#f6e3a0',
      pole: '#8a8378', flag: '#c9453a', flagDark: '#9c3226'
    }),
    night: palette({
      grass: ['#27301c', '#2e2a1a', '#1f2a1e'], grassDark: ['#212a17', '#272315', '#1a2419'], grassLight: ['#2e3822', '#36311f', '#253224'],
      treeA: ['#2c3820', '#222c19', '#1a2214'], treeB: ['#3a2a1a', '#2e2014', '#241810'], treeC: ['#22301f', '#1a2618', '#141e12'],
      flower: ['#6a6258', '#5a3a44', '#6a5a30', '#4a1a1a'],
      path: '#4e4434', pathEdge: '#2e271e', pebble: '#433a2c', rock: '#3a3632', rockDark: '#2a2724', trunk: '#241a14',
      out: '#0e0b09', career: '#4a6e96', careerLit: '#86b0e0', fun: '#c77a30', funLit: '#ffc070', gold: '#c9a040', goldLit: '#ffe9a0',
      pole: '#5a554e', flag: '#a83a2c', flagDark: '#7a2a20', firefly: '#f1c878', fireflyDim: '#7d6437'
    })
  };

  function buildRoad(w, h, night, m) {
    var P = night ? ROAD.night : ROAD.day, H = night ? WORLD.night : WORLD.day;
    var back = new Bitmap(w, h), put = back.painter(), r = random(9090);
    var trees = [P.treeA, P.treeB, P.treeC], R = 3;
    var mask = new Uint8Array(w * h);
    var x, y, i, k;

    function eraAt(yy) {
      var e = 0;
      for (var j = 0; j < m.eras.length; j++) if (yy >= m.eras[j]) e = Math.min(j, 2);
      return e;
    }

    // grass, blending into the next era over a few dithered rows
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        var e = eraAt(y), v = r();
        if (e > 0 && y - m.eras[e] < 10 && dither(x, y) > (y - m.eras[e]) / 10) e -= 1;
        put(x, y, v < 0.1 ? P.grassDark[e] : v < 0.16 ? P.grassLight[e] : P.grass[e]);
      }
    }

    // the road snakes from stop to stop, then fades out as a trail past "you are here"
    var pts = m.points, samples = [];
    for (i = 0; i < pts.length - 1; i++) {
      var a = pts[i], b = pts[i + 1], dy = b.y - a.y;
      var amp = Math.min(m.amp, dy / 3) * (i % 2 ? -1 : 1);
      var steps = Math.max(2, Math.ceil(dy * 1.5));
      for (k = 0; k <= steps; k++) {
        var t = k / steps;
        samples.push([a.x + (b.x - a.x) * t + 3 * amp * t * (1 - t), a.y + dy * t]);
      }
    }
    samples.forEach(function (s) {
      for (var yy = -R - 5; yy <= R + 5; yy++) {
        for (var xx = -R - 5; xx <= R + 5; xx++) {
          var mx = Math.round(s[0]) + xx, my = Math.round(s[1]) + yy;
          if (mx >= 0 && my >= 0 && mx < w && my < h) mask[my * w + mx] = 1;
        }
      }
    });
    samples.forEach(function (s) { disc(put, Math.round(s[0]), Math.round(s[1]), R + 1, P.pathEdge); });
    samples.forEach(function (s) {
      disc(put, Math.round(s[0]), Math.round(s[1]), R, P.path);
      if (r() < 0.12) put(Math.round(s[0]) + Math.floor(r() * 5) - 2, Math.round(s[1]) + Math.floor(r() * 5) - 2, P.pebble);
    });
    var end = pts[pts.length - 1];
    for (y = end.y + 8, k = 0; y < h - 2; y += 4, k++) {
      if (r() < k / 9) continue;
      put(end.x, y, P.path);
      put(end.x + 1, y, P.path);
      put(end.x, y + 1, P.pathEdge);
      put(end.x + 1, y + 1, P.pathEdge);
    }

    // scenery on the grass, kept off the road; trees drawn back to front
    var forest = [];
    for (i = Math.round(w * h / 80); i > 0; i--) {
      x = Math.floor(r() * w);
      y = Math.floor(r() * h);
      if (mask[y * w + x]) continue;
      var era = eraAt(y), pick = r();
      if (pick < 0.5) {
        put(x, y, P.grassDark[era]);
        put(x + 1, y - 1, P.grassDark[era]);
        put(x + 2, y, P.grassDark[era]);
      } else if (pick < 0.78) {
        put(x, y, P.flower[era === 2 && r() < 0.5 ? 3 : Math.floor(r() * 3)]);
      } else if (pick < 0.86) {
        put(x, y, P.rock);
        put(x + 1, y, P.rockDark);
      } else if (y > 12 && !mask[(y - 8) * w + x] && !mask[(y - 4) * w + Math.max(0, x - 4)] && !mask[(y - 4) * w + Math.min(w - 1, x + 4)]) {
        forest.push({ x: x, y: y, era: era, size: r() });
      }
    }
    forest.sort(function (p, q) { return p.y - q.y; }).forEach(function (f) {
      var c = trees[f.era];
      if (f.era === 2) pine(put, f.x, f.y, 7 + Math.floor(f.size * 5), c[0], c[2], P.trunk);
      else roundTree(put, f.x, f.y, 2 + Math.floor(f.size * 2), c, P.trunk, r);
    });

    // start house, stops, and the finish line
    var start = pts[0];
    drawSprite(put, CABIN, start.x - 7, start.y - 11, {
      c: H.chimney, R: H.roof, q: H.roofShade, r: H.roofShade, W: H.wall, w: H.wallShade, G: H.window, D: H.door
    });
    pts.forEach(function (p) {
      if (p.type !== 'stop') return;
      var c = p.kind === 'fun' ? P.fun : P.career, lit = p.kind === 'fun' ? P.funLit : P.careerLit;
      disc(put, p.x, p.y, 5, P.out);
      disc(put, p.x, p.y, 4, c);
      put(p.x - 2, p.y - 2, lit);
      put(p.x - 1, p.y - 2, lit);
      put(p.x - 2, p.y - 1, lit);
    });
    disc(put, end.x, end.y, 6, P.out);
    disc(put, end.x, end.y, 5, P.gold);
    put(end.x - 2, end.y - 3, P.goldLit);
    put(end.x - 3, end.y - 2, P.goldLit);

    var narrow = end.x < 24;
    var flagX = narrow ? end.x + 8 : end.x - 10;
    line(put, flagX, end.y - 15, flagX, end.y + 1, P.pole);
    var cat = narrow ? new Cat(end.x + 5, end.y + 4, {}) : new Cat(end.x - 25, end.y - 8, {});

    var bugs = [];
    for (i = 0; i < Math.round(h / 25); i++) bugs.push({ x: r() * w, y: r() * h, s: r() * 6.28 });

    return {
      back: back,
      cats: [cat],
      mid: function (p, f) {
        var still = reduceMotion ? 0 : f;
        // flag waving at the finish
        var wave = (still >> 1) & 1;
        for (var fy = 0; fy < 5; fy++) {
          for (var fx = 1; fx <= 7; fx++) {
            if (fx === 7 && fy !== 2 - wave && fy !== 2) continue;
            var dip = wave && fx > 3 ? 1 : 0;
            p(flagX + fx, end.y - 15 + fy + dip, fy === 4 || fx > 5 ? P.flagDark : P.flag);
          }
        }
        if (!night) return;
        bugs.forEach(function (b, n) {
          var bx = Math.round(b.x + Math.sin(still * 0.12 + b.s) * 4), by = Math.round(b.y + Math.cos(still * 0.09 + b.s) * 3);
          if ((still + n * 5) % 23 < 15) p(bx, by, (still + n) % 7 < 2 ? P.fireflyDim : P.firefly);
        });
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
    var kind = v.hasWeather && weatherKind();
    if (v.skipWeather && v.skipWeather.indexOf(kind) >= 0) kind = null;
    v.weather = kind ? new Weather(w, h, kind, v.scene.ground) : null;
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
    if (v.weather && s.weatherBehind) v.weather.draw(v.put, f);
    if (v.frontC) c.drawImage(v.frontC, 0, 0);
    if (s.cats) s.cats.forEach(function (cat) { cat.draw(v.put, f, night); });
    if (s.top) s.top(v.put, f, c);
    if (v.weather && !s.weatherBehind) v.weather.draw(v.put, f);
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
    var cy = (cat.y - (state.party || state.hat ? 6 : 1)) * v.scale + v.canvas.offsetTop;
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
      v.canvas.style.cursor = catAt(e) ? 'var(--cursor-pet)' : '';
    });
  }

  function setupWorld() {
    var cv = document.createElement('canvas');
    cv.id = 'world-bg';
    cv.className = 'pixel-canvas';
    cv.setAttribute('aria-hidden', 'true');
    document.body.insertBefore(cv, document.body.firstChild);
    addView({
      el: cv, canvas: cv, scale: 4, hasWeather: true, skipWeather: ['leaves'],
      size: function () { return { w: window.innerWidth, h: window.innerHeight }; },
      build: buildWorld
    });
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

  function setupRoad() {
    var road = document.getElementById('road');
    if (!road) return;
    var S = 3;
    var art = document.createElement('div');
    art.className = 'road-art';
    var cv = document.createElement('canvas');
    cv.className = 'pixel-canvas';
    cv.setAttribute('aria-hidden', 'true');
    art.appendChild(cv);
    road.insertBefore(art, road.firstChild);

    // read where the signs and cards actually landed, in art pixels
    function measure() {
      var top = road.getBoundingClientRect().top;
      function at(el, off) { return Math.round((el.getBoundingClientRect().top - top + off) / S); }
      var first = road.querySelector('.road-era');
      var cs = getComputedStyle(first);
      var cols = cs.gridTemplateColumns.split(' ').map(parseFloat);
      var pad = parseFloat(cs.paddingLeft);
      var x = Math.round((pad + (cols.length > 2 ? cols[0] + cols[1] / 2 : cols[0] / 2)) / S);
      var start = road.querySelector('.road-start'), end = road.querySelector('.road-end');
      var pts = [{ x: x, y: at(start, start.offsetHeight / 2 + 12), type: 'start' }], eras = [];
      Array.prototype.forEach.call(road.querySelectorAll('.road-era'), function (sec) {
        var sign = sec.querySelector('.road-sign');
        eras.push(at(sec, 0));
        pts.push({ x: x, y: at(sign, sign.offsetHeight / 2), type: 'sign' });
        Array.prototype.forEach.call(sec.querySelectorAll('.road-stop'), function (st) {
          pts.push({ x: x, y: at(st, 19), type: 'stop', kind: st.getAttribute('data-kind') });
        });
      });
      pts.push({ x: x, y: at(end, 34), type: 'end' });
      pts.sort(function (a, b) { return a.y - b.y; });
      return { points: pts, eras: eras, amp: cols.length > 2 ? 9 : 3 };
    }

    var v = addView({
      el: road, canvas: cv, scale: S, fit: 'floor', observe: true, resizeWith: road,
      size: function () { return { w: road.clientWidth, h: road.clientHeight }; },
      build: function (w, h, night) { return buildRoad(w, h, night, measure()); }
    });
    enableCats(v);

    // cards can change height (fonts, photos), so redraw the map when the road gets taller or shorter
    if ('ResizeObserver' in window) {
      var lastH = road.clientHeight, timer;
      new ResizeObserver(function () {
        if (road.clientHeight === lastH) return;
        lastH = road.clientHeight;
        clearTimeout(timer);
        timer = setTimeout(function () { mountView(v); }, 150);
      }).observe(road);
    }
  }

  function setupBoard() {
    var board = document.getElementById('board');
    if (!board) return;
    var art = document.createElement('div');
    art.className = 'board-art';
    var cv = document.createElement('canvas');
    cv.className = 'pixel-canvas';
    cv.setAttribute('aria-hidden', 'true');
    art.appendChild(cv);
    board.insertBefore(art, board.firstChild);
    addView({
      el: board, canvas: cv, scale: 3, fit: 'floor', observe: true, resizeWith: board,
      size: function () { return { w: board.clientWidth, h: board.clientHeight }; },
      build: buildBoard
    });
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

  /* ---------- business mode: same pages, none of the pixel art ---------- */

  // sentence case for headings and nav, with acronyms and names spelled the way people expect
  var PROPER = { edc: 'EDC', vg: 'VG', github: 'GitHub', tiktok: 'TikTok', i: 'I', "i'm": "I'm", "i've": "I've", 'tl;dr': 'TL;DR' };

  function sentenceCase(el) {
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), node, first = true;
    while ((node = walker.nextNode())) {
      var text = node.nodeValue.replace(/[a-z][a-z;']*/gi, function (w) {
        var fix = PROPER[w.toLowerCase()];
        return fix && w === w.toLowerCase() ? fix : w;
      });
      if (first && /[a-z]/i.test(text)) {
        text = text.replace(/[a-z]/i, function (c) { return c.toUpperCase(); });
        first = false;
      }
      node.nodeValue = text;
    }
  }

  function setupBusiness() {
    Array.prototype.forEach.call(document.querySelectorAll('.nav-header'), function (h) {
      h.textContent = h.textContent.replace(/—/g, '').trim();
    });
    Array.prototype.forEach.call(document.querySelectorAll('h1, h2, h3, .nav-link, .fav-tab, .case-cta, .back-link, .toc a, .chip-nav a'), sentenceCase);
    var here = location.pathname.replace(/index\.html$/, '');
    Array.prototype.forEach.call(document.querySelectorAll('.nav-link'), function (a) {
      var href = a.getAttribute('href');
      if (href === here || (href !== '/' && href.charAt(0) === '/' && here.indexOf(href) === 0)) a.setAttribute('aria-current', 'page');
    });
    var tick = setupClock();
    if (tick) setInterval(tick, 30000);
  }

  /* ---------- boot ---------- */

  // business mode skips the art entirely, so no animation loop runs in the background
  if (document.body.classList.contains('business')) {
    setupBusiness();
    return;
  }

  setupWorld();
  setupShelf();
  setupRoad();
  setupBoard();
  var updateClock = setupClock();
  setupKonami();
  if (cal.holiday === 'birthday' && cal.year > 2026) {
    try {
      if (!sessionStorage.getItem('v2-bday')) {
        sessionStorage.setItem('v2-bday', '1');
        var age = cal.year - 2026;
        setTimeout(function () { toast('happy birthday ethnmz.com ✦ ' + age + (age === 1 ? ' year' : ' years') + ' old today'); }, 800);
      }
    } catch (e) {}
  }

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
