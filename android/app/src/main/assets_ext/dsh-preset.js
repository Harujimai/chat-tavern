/*
 * dsh-preset.js — 壳层注入的「角色预设 / 参数控制」扩展
 *
 * 不修改 vendor bundle 一行代码：
 *   1) 劫持 window.fetch，对 POST /anthropic/v1/messages 的 JSON body 追加
 *      system / temperature / top_p / max_tokens，并按轮数或 token 预算裁剪 messages。
 *   2) 在页面里挂一个悬浮入口 + 底部抽屉面板（与应用同款视觉），参数即改即生效。
 *
 * 存储（localStorage，与应用同前缀便于一起导出）：
 *   chat-demo:presets       [ {name, system, temperature, topP, maxTokens, historyTurns, budgetTokens, replaceSystem} ]
 *   chat-demo:preset-active 当前预设下标
 */
(function () {
  'use strict';
  if (window.__dshPresetReady) {
    try { window.__dshPresetOpen && window.__dshPresetOpen(); } catch (e) {}
    return;
  }
  window.__dshPresetReady = 1;

  var STORE = 'chat-demo:presets';
  var ACTIVE = 'chat-demo:preset-active';
  var API_RE = /\/anthropic\/v1\/messages/;

  function defaults() {
    return {
      name: '默认',
      system: '',
      temperature: '',
      topP: '',
      maxTokens: '',
      historyTurns: '',
      budgetTokens: '',
      replaceSystem: false
    };
  }

  function readPresets() {
    try {
      var raw = localStorage.getItem(STORE);
      var arr = raw ? JSON.parse(raw) : null;
      if (!arr || !arr.length) return [defaults()];
      return arr.map(function (p) {
        var d = defaults();
        for (var k in d) if (!(k in p)) p[k] = d[k];
        return p;
      });
    } catch (e) {
      return [defaults()];
    }
  }

  function writePresets(arr) {
    try { localStorage.setItem(STORE, JSON.stringify(arr)); } catch (e) {}
  }

  function activeIndex(arr) {
    var i = parseInt(localStorage.getItem(ACTIVE) || '0', 10);
    if (!(i >= 0 && i < arr.length)) i = 0;
    return i;
  }

  function activePreset() {
    var arr = readPresets();
    return arr[activeIndex(arr)];
  }

  /* ---------- 请求改写 ---------- */

  function approxTokens(text) {
    if (!text) return 0;
    var cjk = (text.match(/[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
    var rest = text.length - cjk;
    return Math.ceil(cjk / 1.6 + rest / 3.6);
  }

  function blockText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map(function (b) {
        if (!b) return '';
        if (typeof b.text === 'string') return b.text;
        return '';
      }).join(' ');
    }
    return '';
  }

  function trimByBudget(messages, budget) {
    if (!budget) return messages;
    var kept = [];
    var used = 0;
    for (var i = messages.length - 1; i >= 0; i--) {
      var m = messages[i];
      var t = approxTokens(blockText(m && m.content)) + 4;
      if (used + t > budget && kept.length) break;
      used += t;
      kept.unshift(m);
    }
    while (kept.length > 1 && kept[0].role !== 'user') kept.shift();
    return kept;
  }

  function trimByTurns(messages, turns) {
    if (!turns) return messages;
    var keep = turns * 2;
    if (messages.length <= keep) return messages;
    var cut = messages.slice(-keep);
    while (cut.length > 1 && cut[0].role !== 'user') cut.shift();
    return cut;
  }

  function applyPreset(body, p) {
    var applied = { systemChars: 0, temperature: null, top_p: null, max_tokens: null, messagesBefore: 0, messagesAfter: 0 };

    var userSystem = (p.system || '').trim();
    if (userSystem) {
      var base = typeof body.system === 'string' ? body.system : blockText(body.system);
      if (p.replaceSystem || !base) {
        body.system = userSystem;
        applied.systemReplaced = true;
      } else {
        body.system = base + '\n\n' + userSystem;
      }
      applied.systemChars = body.system.length;
    }

    if (p.temperature !== '' && p.temperature != null && !isNaN(Number(p.temperature))) {
      body.temperature = Number(p.temperature);
      applied.temperature = body.temperature;
    }
    if (p.topP !== '' && p.topP != null && !isNaN(Number(p.topP))) {
      body.top_p = Number(p.topP);
      applied.top_p = body.top_p;
    }
    if (p.maxTokens !== '' && p.maxTokens != null && Number(p.maxTokens) > 0) {
      body.max_tokens = Math.round(Number(p.maxTokens));
      applied.max_tokens = body.max_tokens;
    }

    if (Array.isArray(body.messages)) {
      applied.messagesBefore = body.messages.length;
      var msgs = trimByTurns(body.messages, Number(p.historyTurns) || 0);
      msgs = trimByBudget(msgs, Number(p.budgetTokens) || 0);
      body.messages = msgs;
      applied.messagesAfter = msgs.length;
    }
    return applied;
  }

  if (!window.__dshFetchHooked) {
    window.__dshFetchHooked = 1;
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (API_RE.test(url) && init && typeof init.body === 'string') {
          var p = activePreset();
          var body = JSON.parse(init.body);
          var applied = applyPreset(body, p);
          init = Object.assign({}, init, { body: JSON.stringify(body) });
          applied.preset = p.name;
          console.log('[dsh-preset] applied ' + JSON.stringify(applied));
        }
      } catch (e) {
        console.log('[dsh-preset] hook error ' + (e && e.message));
      }
      return origFetch.call(this, input, init);
    };
  }

  /* ---------- 视觉 ---------- */

  var css = ''
    + ':root{--dshp-accent:#3964fe}'
    + '.dshp-fab{position:fixed;right:0;top:52%;z-index:1500;width:30px;height:78px;'
    + 'border-radius:15px 0 0 15px;display:flex;flex-direction:column;align-items:center;justify-content:center;'
    + 'border:0;background:linear-gradient(180deg,#4f76ff,#3358f0);box-shadow:-2px 2px 14px rgba(57,100,254,.38);'
    + 'color:#fff;gap:3px;transform:translateY(-50%);transition:transform .18s ease,opacity .18s ease}'
    + '.dshp-fab:active{transform:translateY(-50%) scale(.94)}'
    + '.dshp-fab svg{width:15px;height:15px;display:block}'
    + '.dshp-fab span{writing-mode:vertical-rl;font-size:11px;line-height:1;letter-spacing:1px;opacity:.95}'
    + '.dshp-fab.dshp-dark{background:linear-gradient(180deg,#4f76ff,#3358f0);color:#fff}'
    + '.dshp-fab.dshp-hide{opacity:0;pointer-events:none;transform:translateY(-50%) translateX(34px)}'
    + '.dshp-bubble{position:fixed;right:38px;top:52%;transform:translateY(-50%);z-index:1600;'
    + 'background:#1c1c1f;color:#fff;font-size:13px;line-height:1.45;padding:10px 13px;border-radius:12px;'
    + 'box-shadow:0 6px 20px rgba(0,0,0,.28);max-width:196px;opacity:0;transition:opacity .25s ease}'
    + '.dshp-bubble.dshp-on{opacity:1}'
    + '.dshp-bubble:after{content:"";position:absolute;right:-5px;top:50%;margin-top:-5px;width:10px;height:10px;'
    + 'background:#1c1c1f;transform:rotate(45deg)}'
    + '.dshp-card{display:flex;align-items:center;gap:10px;padding:12px 0;border-bottom:1px solid var(--dshp-line)}'
    + '.dshp-avatar{width:42px;height:42px;border-radius:12px;object-fit:cover;flex:0 0 auto;'
    + 'border:1px solid var(--dshp-line);background:var(--dshp-chip)}'
    + '.dshp-overlay{position:fixed;inset:0;z-index:1800;background:rgba(0,0,0,.36);display:flex;'
    + 'align-items:flex-end;justify-content:center;opacity:0;transition:opacity .18s ease}'
    + '.dshp-overlay.dshp-in{opacity:1}'
    + '.dshp-sheet{width:100%;max-width:560px;max-height:88vh;display:flex;flex-direction:column;'
    + 'background:var(--dshp-bg);color:var(--dshp-fg);border-radius:24px 24px 0 0;'
    + 'box-shadow:0 -8px 30px rgba(0,0,0,.18);transform:translateY(18px);transition:transform .2s ease;'
    + 'font-family:inherit;font-size:15px;line-height:1.5}'
    + '.dshp-overlay.dshp-in .dshp-sheet{transform:translateY(0)}'
    + '.dshp-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px 10px;'
    + 'border-bottom:1px solid var(--dshp-line)}'
    + '.dshp-title{font-size:17px;font-weight:600}'
    + '.dshp-x{width:32px;height:32px;border-radius:16px;display:flex;align-items:center;justify-content:center;'
    + 'color:var(--dshp-muted);font-size:20px;line-height:1;background:transparent;border:0}'
    + '.dshp-x:active{background:var(--dshp-chip)}'
    + '.dshp-body{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:6px 18px 14px}'
    + '.dshp-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 0;'
    + 'border-bottom:1px solid var(--dshp-line)}'
    + '.dshp-row:last-child{border-bottom:0}'
    + '.dshp-label{font-size:14px;color:var(--dshp-fg)}'
    + '.dshp-hint{font-size:12px;color:var(--dshp-muted);margin-top:2px}'
    + '.dshp-val{font-size:13px;color:var(--dshp-accent);font-variant-numeric:tabular-nums;min-width:44px;text-align:right}'
    + '.dshp-input,.dshp-select,.dshp-area{width:100%;box-sizing:border-box;border:1px solid var(--dshp-line);'
    + 'background:var(--dshp-chip);color:var(--dshp-fg);border-radius:12px;padding:10px 12px;font-size:14px;'
    + 'font-family:inherit;outline:none;-webkit-appearance:none;appearance:none}'
    + '.dshp-area{min-height:104px;resize:vertical;line-height:1.55}'
    + '.dshp-input:focus,.dshp-area:focus,.dshp-select:focus{border-color:var(--dshp-accent)}'
    + '.dshp-select{background-image:none}'
    + '.dshp-num{width:96px;text-align:right}'
    + '.dshp-range{width:100%;margin:8px 0 0;-webkit-appearance:none;height:22px;background:transparent}'
    + '.dshp-range::-webkit-slider-runnable-track{height:4px;border-radius:2px;background:var(--dshp-line)}'
    + '.dshp-range::-webkit-slider-thumb{-webkit-appearance:none;width:20px;height:20px;border-radius:10px;'
    + 'background:var(--dshp-accent);margin-top:-8px;box-shadow:0 1px 4px rgba(57,100,254,.4)}'
    + '.dshp-btn{border:1px solid var(--dshp-line);background:var(--dshp-chip);color:var(--dshp-fg);'
    + 'border-radius:12px;padding:9px 14px;font-size:14px;font-family:inherit}'
    + '.dshp-btn:active{filter:brightness(.94)}'
    + '.dshp-btn.dshp-primary{background:var(--dshp-accent);border-color:var(--dshp-accent);color:#fff;font-weight:500}'
    + '.dshp-btn.dshp-danger{color:#e5484d;border-color:rgba(229,72,77,.5)}'
    + '.dshp-foot{display:flex;gap:10px;padding:12px 18px calc(14px + env(safe-area-inset-bottom));'
    + 'border-top:1px solid var(--dshp-line)}'
    + '.dshp-foot .dshp-btn{flex:1;padding:12px 0;text-align:center;font-size:15px}'
    + '.dshp-sec{padding:14px 0 4px;font-size:13px;color:var(--dshp-muted);letter-spacing:.02em}'
    + '.dshp-field{padding:8px 0 0}'
    + '.dshp-inline{display:flex;gap:10px;padding:10px 0 14px;border-bottom:1px solid var(--dshp-line)}'
    + '.dshp-inline .dshp-btn{flex:1;padding:10px 0;text-align:center}'
    + '.dshp-switch{position:relative;width:46px;height:28px;flex:0 0 auto;border-radius:14px;'
    + 'background:var(--dshp-line);transition:background .16s ease}'
    + '.dshp-switch.on{background:var(--dshp-accent)}'
    + '.dshp-switch i{position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:11px;background:#fff;'
    + 'transition:transform .16s ease;box-shadow:0 1px 3px rgba(0,0,0,.2)}'
    + '.dshp-switch.on i{transform:translateX(18px)}'
    + '.dshp-toast{position:fixed;left:50%;bottom:88px;transform:translateX(-50%);z-index:1900;'
    + 'background:rgba(20,20,22,.9);color:#fff;font-size:13px;padding:8px 14px;border-radius:10px;'
    + 'opacity:0;transition:opacity .18s ease;pointer-events:none}'
    + '@media (hover:none){button:active,[role="button"]:active{filter:brightness(.96)}}';

  function isDark() {
    var b = document.body, e = document.documentElement;
    function hit(n) { return !!n && (n.classList.contains('dark') || n.hasAttribute('data-ds-dark-theme')); }
    return hit(b) || hit(e);
  }

  function palette() {
    return isDark()
      ? { bg: '#151517', fg: '#e9e9ec', muted: '#9aa0a8', line: '#2b2b30', chip: '#202024' }
      : { bg: '#ffffff', fg: '#1a1a1c', muted: '#8a8f98', line: '#edeef1', chip: '#f4f5f7' };
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  var toastTimer = null;
  function toast(msg) {
    var t = document.getElementById('dshp-toast');
    if (!t) {
      t = el('div', 'dshp-toast');
      t.id = 'dshp-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.style.opacity = '0'; }, 1600);
    try { window.DSHNative && window.DSHNative.haptic(); } catch (e) {}
  }

  function buildFab() {
    var fab = el('div', 'dshp-fab');
    fab.id = 'dshp-fab';
    fab.setAttribute('role', 'button');
    fab.setAttribute('aria-label', '角色预设与参数');
    fab.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/>'
      + '<circle cx="16" cy="7" r="2.1"/><circle cx="10" cy="17" r="2.1"/></svg><span>预设</span>';
    fab.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      hideBubble();
      openPanel();
    });
    document.body.appendChild(fab);
    maybeShowBubble();
    return fab;
  }

  /** 首次进入提示一次，免得这个入口太隐蔽没人发现。 */
  function maybeShowBubble() {
    try {
      if (localStorage.getItem('chat-demo:preset-hint') === '1') return;
    } catch (e) { return; }
    var h = el('div', 'dshp-bubble', '点这里设置角色预设、系统提示词与温度');
    h.id = 'dshp-bubble';
    document.body.appendChild(h);
    requestAnimationFrame(function () { h.classList.add('dshp-on'); });
    setTimeout(function () { hideBubble(true); }, 9000);
  }

  function hideBubble(remember) {
    var h = document.getElementById('dshp-bubble');
    if (h) {
      h.classList.remove('dshp-on');
      setTimeout(function () { if (h.parentNode) h.parentNode.removeChild(h); }, 260);
    }
    if (remember) {
      try { localStorage.setItem('chat-demo:preset-hint', '1'); } catch (e) {}
    }
  }

  function refreshFabTheme() {
    var fab = document.getElementById('dshp-fab');
    if (!fab) return;
    if (isDark()) fab.classList.add('dshp-dark'); else fab.classList.remove('dshp-dark');
    var appOverlay = false;
    try {
      var cands = document.querySelectorAll('[class*="overlay-"],[class*="drawer-"]');
      for (var i = 0; i < cands.length; i++) {
        var s = getComputedStyle(cands[i]);
        if (s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0.01
          && cands[i].getBoundingClientRect().width > 40) { appOverlay = true; break; }
      }
    } catch (e) {}
    if (appOverlay) fab.classList.add('dshp-hide'); else fab.classList.remove('dshp-hide');
  }

  var panel = null;
  var editing = null;

  function numStr(v) { return (v === '' || v == null) ? '' : String(v); }

  /* ---------- 酒馆 PNG 角色卡 ---------- */
  /* 解析全部交给上游库（SillyTavern 同款）：png-chunks-extract 负责切块 + CRC 校验，
     png-chunk-text 负责 tEXt 关键字解码。压缩型 zTXt / iTXt 上游不处理，
     这里补一段：用浏览器自带的 DecompressionStream 解压，不再自己写 inflate。 */

  function b64bytes(b64) {
    var bin = atob(String(b64).replace(/\s+/g, ''));
    var u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }

  function inflate(u8) {
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error('当前 WebView 不支持解压'));
    }
    var s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Response(s).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }

  function utf8(u8) { return new TextDecoder('utf-8').decode(u8); }

  /** zTXt / iTXt：拆出关键字与正文，正文按压缩标志决定要不要 inflate。 */
  function splitTextChunk(kind, d) {
    var z = -1;
    for (var i = 0; i < d.length; i++) { if (d[i] === 0) { z = i; break; } }
    if (z <= 0) return null;
    var keyword = '';
    for (var j = 0; j < z; j++) keyword += String.fromCharCode(d[j]);
    var rest = d.subarray(z + 1);
    if (kind === 'zTXt') {
      return {
        keyword: keyword,
        text: function () { return inflate(rest.subarray(1)).then(utf8); }
      };
    }
    // iTXt: compFlag, compMethod, lang\0, translated\0, text
    var flag = rest[0], p = 2;
    while (p < rest.length && rest[p] !== 0) p++;
    p++;
    while (p < rest.length && rest[p] !== 0) p++;
    p++;
    var body = rest.subarray(p);
    return {
      keyword: keyword,
      text: function () {
        return flag === 1 ? inflate(body).then(utf8) : Promise.resolve(utf8(body));
      }
    };
  }

  /** 从 PNG 原始字节里取角色卡 JSON 文本；优先级 ccv3 > chara > character（与上游一致）。 */
  function readCardText(buf) {
    return new Promise(function (resolve, reject) {
      var lib = window.DSHCardLib;
      if (!lib || !lib.extract || !lib.decode) {
        reject(new Error('角色卡组件未加载（dsh-cardlib.js）'));
        return;
      }
      var chunks;
      try {
        chunks = lib.extract(new Uint8Array(buf));
      } catch (e) {
        reject(new Error('不是有效的 PNG：' + ((e && e.message) || '')));
        return;
      }
      var found = {};
      chunks.forEach(function (c) {
        if (c.name !== 'tEXt' && c.name !== 'zTXt' && c.name !== 'iTXt') return;
        if (c.name === 'tEXt') {
          var t = lib.decode(c);
          found[String(t.keyword || '').toLowerCase()] = Promise.resolve(t.text);
        } else {
          var parsed = splitTextChunk(c.name, c.data);
          if (parsed) found[parsed.keyword.toLowerCase()] = parsed.text();
        }
      });
      var order = ['ccv3', 'chara', 'character'];
      for (var i = 0; i < order.length; i++) {
        var key = order[i];
        if (found[key]) {
          found[key].then(function (t) { resolve({ text: t, key: key }); }, reject);
          return;
        }
      }
      reject(new Error('这张图里没有角色卡元数据（chara / ccv3）'));
    });
  }


  function cardToPreset(card, fileName) {
    card = card || {};
    var p = defaults();
    p.name = (card.name || card.char_name || '导入的角色').toString().slice(0, 40);
    var parts = [];
    function add(label, v) {
      if (typeof v === 'string' && v.trim()) parts.push('【' + label + '】\n' + v.trim());
    }
    add('角色设定', card.description);
    add('性格', card.personality);
    add('场景', card.scenario);
    add('对话示例', card.mes_example || card.example_dialogue);
    add('额外要求', card.system_prompt);
    add('后置指令', card.post_history_instructions);
    if (!parts.length && typeof card.first_mes === 'string' && card.first_mes.trim()) {
      parts.push('【开场白】\n' + card.first_mes.trim());
    }
    p.system = parts.join('\n\n');
    if (card.temperature != null && !isNaN(Number(card.temperature))) p.temperature = String(card.temperature);
    if (card.top_p != null && !isNaN(Number(card.top_p))) p.topP = String(card.top_p);
    if (card.max_tokens != null && Number(card.max_tokens) > 0) p.maxTokens = String(Math.round(Number(card.max_tokens)));
    // 角色卡本身就是人设，默认替换 DeepSeek 内置的「该助手为DeepSeek」前缀，否则会打架
    p.replaceSystem = true;
    p.source = fileName || '';
    return p;
  }

  function importCardFile(file, cb) {
    var reader = new FileReader();
    reader.onerror = function () { cb('读取文件失败'); };
    reader.onload = function () {
      try {
        var buf = reader.result;
        if (/\.json$/i.test(file.name) || file.type === 'application/json') {
          var txt = utf8(new Uint8Array(buf));
          var obj = JSON.parse(txt);
          cb(null, cardToPreset(obj && obj.data ? obj.data : obj, file.name), file.name);
          return;
        }
        readCardText(buf).then(function (res) {
          var raw = String(res.text).trim();
          // 绝大多数卡是 base64，少数直接塞 JSON，两种都认
          var jsonText = raw.charAt(0) === '{' ? raw : utf8(b64bytes(raw));
          var json = JSON.parse(jsonText);
          var card = json && json.data ? json.data : json;
          cb(null, cardToPreset(card, file.name), res.key);
        }).catch(function (e) {
          cb(((e && e.message) || '角色卡解析失败'));
        });
      } catch (e) {
        cb('解析失败：' + ((e && e.message) || ''));
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function openPanel() {
    if (panel) return;
    var arr = readPresets();
    var idx = activeIndex(arr);
    editing = JSON.parse(JSON.stringify(arr[idx]));

    var pal = palette();
    var overlay = el('div', 'dshp-overlay dshp-preset-overlay-main');
    overlay.style.setProperty('--dshp-bg', pal.bg);
    overlay.style.setProperty('--dshp-fg', pal.fg);
    overlay.style.setProperty('--dshp-muted', pal.muted);
    overlay.style.setProperty('--dshp-line', pal.line);
    overlay.style.setProperty('--dshp-chip', pal.chip);

    var sheet = el('div', 'dshp-sheet');

    /* 头部 */
    var head = el('div', 'dshp-head');
    head.appendChild(el('div', 'dshp-title', '角色预设与参数'));
    var close = el('button', 'dshp-x', '✕');
    close.addEventListener('click', closePanel);
    head.appendChild(close);
    sheet.appendChild(head);

    var body = el('div', 'dshp-body');

    /* 预设选择 */
    body.appendChild(el('div', 'dshp-sec', '预设'));
    var sel = el('select', 'dshp-select');
    arr.forEach(function (p, i) {
      var o = el('option', null, p.name || ('预设 ' + (i + 1)));
      o.value = String(i);
      if (i === idx) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () {
      var i = parseInt(sel.value, 10) || 0;
      try { localStorage.setItem(ACTIVE, String(i)); } catch (e) {}
      editing = JSON.parse(JSON.stringify(readPresets()[i]));
      panel.remove();
      panel = null;
      openPanel();
      toast('已切换到「' + (editing.name || '未命名') + '」');
    });
    body.appendChild(sel);

    var nameLabel = el('div', 'dshp-hint', '名称');
    nameLabel.style.marginTop = '12px';
    body.appendChild(nameLabel);
    var nameInput = el('input', 'dshp-input');
    nameInput.type = 'text';
    nameInput.value = editing.name || '';
    nameInput.placeholder = '预设名称，例如：翻译 / 代码审查';
    nameInput.style.marginTop = '10px';
    nameInput.addEventListener('input', function () { editing.name = nameInput.value; });
    body.appendChild(nameInput);

    var inline = el('div', 'dshp-inline');
    var btnNew = el('button', 'dshp-btn', '新建预设');
    btnNew.addEventListener('click', function () {
      commit(true);
      var list = readPresets();
      var fresh = defaults();
      fresh.name = '预设 ' + (list.length + 1);
      list.push(fresh);
      writePresets(list);
      try { localStorage.setItem(ACTIVE, String(list.length - 1)); } catch (e) {}
      panel.remove(); panel = null; openPanel();
      toast('已新建');
    });
    var btnDel = el('button', 'dshp-btn dshp-danger', '删除当前');
    btnDel.addEventListener('click', function () {
      if (arr.length <= 1) { toast('至少保留一个预设'); return; }
      var cur = activeIndex(arr);
      arr.splice(cur, 1);
      writePresets(arr);
      try { localStorage.setItem(ACTIVE, '0'); } catch (e) {}
      panel.remove(); panel = null; openPanel();
      toast('已删除');
    });
    inline.appendChild(btnNew);
    inline.appendChild(btnDel);
    body.appendChild(inline);

    /* 角色卡导入（酒馆 / SillyTavern 的 PNG 角色卡） */
    body.appendChild(el('div', 'dshp-sec', '角色卡'));
    var cardRow = el('div', 'dshp-card');
    var cardText = el('div');
    cardText.style.flex = '1';
    cardText.appendChild(el('div', 'dshp-label', '从相册导入角色卡'));
    cardText.appendChild(el('div', 'dshp-hint',
      '直接读 PNG 里的 chara / ccv3 元数据，不转码、不重新编码，原图信息一行不动'));
    cardRow.appendChild(cardText);

    var fileInput = el('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/png,image/jpeg,image/webp,application/json,.png,.json';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', function () {
      var f = fileInput.files && fileInput.files[0];
      if (!f) return;
      importCardFile(f, function (err, preset, info) {
        fileInput.value = '';
        if (err) { toast(err); return; }
        commit(true);
        var list = readPresets();
        list.push(preset);
        writePresets(list);
        try { localStorage.setItem(ACTIVE, String(list.length - 1)); } catch (e) {}
        if (panel) { panel.remove(); panel = null; }
        openPanel();
        toast('已导入「' + preset.name + '」' + (info ? '（' + info + '）' : ''));
      });
    });

    var btnImport = el('button', 'dshp-btn dshp-primary', '选择图片');
    btnImport.addEventListener('click', function () { fileInput.click(); });
    cardRow.appendChild(btnImport);
    body.appendChild(cardRow);
    body.appendChild(fileInput);

    /* 系统提示词 */
    var secSys = el('div', 'dshp-sec', '系统提示词');
    body.appendChild(secSys);
    var area = el('textarea', 'dshp-area');
    area.placeholder = '写在这里的内容会追加到应用内置 system 之后（或按下方开关替换）';
    area.value = editing.system || '';
    area.addEventListener('input', function () { editing.system = area.value; });
    body.appendChild(area);

    var rowReplace = el('div', 'dshp-row');
    var rl = el('div');
    rl.appendChild(el('div', 'dshp-label', '替换内置系统提示词'));
    rl.appendChild(el('div', 'dshp-hint', '关闭＝追加，开启＝完全替换 DeepSeek 内置人设'));
    rowReplace.appendChild(rl);
    var swReplace = el('div', 'dshp-switch' + (editing.replaceSystem ? ' on' : ''));
    swReplace.appendChild(el('i'));
    swReplace.addEventListener('click', function () {
      editing.replaceSystem = !editing.replaceSystem;
      swReplace.classList.toggle('on', editing.replaceSystem);
    });
    rowReplace.appendChild(swReplace);
    body.appendChild(rowReplace);

    /* 参数 */
    body.appendChild(el('div', 'dshp-sec', '采样参数'));

    function sliderRow(label, hint, min, max, step, key, fmt, emptyZero) {
      var row = el('div', 'dshp-row');
      var left = el('div');
      left.style.flex = '1';
      left.appendChild(el('div', 'dshp-label', label));
      left.appendChild(el('div', 'dshp-hint', hint));
      var range = el('input', 'dshp-range');
      range.type = 'range';
      range.min = String(min);
      range.max = String(max);
      range.step = String(step);
      var val = el('div', 'dshp-val');
      function paint() {
        var v = editing[key];
        var show = (v === '' || v == null) ? '' : fmt(v);
        val.textContent = show === '' ? '默认' : show;
        range.value = String((v === '' || v == null) ? emptyZero : v);
      }
      range.addEventListener('input', function () {
        editing[key] = range.value;
        paint();
      });
      paint();
      left.appendChild(range);
      row.appendChild(left);
      row.appendChild(val);
      body.appendChild(row);
      return row;
    }

    sliderRow('温度 temperature', '越高越发散，越低越稳定', 0, 2, 0.1, 'temperature',
      function (v) { return Number(v).toFixed(1); }, 1.0);
    sliderRow('top_p', '核采样阈值，与温度二选一即可', 0, 1, 0.05, 'topP',
      function (v) { return Number(v).toFixed(2); }, 1.0);

    /* 数值输入 */
    function numRow(label, hint, key, placeholder) {
      var row = el('div', 'dshp-row');
      var left = el('div');
      left.appendChild(el('div', 'dshp-label', label));
      left.appendChild(el('div', 'dshp-hint', hint));
      row.appendChild(left);
      var inp = el('input', 'dshp-input dshp-num');
      inp.type = 'number';
      inp.inputMode = 'numeric';
      inp.value = numStr(editing[key]);
      inp.placeholder = placeholder || '默认';
      inp.addEventListener('input', function () { editing[key] = inp.value; });
      row.appendChild(inp);
      body.appendChild(row);
      return row;
    }

    body.appendChild(el('div', 'dshp-sec', '上下文控制'));
    numRow('最大回复 tokens', 'max_tokens，留空＝应用默认', 'maxTokens', '默认');
    numRow('历史轮数', '只发最近 N 轮，0 或空＝全部', 'historyTurns', '全部');
    numRow('上下文预算', '按估算 token 上限裁剪历史，留空＝不限', 'budgetTokens', '不限');

    var footInfo = el('div', 'dshp-hint');
    footInfo.style.padding = '14px 0 4px';
    var ver = '';
    try { ver = (window.DSHNative && window.DSHNative.version) ? window.DSHNative.version() : ''; } catch (e) {}
    footInfo.textContent = '参数在每次发送时读取，改完直接返回聊天即可生效。仅影响本机发出的请求。'
      + (ver ? '  ·  v' + ver : '');
    body.appendChild(footInfo);

    sheet.appendChild(body);

    /* 底部按钮 */
    var foot = el('div', 'dshp-foot');
    var btnReset = el('button', 'dshp-btn', '重置本预设');
    btnReset.addEventListener('click', function () {
      var keepName = editing.name;
      editing = defaults();
      editing.name = keepName;
      commit(false);
      panel.remove(); panel = null; openPanel();
      toast('已重置');
    });
    var btnSave = el('button', 'dshp-btn dshp-primary', '保存');
    btnSave.addEventListener('click', function () {
      commit(true);
      toast('已保存并生效');
      closePanel();
    });
    foot.appendChild(btnReset);
    foot.appendChild(btnSave);
    sheet.appendChild(foot);

    overlay.appendChild(sheet);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closePanel();
    });
    document.body.appendChild(overlay);
    panel = overlay;
    requestAnimationFrame(function () { overlay.classList.add('dshp-in'); });
    document.addEventListener('keydown', onKeydown, true);
  }

  function onKeydown(e) {
    if (e.key === 'Escape' && panel) {
      e.stopPropagation();
      closePanel();
    }
  }

  function commit(notify) {
    if (!editing) return;
    var arr = readPresets();
    var idx = activeIndex(arr);
    arr[idx] = editing;
    writePresets(arr);
    if (notify) console.log('[dsh-preset] saved ' + JSON.stringify(editing));
  }

  function closePanel() {
    if (!panel) return;
    var p = panel;
    panel = null;
    document.removeEventListener('keydown', onKeydown, true);
    p.classList.remove('dshp-in');
    setTimeout(function () { if (p.parentNode) p.parentNode.removeChild(p); }, 200);
  }

  window.__dshPresetOpen = openPanel;
  window.__dshPresetClose = closePanel;

  function mount() {
    if (!document.body) return;
    if (!document.getElementById('dshp-style')) {
      var st = document.createElement('style');
      st.id = 'dshp-style';
      st.textContent = css;
      document.head.appendChild(st);
    }
    if (!document.getElementById('dshp-fab')) buildFab();
    refreshFabTheme();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
  setInterval(refreshFabTheme, 800);
})();
