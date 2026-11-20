// Décor : étoiles qui scintillent + flocons qui tombent.
// Respecte "réduire les animations" (prefers-reduced-motion) : décor fixe.
(() => {
  'use strict';
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- Étoiles ----------
  const stars = document.getElementById('stars');
  if (stars) {
    const NS = 'http://www.w3.org/2000/svg';
    for (let i = 0; i < 150; i++) {
      const c = document.createElementNS(NS, 'circle');
      const y = Math.pow(Math.random(), 1.3) * 72;           // plus dense en haut
      const big = Math.random() < 0.08;
      const r = big ? 1.3 + Math.random() * 0.7 : 0.4 + Math.random() * 0.8;
      const o = (0.35 + Math.random() * 0.65).toFixed(2);
      c.setAttribute('cx', (Math.random() * 100).toFixed(2) + '%');
      c.setAttribute('cy', y.toFixed(2) + '%');
      c.setAttribute('r', r.toFixed(2));
      c.setAttribute('opacity', o);
      if (Math.random() < 0.35) {
        c.classList.add('tw');
        c.style.setProperty('--o', o);
        c.style.animationDuration = (2 + Math.random() * 4).toFixed(1) + 's';
        c.style.animationDelay = (-Math.random() * 6).toFixed(1) + 's';
      }
      stars.append(c);
    }
  }

  // ---------- Flocons ----------
  const canvas = document.getElementById('snow');
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  let w = 0, h = 0, flakes = [];

  function makeFlake(anywhere) {
    const r = 0.8 + Math.pow(Math.random(), 2) * 2.8;       // beaucoup de petits, quelques gros
    return {
      x: Math.random() * w,
      y: anywhere ? Math.random() * h : -6,
      r,
      vy: 16 + r * 13 + Math.random() * 10,                  // les gros tombent plus vite (profondeur)
      sway: 6 + Math.random() * 18,
      phase: Math.random() * Math.PI * 2,
      freq: 0.3 + Math.random() * 0.7,
      a: 0.45 + Math.random() * 0.5,
    };
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const target = Math.round(Math.min(170, Math.max(40, (w * h) / 7000)));
    while (flakes.length < target) flakes.push(makeFlake(true));
    flakes.length = target;
    for (const f of flakes) if (f.x > w) f.x = Math.random() * w;
    draw();
  }

  function draw() {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#ffffff';
    for (const f of flakes) {
      ctx.globalAlpha = f.a;
      ctx.beginPath();
      ctx.arc(f.x + Math.sin(f.phase) * f.sway, f.y, f.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  let last = performance.now();
  function frame(t) {
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    for (const f of flakes) {
      f.y += f.vy * dt;
      f.phase += f.freq * dt;
      if (f.y > h + 6) Object.assign(f, makeFlake(false));
    }
    draw();
    requestAnimationFrame(frame);
  }

  window.addEventListener('resize', resize);
  resize();
  if (!reduce) requestAnimationFrame((t) => { last = t; frame(t); });
})();
