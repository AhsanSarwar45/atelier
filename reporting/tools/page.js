/* Report page behaviour. Agents never write this file; the builder inlines it. */
(function () {
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ── answer chips ─────────────────────────────── */
  $$('.chips[role="radiogroup"]').forEach(function (group) {
    $$('button.chip', group).forEach(function (btn) {
      btn.addEventListener('click', function () {
        $$('button.chip', group).forEach(function (b) { b.setAttribute('aria-checked', String(b === btn)); });
        compose();
      });
    });
  });

  /* ── decision overrides ───────────────────────── */
  $$('button.ovr').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var on = btn.getAttribute('aria-pressed') !== 'true';
      btn.setAttribute('aria-pressed', String(on));
      btn.textContent = on ? 'change this' : 'override';
      btn.closest('.d').classList.toggle('flag', on);
      compose();
    });
  });

  function reply() {
    var parts = $$('.chips[role="radiogroup"]')
      .map(function (g) { return $('button.chip[aria-checked="true"]', g); })
      .filter(Boolean)
      .map(function (b) { return b.dataset.say; });
    var flagged = $$('button.ovr[aria-pressed="true"]').map(function (b) { return b.dataset.d; });
    if (flagged.length) parts.push('Change ' + flagged.join(', ') + '.');
    return parts.join(' ');
  }

  function compose() { var p = $('#prev'); if (p) p.textContent = reply(); }

  var send = $('#send');
  if (send) {
    send.addEventListener('click', function () {
      var text = reply();
      var done = function () {
        send.textContent = 'Copied — paste it in';
        send.classList.add('ok');
        setTimeout(function () { send.textContent = 'Copy my reply'; send.classList.remove('ok'); }, 2200);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, fallback);
      } else { fallback(); }
      function fallback() {
        var ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        ta.remove(); done();
      }
    });
  }

  /* ── contents rail — last section past the line ── */
  var links = $$('nav a');
  var cards = links.map(function (a) { return document.getElementById(a.getAttribute('href').slice(1)); }).filter(Boolean);
  var LINE = 110, lock = 0, queued = false;

  function mark(el) { links.forEach(function (a, i) { a.classList.toggle('on', cards[i] === el); }); }

  function spy() {
    queued = false;
    if (Date.now() < lock || !cards.length) return;
    var atEnd = window.innerHeight + window.scrollY >= document.body.scrollHeight - 4;
    var active = atEnd ? cards[cards.length - 1] : cards[0];
    if (!atEnd) cards.forEach(function (c) { if (c.getBoundingClientRect().top <= LINE) active = c; });
    mark(active);
  }

  addEventListener('scroll', function () { if (!queued) { queued = true; requestAnimationFrame(spy); } }, { passive: true });
  addEventListener('resize', spy, { passive: true });
  links.forEach(function (a, i) { a.addEventListener('click', function () { lock = Date.now() + 700; mark(cards[i]); }); });

  /* ── wipe sliders ─────────────────────────────── */
  $$('.wipe').forEach(function (w) {
    var top = $('.top', w), handle = $('.handle', w);
    function set(pct) {
      pct = Math.max(0, Math.min(100, pct));
      top.style.width = pct + '%';
      handle.style.left = pct + '%';
    }
    function fromEvent(e) {
      var r = w.getBoundingClientRect();
      var x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
      set((x / r.width) * 100);
    }
    var dragging = false;
    w.addEventListener('pointerdown', function (e) { dragging = true; w.setPointerCapture(e.pointerId); fromEvent(e); });
    w.addEventListener('pointermove', function (e) { if (dragging) fromEvent(e); });
    w.addEventListener('pointerup', function () { dragging = false; });
    set(50);
  });

  /* ── lightbox: click to enlarge, wheel to zoom, drag to pan ── */
  var lb = $('#lb');
  if (lb) {
    var panes = [], zoom = 1, ox = 0, oy = 0, natural = [];

    function layout() {
      panes.forEach(function (p, i) {
        var img = $('img', p);
        var base = Math.min(p.clientWidth / natural[i].w, p.clientHeight / natural[i].h);
        var s = base * zoom;
        img.style.width = natural[i].w * s + 'px';
        img.style.height = natural[i].h * s + 'px';
        img.style.transform = 'translate(' + (-natural[i].w * s / 2 + ox) + 'px,' + (-natural[i].h * s / 2 + oy) + 'px)';
      });
    }

    function open(sources) {
      $$('.pane', lb).forEach(function (p) { p.remove(); });
      panes = []; natural = []; zoom = 1; ox = 0; oy = 0;
      sources.forEach(function (src) {
        var pane = document.createElement('div');
        pane.className = 'pane' + (sources.length > 1 ? ' half' : '');
        var img = new Image();
        img.src = src.src;
        pane.appendChild(img);
        if (src.cap) {
          var c = document.createElement('div');
          c.className = 'cap';
          c.style.left = '14px';
          c.textContent = src.cap;
          pane.appendChild(c);
        }
        lb.appendChild(pane);
        panes.push(pane);
        natural.push({ w: img.naturalWidth || 1600, h: img.naturalHeight || 900 });
        img.addEventListener('load', function () {
          natural[panes.indexOf(pane)] = { w: img.naturalWidth, h: img.naturalHeight };
          layout();
        });
      });
      lb.classList.add('on');
      document.body.style.overflow = 'hidden';
      layout();
    }

    function close() { lb.classList.remove('on'); document.body.style.overflow = ''; }

    $('#lbclose').addEventListener('click', close);
    $('#lbreset').addEventListener('click', function () { zoom = 1; ox = 0; oy = 0; layout(); });
    lb.addEventListener('click', function (e) { if (e.target === lb) close(); });
    addEventListener('keydown', function (e) { if (e.key === 'Escape' && lb.classList.contains('on')) close(); });

    lb.addEventListener('wheel', function (e) {
      if (!lb.classList.contains('on')) return;
      e.preventDefault();
      var f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      zoom = Math.max(1, Math.min(12, zoom * f));
      if (zoom === 1) { ox = 0; oy = 0; }
      layout();
    }, { passive: false });

    var dragging = false, lx = 0, ly = 0;
    lb.addEventListener('pointerdown', function (e) {
      if (!e.target.closest('.pane')) return;
      dragging = true; lx = e.clientX; ly = e.clientY;
      e.target.closest('.pane').classList.add('drag');
    });
    lb.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      ox += e.clientX - lx; oy += e.clientY - ly; lx = e.clientX; ly = e.clientY;
      layout();
    });
    addEventListener('pointerup', function () {
      dragging = false;
      $$('.pane', lb).forEach(function (p) { p.classList.remove('drag'); });
    });

    $$('figure img').forEach(function (img) {
      img.addEventListener('click', function () {
        var group = img.closest('[data-pair]');
        if (group) {
          open($$('figure', group).map(function (f) {
            return { src: $('img', f).src, cap: (f.querySelector('figcaption') || {}).textContent || '' };
          }));
        } else {
          var cap = img.closest('figure') && img.closest('figure').querySelector('figcaption');
          open([{ src: img.src, cap: cap ? cap.textContent : '' }]);
        }
      });
    });
  }

  compose();
  spy();
})();
