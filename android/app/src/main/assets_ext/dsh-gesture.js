/*
 * dsh-gesture.js — 边栏跟手滑出 / 滑回（壳层注入，在 dsh-preset.js 之后）。
 *
 * 关键约束：
 * 1) Android 10+ 左边缘被系统返回手势占用，从 x=0 起手会被系统吃掉，
 *    所以不限定起手位置——在页面左半区横向右拖即可把抽屉拉出来。
 * 2) 抽屉由 React 按需挂载，未打开时 DOM 里没有节点：
 *    必须先点汉堡让它挂载，再用临时样式藏住，等节点出现后按手指位置摆好再显示。
 * 3) 松手按位移比例吸附，220ms 曲线收尾。
 */
(function () {
  'use strict';
  if (window.__dshGesture) return;
  window.__dshGesture = true;

  var SLOP = 4;
  var SETTLE = 0.32;
  var DUR = 260;

  var drawer = null, mask = null, width = 300;
  var phase = null;                 // 'arm' | 'drag'
  var dir = 0;                      // +1 打开，-1 关闭
  var startX = 0, startY = 0, cur = 0, pendingPx = 0;
  var suppressClick = false, raf = 0, hideTag = null, waiting = false;
  var sheet = null, sheetOverlay = null, sheetY = 0, sheetDy = 0;
  var side = 'l';                   // 抽屉贴哪边：'l' 左（右滑拉出）| 'r' 右（左滑拉出）

  function q() {
    drawer = document.querySelector('[class*="drawer-"]:not([class*="drawerMask"])');
    mask = document.querySelector('[class*="drawerMask"]');
    if (drawer) width = drawer.offsetWidth || width;
  }

  function hamburger() {
    var b = document.querySelector(
      'button[aria-label="打开边栏"], button[aria-label="Open sidebar"], button[aria-label="打开侧边栏"], button[aria-label="打开侧栏"]'
    );
    if (b) return b;
    // 兜底：左上角那颗按钮（不同语言 / 版本 aria-label 会变）
    var all = document.querySelectorAll('button');
    for (var i = 0; i < all.length; i++) {
      var r = all[i].getBoundingClientRect();
      if (r.left < 80 && r.top < 130 && r.width > 20 && r.height > 20) return all[i];
    }
    return null;
  }

  function drawerVisible() {
    q();
    if (!drawer) return false;
    var r = drawer.getBoundingClientRect();
    return r.width > 40 && r.left < window.innerWidth - 40;
  }

  function paint(px) {
    if (!drawer) return;
    cur = px;
    drawer.style.transition = 'none';   // 跟手阶段绝不带补间，否则手指走一步、面板才追一步
    drawer.style.willChange = 'transform';
    drawer.style.transform = 'translate3d(' + px.toFixed(2) + 'px,0,0)';
    if (mask) {
      var p = 1 - Math.abs(px) / width;
      if (p < 0) p = 0; else if (p > 1) p = 1;
      mask.style.willChange = 'opacity';
      mask.style.background = 'rgba(0,0,0,' + (0.26 * p).toFixed(3) + ')';
    }
  }

  // 抽屉改成右侧出：左滑从右边拉出聊天记录（0 = 完全展开，width = 完全收起）
  function anchorRight() {
    if (!drawer) return;
    drawer.style.left = 'auto';
    drawer.style.right = '0';
    // 右边滑出的面板：左侧圆角 + 投影，视觉上像浮在页面上而不是砌在边上
    drawer.style.borderRadius = '20px 0 0 20px';
    drawer.style.boxShadow = '-18px 0 36px rgba(0,0,0,.16)';
    drawer.style.overflow = 'hidden';
  }

  // 左侧滑出（用户要的默认方向：向右拖拉出聊天记录）
  function anchorLeft() {
    if (!drawer) return;
    drawer.style.right = 'auto';
    drawer.style.left = '0';
    drawer.style.borderRadius = '0 20px 20px 0';
    drawer.style.boxShadow = '18px 0 36px rgba(0,0,0,.16)';
    drawer.style.overflow = 'hidden';
  }

  function hiddenPx() { return side === 'l' ? -width : width; }

  function clearTag() {
    if (hideTag && hideTag.parentNode) hideTag.parentNode.removeChild(hideTag);
    hideTag = null;
  }

  function reset(keepDim) {
    if (drawer) {
      drawer.style.willChange = '';
      drawer.style.transform = '';
      drawer.style.transition = '';
    }
    if (mask) {
      mask.style.willChange = '';
      mask.style.transition = '';
      if (!keepDim) mask.style.background = '';
      else mask.style.background = 'rgba(0,0,0,0.26)';
    }
  }

  // 输入法是否弹起：visualViewport 被顶掉 140px 以上就认为是
  function keyboardOpen() {
    var vv = window.visualViewport;
    return !!(vv && window.innerHeight - vv.height > 140);
  }

  function haptic() {    try {
      if (window.DSHNative && window.DSHNative.haptic) window.DSHNative.haptic();
    } catch (e) {}
  }

  function settle(px, done) {
    if (!drawer) { if (done) done(); return; }
    drawer.style.transition = 'transform ' + DUR + 'ms cubic-bezier(.16,.84,.24,1)';
    if (mask) mask.style.transition = 'opacity ' + DUR + 'ms linear';
    paint(px);
    setTimeout(done, DUR + 10);
  }

  function closeByMask() {
    var m = mask;
    if (m) {
      try {
        m.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 380, clientY: 400 }));
      } catch (e) {}
    }
    setTimeout(function () { reset(); q(); }, 40);
  }

  // 点汉堡挂载抽屉，同时藏住，等节点出现后按 pendingPx 摆放
  function beginMount() {
    var b = hamburger();
    if (!b) return false;
    if (!hideTag) {
      hideTag = document.createElement('style');
      document.head.appendChild(hideTag);
    }
    hideTag.textContent = side === 'l'
      ? '[class*="drawer-"]:not([class*="drawerMask"]){opacity:0 !important;right:auto !important;left:0 !important}'
      : '[class*="drawer-"]:not([class*="drawerMask"]){opacity:0 !important;left:auto !important;right:0 !important}';
    b.click();
    if (waiting) return true;
    waiting = true;
    var tries = 0;
    (function wait() {
      q();
      if (drawer) {
        waiting = false;
        if (side === 'l') anchorLeft(); else anchorRight();
        drawer.style.transition = 'none';
        if (mask) mask.style.transition = 'none';
        paint(pendingPx);
        requestAnimationFrame(function () { requestAnimationFrame(clearTag); });
        return;
      }
      if (++tries > 40) {
        waiting = false;
        clearTag();
        // 兜底：节点没等到也让抽屉按原样留在打开状态，至少「滑了有反应」
        if (drawer) { drawer.style.transform = ''; drawer.style.transition = ''; }
        return;
      }
      requestAnimationFrame(wait);
    })();
    return true;
  }

  function inScrollableX(el) {
    while (el && el !== document.body) {
      if (el.tagName === 'PRE' || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return true;
      if (el.classList && (el.classList.contains('markdown-table-wrapper') || el.classList.contains('dshp-body'))) return true;
      var ov = getComputedStyle(el).overflowX;
      if ((ov === 'auto' || ov === 'scroll') && el.scrollWidth > el.clientWidth + 4) return true;
      el = el.parentElement;
    }
    return false;
  }

  function onStart(e) {
    if (e.touches.length !== 1) return;
    var target = e.target;
    // 预设面板：向下拖关闭（类似原生 bottom sheet）
    if (target && target.closest && target.closest('.dshp-overlay')) {
      if (target.closest('textarea, input, select, .dshp-body')) {
        var body = target.closest('.dshp-body');
        if (!body || body.scrollTop > 0) return;
      }
      var sh = document.querySelector('.dshp-overlay .dshp-sheet');
      if (!sh) return;
      sheet = sh;
      sheetOverlay = target.closest('.dshp-overlay');
      sheetY = e.touches[0].clientY;
      sheetDy = 0;
      phase = 'sheet';
      suppressClick = false;
      return;
    }
    if (inScrollableX(target)) return;
    var t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    cur = 0;
    pendingPx = 0;
    dir = 0;
    phase = 'arm';
    suppressClick = false;
  }

  function onMove(e) {
    if (phase === 'sheet') {
      if (e.touches.length !== 1) return;
      var sy = e.touches[0].clientY;
      var dy = sy - sheetY;
      // 往上拖是滚动内容，不是关面板：立刻放手，别 preventDefault 卡住滚动
      if (dy < -4) {
        if (sheet) { sheet.style.transition = ''; sheet.style.transform = ''; }
        if (sheetOverlay) { sheetOverlay.style.transition = ''; sheetOverlay.style.opacity = ''; }
        sheet = null; sheetOverlay = null; sheetDy = 0; phase = null;
        return;
      }
      if (dy < 0) dy = 0;
      sheetDy = dy;
      if (sheet) {
        sheet.style.transition = 'none';
        sheet.style.transform = 'translateY(' + dy.toFixed(1) + 'px)';
      }
      if (sheetOverlay) {
        sheetOverlay.style.transition = 'none';
        sheetOverlay.style.opacity = String(Math.max(0.15, 1 - dy / 460));
      }
      if (e.cancelable) e.preventDefault();
      return;
    }

    if (phase !== 'arm' && phase !== 'drag') return;
    if (e.touches.length !== 1) return;
    var t = e.touches[0];
    var dx = t.clientX - startX;
    var dy = t.clientY - startY;

    // 输入法开着时，下滑直接撤掉键盘（交给原生做收起动画，比硬改布局平滑）
    var editing = (function () {
      var a = document.activeElement;
      return !!(a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT'));
    })();
    if (phase === 'arm' && (keyboardOpen() || editing) && dy > 8 && Math.abs(dy) > Math.abs(dx)) {
      var ae = document.activeElement;
      try { if (ae && ae.blur) ae.blur(); } catch (err) {}
      try { if (window.DSHNative && window.DSHNative.hideKeyboard) window.DSHNative.hideKeyboard(); } catch (err2) {}
      phase = null;
      if (e.cancelable) e.preventDefault();
      return;
    }

    if (phase === 'arm') {
      if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
      if (Math.abs(dy) >= Math.abs(dx)) { phase = null; return; }
      var open = drawerVisible();
      if (!open) {
        // 向右拖 → 左侧抽屉（默认方向）；向左拖 → 右侧抽屉（保留）
        side = dx > 0 ? 'l' : 'r';
        dir = 1;
        pendingPx = hiddenPx() + dx;
        if (!beginMount()) { phase = null; return; }
      } else if ((side === 'l' && dx < 0) || (side === 'r' && dx > 0)) {
        dir = -1;
        q();
        if (side === 'l') anchorLeft(); else anchorRight();
      } else {
        phase = null;
        return;
      }
      phase = 'drag';
      suppressClick = true;
    }

    if (phase !== 'drag') return;

    var px;
    if (dir === 1) {
      px = hiddenPx() + dx;
      var hi = hiddenPx();
      px = hi < 0 ? Math.min(0, Math.max(hi, px)) : Math.min(hi, Math.max(0, px));
    } else {
      px = side === 'l' ? Math.min(0, Math.max(-width, dx)) : Math.max(0, Math.min(width, dx));
    }
    pendingPx = px;

    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(function () {
      raf = 0;
      if (!drawer) q();
      paint(pendingPx);
    });
    if (e.cancelable) e.preventDefault();
  }

  function onEnd() {
    if (phase === 'sheet') {
      phase = null;
      var dy = sheetDy;
      sheetDy = 0;
      var sh = sheet, ov = sheetOverlay;
      sheet = null;
      sheetOverlay = null;
      if (!sh) return;
      if (dy > 96) {
        sh.style.transition = 'transform 180ms ease-in';
        sh.style.transform = 'translateY(110%)';
        if (ov) {
          ov.style.transition = 'opacity 180ms linear';
          ov.style.opacity = '0';
        }
        suppressClick = true;
        setTimeout(function () {
          var x = document.querySelector('.dshp-overlay .dshp-x');
          if (x) x.click();
          setTimeout(function () {
            if (sh) { sh.style.transition = ''; sh.style.transform = ''; }
            if (ov) { ov.style.transition = ''; ov.style.opacity = ''; }
            suppressClick = false;
          }, 60);
        }, 170);
      } else {
        sh.style.transition = 'transform 200ms cubic-bezier(.22,.61,.36,1)';
        sh.style.transform = 'translateY(0)';
        if (ov) {
          ov.style.transition = 'opacity 200ms linear';
          ov.style.opacity = '1';
        }
        setTimeout(function () {
          if (sh) { sh.style.transition = ''; sh.style.transform = ''; }
          if (ov) { ov.style.transition = ''; ov.style.opacity = ''; }
        }, 220);
      }
      return;
    }

    if (phase !== 'drag') { phase = null; return; }
    phase = null;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (!drawer) q();

    var p = drawer ? 1 - Math.abs(cur) / width : 0;
    var hid = hiddenPx();

    if (dir === 1) {
      if (p >= SETTLE) {
        settle(0, function () { reset(true); haptic(); });
      } else {
        settle(hid, closeByMask);
      }
    } else {
      if (p <= 1 - SETTLE) {
        settle(hid, closeByMask);
      } else {
        settle(0, function () { reset(true); haptic(); });
      }
    }
    dir = 0;
    setTimeout(function () { suppressClick = false; }, 60);
  }

  document.addEventListener('click', function (e) {
    if (!suppressClick) return;
    suppressClick = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);

  document.addEventListener('touchstart', onStart, { passive: true, capture: true });
  document.addEventListener('touchmove', onMove, { passive: false, capture: true });
  document.addEventListener('touchend', onEnd, { passive: true, capture: true });
  document.addEventListener('touchcancel', onEnd, { passive: true, capture: true });

  window.__dshGestureDebug = function () {
    return JSON.stringify({ phase: phase, dir: dir, cur: cur, width: width, hasDrawer: !!drawer });
  };
})();
