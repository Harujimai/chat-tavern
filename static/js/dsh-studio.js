/*
 * dsh-studio.js — Chat Tavern「角色预设」界面
 *
 * 不修改 vendor bundle：
 *   1) 侧边栏注入「角色预设」入口（克隆原生设置行，视觉一致），设置弹窗内也加一个 tab。
 *   2) 全屏 Studio：角色列表 + 系统提示词 + 温度 / Top P / max_tokens / 上下文轮数与预算。
 *   3) 劫持 window.fetch，对 POST /anthropic/v1/messages 真实改写请求。
 *   4) 酒馆 PNG 角色卡导入（复用 dsh-cardlib.js），同时支持角色卡 JSON。
 *
 * 存储与应用同前缀（与旧壳层注入版兼容）：
 *   chat-tavern:presets       [{name, system, temperature, topP, maxTokens, historyTurns, budgetTokens, replaceSystem, source, avatar}]
 *   chat-tavern:preset-active 当前预设下标
 */
(function () {
  'use strict';

  if (window.__dshStudioReady) {
    try { window.__dshStudioOpen && window.__dshStudioOpen(); } catch (e) {}
    return;
  }
  window.__dshStudioReady = 1;

  var STORE = 'chat-tavern:presets';
  var ACTIVE = 'chat-tavern:preset-active';
  /* 更名前的本地预设，只迁移一次。 */
  try {
    if (!localStorage.getItem(STORE)) {
      var legacyPresets = localStorage.getItem('chat-demo:presets');
      if (legacyPresets) localStorage.setItem(STORE, legacyPresets);
      var legacyActive = localStorage.getItem('chat-demo:preset-active');
      if (legacyActive) localStorage.setItem(ACTIVE, legacyActive);
    }
  } catch (e) {}
  var API_RE = /\/anthropic\/v1\/messages/;

  /* ================================================================
   * 数据
   * ================================================================ */

  function defaults(over) {
    var d = {
      name: '默认',
      system: '',
      temperature: '',
      topP: '',
      maxTokens: '',
      historyTurns: '',
      budgetTokens: '',
      replaceSystem: false,
      source: '',
      avatar: ''
    };
    if (over) for (var k in over) d[k] = over[k];
    return d;
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function normStr(v) {
    if (v == null) return '';
    return String(v);
  }

  function readPresets() {
    try {
      var raw = localStorage.getItem(STORE);
      var arr = raw ? JSON.parse(raw) : null;
      if (!arr || !arr.length) return [defaults()];
      return arr.map(function (p) {
        p = p || {};
        var d = defaults();
        for (var k in d) if (!(k in p)) p[k] = d[k];
        p.name = normStr(p.name) || '未命名';
        p.system = normStr(p.system);
        p.source = normStr(p.source);
        p.avatar = normStr(p.avatar);
        ['temperature', 'topP', 'maxTokens', 'historyTurns', 'budgetTokens'].forEach(function (k) {
          p[k] = (p[k] == null) ? '' : String(p[k]);
        });
        p.replaceSystem = !!p.replaceSystem;
        return p;
      });
    } catch (e) {
      return [defaults()];
    }
  }

  var quotaWarned = false;
  function writePresets(arr) {
    try {
      localStorage.setItem(STORE, JSON.stringify(arr));
      return true;
    } catch (e) {
      if (!quotaWarned) {
        quotaWarned = true;
        try { toast('保存失败：本地存储空间不足，请精简角色设定'); } catch (e2) {}
      }
      return false;
    }
  }

  function activeIndex(arr) {
    var i = parseInt(localStorage.getItem(ACTIVE) || '0', 10);
    if (!(i >= 0 && i < arr.length)) i = 0;
    return i;
  }

  function setActive(i) {
    try { localStorage.setItem(ACTIVE, String(i)); } catch (e) {}
  }

  function activePreset() {
    var arr = readPresets();
    return arr[activeIndex(arr)];
  }

  /* ================================================================
   * 请求改写
   * ================================================================ */

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

  function trimByTurns(messages, turns) {
    if (!turns) return messages;
    var keep = turns * 2;
    if (messages.length <= keep) return messages;
    var cut = messages.slice(-keep);
    while (cut.length > 1 && cut[0].role === 'assistant') cut.shift();
    return cut;
  }

  function trimByBudget(messages, budget) {
    if (!budget) return messages;
    var kept = [];
    var used = 0;
    var start = messages.length;
    for (var i = messages.length - 1; i >= 0; i--) {
      var m = messages[i];
      var t = approxTokens(blockText(m && m.content)) + 4;
      if (used + t > budget && kept.length) break;
      used += t;
      kept.unshift(m);
      start = i;
    }
    // 会话不能以 assistant 开头（latest_reminder 等前缀消息要保留）
    if (kept.length && kept[0].role === 'assistant') {
      var prev = start > 0 ? messages[start - 1] : null;
      if (prev) kept.unshift(prev);
    }
    while (kept.length > 1 && kept[0].role === 'assistant') kept.shift();
    return kept;
  }

  function applyPreset(body, p) {
    var applied = { systemChars: 0, temperature: null, top_p: null, max_tokens: null, messagesBefore: 0, messagesAfter: 0, preset: p.name };

    var userSystem = (p.system || '').trim();
    if (userSystem) {
      if (Array.isArray(body.system) && !p.replaceSystem) {
        body.system = body.system.concat([{ type: 'text', text: userSystem }]);
        applied.systemAppended = true;
      } else if (Array.isArray(body.system)) {
        body.system = [{ type: 'text', text: userSystem }];
        applied.systemReplaced = true;
      } else {
        var base = typeof body.system === 'string' ? body.system : blockText(body.system);
        if (p.replaceSystem || !base) {
          body.system = userSystem;
          applied.systemReplaced = true;
        } else {
          body.system = base + '\n\n' + userSystem;
          applied.systemAppended = true;
        }
      }
      applied.systemChars = userSystem.length;
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
          window.__dshStudioLastApplied = applied;
          try { window.dispatchEvent(new CustomEvent('dsh-studio:applied', { detail: applied })); } catch (e2) {}
          console.log('[dsh-studio] applied ' + JSON.stringify(applied));
        }
      } catch (e) {
        console.log('[dsh-studio] hook error ' + (e && e.message));
      }
      return origFetch.call(this, input, init);
    };
  }

  /* ================================================================
   * 酒馆 PNG 角色卡（复用 dsh-cardlib.js 的 chunk 解析）
   * ================================================================ */

  function b64bytes(b64) {
    var bin = atob(String(b64).replace(/\s+/g, ''));
    var u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }

  function inflate(u8) {
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error('当前浏览器不支持解压（DecompressionStream）'));
    }
    var s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Response(s).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }

  function utf8(u8) { return new TextDecoder('utf-8').decode(u8); }

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
    var flag = rest[0];
    var p = 2;
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
    // 角色卡本身就是人设，默认替换内置的「该助手为DeepSeek」前缀，否则会打架
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
          cb(null, cardToPreset(obj && obj.data ? obj.data : obj, file.name));
          return;
        }
        readCardText(buf).then(function (res) {
          var raw = String(res.text).trim();
          var jsonText = raw.charAt(0) === '{' ? raw : utf8(b64bytes(raw));
          var json = JSON.parse(jsonText);
          var card = json && json.data ? json.data : json;
          cb(null, cardToPreset(card, file.name));
        }).catch(function (e) {
          cb((e && e.message) || '角色卡解析失败');
        });
      } catch (e) {
        cb('解析失败：' + ((e && e.message) || ''));
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function makeThumb(file) {
    return new Promise(function (resolve) {
      if (!/^image\//.test(file.type) && !/\.png$/i.test(file.name)) { resolve(''); return; }
      var url = '';
      try {
        url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () {
          try {
            var S = 96;
            var c = document.createElement('canvas');
            c.width = S;
            c.height = S;
            var ctx = c.getContext('2d');
            var w = img.naturalWidth, h = img.naturalHeight;
            var s = Math.min(w, h);
            ctx.drawImage(img, (w - s) / 2, (h - s) / 2, s, s, 0, 0, S, S);
            var data = c.toDataURL('image/webp', 0.82);
            URL.revokeObjectURL(url);
            resolve(data);
          } catch (e) {
            try { URL.revokeObjectURL(url); } catch (e2) {}
            resolve('');
          }
        };
        img.onerror = function () {
          try { URL.revokeObjectURL(url); } catch (e) {}
          resolve('');
        };
        img.src = url;
      } catch (e) {
        if (url) { try { URL.revokeObjectURL(url); } catch (e2) {} }
        resolve('');
      }
    });
  }

  /* ================================================================
   * 小工具 / 图标
   * ================================================================ */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function icon(html, cls) {
    var s = el('span', cls || 'dshs-ico');
    s.innerHTML = html;
    return s;
  }

  var I = {
    logo: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none"><path d="M12 2.6l2.2 6.1 6.1 2.2-6.1 2.2L12 19.2l-2.2-6.1-6.1-2.2 6.1-2.2L12 2.6z" fill="currentColor"/><path d="M19.2 15.4l.9 2.5 2.5.9-2.5.9-.9 2.5-.9-2.5-2.5-.9 2.5-.9.9-2.5z" fill="currentColor" opacity=".72"/></svg>',
    close: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    back: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M11.2 4.4L6 9l5.2 4.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    plus: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 3.2v9.6M3.2 8h9.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    upload: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 10.6V2.9M5.2 5.7L8 2.9l2.8 2.8" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.9 10.9v1.3c0 .5.4.9.9.9h8.4c.5 0 .9-.4.9-.9v-1.3" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/></svg>',
    x: '<svg width="9" height="9" viewBox="0 0 10 10" fill="none"><path d="M2.2 2.2l5.6 5.6M7.8 2.2L2.2 7.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    spark: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1.9l1.15 3.05L12.2 6.1 9.15 7.25 8 10.3 6.85 7.25 3.8 6.1l3.05-1.15L8 1.9z" fill="currentColor"/><path d="M12.35 9.55l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6.6-1.6z" fill="currentColor" opacity=".7"/></svg>'
  };

  function initialOf(name) {
    var s = (name || '').trim();
    return s ? s.charAt(0).toUpperCase() : '?';
  }

  function fmtNum(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function metaOf(p) {
    var bits = [];
    if (p.temperature !== '') bits.push('温度 ' + p.temperature);
    if (p.historyTurns !== '') bits.push(p.historyTurns + ' 轮');
    var sys = (p.system || '').trim();
    if (sys) bits.push(sys.length >= 1000 ? (sys.length / 1000).toFixed(1) + 'k 字' : sys.length + ' 字');
    return bits.join(' · ') || '未设置';
  }

  function describePreset(p) {
    var bits = [];
    var sys = (p.system || '').trim();
    if (sys) bits.push('系统 ' + fmtNum(sys.length) + ' 字');
    if (p.temperature !== '') bits.push('温度 ' + p.temperature);
    if (p.topP !== '') bits.push('Top P ' + p.topP);
    if (p.maxTokens !== '') bits.push('max_tokens ' + p.maxTokens);
    if (p.historyTurns !== '') bits.push('保留 ' + p.historyTurns + ' 轮');
    if (p.budgetTokens !== '') bits.push('预算 ' + fmtNum(p.budgetTokens));
    if (p.replaceSystem && sys) bits.push('替换内置提示词');
    return bits.length ? bits.join(' · ') : '未覆盖参数，使用应用默认值';
  }

  /* ================================================================
   * 状态
   * ================================================================ */

  var overlay = null;
  var dialog = null;
  var ui = {};
  var arr = [];
  var cur = 0;
  var draft = null;
  var saveTimer = null;
  var toastTimer = null;
  var busyImport = false;
  var mobileQuery = window.matchMedia ? window.matchMedia('(max-width: 760px)') : null;

  function isMobile() { return !!(mobileQuery && mobileQuery.matches); }

  /* ================================================================
   * 打开 / 关闭
   * ================================================================ */

  function openStudio() {
    if (overlay) {
      try { dialog && dialog.focus(); } catch (e) {}
      return;
    }
    arr = readPresets();
    cur = activeIndex(arr);
    draft = clone(arr[cur]);

    overlay = el('div', 'dshs-overlay');
    dialog = el('div', 'dshs-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', '角色预设与参数');
    dialog.tabIndex = -1;

    /* header */
    var head = el('div', 'dshs-head');
    var brand = el('div', 'dshs-brand');
    var logo = el('div', 'dshs-logo');
    logo.innerHTML = I.logo;
    var titles = el('div', 'dshs-titles');
    titles.appendChild(el('div', 'dshs-title', '角色预设'));
    titles.appendChild(el('div', 'dshs-sub', '系统提示词 · 采样参数 · 上下文'));
    brand.appendChild(logo);
    brand.appendChild(titles);
    var closeBtn = el('button', 'dshs-iconbtn');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', '关闭');
    closeBtn.innerHTML = I.close;
    closeBtn.addEventListener('click', closeStudio);
    head.appendChild(brand);
    head.appendChild(closeBtn);
    dialog.appendChild(head);

    /* main */
    var main = el('div', 'dshs-main');
    var list = el('div', 'dshs-list');
    var listHead = el('div', 'dshs-listhead');
    listHead.appendChild(el('span', null, '角色'));
    var count = el('span', 'dshs-count', '0');
    listHead.appendChild(count);
    var items = el('div', 'dshs-items');
    items.setAttribute('role', 'listbox');
    items.setAttribute('aria-label', '角色预设列表');
    var listFoot = el('div', 'dshs-listfoot');

    var newBtn = el('button', 'dshs-btn');
    newBtn.type = 'button';
    newBtn.innerHTML = I.plus + '<span>新建</span>';
    newBtn.addEventListener('click', createPreset);

    var importBtn = el('button', 'dshs-btn');
    importBtn.type = 'button';
    importBtn.innerHTML = I.upload + '<span>导入卡</span>';
    importBtn.addEventListener('click', function () {
      if (busyImport) return;
      fileInput.click();
    });

    listFoot.appendChild(newBtn);
    listFoot.appendChild(importBtn);
    list.appendChild(listHead);
    list.appendChild(items);
    list.appendChild(listFoot);

    var editor = el('div', 'dshs-editor');
    main.appendChild(list);
    main.appendChild(editor);
    dialog.appendChild(main);

    /* file input + toast + drop */
    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/png,application/json,.png,.json';
    fileInput.className = 'dshs-hidden';
    fileInput.addEventListener('change', function () {
      var f = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (f) importFile(f);
    });
    dialog.appendChild(fileInput);

    var dragDepth = 0;
    function hasFiles(e) {
      var t = e.dataTransfer && e.dataTransfer.types;
      if (!t) return false;
      for (var i = 0; i < t.length; i++) if (t[i] === 'Files') return true;
      return false;
    }
    overlay.addEventListener('dragenter', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth++;
      overlay.classList.add('dshs-dragging');
    });
    overlay.addEventListener('dragover', function (e) {
      if (hasFiles(e)) e.preventDefault();
    });
    overlay.addEventListener('dragleave', function (e) {
      if (!hasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) overlay.classList.remove('dshs-dragging');
    });
    overlay.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      overlay.classList.remove('dshs-dragging');
      var f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) importFile(f);
    });

    var toastEl = el('div', 'dshs-toast');
    dialog.appendChild(toastEl);
    var dropEl = el('div', 'dshs-drop', '松开以导入酒馆角色卡');
    dialog.appendChild(dropEl);

    ui = {
      head: head, list: list, items: items, count: count, editor: editor,
      closeBtn: closeBtn, newBtn: newBtn, importBtn: importBtn,
      toast: toastEl
    };

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    document.body.classList.add('dshs-lock');
    document.documentElement.classList.add('dshs-lock');

    renderList();
    renderEditor();

    document.addEventListener('keydown', onKeydown, true);
    overlay.addEventListener('mousedown', function (e) {
      if (e.target === overlay) closeStudio();
    });
    requestAnimationFrame(function () { overlay.classList.add('dshs-in'); });
    setTimeout(function () { try { dialog.focus(); } catch (e) {} }, 60);
  }

  function closeStudio() {
    if (!overlay) return;
    flush();
    overlay.classList.remove('dshs-in');
    document.body.classList.remove('dshs-lock');
    document.documentElement.classList.remove('dshs-lock');
    document.removeEventListener('keydown', onKeydown, true);
    var node = overlay;
    overlay = null;
    dialog = null;
    ui = {};
    setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 190);
  }

  function onKeydown(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeStudio();
      return;
    }
    if (e.key !== 'Tab' || !dialog) return;
    var nodes = dialog.querySelectorAll('button, input, textarea, select, [tabindex]:not([tabindex="-1"])');
    var list = [];
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].offsetParent !== null && !nodes[i].disabled) list.push(nodes[i]);
    }
    if (!list.length) return;
    var first = list[0], last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  /* ================================================================
   * 列表
   * ================================================================ */

  function renderList() {
    if (!ui.items) return;
    ui.items.innerHTML = '';
    ui.count.textContent = String(arr.length);
    var act = activeIndex(arr);

    arr.forEach(function (p, i) {
      var live = (i === cur && draft) ? draft : p;
      var item = el('button', 'dshs-item' + (i === cur ? ' dshs-sel' : ''));
      item.type = 'button';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', i === cur ? 'true' : 'false');

      var ava = el('span', 'dshs-ava');
      if (live.avatar) {
        var img = document.createElement('img');
        img.src = live.avatar;
        img.alt = '';
        ava.appendChild(img);
      } else {
        ava.textContent = initialOf(live.name);
        if (!live.name) ava.classList.add('dshs-ava-plain');
      }

      var txt = el('span', 'dshs-itxt');
      txt.appendChild(el('span', 'dshs-iname', live.name || '未命名'));
      txt.appendChild(el('span', 'dshs-imeta', metaOf(live)));

      var dot = el('span', 'dshs-idot' + (i === act ? ' dshs-on' : ''));

      item.appendChild(ava);
      item.appendChild(txt);
      item.appendChild(dot);
      item.addEventListener('click', function () { selectPreset(i); });
      ui.items.appendChild(item);
    });
    updateStatus();
  }

  /* ================================================================
   * 编辑器
   * ================================================================ */

  function commit() {
    if (!draft) return;
    if (!arr[cur]) return;
    arr[cur] = clone(draft);
    writePresets(arr);
  }

  function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    commit();
  }

  function commitSoon() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      commit();
      renderList();
    }, 220);
  }

  function selectPreset(i) {
    if (i === cur) {
      if (isMobile() && dialog) dialog.classList.add('dshs-mobile-edit');
      return;
    }
    flush();
    cur = i;
    draft = clone(arr[i]);
    setActive(i);
    renderList();
    renderEditor();
    if (isMobile() && dialog) dialog.classList.add('dshs-mobile-edit');
  }

  function createPreset() {
    flush();
    var p = defaults({ name: '新角色' });
    arr.push(p);
    cur = arr.length - 1;
    draft = clone(p);
    setActive(cur);
    commit();
    renderList();
    renderEditor();
    if (isMobile() && dialog) dialog.classList.add('dshs-mobile-edit');
    var nameInput = ui.editor && ui.editor.querySelector('.dshs-nameinput');
    if (nameInput) {
      setTimeout(function () {
        nameInput.focus();
        nameInput.select();
      }, 40);
    }
  }

  function deletePreset() {
    if (arr.length === 1) {
      arr = [defaults()];
      cur = 0;
      draft = clone(arr[0]);
    } else {
      arr.splice(cur, 1);
      if (cur >= arr.length) cur = arr.length - 1;
      draft = clone(arr[cur]);
    }
    setActive(cur);
    writePresets(arr);
    renderList();
    renderEditor();
    toast('已删除');
  }

  function renderEditor() {
    if (!ui.editor) return;
    var ed = ui.editor;
    ed.innerHTML = '';
    ed.classList.remove('dshs-empty');

    var p = draft;
    var act = activeIndex(arr);
    var scroll = el('div', 'dshs-edscroll');

    /* head */
    var head = el('div', 'dshs-edhead');
    var back = el('button', 'dshs-back');
    back.type = 'button';
    back.setAttribute('aria-label', '返回角色列表');
    back.innerHTML = I.back;
    back.addEventListener('click', function () {
      if (dialog) dialog.classList.remove('dshs-mobile-edit');
    });

    var ava = el('div', 'dshs-avatar');
    if (p.avatar) {
      var img = document.createElement('img');
      img.src = p.avatar;
      img.alt = '';
      ava.appendChild(img);
    } else {
      ava.textContent = initialOf(p.name);
      if (!p.name) ava.classList.add('dshs-ava-plain');
    }

    var nameWrap = el('div', 'dshs-edname');
    var nameInput = el('input', 'dshs-nameinput');
    nameInput.type = 'text';
    nameInput.value = p.name || '';
    nameInput.placeholder = '角色名称';
    nameInput.maxLength = 40;
    nameInput.setAttribute('aria-label', '角色名称');
    nameInput.addEventListener('input', function () {
      draft.name = nameInput.value;
      if (!draft.avatar) {
        ava.textContent = initialOf(draft.name);
        ava.classList.toggle('dshs-ava-plain', !draft.name);
      }
      commitSoon();
    });
    var meta = el('div', 'dshs-edmeta');
    var sysLen = (p.system || '').trim().length;
    meta.textContent = (p.source ? '来自 ' + p.source : '手动创建') + (sysLen ? ' · 约 ' + fmtNum(approxTokens(p.system)) + ' tokens' : '');
    nameWrap.appendChild(nameInput);
    nameWrap.appendChild(meta);

    head.appendChild(back);
    head.appendChild(ava);
    head.appendChild(nameWrap);
    if (cur === act) head.appendChild(el('span', 'dshs-pill', '使用中'));
    scroll.appendChild(head);

    /* system prompt */
    var secSys = el('div', 'dshs-section');
    var labelRow = el('div', 'dshs-labelrow');
    labelRow.appendChild(el('label', 'dshs-label', '系统提示词'));
    var countTxt = el('span', 'dshs-countTxt', p.system.length + ' 字');
    labelRow.appendChild(countTxt);

    var ta = el('textarea', 'dshs-textarea');
    ta.value = p.system || '';
    ta.placeholder = '例如：\n你是「林晚」，一位……\n说话简短、克制，偶尔用反问。\n始终保持角色，不要跳出设定。';
    ta.setAttribute('spellcheck', 'false');
    ta.setAttribute('aria-label', '系统提示词');
    ta.addEventListener('input', function () {
      draft.system = ta.value;
      countTxt.textContent = draft.system.length + ' 字';
      commitSoon();
    });

    secSys.appendChild(labelRow);
    secSys.appendChild(ta);
    secSys.appendChild(el('div', 'dshs-hint', '留空时使用应用默认系统提示词。关闭下方「替换」后，设定会追加在默认提示词之后。'));
    scroll.appendChild(secSys);

    /* sampling params */
    var secParam = el('div', 'dshs-section');
    secParam.appendChild(el('div', 'dshs-secTitle', '采样参数'));
    secParam.appendChild(makeSlider({
      key: 'temperature', name: '温度', min: 0, max: 2, step: 0.1, def: 1, decimals: 1
    }));
    secParam.appendChild(makeSlider({
      key: 'topP', name: 'Top P', min: 0, max: 1, step: 0.05, def: 1, decimals: 2
    }));
    secParam.appendChild(makeNumber({
      key: 'maxTokens', name: 'max_tokens', unit: 'tokens', min: 1, max: 32768,
      placeholder: '默认', hint: '单次回复的最大 token 数；留空跟随应用默认。'
    }));
    scroll.appendChild(secParam);

    /* context */
    var secCtx = el('div', 'dshs-section');
    secCtx.appendChild(el('div', 'dshs-secTitle', '上下文'));
    var grid = el('div', 'dshs-grid2');
    grid.appendChild(makeNumber({
      key: 'historyTurns', name: '保留轮数', unit: '轮', min: 0, max: 200,
      placeholder: '不限', hint: '每轮 = 1 问 1 答；0 或留空不裁剪。'
    }));
    grid.appendChild(makeNumber({
      key: 'budgetTokens', name: '上下文预算', unit: 'tokens', min: 0, max: 200000,
      placeholder: '不限', hint: '按内容粗估；超出时从最早的消息开始丢弃。'
    }));
    secCtx.appendChild(grid);
    scroll.appendChild(secCtx);

    /* replace switch */
    var secSwitch = el('div', 'dshs-section');
    var swRow = el('div', 'dshs-switchrow');
    var swTxt = el('div', 'dshs-switchtxt');
    swTxt.appendChild(el('div', 'dshs-switchname', '替换内置系统提示词'));
    swTxt.appendChild(el('div', 'dshs-switchdesc', '开启后完全覆盖 DeepSeek 默认设定；角色卡导入默认开启。'));
    var sw = el('button', 'dshs-switch' + (p.replaceSystem ? ' dshs-on' : ''));
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', p.replaceSystem ? 'true' : 'false');
    sw.setAttribute('aria-label', '替换内置系统提示词');
    sw.addEventListener('click', function () {
      draft.replaceSystem = !draft.replaceSystem;
      sw.classList.toggle('dshs-on', draft.replaceSystem);
      sw.setAttribute('aria-checked', draft.replaceSystem ? 'true' : 'false');
      commitSoon();
    });
    swRow.appendChild(swTxt);
    swRow.appendChild(sw);
    secSwitch.appendChild(swRow);
    scroll.appendChild(secSwitch);

    ed.appendChild(scroll);

    /* footer */
    var foot = el('div', 'dshs-foot');
    var status = el('div', 'dshs-status');
    foot.appendChild(status);

    var btns = el('div', 'dshs-footbtns');
    var del = el('button', 'dshs-btn dshs-btn-danger', '删除');
    del.type = 'button';
    var armed = false, armTimer = null;
    del.addEventListener('click', function () {
      if (!armed) {
        armed = true;
        del.textContent = '确认删除？';
        del.style.background = 'rgba(236,19,19,.08)';
        armTimer = setTimeout(function () {
          armed = false;
          del.textContent = '删除';
          del.style.background = '';
        }, 2600);
        return;
      }
      clearTimeout(armTimer);
      deletePreset();
    });

    var save = el('button', 'dshs-btn dshs-btn-primary', '保存并关闭');
    save.type = 'button';
    save.addEventListener('click', function () {
      flush();
      setActive(cur);
      renderList();
      toast('已使用「' + (draft.name || '未命名') + '」');
      setTimeout(closeStudio, 420);
    });

    btns.appendChild(del);
    btns.appendChild(save);
    foot.appendChild(btns);
    ed.appendChild(foot);

    updateStatus();
  }

  function makeSlider(o) {
    var wrap = el('div', 'dshs-param');
    var top = el('div', 'dshs-paramtop');
    top.appendChild(el('span', 'dshs-paramname', o.name));
    var val = el('span', 'dshs-paramval');
    top.appendChild(val);
    wrap.appendChild(top);

    var range = el('input', 'dshs-range');
    range.type = 'range';
    range.min = String(o.min);
    range.max = String(o.max);
    range.step = String(o.step);
    range.setAttribute('aria-label', o.name);

    function current() {
      var v = draft[o.key];
      return (v === '' || v == null || isNaN(Number(v))) ? null : Number(v);
    }
    function paint() {
      var v = current();
      var shown = v == null ? o.def : v;
      range.value = String(shown);
      var pct = (shown - o.min) / (o.max - o.min) * 100;
      range.style.setProperty('--p', pct.toFixed(2) + '%');
      val.innerHTML = '';
      val.classList.toggle('dshs-empty', v == null);
      var num = el('span', null, v == null ? '应用默认' : Number(shown.toFixed(o.decimals)).toString());
      val.appendChild(num);
      var reset = el('button', 'dshs-reset');
      reset.type = 'button';
      reset.title = '恢复应用默认';
      reset.setAttribute('aria-label', '恢复' + o.name + '默认值');
      reset.innerHTML = I.x;
      reset.addEventListener('click', function () {
        draft[o.key] = '';
        paint();
        commitSoon();
      });
      val.appendChild(reset);
    }

    range.addEventListener('input', function () {
      var v = Number(range.value);
      draft[o.key] = String(Number(v.toFixed(o.decimals + 1)));
      paint();
      commitSoon();
    });

    wrap.appendChild(range);
    paint();
    return wrap;
  }

  function makeNumber(o) {
    var wrap = el('div');
    wrap.appendChild(el('label', 'dshs-fieldlabel', o.name));
    var box = el('div', 'dshs-inputwrap');
    var input = el('input', 'dshs-input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.autocomplete = 'off';
    input.placeholder = o.placeholder || '';
    input.value = draft[o.key] == null ? '' : String(draft[o.key]);
    input.setAttribute('aria-label', o.name);
    box.appendChild(input);
    box.appendChild(el('span', 'dshs-unit', o.unit));
    wrap.appendChild(box);
    if (o.hint) wrap.appendChild(el('div', 'dshs-fieldhint', o.hint));

    input.addEventListener('input', function () {
      var cleaned = input.value.replace(/[^\d]/g, '');
      if (cleaned !== input.value) input.value = cleaned;
      draft[o.key] = cleaned;
      commitSoon();
    });
    input.addEventListener('blur', function () {
      var v = input.value.trim();
      if (!v) { draft[o.key] = ''; return; }
      var n = parseInt(v, 10);
      if (isNaN(n)) n = o.min;
      if (n < o.min) n = o.min;
      if (n > o.max) n = o.max;
      draft[o.key] = String(n);
      input.value = String(n);
      commitSoon();
    });
    return wrap;
  }

  function updateStatus() {
    if (!ui.editor) return;
    var st = ui.editor.querySelector('.dshs-status');
    if (!st) return;
    var act = activeIndex(arr);
    var p = (cur === act && draft) ? draft : (arr[act] || defaults());
    st.innerHTML = '';
    var dot = el('span', 'dshs-live');
    st.appendChild(dot);
    st.appendChild(document.createTextNode('当前生效：' + describePreset(p)));
  }

  /* ================================================================
   * 导入
   * ================================================================ */

  function importFile(file) {
    if (busyImport) return;
    if (!/\.png$/i.test(file.name) && !/\.json$/i.test(file.name) && !/^image\/png$/.test(file.type) && file.type !== 'application/json') {
      toast('请选择 PNG 角色卡或角色卡 JSON');
      return;
    }
    busyImport = true;
    if (ui.importBtn) ui.importBtn.disabled = true;
    toast('正在解析「' + file.name + '」…');
    importCardFile(file, function (err, preset) {
      if (err) {
        busyImport = false;
        if (ui.importBtn) ui.importBtn.disabled = false;
        toast('导入失败：' + err);
        return;
      }
      makeThumb(file).then(function (thumb) {
        preset.avatar = thumb || '';
        flush();
        arr.push(preset);
        cur = arr.length - 1;
        draft = clone(preset);
        setActive(cur);
        writePresets(arr);
        busyImport = false;
        if (ui.importBtn) ui.importBtn.disabled = false;
        renderList();
        renderEditor();
        if (dialog) dialog.classList.add('dshs-mobile-edit');
        toast('已导入「' + preset.name + '」并启用');
      });
    });
  }

  /* ================================================================
   * toast
   * ================================================================ */

  function toast(msg) {
    if (!ui.toast) return;
    ui.toast.textContent = msg;
    ui.toast.classList.add('dshs-show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      if (ui.toast) ui.toast.classList.remove('dshs-show');
    }, 2400);
  }

  /* ================================================================
   * 入口注入
   * ================================================================ */

  function mountEntry() {
    if (!document.body || document.getElementById('dshs-entry')) return;
    var bottom = document.querySelector('[class*="bottom-ac14ac"]');
    if (!bottom) return;
    var settings = null;
    var btns = bottom.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if (/(^|\s)settings-ac14ac/.test(btns[i].className)) { settings = btns[i]; break; }
    }
    if (!settings) return;

    var btn = settings.cloneNode(true);
    btn.id = 'dshs-entry';
    btn.setAttribute('aria-label', '角色预设');
    btn.removeAttribute('aria-expanded');
    var lbl = btn.querySelector('[class*="settingsLabel"]');
    if (lbl) lbl.textContent = '角色预设';
    var ic = btn.querySelector('[class*="settingsIcon"]');
    if (ic) ic.innerHTML = I.spark;
    btn.style.margin = '10px 0';
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      openStudio();
    });
    bottom.insertBefore(btn, settings);
  }

  function mountTab() {
    if (document.getElementById('dshs-tab')) return;
    var nav = document.querySelector('[class*="navigation-_85c1b"]');
    if (!nav) return;
    var base = nav.querySelector('button');
    if (!base) return;
    var b = base.cloneNode(true);
    b.id = 'dshs-tab';
    b.className = (base.className || '').replace(/\s*navItemActive-\S+/g, '').trim();
    b.setAttribute('aria-selected', 'false');
    b.innerHTML = I.spark + '角色预设';
    b.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var close = document.querySelector('[class*="close-_83af2"]');
      if (close) close.click();
      setTimeout(openStudio, 170);
    });
    nav.appendChild(b);
  }

  var mountTimer = null;
  function scheduleMount() {
    if (mountTimer) return;
    mountTimer = setTimeout(function () {
      mountTimer = null;
      mountEntry();
      mountTab();
    }, 120);
  }

  function boot() {
    scheduleMount();
    var mo = new MutationObserver(scheduleMount);
    mo.observe(document.body, { childList: true, subtree: true });
    [400, 1200, 2600].forEach(function (ms) {
      setTimeout(scheduleMount, ms);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* 兼容旧壳层注入脚本的入口约定 */
  window.__dshStudioOpen = openStudio;
  window.__dshStudioClose = closeStudio;
  window.__dshPresetOpen = openStudio;
  window.__dshPresetClose = closeStudio;

  /* 调试入口 */
  window.DSHStudio = {
    open: openStudio,
    close: closeStudio,
    presets: readPresets,
    describe: describePreset
  };
})();
