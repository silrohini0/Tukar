/* ============================================================
   Tukar — Landing page runtime (vanilla JS, no build step)
   - Hero "speeding corridor" light-streaks canvas
   - Commitment-grid canvas
   - Night-Earth globe with cross-border arcs canvas
   - Tech marquee population + tabbed circuits/contracts grid
   All canvases use requestAnimationFrame, draw first frame
   synchronously, and pause when the tab is hidden.
   ============================================================ */
(function () {
  "use strict";

  var PAL = ["#ff8a3d", "#ffd29a", "#ff6a18"]; // [stroke, hot tip, deep]

  function hexA(hex, a) {
    var h = hex.replace("#", "");
    var r = parseInt(h.slice(0, 2), 16),
      g = parseInt(h.slice(2, 4), 16),
      b = parseInt(h.slice(4, 6), 16);
    return "rgba(" + r + "," + g + "," + b + "," + a + ")";
  }

  // Respect the OS "reduce motion" accessibility setting: we still draw each
  // canvas's first (static) frame, but never run the animation loops.
  var reducedMotion =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Each animation registers a {start, stop} so we can pause on tab-hide.
  var loops = [];
  function register(loop) {
    loops.push(loop);
  }
  document.addEventListener("visibilitychange", function () {
    for (var i = 0; i < loops.length; i++) {
      if (document.hidden || reducedMotion) loops[i].stop();
      else loops[i].start();
    }
  });

  /* ---------------------------------------------------------
     HERO — light streaks accelerating from a vanishing point
  --------------------------------------------------------- */
  function initHero() {
    var cv = document.getElementById("heroCanvas");
    if (!cv) return;
    var ctx = cv.getContext("2d");
    var W, H, dpr, F, lanes;

    function resize() {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = cv.clientWidth || cv.parentElement.clientWidth;
      H = cv.clientHeight || cv.parentElement.clientHeight;
      cv.width = Math.max(1, W * dpr);
      cv.height = Math.max(1, H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      F = { x: W * 0.6, y: H * 0.36 };
      var exits = [
        [-0.12, 1.05], [0.1, 1.12], [0.28, 1.12], [0.46, 1.12], [0.64, 1.12],
        [0.84, 1.08], [1.06, 0.92], [1.12, 0.66], [1.1, 0.44], [-0.06, 0.86], [-0.1, 0.64]
      ];
      lanes = exits.map(function (e) {
        var E = { x: e[0] * W, y: e[1] * H };
        var C = { x: F.x + (E.x - F.x) * 0.12, y: F.y + (E.y - F.y) * 0.5 };
        return { F: F, C: C, E: E };
      });
    }

    function B(l, t) {
      var u = 1 - t;
      return {
        x: u * u * l.F.x + 2 * u * t * l.C.x + t * t * l.E.x,
        y: u * u * l.F.y + 2 * u * t * l.C.y + t * t * l.E.y
      };
    }
    function spawn() {
      return {
        li: Math.floor(Math.random() * lanes.length),
        t: Math.random() * 0.12,
        v: 0.0045 + Math.random() * 0.006,
        len: 0.05 + Math.random() * 0.07,
        b: 0.5 + Math.random() * 0.5,
        cool: Math.random() < 0.13,
        delay: Math.random() * 0.45
      };
    }

    var streaks = [];
    var raf = 0, last = performance.now();
    var TARGET = window.innerWidth < 720 ? 70 : 120;

    function frame(now) {
      var dt = Math.min(40, now - last);
      last = now;
      while (streaks.length < TARGET) streaks.push(spawn());
      if (streaks.length > TARGET) streaks.length = TARGET;

      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "rgba(10,7,5,0.30)";
      ctx.fillRect(0, 0, W, H);

      var g = ctx.createRadialGradient(F.x, F.y, 0, F.x, F.y, Math.max(W, H) * 0.55);
      g.addColorStop(0, "rgba(255,165,90,0.18)");
      g.addColorStop(0.16, "rgba(220,110,40,0.08)");
      g.addColorStop(0.45, "rgba(120,50,15,0.025)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);

      for (var i = 0; i < streaks.length; i++) {
        var s = streaks[i];
        if (s.delay > 0) { s.delay -= dt / 1000; continue; }
        s.t += (s.v + s.t * s.t * 0.06) * (dt / 16.67);
        if (s.t >= 1) { streaks[i] = spawn(); continue; }
        var l = lanes[s.li];
        var p2 = B(l, s.t), p1 = B(l, Math.max(0, s.t - s.len * (1 + s.t * 7)));
        var w = 0.5 + s.t * s.t * 6.5;
        var fade = s.t < 0.1 ? s.t / 0.1 : (s.t > 0.85 ? (1 - s.t) / 0.15 : 1);
        var a = Math.max(0, Math.min(1, s.b * fade));
        var grad = ctx.createLinearGradient(p1.x, p1.y, p2.x, p2.y);
        if (s.cool) {
          grad.addColorStop(0, "rgba(180,185,200,0)");
          grad.addColorStop(1, "rgba(205,210,225," + (a * 0.5) + ")");
        } else {
          grad.addColorStop(0, hexA(PAL[2], 0));
          grad.addColorStop(0.6, hexA(PAL[0], a * 0.85));
          grad.addColorStop(1, hexA(PAL[1], a));
        }
        ctx.strokeStyle = grad;
        ctx.lineWidth = w;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = "source-over";
      raf = requestAnimationFrame(frame);
    }

    function start() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } }
    function stop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }

    resize();
    window.addEventListener("resize", resize);
    register({ start: start, stop: stop });
    frame(performance.now()); // first frame synchronously
  }

  /* ---------------------------------------------------------
     COMMITMENT GRID — cells light up in a travelling wave
  --------------------------------------------------------- */
  function initGrid() {
    var cv = document.getElementById("gridCanvas");
    if (!cv) return;
    var ctx = cv.getContext("2d");
    var W, H, dpr, cols, rows, cell, gap, ox, oy, raf = 0;

    function rr(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }
    function resize() {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = cv.clientWidth; H = cv.clientHeight;
      cv.width = Math.max(1, W * dpr); cv.height = Math.max(1, H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = 7;
      gap = Math.min(W, H) * 0.03;
      cell = (W - gap * (cols + 1)) / cols;
      rows = Math.max(4, Math.floor((H - gap) / (cell + gap)));
      ox = gap; oy = gap;
    }
    resize();
    var t0 = performance.now();

    function frame(now) {
      var time = (now - t0) / 1000;
      ctx.clearRect(0, 0, W, H);
      for (var r = 0; r < rows; r++) {
        for (var c = 0; c < cols; c++) {
          var x = ox + c * (cell + gap), y = oy + r * (cell + gap);
          var d = c * 0.7 + r;
          var phase = time * 1.05 - d * 0.3;
          var period = 3.4;
          var pf = phase - Math.floor(phase / period) * period;
          var glow = pf < 1 ? Math.sin(pf * Math.PI) : 0;
          glow = Math.max(0, glow);
          rr(x, y, cell, cell, cell * 0.2);
          ctx.strokeStyle = "rgba(255,255,255,0.06)";
          ctx.lineWidth = 1;
          ctx.stroke();
          if (glow > 0.02) {
            ctx.save();
            ctx.shadowColor = hexA(PAL[0], 0.8 * glow);
            ctx.shadowBlur = 20 * glow;
            rr(x, y, cell, cell, cell * 0.2);
            ctx.fillStyle = hexA(PAL[2], 0.12 + 0.5 * glow);
            ctx.fill();
            ctx.strokeStyle = hexA(PAL[0], 0.3 + 0.6 * glow);
            ctx.lineWidth = 1.4;
            ctx.stroke();
            ctx.restore();
          }
        }
      }
      raf = requestAnimationFrame(frame);
    }
    function start() { if (!raf) raf = requestAnimationFrame(frame); }
    function stop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }

    window.addEventListener("resize", resize);
    register({ start: start, stop: stop });
    frame(performance.now());
  }

  /* ---------------------------------------------------------
     GLOBE — night Earth, warm city lights, cross-border arcs
  --------------------------------------------------------- */
  function initGlobe() {
    var cv = document.getElementById("globeCanvas");
    if (!cv) return;
    var ctx = cv.getContext("2d");
    var W, H, dpr, cx, cy, R, raf = 0, rot = 0;

    function resize() {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = cv.clientWidth; H = cv.clientHeight;
      cv.width = Math.max(1, W * dpr); cv.height = Math.max(1, H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cx = W * 0.5; cy = H * 0.5; R = Math.min(W, H) * 0.47;
    }
    resize();

    var D2R = Math.PI / 180;
    function toV(lat, lon) {
      return { x: Math.cos(lat) * Math.sin(lon), y: Math.sin(lat), z: Math.cos(lat) * Math.cos(lon) };
    }
    var CONTINENTS = [
      [[71,-156],[70,-128],[60,-95],[55,-80],[52,-56],[47,-53],[45,-66],[41,-70],[37,-76],[30,-81],[25,-81],[18,-95],[15,-92],[20,-105],[30,-114],[40,-124],[48,-125],[55,-130],[62,-150]],
      [[81,-30],[78,-18],[70,-22],[61,-46],[72,-58],[80,-45]],
      [[12,-72],[10,-61],[4,-52],[-5,-35],[-12,-38],[-23,-43],[-34,-54],[-50,-69],[-40,-73],[-30,-71],[-18,-70],[-4,-81],[6,-78]],
      [[37,-6],[34,11],[31,25],[30,33],[15,40],[11,51],[-1,42],[-16,40],[-26,34],[-34,20],[-29,16],[-12,13],[-1,9],[5,-4],[15,-17],[21,-17],[28,-13],[34,-9]],
      [[60,-9],[64,12],[70,28],[60,32],[50,28],[45,33],[40,20],[37,15],[36,-5],[43,-9],[48,-5],[54,-8]],
      [[60,30],[70,55],[76,95],[73,140],[66,170],[60,160],[52,140],[45,132],[39,127],[31,122],[22,109],[10,105],[8,98],[16,95],[22,90],[20,80],[8,77],[18,72],[24,67],[30,58],[37,48],[40,52],[48,52],[54,40]],
      [[-11,131],[-12,142],[-19,147],[-28,154],[-38,147],[-38,140],[-33,123],[-31,115],[-22,114],[-14,127]]
    ];
    function onLand(lonD, latD) {
      for (var p = 0; p < CONTINENTS.length; p++) {
        var poly = CONTINENTS[p], inside = false;
        for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          var yi = poly[i][0], xi = poly[i][1], yj = poly[j][0], xj = poly[j][1];
          if (((yi > latD) !== (yj > latD)) && (lonD < (xj - xi) * (latD - yi) / (yj - yi) + xi)) inside = !inside;
        }
        if (inside) return true;
      }
      return false;
    }
    var dots = [];
    for (var latD = -84; latD <= 84; latD += 3.2) {
      var rr2 = Math.cos(latD * D2R);
      var step = 3.2 / Math.max(0.18, rr2);
      for (var lonD = -180; lonD < 180; lonD += step) {
        var v = toV(latD * D2R, lonD * D2R);
        dots.push({ x: v.x, y: v.y, z: v.z, land: onLand(lonD, latD) });
      }
    }
    var CITY_LL = [
      [40.7,-74],[34,-118],[41.8,-87.6],[19.4,-99],[43.7,-79.4],[25.8,-80.2],[45.5,-73.6],[37.8,-122.4],[29.8,-95.4],[49.3,-123.1],
      [-23.5,-46.6],[-34.6,-58.4],[-12,-77],[4.7,-74],[-33.4,-70.7],[10.5,-66.9],
      [51.5,-0.1],[48.9,2.3],[40.4,-3.7],[52.5,13.4],[41.9,12.5],[55.8,37.6],[41,28.9],[59.3,18.1],[52.2,21],[50.1,8.7],[45.5,9.2],
      [6.5,3.4],[30,31.2],[-26.2,28],[-1.3,36.8],[33.6,-7.6],[14.7,-17.4],[9,38.7],
      [25.2,55.3],[24.7,46.7],[35.7,51.4],[31.8,35.2],
      [19,72.8],[28.6,77.2],[1.35,103.8],[-6.2,106.8],[13.7,100.5],[22.3,114.2],[31.2,121.5],[39.9,116.4],[35.7,139.7],[37.6,127],[14.6,121],[23.8,90.4],
      [-33.9,151.2],[-37.8,145],[-36.8,174.8]
    ];
    var CITIES = CITY_LL.map(function (c) {
      return { v: toV(c[0] * D2R, c[1] * D2R), s: 0.6 + Math.random() * 0.9, ph: Math.random() * 6.28 };
    });
    function slerp(a, b, t) {
      var d = a.x * b.x + a.y * b.y + a.z * b.z;
      d = Math.max(-1, Math.min(1, d));
      var o = Math.acos(d);
      if (o < 1e-4) return a;
      var s = Math.sin(o), k1 = Math.sin((1 - t) * o) / s, k2 = Math.sin(t * o) / s;
      return { x: a.x * k1 + b.x * k2, y: a.y * k1 + b.y * k2, z: a.z * k1 + b.z * k2 };
    }
    function mkArc() {
      var i = Math.floor(Math.random() * CITIES.length);
      var j = Math.floor(Math.random() * CITIES.length);
      if (j === i) j = (j + 1) % CITIES.length;
      return { a: CITIES[i].v, b: CITIES[j].v, head: Math.random() * 0.4 };
    }
    var pairs = [mkArc(), mkArc(), mkArc(), mkArc(), mkArc()];

    function frame() {
      rot += 0.0016;
      ctx.clearRect(0, 0, W, H);
      var cosR = Math.cos(rot), sinR = Math.sin(rot);

      var oc = ctx.createRadialGradient(cx - R * 0.34, cy - R * 0.4, R * 0.1, cx, cy, R);
      oc.addColorStop(0, "rgba(44,35,34,0.99)");
      oc.addColorStop(0.55, "rgba(23,18,18,1)");
      oc.addColorStop(1, "rgba(9,6,7,1)");
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.fillStyle = oc; ctx.fill();

      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.clip();
      for (var k = 0; k < dots.length; k++) {
        var d = dots[k];
        var x = d.x * cosR + d.z * sinR;
        var z = -d.x * sinR + d.z * cosR;
        if (z <= 0.03) continue;
        var sx = cx + R * x, sy = cy - R * d.y;
        if (d.land) {
          ctx.beginPath(); ctx.arc(sx, sy, 1.15, 0, 7);
          ctx.fillStyle = "rgba(200,151,101," + (0.13 + 0.52 * z) + ")";
          ctx.fill();
        } else {
          ctx.beginPath(); ctx.arc(sx, sy, 0.72, 0, 7);
          ctx.fillStyle = "rgba(128,116,118," + (0.03 + 0.07 * z) + ")";
          ctx.fill();
        }
      }
      ctx.globalCompositeOperation = "lighter";
      for (var ci = 0; ci < CITIES.length; ci++) {
        var c = CITIES[ci], cv2 = c.v;
        var x2 = cv2.x * cosR + cv2.z * sinR;
        var z2 = -cv2.x * sinR + cv2.z * cosR;
        if (z2 <= 0.04) continue;
        var sx2 = cx + R * x2, sy2 = cy - R * cv2.y;
        var tw = 0.78 + 0.22 * Math.sin(rot * 22 + c.ph);
        var a2 = (0.3 + 0.7 * z2) * tw;
        var rad = c.s * (1.0 + 1.05 * z2);
        var gl = ctx.createRadialGradient(sx2, sy2, 0, sx2, sy2, rad * 4.2);
        gl.addColorStop(0, "rgba(255,214,150," + Math.min(1, a2) + ")");
        gl.addColorStop(0.4, "rgba(255,150,60," + (a2 * 0.4) + ")");
        gl.addColorStop(1, "rgba(255,140,40,0)");
        ctx.beginPath(); ctx.arc(sx2, sy2, rad * 4.2, 0, 7); ctx.fillStyle = gl; ctx.fill();
        ctx.beginPath(); ctx.arc(sx2, sy2, rad * 0.6, 0, 7); ctx.fillStyle = "rgba(255,240,212," + Math.min(1, a2) + ")"; ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";
      var term = ctx.createLinearGradient(cx - R, cy, cx + R, cy);
      term.addColorStop(0, "rgba(0,0,0,0)");
      term.addColorStop(0.5, "rgba(0,0,0,0.05)");
      term.addColorStop(1, "rgba(6,4,5,0.55)");
      ctx.fillStyle = term; ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
      ctx.restore();

      // soft edge fade (no hard rim)
      ctx.globalCompositeOperation = "destination-out";
      var fade = ctx.createRadialGradient(cx, cy, R * 0.9, cx, cy, R * 1.02);
      fade.addColorStop(0, "rgba(0,0,0,0)");
      fade.addColorStop(1, "rgba(0,0,0,1)");
      ctx.beginPath(); ctx.arc(cx, cy, R * 1.02, 0, 7); ctx.fillStyle = fade; ctx.fill();

      ctx.globalCompositeOperation = "lighter";
      var halo = ctx.createRadialGradient(cx, cy, R * 0.8, cx, cy, R * 1.08);
      halo.addColorStop(0, "rgba(255,150,80,0)");
      halo.addColorStop(0.72, "rgba(255,140,70,0.12)");
      halo.addColorStop(1, "rgba(255,140,70,0)");
      ctx.beginPath(); ctx.arc(cx, cy, R * 1.08, 0, 7); ctx.fillStyle = halo; ctx.fill();

      // arcs
      for (var pi = 0; pi < pairs.length; pi++) {
        var p = pairs[pi];
        p.head += 0.005;
        if (p.head > 1.4) { var na = mkArc(); p.a = na.a; p.b = na.b; p.head = 0; }
        var N = 42;
        for (var ii = 0; ii < N; ii++) {
          var sN = ii / (N - 1);
          var seg = p.head - sN * 0.5;
          if (seg < 0 || seg > 1) continue;
          var m = slerp(p.a, p.b, seg);
          var lift = 1 + 0.2 * Math.sin(Math.PI * seg);
          var vx = m.x * lift, vy = m.y * lift, vz = m.z * lift;
          var ax = vx * cosR + vz * sinR;
          var az = -vx * sinR + vz * cosR;
          var aa = (1 - sN) * (az > 0 ? 1 : 0.22);
          if (aa <= 0.01) continue;
          ctx.beginPath();
          ctx.arc(cx + R * ax, cy - R * vy, ii === 0 ? 2.6 : 1.5, 0, 7);
          ctx.fillStyle = hexA(ii === 0 ? PAL[1] : PAL[0], aa);
          ctx.fill();
        }
      }
      ctx.globalCompositeOperation = "source-over";
      raf = requestAnimationFrame(frame);
    }
    function start() { if (!raf) raf = requestAnimationFrame(frame); }
    function stop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }

    window.addEventListener("resize", resize);
    register({ start: start, stop: stop });
    frame();
  }

  /* ---------------------------------------------------------
     MARQUEE — duplicate the chip list for a seamless loop
  --------------------------------------------------------- */
  function initMarquee() {
    var track = document.getElementById("marquee");
    if (!track) return;
    var items = ["Stellar", "Soroban", "Circom", "Groth16", "BN254", "Poseidon", "snarkjs", "circomlib", "zk-SNARK", "WASM", "Protocol 26"];
    var html = "";
    // two passes so translateX(-50%) loops seamlessly
    for (var pass = 0; pass < 2; pass++) {
      for (var i = 0; i < items.length; i++) {
        html += '<div class="chip">' + items[i] + "</div>";
      }
    }
    track.innerHTML = html;
  }

  /* ---------------------------------------------------------
     TABS — Circuits / Contracts / Corridor flow / Disclosure
  --------------------------------------------------------- */
  var DATA = {
    circuits: [
      { tag: "GROTH16 · BN254", code: "transfer.circom", name: "Shielded transfer", type: "2-in / 2-out JoinSplit", status: "VERIFIED ON-CHAIN", meta: "depth 10", icon: "swap" },
      { tag: "GROTH16 · BN254", code: "compliance.circom", name: "ASP compliance", type: "allow ∈ / deny ∉", status: "VERIFIED ON-CHAIN", meta: "bound", icon: "shield" },
      { tag: "GROTH16 · BN254", code: "disclosure.circom", name: "Selective disclosure", type: "commitment → amount", status: "VERIFIED ON-CHAIN", meta: "tamper → reject", icon: "eye" },
      { tag: "GROTH16 · BN254", code: "merkleUpdate.circom", name: "Trustless update", type: "old_root → new_root", status: "VERIFIED ON-CHAIN", meta: "fake → reject", icon: "tree" }
    ],
    contracts: [
      { tag: "SOROBAN", code: "CABRLZH…AA7FEXPJ", name: "pool", type: "orchestration · nullifiers", status: "36/36 TESTS PASS", meta: "no double-spend", icon: "layers" },
      { tag: "SOROBAN", code: "CCRCRVF…I6K3N", name: "transfer verifier", type: "shielded JoinSplit", status: "VERIFY → TRUE", meta: "BN254", icon: "chip" },
      { tag: "SOROBAN", code: "CAGBZGF…XIJQO", name: "compliance verifier", type: "ASP allow / deny", status: "VERIFY → TRUE", meta: "tx ✓", icon: "shield" },
      { tag: "SOROBAN", code: "CACVDX2…AAOD3", name: "disclosure verifier", type: "selective disclosure", status: "VERIFY → TRUE", meta: "tamper → reject", icon: "eye" },
      { tag: "SOROBAN", code: "CBQB4AJ…7EP5Z", name: "merkleUpdate verifier", type: "trustless root advance", status: "VERIFY → TRUE", meta: "fake → reject", icon: "tree" }
    ],
    flow: [
      { tag: "EDGE A", code: "fiat → USDC", name: "Deposit", type: "compliance proof bound", status: "ON-CHAIN", meta: "pinned ASP", icon: "in" },
      { tag: "CORRIDOR", code: "shielded", name: "Transfer", type: "spend · record", status: "PRIVATE", meta: "hidden", icon: "swap" },
      { tag: "TREE", code: "register_root", name: "Update", type: "merkleUpdate proof", status: "TRUSTLESS", meta: "enforced", icon: "refresh" },
      { tag: "EDGE B", code: "USDC → fiat", name: "Withdraw", type: "amount bound to proof", status: "ON-CHAIN", meta: "AmountNotBound", icon: "out" }
    ],
    disclosure: [
      { tag: "REGULATOR", code: "audit request", name: "Open commitment", type: "opens to one amount", status: "PROVEN", meta: "bound", icon: "eye" },
      { tag: "OFF-CHAIN", code: "false witness", name: "Soundness", type: "false witness rejected", status: "REJECTED", meta: "neg test", icon: "shield" },
      { tag: "ON-CHAIN", code: "tampered input", name: "Tamper check", type: "tampered public input", status: "INVALIDPROOF", meta: "on-chain", icon: "alert" },
      { tag: "PRIVACY", code: "pool", name: "No graph leak", type: "payment graph hidden", status: "PRIVATE", meta: "selective", icon: "lock" }
    ]
  };

  var ICONS = {
    swap: ["M4 8H18", "M15 5 18 8 15 11", "M20 16H6", "M9 13 6 16 9 19"],
    shield: ["M12 3 19 6V11C19 16 16 19 12 21 8 19 5 16 5 11V6Z", "M9 12 11 14 15 9"],
    eye: ["M2 12C5 6 19 6 22 12 19 18 5 18 2 12Z", "M12 9.4A2.6 2.6 0 1 0 12.01 9.4"],
    tree: ["M12 5 6 11", "M12 5 18 11", "M6 11 3 18", "M6 11 9 18", "M18 11 15 18", "M18 11 21 18", "M12 3.4A1 1 0 1 0 12.01 3.4"],
    layers: ["M12 3 21 8 12 13 3 8Z", "M3 12 12 17 21 12", "M3 16 12 21 21 16"],
    chip: ["M7 7H17V17H7Z", "M10 10H14V14H10Z", "M9 3V6", "M15 3V6", "M9 18V21", "M15 18V21", "M3 9H6", "M3 15H6", "M18 9H21", "M18 15H21"],
    in: ["M16 4H20V20H16", "M4 12H14", "M11 9 14 12 11 15"],
    out: ["M8 4H4V20H8", "M20 12H10", "M13 9 10 12 13 15"],
    refresh: ["M20 11A8 8 0 0 0 6 6L4 8", "M4 4V8H8", "M4 13A8 8 0 0 0 18 18L20 16", "M20 20V16H16"],
    lock: ["M6 11H18V20H6Z", "M8.5 11V8A3.5 3.5 0 0 1 15.5 8V11", "M12 14V17"],
    alert: ["M12 3 22 20H2Z", "M12 9V14", "M12 17V17.4"]
  };

  function iconSVG(name) {
    var paths = (ICONS[name] || ICONS.swap).map(function (d) {
      return '<path d="' + d + '"></path>';
    }).join("");
    return '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#ff8a3d" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + paths + "</svg>";
  }

  function cardHTML(c) {
    return (
      '<div class="circ-card">' +
        '<div class="circ-vis">' +
          '<span class="circ-icon">' + iconSVG(c.icon) + "</span>" +
          '<span class="circ-led"></span>' +
        "</div>" +
        '<div class="circ-meta">' +
          '<div class="circ-tag">' + c.tag + "</div>" +
          '<div class="circ-code">' + c.code + "</div>" +
          '<div class="circ-name">' + c.name + "</div>" +
          '<div class="circ-type">' + c.type + "</div>" +
        "</div>" +
        '<div class="hr-card"></div>' +
        '<div class="circ-foot">' +
          '<div class="circ-status"><span class="dot"></span>' + c.status + "</div>" +
          '<div class="meta">' + c.meta + "</div>" +
        "</div>" +
      "</div>"
    );
  }

  function initTabs() {
    var grid = document.getElementById("cardGrid");
    var tabs = document.querySelectorAll(".tab");
    if (!grid || !tabs.length) return;

    function render(key) {
      grid.innerHTML = (DATA[key] || DATA.circuits).map(cardHTML).join("");
    }
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener("click", function () {
        for (var j = 0; j < tabs.length; j++) tabs[j].setAttribute("aria-selected", "false");
        this.setAttribute("aria-selected", "true");
        render(this.getAttribute("data-tab"));
      });
    }
    render("circuits");
  }

  /* --------------------------------------------------------- */
  function boot() {
    initMarquee();
    initTabs();
    initHero();
    initGrid();
    initGlobe();
    // Reduced motion: keep the static first frames, stop the rAF loops.
    if (reducedMotion) {
      for (var i = 0; i < loops.length; i++) loops[i].stop();
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
