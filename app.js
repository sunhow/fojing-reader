/* ============================================================
   佛经精读：五经书架 —— 应用逻辑
   纯静态、无依赖；进度与笔记保存在浏览器 localStorage。
   ============================================================ */
(function () {
  'use strict';

  var BOOK = window.BOOK || null;

  /* ----------------------------- 站点文案 ----------------------------- */
  var CONFIG = window.SITE_CONFIG;
  var FOUNDATIONS = window.FOUNDATIONS || [];
  var FOUNDATION_TERM_ALIASES = {};
  if (BOOK) BOOK.chapters.forEach(function(ch){ch.sections.forEach(function(sec){sec.notes.forEach(function(n){FOUNDATION_TERM_ALIASES[n.traditional || n.term] = n.term;});});});

  /* ----------------------------- 存储 ----------------------------- */
  var LS = {
    settings: 'fojing.settings.v1',
    progress: 'fojing.progress.v1',
    notes: 'fojing.notes.v1',
    last: 'fojing.last.v1',
    swipeHint: 'fojing.swipeHint.v1'
  };

  var DEFAULT_SETTINGS = {
    theme: 'paper',
    fontSize: 'm',
    writing: 'horizontal',
    defaultMode: 'focus',
    defaultReveal: 'hidden',
    speechRate: '0.9',
    script: 'simplified'
  };

  var FONT_SIZE = { s: '17px', m: '19px', l: '21.5px', xl: '24px' };

  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var v = JSON.parse(raw);
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch (e) { toast('本机存储不可用，请导出备份保存笔记'); return false; }
  }

  /* --------- 本地数据规范化 ---------
     进度：{ [id]: { done, pos, revealed:{}, at } }
     笔记：{ [id]: { text, at } }
     旧版本的笔记是纯字符串、也没有 at，这里统一升级。
     at = 0 表示「登录前就存在的旧数据」：同步时只会补上云端还没有的小节，
     不会覆盖云端更新的记录。 */
  function normalizeProgress(raw) {
    var out = {};
    if (!raw || typeof raw !== 'object') return out;
    Object.keys(raw).forEach(function (id) {
      var e = raw[id];
      if (!e || typeof e !== 'object') return;
      out[id] = {
        done: !!e.done,
        pos: Number.isInteger(e.pos) && e.pos >= 0 ? e.pos : 0,
        revealed: e.revealed && typeof e.revealed === 'object' ? e.revealed : {},
        at: Number.isFinite(e.at) ? e.at : 0
      };
    });
    return out;
  }

  function normalizeNotes(raw) {
    var out = {};
    if (!raw || typeof raw !== 'object') return out;
    Object.keys(raw).forEach(function (id) {
      var e = raw[id];
      if (typeof e === 'string') { out[id] = { text: e, at: 0 }; return; }
      if (!e || typeof e !== 'object') return;
      out[id] = { text: typeof e.text === 'string' ? e.text : '', at: Number.isFinite(e.at) ? e.at : 0 };
    });
    return out;
  }

  var settings = Object.assign({}, DEFAULT_SETTINGS, load(LS.settings, {}));
  var progress = normalizeProgress(load(LS.progress, {}));
  var mynotes = normalizeNotes(load(LS.notes, {}));


  var state = {
    mode: settings.defaultMode === 'flow' ? 'flow' : 'focus',
    reader: null,      // {ci, si, pos, revealed:{}}
    searchQuery: '',
    glossaryCh: 'all',
    unused: null
  };

  /* ----------------------------- 工具 ----------------------------- */
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function escapeAttr(s) { return escapeHtml(s).replace(/\n/g, ' '); }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  var FLAT_CACHE = null;
  function flatSections() {
    if (FLAT_CACHE) return FLAT_CACHE;
    if (!BOOK) return [];
    var arr = [];
    BOOK.chapters.forEach(function (ch, ci) {
      ch.sections.forEach(function (sec, si) {
        arr.push({ ci: ci, si: si, ch: ch, sec: sec });
      });
    });
    FLAT_CACHE = arr;
    return arr;
  }

  /** 全书顺序上相邻的一节（delta = -1 上一节，1 下一节） */
  function neighborSection(ci, si, delta) {
    var flat = flatSections();
    for (var i = 0; i < flat.length; i++) {
      if (flat[i].ci === ci && flat[i].si === si) return flat[i + delta] || null;
    }
    return null;
  }

  /** 这一节是否有过实际的阅读动作（只是打开过、什么都没做不算） */
  function hasReadMark(p) {
    if (!p) return false;
    if (p.done) return true;
    if (Number.isFinite(p.pos) && p.pos > 0) return true;
    if (p.revealed && Object.keys(p.revealed).length) return true;
    return Number.isFinite(p.at) && p.at > 0;
  }

  /** 读到过的、全书顺序最靠后的一节 */
  function furthestRead() {
    var flat = flatSections();
    for (var i = flat.length - 1; i >= 0; i--) {
      if (hasReadMark(progress[flat[i].sec.id])) return flat[i];
    }
    return null;
  }

  /** 全书第一处还没标记掌握的小节 */
  function firstUnreadSection() {
    var flat = flatSections();
    for (var i = 0; i < flat.length; i++) {
      if (!(progress[flat[i].sec.id] && progress[flat[i].sec.id].done)) return flat[i];
    }
    return flat[0] || null;
  }

  /** 首页的「继续阅读」按钮：主标题 + 目的地（篇 · 节） */
  function resumeButton(entry, primary, label) {
    var ch = BOOK.chapters[entry.ci];
    var sec = ch.sections[entry.si];
    return '<a class="btn' + (primary ? ' primary' : '') + ' resume" href="#/read/' + entry.ci + '/' + entry.si + '"' +
      ' title="' + escapeAttr(ch.title + ' · ' + sec.title) + '">' +
      '<span class="rb-label">' + escapeHtml(label) + '</span>' +
      '<span class="rb-sub">' + escapeHtml(ch.title) + ' · 第 ' + sec.number + ' 节</span></a>';
  }

  function secProgress(id) {
    if (!progress[id]) progress[id] = { done: false, pos: 0, revealed: {}, at: 0 };
    if (!progress[id].revealed || typeof progress[id].revealed !== 'object') progress[id].revealed = {};
    if (!Number.isFinite(progress[id].at)) progress[id].at = 0;
    return progress[id];
  }

  /* --------- 保存并通知云同步 --------- */
  function persistProgress() { return save(LS.progress, progress); }
  function persistNotes() { return save(LS.notes, mynotes); }
  /** 打上修改时间，供多设备之间逐节比较新旧 */
  function touch(entry) { entry.at = Date.now(); return entry; }

  /* --------- 逐段精读的推进逻辑（按钮、键盘、滑动共用） --------- */
  function focusState() {
    if (!state.reader) return null;
    var sec = BOOK.chapters[state.reader.ci] && BOOK.chapters[state.reader.ci].sections[state.reader.si];
    if (!sec) return null;
    var pr = secProgress(sec.id);
    return { sec: sec, pr: pr, pos: pr.pos || 0 };
  }
  function focusReveal() {
    var f = focusState(); if (!f) return;
    f.pr.revealed[f.pos] = true;
    touch(f.pr); persistProgress();
    // Reveal in place; rebuilding the route would reset the scroll position.
    var explanation = $('#focusTrans');
    if (explanation) {
      explanation.hidden = false;
      explanation.classList.add('reveal');
    }
    var revealButton = $('#revealBtn');
    if (revealButton) {
      revealButton.id = 'nextPair';
      revealButton.textContent = f.pos < f.sec.pairs.length - 1 ? '下一段 →' : '读完了';
    }
  }
  function focusNext() {
    var f = focusState(); if (!f) return;
    f.pr.pos = Math.min(f.sec.pairs.length, f.pos + 1);
    touch(f.pr); persistProgress(); route();
  }
  /** 跳到另一节；pos 省略时沿用那一节自己保存的位置 */
  function goToSection(entry, pos) {
    var sec = entry && BOOK.chapters[entry.ci] && BOOK.chapters[entry.ci].sections[entry.si];
    if (!sec) return false;
    if (typeof pos === 'number') {
      var pr = secProgress(sec.id);
      pr.pos = Math.max(0, Math.min(pos, sec.pairs.length));
      touch(pr); persistProgress();
    }
    navigate('#/read/' + entry.ci + '/' + entry.si);
    return true;
  }
  /* 第一节按「上一段」＝ 回到上一节的最后一句 */
  function focusPrev() {
    var f = focusState(); if (!f) return;
    if (f.pos <= 0) {
      var prev = neighborSection(state.reader.ci, state.reader.si, -1);
      if (!prev) return;
      goToSection(prev, Math.max(0, prev.sec.pairs.length - 1));
      return;
    }
    f.pr.pos = Math.max(0, f.pos - 1);
    touch(f.pr); persistProgress(); route();
  }
  /* 先展开白话，已展开则进下一段；读完后进入下一节 */
  function focusAdvance() {
    var f = focusState(); if (!f) return;
    if (f.pos >= f.sec.pairs.length) {
      var next = neighborSection(state.reader.ci, state.reader.si, 1);
      if (!next) { toast('这已经是最后一节了'); return; }
      goToSection(next);
      return;
    }
    if (!f.pr.revealed[f.pos] && settings.defaultReveal !== 'shown') focusReveal();
    else focusNext();
  }

  function chapterStats(ch) {
    var done = 0, total = ch.sections.length;
    ch.sections.forEach(function (s) { if (progress[s.id] && progress[s.id].done) done++; });
    return { done: done, total: total, pct: total ? Math.round(done / total * 100) : 0 };
  }

  function overallStats() {
    var done = 0, total = 0;
    if (BOOK) BOOK.chapters.forEach(function (ch) {
      total += ch.sections.length;
      ch.sections.forEach(function (s) { if (progress[s.id] && progress[s.id].done) done++; });
    });
    return { done: done, total: total, pct: total ? Math.round(done / total * 100) : 0 };
  }

  /* --------- 把注释里的词语在原文里标出来，可点击 --------- */
  // 注释词条里可能带拼音（如「夙（sù）心」）或用顿号并列（如「石、斗」），
  // 匹配时先去掉拼音，再逐个尝试候选词。
  function stripPinyin(t) { return String(t).replace(/[（(][^）)]*[）)]/g, ''); }
  function matchKey(text, term) {
    var base = stripPinyin(term).trim();
    var cands = [base];
    if (/[、，,;；/]/.test(base)) cands = cands.concat(base.split(/[、，,;；/]/));
    cands = cands.map(function (x) { return x.trim(); })
      .filter(function (x) { return x.length >= 1; })
      .sort(function (a, b) { return b.length - a.length; });
    for (var i = 0; i < cands.length; i++) {
      if (text.indexOf(cands[i]) !== -1) return cands[i];
    }
    return null;
  }

  function decorate(text, notes) {
    var out = escapeHtml(text);
    if (!notes || !notes.length) return out;
    var items = notes
      .map(function (n) { return { t: n.term, e: n.explain, m: matchKey(out, n.term) }; })
      .filter(function (n) { return n.m; })
      .sort(function (a, b) { return b.m.length - a.m.length; });

    var matches = [];
    items.forEach(function (it) {
      var from = 0, idx;
      while ((idx = out.indexOf(it.m, from)) !== -1) {
        matches.push({ start: idx, end: idx + it.m.length, note: it });
        from = idx + it.m.length;
        if (it.m.length <= 1) break; // 单字词只标第一处，避免满屏标红
      }
    });
    matches.sort(function (a, b) { return a.start - b.start || b.end - a.end; });
    var chosen = [], last = -1;
    matches.forEach(function (m) { if (m.start >= last) { chosen.push(m); last = m.end; } });

    var res = '', pos = 0;
    chosen.forEach(function (m) {
      res += out.slice(pos, m.start);
      res += '<span class="term" data-term="' + escapeAttr(m.note.t) + '" data-explain="' + escapeAttr(m.note.e) + '">' +
        out.slice(m.start, m.end) + '</span>';
      pos = m.end;
    });
    res += out.slice(pos);
    return res;
  }

  /* ----------------------------- 主题 / 设置 ----------------------------- */
  function applySettings() {
    var root = document.documentElement;
    root.dataset.theme = settings.theme || 'paper';
    document.body.style.setProperty('--reading-size', FONT_SIZE[settings.fontSize] || FONT_SIZE.m);
    document.body.classList.toggle('writing-vertical', settings.writing === 'vertical');
    $$('.seg').forEach(function (seg) {
      var key = seg.dataset.setting;
      $$('button', seg).forEach(function (b) {
        b.classList.toggle('on', String(settings[key]) === String(b.dataset.val));
      });
    });
  }
  function setSetting(key, val) {
    settings[key] = val;
    save(LS.settings, settings);
    applySettings();
  }

  /* ----------------------------- 朗读 ----------------------------- */
  var voiceCache = null;
  function pickVoice() {
    if (!('speechSynthesis' in window)) return null;
    if (voiceCache) return voiceCache;
    var vs = window.speechSynthesis.getVoices() || [];
    voiceCache = vs.filter(function (v) { return /zh|Chinese/i.test(v.lang + ' ' + v.name); })[0] || null;
    return voiceCache;
  }
  function speak(text, rate) {
    if (!('speechSynthesis' in window)) { toast('当前浏览器不支持朗读功能'); return; }
    window.speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.rate = parseFloat(rate || settings.speechRate) || 0.9;
    var v = pickVoice(); if (v) u.voice = v;
    window.speechSynthesis.speak(u);
  }
  if ('speechSynthesis' in window) {
    window.speechSynthesis.onvoiceschanged = function () { voiceCache = null; pickVoice(); };
  }

  /* ----------------------------- 浮层 / 提示 ----------------------------- */
  function showPopover(el) {
    var pop = $('#popover');
    pop.innerHTML = '<b>' + escapeHtml(el.dataset.term) + '</b>' + escapeHtml(el.dataset.explain) + foundationLinks(el.dataset.term);
    pop.hidden = false;
    var r = el.getBoundingClientRect();
    var pw = pop.offsetWidth, ph = pop.offsetHeight;
    var left = Math.min(Math.max(8, r.left + r.width / 2 - pw / 2), window.innerWidth - pw - 8);
    var top = r.top - ph - 10;
    pop.classList.toggle('below', top < 8);
    if (top < 8) top = r.bottom + 10;
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }
  function hidePopover() { $('#popover').hidden = true; }

  var toastTimer = null;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 1900);
  }

  /* ----------------------------- 路由 ----------------------------- */
  function navigate(hash) { location.hash = hash; }

  function route() {
    hidePopover();
    var h = (location.hash || '#/').replace(/^#/, '');
    var parts = h.split('/').filter(function (x) { return x !== ''; });
    var view = $('#view');
    view.classList.toggle('wide', parts[0] === 'glossary' || (parts[0] === 'basics' && !parts[1]) || parts.length === 0);
    if (parts[0] !== 'read') state.reader = null;
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();

    if (!BOOK) {
      view.innerHTML = '<div class="empty"><h2>内容数据还没生成</h2>' +
        '<p>请先在项目目录运行 <code>python3 build.py</code> 生成 <code>book.js</code>。</p></div>';
      return;
    }

    if (parts.length === 0) renderHome(view);
    else if (parts[0] === 'ch') renderChapter(view, parseInt(parts[1], 10));
    else if (parts[0] === 'read') renderReader(view, parseInt(parts[1], 10), parseInt(parts[2], 10));
    else if (parts[0] === 'glossary') renderGlossary(view);
    else if (parts[0] === 'mynotes') renderMyNotes(view);
    else if (parts[0] === 'guide') renderGuide(view);
    else if (parts[0] === 'basics') renderFoundations(view,parts[1]);
    else if (parts[0] === 'passage') { openPassageById(parts[1]); return; }
    else renderHome(view);

    // 高亮导航
    var key = parts[0] === 'read' || parts[0] === 'ch' ? 'home' : (parts[0] || 'home');
    $$('[data-nav]').forEach(function (a) {
      a.classList.toggle('active', a.dataset.nav === key);
    });
    // 手机端：阅读时把底部标签栏换成逐句操作条
    var focusMode = parts[0] === 'read' && state.mode === 'focus';
    document.body.classList.toggle('in-reader', parts[0] === 'read');
    document.body.classList.toggle('focus-mode', focusMode);
    if (focusMode) hintSwipeOnce();

    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  /* 触屏上没有「空格 → 下一段」这类提示，第一次进逐段精读时口头交代一次滑动手势 */
  function isTouchReading() {
    if (window.innerWidth > 720) return false;
    if ((navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window) return true;
    return !!(window.matchMedia && window.matchMedia('(hover: none)').matches);
  }
  function hintSwipeOnce() {
    if (!isTouchReading() || load(LS.swipeHint, false)) return;
    save(LS.swipeHint, true);
    setTimeout(function () { toast('左滑看下一段，右滑回上一段'); }, 700);
  }

  /* ----------------------------- 首页 ----------------------------- */
  function lotus() {
    return '<svg class="lotus" viewBox="0 0 240 200" fill="none" aria-hidden="true"><g stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M120 157C72 132 79 78 120 28C161 78 168 132 120 157Z"/><path d="M120 157C65 154 38 109 46 59C96 69 123 107 120 157Z"/><path d="M120 157C175 154 202 109 194 59C144 69 117 107 120 157Z"/><path d="M120 157C74 172 28 151 13 109C67 101 102 117 120 157Z"/><path d="M120 157C166 172 212 151 227 109C173 101 138 117 120 157Z"/><path d="M120 157V87M52 177Q120 198 188 177M70 185Q120 201 170 185"/></g></svg>';
  }

  function foundationLinks(term) {
    term = FOUNDATION_TERM_ALIASES[term] || term;
    var matches=FOUNDATIONS.filter(function(t){return t.terms.indexOf(term)!==-1;});
    return matches.length ? '<div class="term-guide-links">'+matches.map(function(t){return '<a class="foundation-link" href="#/basics/'+t.id+'">深入导读：'+escapeHtml(t.title)+' ↗</a>';}).join('')+'</div>' : '';
  }

  function renderFoundations(view,id) {
    if(!id){
      var groups=['从哪里开始','怎样练习','怎样观察身心','把理解落实为愿行'];
      var html='<div class="crumb"><a href="#/">书架</a> / 基础导读</div><header class="chapter-head basics-heading"><div class="eyebrow">A CONNECTED INTRODUCTION</div><h1>把名词连起来，<br>再回到经文里。</h1><p class="ch-sub">十二个基础主题，帮助你理解它们之间的关系。<br>每篇都有通俗解释、常见误解、生活例子和原文入口。</p></header>';
      html+='<div class="basics-toolbar"><label><span>查找主题</span><input type="search" id="basicsSearch" aria-label="查找基础主题" placeholder="例如：因果、五蕴、正念、净土"></label><a href="#/glossary">只想查一个词？打开名词表 →</a></div>';
      html+='<nav class="concept-path" aria-label="基础概念阅读路径">'+groups.map(function(g,i){var first=FOUNDATIONS.find(function(t){return t.group===g;});return '<a href="#/basics/'+first.id+'"><small>0'+(i+1)+'</small><strong>'+escapeHtml(g)+'</strong><span>'+['三宝 · 四谛 · 八正道','戒定慧 · 业与十善','五蕴 · 缘起 · 无我 · 空性','菩提心 · 回向 · 净土'][i]+'</span></a>';}).join('')+'</nav>';
      groups.forEach(function(g){html+='<section class="basics-group" data-basics-group><h2>'+escapeHtml(g)+'</h2><div class="basics-grid">';FOUNDATIONS.filter(function(t){return t.group===g;}).forEach(function(t){html+='<a class="basics-card" href="#/basics/'+t.id+'" data-topic-search="'+escapeAttr(t.title+' '+t.summary+' '+t.terms.join(' '))+'"><span class="topic-number">'+String(FOUNDATIONS.indexOf(t)+1).padStart(2,'0')+'</span><h3>'+escapeHtml(t.title)+'</h3><p>'+escapeHtml(t.summary)+'</p><span class="topic-more">理解概念 · 回到经文 ↗</span></a>';});html+='</div></section>';});
      html+='<p class="empty" id="basicsEmpty" hidden>没有找到这个主题，试试更短的词，或打开名词表。</p><p class="basics-boundary">这是读经的入门导读，不替代系统课程或特定传统的完整教义。生活例子用于帮助理解，不是经文原句。译文与导读为 AI 辅助学习稿，尚未经专业逐条审校。</p>';
      view.innerHTML=html;$('#basicsSearch').addEventListener('input',function(e){var q=e.target.value.trim().toLowerCase(),count=0;$$('.basics-card').forEach(function(c){c.hidden=!c.dataset.topicSearch.toLowerCase().includes(q);if(!c.hidden)count++;});$$('[data-basics-group]').forEach(function(g){g.hidden=!$$('.basics-card',g).some(function(c){return !c.hidden;});});$('#basicsEmpty').hidden=count>0;});return;
    }
    var topic=FOUNDATIONS.find(function(t){return t.id===id;});
    if(!topic){view.innerHTML='<div class="empty"><h2>没有找到这个导读主题</h2><a class="btn" href="#/basics">返回基础导读</a></div>';return;}
    var index=FOUNDATIONS.indexOf(topic),previous=FOUNDATIONS[index-1],next=FOUNDATIONS[index+1];
    var html='<div class="crumb"><a href="#/">书架</a> / <a href="#/basics">基础导读</a> / '+escapeHtml(topic.title)+'</div><article class="foundation-article"><header class="chapter-head"><div class="eyebrow">'+String(index+1).padStart(2,'0')+' / 12 · '+escapeHtml(topic.group)+'</div><h1>'+escapeHtml(topic.title)+'</h1><p class="ch-sub">'+escapeHtml(topic.subtitle)+'</p></header><div class="foundation-summary">'+escapeHtml(topic.summary)+'</div><div class="prose foundation-prose">'+topic.paragraphs.map(function(p){return '<p>'+escapeHtml(p)+'</p>';}).join('')+'</div><section class="foundation-callout"><h2>容易误解的地方</h2><p>'+escapeHtml(topic.misconception)+'</p></section><section class="foundation-example"><h2>放进生活里想一想</h2><p>'+escapeHtml(topic.example)+'</p><small>生活例子 · 不是经文原句</small></section><section class="foundation-related"><h2>与这些概念连起来</h2><div>'+topic.related.map(function(id){var t=FOUNDATIONS.find(function(x){return x.id===id;});return '<a class="chip" href="#/basics/'+id+'">'+escapeHtml(t.title)+' →</a>';}).join('')+'</div></section><section class="foundation-readings"><div class="panel-head"><h2>回到经文</h2><span class="count">点击直达对应段落</span></div>'+topic.references.map(function(ref){return '<a href="'+escapeAttr(ref.href)+'" class="foundation-reading"><span>'+escapeHtml(ref.book)+'</span><strong>'+escapeHtml(ref.label)+'</strong><i>↗</i></a>';}).join('')+'</section><nav class="foundation-pagination" aria-label="相邻基础主题">'+(previous?'<a href="#/basics/'+previous.id+'">← '+escapeHtml(previous.title)+'</a>':'<span></span>')+'<a href="#/basics">全部主题</a>'+(next?'<a href="#/basics/'+next.id+'">'+escapeHtml(next.title)+' →</a>':'<span></span>')+'</nav><p class="basics-boundary">入门导读为 AI 辅助学习稿；不同佛教传统的精细解释可能不同。上方经文入口便于核对本书架所采用的原典和版本说明。</p></article>';
    view.innerHTML=html;
  }

  function openPassageById(id) {
    var found=null;flatSections().some(function(e){var pi=e.sec.pairs.findIndex(function(p){return p.id===id;});if(pi!==-1){found={entry:e,pos:pi};return true;}return false;});
    if(!found){$('#view').innerHTML='<div class="empty"><h2>没有找到这个经文段落</h2><a href="#/basics">返回基础导读</a></div>';return;}
    var pr=secProgress(found.entry.sec.id);pr.pos=found.pos;touch(pr);persistProgress();state.mode='focus';navigate('#/read/'+found.entry.ci+'/'+found.entry.si);
  }

  function renderHome(view) {
    var ov=overallStats(),last=load(LS.last,null),lastEntry=last&&BOOK.chapters[last.ci]&&BOOK.chapters[last.ci].sections[last.si]?last:firstUnreadSection();
    var html='<section class="library-hero"><div class="hero-copy"><div class="eyebrow">'+escapeHtml(CONFIG.notebookName)+' <span>/</span> A PERSONAL SUTRA LIBRARY</div><h1>慢读经文，<br><em>躬行于日常。</em></h1><p class="library-lead">从知足与善行，到般若与行愿。<br>八项经书与选读，配完整白话，一段一段读懂。</p><div class="hero-actions">'+resumeButton(lastEntry,true,last?'继续上次阅读':'从《佛遗教经》开始')+'<a href="#/guide" class="quiet-link">初读指南 ↗</a></div></div><div class="library-art" aria-hidden="true">'+lotus()+'<div class="art-caption">戒 · 定 · 慧</div><span class="vertical-note">读有所悟　行有所依</span></div></section>';
    html+='<div class="reading-summary"><div><span class="summary-label">我的阅读</span><strong>'+ov.done+'<small> / '+ov.total+' 节已读完</small></strong></div><div class="summary-progress"><div class="bar"><i style="width:'+ov.pct+'%"></i></div><span>'+ov.pct+'% · 八项经书与选读，循序渐读</span></div><a href="#/mynotes">我的札记 →</a></div>';
    html+='<a class="basics-home-banner" href="#/basics"><span class="small-seal">知</span><div><strong>佛教基础名词导读</strong><p>三宝、四谛、五蕴、缘起……把十二个概念连起来，再回到经文。</p></div><span>开始理解 ↗</span></a>';
    html+='<section class="library-catalog"><header class="catalog-head"><div><div class="eyebrow">READING COLLECTION / 01—08</div><h2>循序读经</h2></div><span class="collection-count">8 项经书与选读 · 206 段白话对照</span></header><p class="collection-intro">先从生活里的修心与不伤害读起，再慢慢进入无住的智慧与广大的愿行。</p><div class="reading-path" aria-label="建议阅读顺序">';
    BOOK.chapters.slice(0,5).forEach(function(ch,i){html+='<a href="#/ch/'+i+'"><span>'+String(i+1).padStart(2,'0')+'</span>'+escapeHtml(ch.theme)+'</a>'+(i<4?'<i aria-hidden="true">→</i>':'');});
    html+='</div><div class="book-grid">';
    BOOK.chapters.forEach(function(ch,i){var st=chapterStats(ch);html+='<a class="book-card" href="#/ch/'+i+'" aria-label="'+escapeAttr(String(i+1).padStart(2,'0')+' '+ch.title+' '+ch.subtitle)+'"><div class="book-cover cover-'+i+'"><div class="cover-meta">SUTRA '+String(i+1).padStart(2,'0')+'</div><div class="cover-title">'+escapeHtml(ch.title)+'</div><div class="cover-foot"><span>原文 · 白话</span><b>'+['修','善','空','慧','愿','觉','言','净'][i]+'</b></div></div><div class="book-info"><div class="book-kicker">'+escapeHtml(ch.theme)+'<span>'+(ch.scope==='selection'?'选读 · ':'')+ch.passageCount+' 段</span></div><h3>'+escapeHtml(ch.title)+'</h3><p>'+escapeHtml(ch.subtitle)+'</p><div class="book-progress"><div class="bar"><i style="width:'+st.pct+'%"></i></div><small>'+(st.done?st.done+' / '+st.total+' 节':'开始阅读')+' <span>↗</span></small></div></div></a>';});
    html+='</div></section><section class="companion-section"><div><div class="eyebrow">CONTINUE YOUR READING</div><h2>已经读过的，也在这里。</h2><p>继续《地藏经》的白话阅读，或翻开《易经》。</p></div><div class="companion-links"><a href="https://sunhow.github.io/dizang-reader/" target="_blank" rel="noopener noreferrer"><span class="companion-seal">藏</span><div><strong>地藏菩萨本愿经</strong><small>十三品 · 完整白话 · 原有笔记</small></div><span>↗</span></a><a href="https://sunhow.github.io/yijing-reader/" target="_blank" rel="noopener noreferrer"><span class="companion-seal">易</span><div><strong>易经 · 六十四卦精读</strong><small>个人经典阅读站 · 独立入口</small></div><span>↗</span></a></div></section>';
    html+='<section class="reading-note"><span class="small-seal">读</span><div><h3>先读懂一句，再记下一点。</h3><p>原文、白话与阅读提示分开呈现。可以随时查看繁体底本，查找名词，记下疑问，也记下一件愿意在生活中实践的事。</p><a href="#/guide">版本、收录范围与使用说明 →</a></div></section>';
    view.innerHTML=html;
  }

  function renderGuide(view) {
    var html='<div class="crumb"><a href="#/">书架</a> / 初读指南</div><header class="chapter-head"><div class="eyebrow">BEFORE YOU BEGIN</div><h1>由浅入深，读与行相伴。</h1><p class="ch-sub">书架保留原有五经顺序，并增补入门、偈颂和净土阅读。</p></header><div class="guide-content prose"><h2>建议怎样读</h2><p>《佛遗教经》先看少欲、知足与实际修习；《十善业道经》关注身口意的不伤害；《心经》《金刚经》再进入无自性、无我和不住相；《普贤行愿品》把理解展开为广大利他愿行。这个顺序是本书架的阅读安排，不是所有佛教传统唯一的修学次第。</p><h2>八项经书与选读的版本范围</h2>';
    BOOK.chapters.forEach(function(ch,i){html+='<h3>'+String(i+1).padStart(2,'0')+' · '+escapeHtml(ch.fullTitle)+'</h3><p>'+escapeHtml(ch.author)+'。'+escapeHtml(ch.edition)+'</p><p><a href="'+escapeAttr(ch.source)+'" target="_blank" rel="noopener noreferrer">核对原文来源 ↗</a> · '+ch.passageCount+' 个对照段落</p>';});
    html+='<h2>原文与白话的边界</h2><p>本站收录七项所注明范围的完整正文，以及明确标注的《法句经》二十偈选读，共 38 个阅读小节、206 个对照段落。小节名为便于阅读所拟；《金刚经》的三十二分保留在段落标题中，《普贤行愿品》偈颂每四句一组。来源网页的开经仪轨、现代序言和链接说明不混入正文。</p><p>白话依原文次序展开内容，保持对话、清单和偈颂；原有专名酌予保留。佛教术语有多种解释，白话中的必要解释并非唯一可能译法。「阅读提示」另行说明背景和歧义。译文、提示和名词表由 AI 辅助撰写，尚未经过佛教学者或法师逐条审定，也不是某位法师的讲记。</p><h2>尤其值得留意</h2><p>般若经中的「空」不是一切不存在，「无我」不是否定人的尊严或责任。经典中关于福报、神通和护持的叙述，保留其信仰意义，不作为现实健康、财富或安全的保证。出家戒律与在家生活的适用范围不同，严酷本生叙事也不是要求模仿伤害身体。</p><h2>怎么用这个网站</h2><p>先在书架选经，再选小节。点击「看白话」或原文，只在当前位置展开译文，手机和电脑都不自动滚动。译文下方可以展开阅读提示。切换通篇对照可一次看完本节，段落目录可直接定位。</p><p>搜索支持原文、底本字形、白话、阅读提示和基础导读。新增的<a href="#/basics">基础导读</a>把十二个概念连成学习路径，提供常见误解、生活例子和直达原文的链接；名词页可按经书筛选，也可进入相关深入导读。设置提供简繁经文、字号、横竖排、纸色以及备份导入导出。朗读依赖设备的中文语音。</p><h2>笔记与进度</h2><p>本书架的数据仅保存在当前浏览器，可导出 JSON 备份，在另一设备导入。它有独立的笔记与进度空间；已有《地藏经》和《易经》的记录仍在各自网站内，点击书架入口即可继续。不同站点的备份不互相混用。</p><p>本站使用 Cloudflare Web Analytics 统计整体访问量、来源和设备等信息，统计报表仅由站主在登录后的后台查看。本网站不把笔记、搜索输入或阅读进度作为统计事件发送；笔记仍保存在当前浏览器。</p><h2>来源与授权</h2><p>古代经文属于公有领域，电子底本来源、页面修订号及处理规则见 <a href="SOURCES.md" target="_blank" rel="noopener noreferrer">SOURCES.md</a>。新增白话和提示按 CC BY-SA 4.0 提供。阅读界面改编自 <a href="https://github.com/Redwallen/liaofan-sizun" target="_blank" rel="noopener noreferrer">Redwallen 的 MIT 开源项目</a>，并在 Sunhow 的个人经典阅读器上继续改造。</p></div><a class="btn primary" href="#/ch/0">从《佛遗教经》开始 →</a>';
    view.innerHTML=html;
  }

  function toChineseNum(n) {
    return ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三'][n] || String(n);
  }

  /* ----------------------------- 章节页 ----------------------------- */
  function renderChapter(view, ci) {
    var ch = BOOK.chapters[ci];
    if (!ch) { view.innerHTML = '<div class="empty"><h2>没有这部经</h2></div>'; return; }
    var st = chapterStats(ch);
    var prev = BOOK.chapters[ci - 1], next = BOOK.chapters[ci + 1];

    var html = '';
    html += '<div class="crumb"><a href="#/">目录</a> / ' + escapeHtml(ch.title) + '</div>';
    html += '<header class="chapter-head">';
    html += '<div class="ch-no">建议阅读顺序 · 第 ' + toChineseNum(ci + 1) + ' 部 · 共 ' + ch.sections.length + ' 节</div>';
    html += '<h1>' + escapeHtml(ch.title) + '</h1>';
    if (ch.subtitle) html += '<div class="ch-sub">' + escapeHtml(ch.subtitle) + '</div>';
    html += '</header>';

    html += '<div class="overall"><div class="ring" style="--p:' + st.pct + '"><b>' + st.pct + '%</b></div>' +
            '<div class="overall-text"><strong>已读完 ' + st.done + ' / ' + st.total + ' 节</strong>' +
            '<span>' + (st.pct === 100 ? '这部经已经读完了。' : '一节一节来，不必急。') + '</span></div>' +
            '<a class="btn primary" href="#/read/' + ci + '/' + firstUnreadIndex(ch) + '">' +
            (st.done ? '继续阅读' : '开始阅读') + '</a></div>';

    if (ch.intro) html += '<div class="chapter-intro">' + paragraphs(ch.intro) + '</div>';
    html += '<details class="edition-note"><summary>版本与收录范围 · '+escapeHtml(ch.author)+'</summary><p>'+escapeHtml(ch.edition)+'</p><a href="'+escapeAttr(ch.source)+'" target="_blank" rel="noopener noreferrer">核对来源 ↗</a></details>';

    html += '<div class="sec-list">';
    ch.sections.forEach(function (sec, si) {
      var p = progress[sec.id] || {};
      html += '<a class="sec-item' + (p.done ? ' done' : '') + '" href="#/read/' + ci + '/' + si + '">';
      html += '<span class="sec-no">' + sec.number + '</span>';
      html += '<span class="sec-title">' + escapeHtml(sec.title) + '</span>';
      if (mynotes[sec.id] && mynotes[sec.id].text) html += '<span class="sec-meta">有笔记</span>';
      html += '<span class="sec-meta">' + sec.pairs.length + ' 段</span>';
      if (p.done) html += '<span class="sec-check">✓</span>';
      html += '</a>';
    });
    html += '</div>';

    html += '<div class="reader-foot">';
    if (prev) html += '<a class="btn ghost small" href="#/ch/' + (ci - 1) + '">← ' + escapeHtml(prev.title) + '</a>';
    html += '<span class="spacer"></span>';
    if (next) html += '<a class="btn ghost small" href="#/ch/' + (ci + 1) + '">' + escapeHtml(next.title) + ' →</a>';
    html += '</div>';

    view.innerHTML = html;
  }

  function paragraphs(text) {
    return String(text).split(/\n+/).filter(Boolean).map(function (p) {
      return '<p>' + escapeHtml(p) + '</p>';
    }).join('');
  }

  function firstUnreadIndex(ch) {
    for (var i = 0; i < ch.sections.length; i++) {
      if (!(progress[ch.sections[i].id] && progress[ch.sections[i].id].done)) return i;
    }
    return 0;
  }

  /* ----------------------------- 阅读页 ----------------------------- */
  function renderReader(view, ci, si) {
    var ch = BOOK.chapters[ci];
    if (!ch || !ch.sections[si]) { view.innerHTML = '<div class="empty"><h2>没有这一节</h2><p><a href="#/">回到目录</a></p></div>'; return; }
    var sec = ch.sections[si];
    if (settings.script === 'traditional') sec = Object.assign({},sec,{pairs:sec.pairs.map(function(p){return Object.assign({},p,{orig:p.traditional});}),notes:sec.notes.map(function(n){return Object.assign({},n,{term:n.traditional||n.term});})});
    var pr = secProgress(sec.id);
    save(LS.last, { ci: ci, si: si });

    state.reader = { ci: ci, si: si, id: sec.id };

    var html = '';
    html += '<div class="reader">';

    // 顶部
    html += '<div class="reader-top">';
    html += '<a href="#/ch/' + ci + '">' + escapeHtml(ch.title) + '</a><span>/</span>';
    html += '<span class="rt-title">第 ' + sec.number + ' 节</span>';
    html += '<span class="spacer"></span>';
    html += '<div class="seg-control">' +
            '<button data-mode="focus" class="' + (state.mode === 'focus' ? 'on' : '') + '">逐段精读</button>' +
            '<button data-mode="flow" class="' + (state.mode === 'flow' ? 'on' : '') + '">通篇对照</button></div>';
    html += '<button class="btn small ghost" id="speakSection">朗读</button>';
    if (state.mode === 'flow') html += '<button class="btn small ghost" id="toggleAll">全部展开</button>';
    html += '</div>';

    html += '<header class="sec-heading">';
    html += '<div class="sec-pos">' + escapeHtml(ch.title) + ' · ' + (si + 1) + ' / ' + ch.sections.length + '</div>';
    html += '<h1>' + escapeHtml(sec.title) + '</h1>';
    html += '</header>';

    html += '<div class="reading-context"><div><span class="eyebrow">本节提要</span><p>' + escapeHtml(sec.intro) + '</p></div><label class="passage-picker">段落目录<select id="passageSelect" aria-label="选择经文段落">' + sec.pairs.map(function(p,i){return '<option value="'+i+'"'+(i===pr.pos?' selected':'')+'>'+String(i+1).padStart(2,'0')+' · '+escapeHtml(p.label)+'</option>';}).join('') + (pr.pos >= sec.pairs.length ? '<option value="'+sec.pairs.length+'" selected>本节已读完</option>' : '') + '</select></label></div>';


    var allRevealed = sec.pairs.every(function (_, i) { return pr.revealed[i]; });
    var defaultShown = settings.defaultReveal === 'shown';

    if (state.mode === 'focus') {
      html += renderFocus(sec, pr, allRevealed, defaultShown);
    } else {
      html += renderFlow(sec, pr, defaultShown);
    }

    // 注释
    var paragraphNotes = state.mode === 'focus' && sec.pairs[pr.pos] ? sec.notes.filter(function(n){return sec.pairs[pr.pos].orig.includes(n.term);}) : sec.notes;
    if (paragraphNotes && paragraphNotes.length) {
      html += '<section class="panel"><div class="panel-head"><h3>名词注解</h3>' +
              '<span class="count">' + paragraphNotes.length + ' 条</span></div>' +
              '<div class="note-cards">';
      paragraphNotes.forEach(function (n) {
        html += '<div class="note-card"><b>' + escapeHtml(n.term) + '</b>' + escapeHtml(n.explain) + foundationLinks(n.term) + '</div>';
      });
      html += '</div></section>';
    }

    // 心得
    if (sec.insight) {
      html += '<section class="panel"><div class="panel-head"><h3>这一节在说什么</h3></div>' +
              '<div class="insight-card"><span class="ilabel">阅读线索</span>' + escapeHtml(sec.insight) + '</div></section>';
    }

    html += '<div class="source-note">'+escapeHtml(ch.author)+' · <a href="#/ch/'+ci+'">版本与目录</a><br>白话译文与阅读提示为 AI 辅助整理 · <a href="' + escapeAttr(sec.source) + '" target="_blank" rel="noopener noreferrer">核对本节原文 ↗</a></div>';
    var before = neighborSection(ci, si, -1), after = neighborSection(ci, si, 1);
    html += '<nav class="gua-neighbors" aria-label="相邻小节">' + (before ? '<a href="#/read/'+before.ci+'/'+before.si+'">← '+escapeHtml(before.sec.name)+'</a>':'<span>全书起点</span>') + '<a href="#/">经典书架</a>' + (after ? '<a href="#/read/'+after.ci+'/'+after.si+'">'+escapeHtml(after.sec.name)+' →</a>':'<span>全书终章</span>') + '</nav>';

    // 我的笔记
    html += '<section class="panel mynote-box"><div class="panel-head"><h3>我的笔记</h3>' +
            '<span class="spacer"></span><span class="count" id="noteState"></span></div>' +
            '<textarea aria-label="我的笔记" id="myNote" placeholder="写点自己的想法、疑问或要记住的话…（自动保存在本机）"></textarea>' +
            '</section>';

    html += '</div>';
    view.innerHTML = html;

    $('#passageSelect').addEventListener('change', function(e) { pr.pos = Number(e.target.value); touch(pr); persistProgress(); route(); if (state.mode === 'flow') { var selected = $('[data-pair="'+pr.pos+'"]'); if(selected) selected.scrollIntoView({block:'start',behavior:'smooth'}); } });

    // 恢复笔记
    var ta = $('#myNote');
    if (ta) {
      ta.value = (mynotes[sec.id] && mynotes[sec.id].text) || '';
      var stateEl = $('#noteState');
      if (ta.value) stateEl.textContent = '已保存';
      var timer = null;
      ta.addEventListener('input', function () {
        clearTimeout(timer);
        (function () {
          // 清空也要记录（空文本 = 已删除的墓碑），否则其它设备会把旧笔记传回来
          mynotes[sec.id] = { text: ta.value, at: Date.now() };
          var saved = persistNotes();
          if (!saved) { stateEl.textContent = '保存失败，请导出备份'; return; }
          stateEl.textContent = ta.value
            ? '已保存 ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
            : '已清空';
        })();
      });
    }
  }

  function renderTranslation(pair) {
    return '<span class="tlabel">白话译文</span><div class="plain-translation">' + escapeHtml(pair.trans) + '</div>' +
      (pair.annotation ? '<details class="reading-tip"><summary>阅读提示 · 背景与解释</summary><div>' + escapeHtml(pair.annotation) + '</div></details>' : '');
  }

  function renderFocus(sec, pr, allRevealed, defaultShown) {
    var pos = Math.min(pr.pos || 0, sec.pairs.length);
    var html = '<div class="focus-stage">';

    // 进度点
    html += '<div class="dots">';
    sec.pairs.forEach(function (_, i) {
      var cls = i === pos ? 'now' : (pr.revealed[i] || defaultShown || i < pos ? 'seen' : '');
      html += '<button type="button" aria-label="跳至' + escapeAttr(sec.pairs[i].label) + '" class="' + cls + '" data-dot="' + i + '"></button>';
    });
    html += '</div>';

    if (pos >= sec.pairs.length) {
      html += '<div class="finish-box" style="margin:auto">' +
              '<p>这一节的 ' + sec.pairs.length + ' 段都读完了。</p>' +
              '<button class="btn primary" id="markDone2">' + (pr.done ? '✓ 已读完（点击取消）' : '标记本节已读完') + '</button>' +
              '</div>';
      html += '</div>';
      html += renderFocusBar(sec, pr, pos, false, true);
      return html;
    }

    var pair = sec.pairs[pos];
    var shown = pr.revealed[pos] || defaultShown;
    html += '<div class="focus-body">';
    html += '<div class="passage-label">' + escapeHtml(pair.label) + ' <span>' + (pos + 1) + ' / ' + sec.pairs.length + '</span></div>';
    if (pair.citation) html += '<div class="passage-citation">出处：'+escapeHtml(pair.citation)+'</div>';
    html += '<p class="orig-line" tabindex="0" role="button" aria-label="展开本段白话" id="focusOrig">' + decorate(pair.orig, sec.notes) + '</p>';
    html += '<div class="trans-box' + (shown ? ' reveal' : '') + '" id="focusTrans"' + (shown ? '' : ' hidden') + '>' +
            renderTranslation(pair) + '</div>';
    html += '</div>';

    html += '</div>';
    html += renderFocusBar(sec, pr, pos, shown, false);
    return html;
  }

  /* 逐段精读的操作条：渲染在白色卡片之外，靠 CSS 固定在视口底部，始终可见。
     手机上没有键盘、也看不到「空格 →」的提示，所以读完整一节时这里必须给出
     一个能点的「下一节」，不能只靠滑动。 */
  function renderFocusBar(sec, pr, pos, shown, finished) {
    var prevS = neighborSection(state.reader.ci, state.reader.si, -1);
    var nextS = neighborSection(state.reader.ci, state.reader.si, 1);
    var canPrev = pos > 0 || !!prevS;

    var html = '<div class="focus-actions"><div class="fa-inner">';
    html += '<button class="btn small" id="prevPair"' + (canPrev ? '' : ' disabled') + '>上一段</button>';
    if (finished) {
      if (nextS) {
        html += '<a class="btn small primary" href="#/read/' + nextS.ci + '/' + nextS.si + '">下一节 →</a>';
      } else {
        html += '<a class="btn small primary" href="#/">回到目录</a>';
      }
    } else if (!shown) {
      html += '<button class="btn small primary" id="revealBtn">看白话</button>';
    } else if (pos < sec.pairs.length - 1) {
      html += '<button class="btn small primary" id="nextPair">下一段 →</button>';
    } else {
      html += '<button class="btn small primary" id="nextPair">读完了</button>';
    }
    var tip = finished
      ? (nextS ? '空格 → 下一节' : '这已经是书架最后一节')
      : '点原文也能显示白话 · 空格 → 下一段';
    html += '<span class="tip">' + tip + '</span>';
    html += '</div></div>';
    return html;
  }

  function renderFlow(sec, pr, defaultShown) {
    var html = '<div class="flow-list">';
    sec.pairs.forEach(function (pair, i) {
      var shown = pr.revealed[i] || defaultShown;
      html += '<div class="pair' + (shown ? ' opened' : '') + '" data-pair="' + i + '">';
      html += '<div class="passage-label">' + escapeHtml(pair.label) + '</div>';
      if (pair.citation) html += '<div class="passage-citation">出处：'+escapeHtml(pair.citation)+'</div>';
      html += '<p class="orig-line" tabindex="0" role="button" aria-label="切换本段白话">' + decorate(pair.orig, sec.notes) + '</p>';
      html += '<div class="pair-click-hint">点击这一段，看白话译文</div>';
      html += '<div class="trans-box reveal">' + renderTranslation(pair) + '</div>';
      html += '</div>';
    });
    html += '</div>';

    // 通篇模式没有逐句操作条，标记入口放在整节末尾
    html += '<div class="flow-foot"><button class="btn' + (pr.done ? '' : ' primary') + '" id="markDone">' +
            (pr.done ? '✓ 已读完（点击取消）' : '标记本节已读完') + '</button></div>';
    return html;
  }

  /* ----------------------------- 字词表 ----------------------------- */
  function renderGlossary(view) {
    var all = [];
    BOOK.chapters.forEach(function (ch, ci) {
      ch.sections.forEach(function (sec) {
        (sec.notes || []).forEach(function (n) {
          all.push({ term: n.term, explain: n.explain, ch: ci, chTitle: ch.title, sec: sec });
        });
      });
    });
    if (state.glossaryCh !== 'all') all = all.filter(function(n){return n.ch === state.glossaryCh;});
    // 去重（同一词条、同一解释）
    var seen = {}, uniq = [];
    all.forEach(function (n) {
      var k = n.term + '|' + n.explain;
      if (!seen[k]) { seen[k] = 1; uniq.push(n); }
    });
    uniq.sort(function (a, b) { return a.term.localeCompare(b.term, 'zh'); });

    var filtered = uniq;

    var html = '';
    html += '<div class="crumb"><a href="#/">目录</a> / 名词注解</div>';
    html += '<header class="chapter-head"><h1>名词注解</h1>' +
            '<div class="ch-sub">当前范围 ' + uniq.length + ' 条，按词语排序</div></header>';
    html += '<div class="glossary-filter">';
    html += '<button class="chip' + (state.glossaryCh === 'all' ? ' on' : '') + '" data-gch="all">全部</button>';
    BOOK.chapters.forEach(function (ch, ci) {
      html += '<button class="chip' + (state.glossaryCh === ci ? ' on' : '') + '" data-gch="' + ci + '">' + escapeHtml(ch.title) + '</button>';
    });
    html += '</div>';

    html += '<div class="glossary-grid">';
    filtered.forEach(function (n) {
      html += '<div class="gloss-item" data-goto="' + n.ch + '/' + BOOK.chapters[n.ch].sections.indexOf(n.sec) + '">';
      html += '<span class="g-ch">' + escapeHtml(n.chTitle) + '</span>';
      html += '<b>' + escapeHtml(n.term) + '</b>';
      html += '<p>' + escapeHtml(n.explain) + '</p>' + foundationLinks(n.term);
      html += '<div class="g-src">出自：' + escapeHtml(n.sec.title) + '</div>';
      html += '</div>';
    });
    html += '</div>';
    if (!filtered.length) html += '<div class="empty">这一类还没有词条。</div>';

    view.innerHTML = html;
  }

  /* ----------------------------- 我的笔记 ----------------------------- */
  function renderMyNotes(view) {
    var entries = [];
    BOOK.chapters.forEach(function (ch, ci) {
      ch.sections.forEach(function (sec, si) {
        if (mynotes[sec.id] && mynotes[sec.id].text) {
          entries.push({ ci: ci, si: si, ch: ch, sec: sec, text: mynotes[sec.id].text });
        }
      });
    });
    var html = '';
    html += '<div class="crumb"><a href="#/">目录</a> / 我的笔记</div>';
    html += '<header class="chapter-head"><h1>我的笔记</h1>' +
            '<div class="ch-sub">共 ' + entries.length + ' 条 · 只保存在本机浏览器</div></header>';
    if (!entries.length) {
      html += '<div class="empty"><h2>还没有笔记</h2><p>读到有想法的地方，在页面底部写几句，就会出现在这里。</p>' +
              '<p style="margin-top:16px"><a class="btn primary" href="#/">去阅读</a></p></div>';
    } else {
      html += '<div class="mynote-list">';
      entries.forEach(function (e) {
        html += '<div class="mynote-entry">';
        html += '<div class="me-head"><b>' + escapeHtml(e.sec.title) + '</b>' +
                '<span>' + escapeHtml(e.ch.title) + ' · 第 ' + e.sec.number + ' 节</span></div>';
        html += '<div class="me-body">' + escapeHtml(e.text) + '</div>';
        html += '<div class="me-actions"><a class="btn ghost small" href="#/read/' + e.ci + '/' + e.si + '">回到这一节</a></div>';
        html += '</div>';
      });
      html += '</div>';
    }
    view.innerHTML = html;
  }

  /* ----------------------------- 搜索 ----------------------------- */
  function buildIndex() {
    var idx = [];
    BOOK.chapters.forEach(function (ch, ci) {
      ch.sections.forEach(function (sec, si) {
        idx.push({
          ci: ci, si: si,
          chTitle: ch.title,
          title: ch.title + ' · ' + sec.title,
          orig: sec.pairs.map(function (p) { return p.orig + ' ' + p.traditional; }).join(''),
          trans: sec.pairs.map(function (p) { return p.trans; }).join(' '),
          notes: (sec.notes || []).map(function (n) { return n.term + '：' + n.explain; }).join(' ') + ' ' + sec.pairs.map(function(p){return p.label + ' ' + (p.annotation || '');}).join(' ')
        });
      });
    });
    FOUNDATIONS.forEach(function(t){idx.push({href:'#/basics/'+t.id,chTitle:'基础导读',title:t.title,orig:t.terms.join(' '),trans:t.summary+' '+t.paragraphs.join(' '),notes:t.misconception+' '+t.example});});
    return idx;
  }
  var SEARCH_INDEX = null;

  function doSearch(q) {
    if (!SEARCH_INDEX) SEARCH_INDEX = buildIndex();
    q = q.trim();
    if (!q) return [];
    var lq = q.toLowerCase();
    var res = [];
    SEARCH_INDEX.forEach(function (it) {
      var fields = [
        { name: 'title', text: it.title },
        { name: 'orig', text: it.orig },
        { name: 'trans', text: it.trans },
        { name: 'notes', text: it.notes }
      ];
      var best = null;
      fields.forEach(function (f) {
        var t = f.text, lt = t.toLowerCase(), i = lt.indexOf(lq);
        if (i === -1) return;
        var snippet = t.slice(Math.max(0, i - 24), i + q.length + 40);
        if (!best || f.name === 'title') best = { field: f.name, snippet: snippet, at: i };
      });
      if (best) {
        var score = (best.field === 'title' ? 100 : 0) + (best.field === 'orig' ? 10 : 0);
        res.push({ it: it, best: best, score: score, count: (it.orig.split(q).length - 1) + (it.trans.split(q).length - 1) });
      }
    });
    res.sort(function (a, b) { return (b.score + b.count * 3) - (a.score + a.count * 3); });
    return res;
  }

  function renderSearchResults(q) {
    var box = $('#searchResults');
    if (!q.trim()) {
      box.innerHTML = '<p class="search-hint">输入关键词，例如「知足」「十善」「无所住」「回向」。</p>';
      return;
    }
    var res = doSearch(q);
    if (!res.length) {
      box.innerHTML = '<p class="search-hint">没有找到「' + escapeHtml(q) + '」。换个词试试？</p>';
      return;
    }
    var html = '<div class="sr-group">找到 ' + res.length + ' 项结果</div>';
    res.slice(0, 40).forEach(function (r) {
      html += '<a class="sr-item" href="' + escapeAttr(r.it.href || '#/read/'+r.it.ci+'/'+r.it.si) + '">';
      html += '<div class="sr-ch">' + escapeHtml(r.it.chTitle) + '</div>';
      html += '<div class="sr-title">' + hl(r.it.title, q) + '</div>';
      html += '<div class="sr-text">' + hl(r.best.snippet, q) + '…</div>';
      html += '</a>';
    });
    box.innerHTML = html;
  }
  function hl(text, q) {
    var e = escapeHtml(text);
    var eq = escapeHtml(q);
    if (!eq) return e;
    try {
      return e.replace(new RegExp(eq.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), function (m) {
        return '<mark>' + m + '</mark>';
      });
    } catch (err) { return e; }
  }

  /* ----------------------------- 抽屉 / 弹层开关 ----------------------------- */
  function openSettings() {
    $('#settingsDrawer').hidden = false;
    $('#drawerMask').hidden = false;
    $('#closeSettings').focus();
  }
  function closeSettings() {
    $('#settingsDrawer').hidden = true;
    $('#drawerMask').hidden = true;
  }
  function openSearch() {
    $('#searchModal').hidden = false;
    $('#searchMask').hidden = false;
    var inp = $('#searchInput');
    inp.value = state.searchQuery || '';
    renderSearchResults(inp.value);
    setTimeout(function () { inp.focus(); }, 30);
  }
  function closeSearch() {
    $('#searchModal').hidden = true;
    $('#searchMask').hidden = true;
  }

  /* ----------------------------- 事件绑定 ----------------------------- */
  function bindOnce() {
    window.addEventListener('hashchange', route);

    $('#settingsBtn').addEventListener('click', openSettings);
    $('#tabSettings').addEventListener('click', openSettings);
    $('#closeSettings').addEventListener('click', closeSettings);
    $('#drawerMask').addEventListener('click', closeSettings);

    $('#searchBtn').addEventListener('click', openSearch);
    $('#closeSearch').addEventListener('click', closeSearch);
    $('#searchMask').addEventListener('click', closeSearch);
    $('#searchInput').addEventListener('input', function (e) {
      state.searchQuery = e.target.value;
      renderSearchResults(e.target.value);
    });

    // 设置项
    $$('.seg').forEach(function (seg) {
      seg.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-val]');
        if (!b) return;
        setSetting(seg.dataset.setting, b.dataset.val);
        if (seg.dataset.setting === 'script') { route(); }
        if (seg.dataset.setting === 'defaultMode') {
          // 立即切换当前阅读视图
          if (/^#\/read\//.test(location.hash)) {
            state.mode = b.dataset.val === 'flow' ? 'flow' : 'focus';
            route();
          } else {
            state.mode = b.dataset.val === 'flow' ? 'flow' : 'focus';
          }
        }
      });
    });

    $('#resetProgress').addEventListener('click', function () {
      var msg = '确定清除本网站的阅读进度与笔记吗？此操作不可撤销，请先导出备份。';
      if (!confirm(msg)) return;
      progress = {};
      mynotes = {};
      save(LS.progress, progress);
      save(LS.notes, mynotes);
      save(LS.last, null);
      toast('已清除');
      route();
    });

    // 主视图事件委托
    var view = $('#view');
    view.addEventListener('click', function (e) {
      var t = e.target;

      // 词条
      var term = t.closest('.term');
      if (term) { e.stopPropagation(); showPopover(term); return; }


      // 模式切换
      var modeBtn = t.closest('[data-mode]');
      if (modeBtn) { state.mode = modeBtn.dataset.mode; route(); return; }

      // 进度点
      var dot = t.closest('[data-dot]');
      if (dot && state.reader) {
        var pr = secProgress(state.reader.id);
        pr.pos = parseInt(dot.dataset.dot, 10);
        touch(pr); persistProgress();
        route();
        return;
      }

      // 逐句：看白话 / 上下句
      if ((t.closest('#revealBtn') || t.closest('#focusOrig')) && state.reader) {
        focusReveal();
        return;
      }
      if (t.closest('#nextPair') && state.reader) {
        focusNext();
        return;
      }
      if (t.closest('#prevPair') && state.reader) {
        focusPrev();
        return;
      }

      // 通篇：展开某句
      var pair = t.closest('.pair');
      if (pair && !t.closest('.term') && !t.closest('.trans-box')) {
        var i = parseInt(pair.dataset.pair, 10);
        pair.classList.toggle('opened');
        if (state.reader) {
          var pr5 = secProgress(state.reader.id);
          if (pair.classList.contains('opened')) pr5.revealed[i] = true;
          else delete pr5.revealed[i];
          touch(pr5); persistProgress();
        }
        return;
      }

      // 标记已读完
      if ((t.closest('#markDone') || t.closest('#markDone2')) && state.reader) {
        var pr6 = secProgress(state.reader.id);
        pr6.done = !pr6.done;
        touch(pr6); persistProgress();
        toast(pr6.done ? '已标记为读完' : '已取消标记');
        route();
        return;
      }

      // 朗读（整节）
      if (t.closest('#speakSection') && state.reader) {
        var sec2 = BOOK.chapters[state.reader.ci].sections[state.reader.si];
        speak(sec2.pairs.map(function (x) { return settings.script === 'traditional' ? x.traditional : x.orig; }).join(''));
        return;
      }

      // 通篇模式：全部展开 / 收起
      if (t.closest('#toggleAll') && state.reader) {
        var pairs = $$('.pair', view);
        var allOpen = pairs.length > 0 && pairs.every(function (p) { return p.classList.contains('opened'); });
        var prT = secProgress(state.reader.id);
        pairs.forEach(function (p) {
          var i = parseInt(p.dataset.pair, 10);
          p.classList.toggle('opened', !allOpen);
          if (allOpen) delete prT.revealed[i]; else prT.revealed[i] = true;
        });
        touch(prT); persistProgress();
        t.closest('#toggleAll').textContent = allOpen ? '全部展开' : '全部收起';
        return;
      }

      // 字词表筛选
      var chip = t.closest('[data-gch]');
      if (chip) {
        state.glossaryCh = chip.dataset.gch === 'all' ? 'all' : parseInt(chip.dataset.gch, 10);
        route();
        return;
      }
      if (t.closest('.foundation-link')) return;
      var gi = t.closest('[data-goto]');
      if (gi) {
        var parts = gi.dataset.goto.split('/');
        navigate('#/read/' + parts[0] + '/' + parts[1]);
        return;
      }
    });

    // 点击空白关闭浮层
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.term') && !e.target.closest('#popover')) hidePopover();
    });
    // 点击搜索结果后关闭搜索面板
    $('#searchResults').addEventListener('click', function (e) {
      if (e.target.closest('.sr-item')) closeSearch();
    });

    // 键盘
    document.addEventListener('keydown', function (e) {
      var typing = /INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '');
      if (e.key === 'Escape') { closeSearch(); closeSettings(); hidePopover(); return; }
      if (typing) return;
      if (!$('#searchModal').hidden || !$('#settingsDrawer').hidden) return;
      if (e.key === 'Enter' && document.activeElement && document.activeElement.matches('.orig-line')) { e.preventDefault(); document.activeElement.click(); return; }
      if (e.key === ' ' && document.activeElement && document.activeElement.matches('button,a,summary,[role=button]')) return;
      if (e.key === '/' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault(); openSearch(); return;
      }
      if (!state.reader || state.mode !== 'focus' || /^#\/read\//.test(location.hash) === false) return;
      if (e.key === ' ' || e.key === 'ArrowRight' || e.key === 'j') {
        e.preventDefault();
        focusAdvance();
      } else if (e.key === 'ArrowLeft' || e.key === 'k') {
        e.preventDefault();
        focusPrev();
      } else if (e.key === 'r') {
        e.preventDefault();
        focusReveal();
      }
    });

    // 手机滑动：左滑下一段（先展开白话），右滑上一段
    var touchStart = null;
    view.addEventListener('touchstart', function (e) {
      if (!state.reader || state.mode !== 'focus' || !/^#\/read\//.test(location.hash)) { touchStart = null; return; }
      var t = e.changedTouches[0];
      touchStart = { x: t.clientX, y: t.clientY, target: e.target };
    }, { passive: true });
    view.addEventListener('touchend', function (e) {
      var s = touchStart; touchStart = null;
      if (!s) return;
      var t = e.changedTouches[0];
      var dx = t.clientX - s.x, dy = t.clientY - s.y;
      // 水平位移要够大、且明显大于垂直位移，避免和滚动、点击冲突
      if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      var el = s.target;
      if (el && el.closest && (el.closest('.btn') || el.closest('.term') || el.closest('a') || el.closest('textarea') || el.closest('.dots'))) return;
      if (dx < 0) focusAdvance(); else focusPrev();
    }, { passive: true });

    window.addEventListener('resize', hidePopover);
    window.addEventListener('scroll', hidePopover, { passive: true });
  }

  /* ----------------------------- 启动 ----------------------------- */
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    var local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (location.protocol !== 'https:' && !local) return; // file:// 下不注册
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }

  function bindBackup() {
    $('#exportData').addEventListener('click', function(){
      var payload={format:'fojing-reader',version:1,exportedAt:new Date().toISOString(),progress:progress,notes:mynotes};
      var blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');
      a.href=url;a.download='fojing-backup-'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(function(){URL.revokeObjectURL(url);},3000);toast('已导出阅读备份');
    });
    $('#importData').addEventListener('click',function(){$('#importFile').click();});
    $('#importFile').addEventListener('change',async function(e){
      var file=e.target.files[0];if(!file)return;
      try{
        if(file.size>5*1024*1024)throw new Error('备份文件不能超过 5 MB');
        var data=JSON.parse(await file.text());
        if(data.format!=='fojing-reader'||data.version!==1||!data.notes||!data.progress||Array.isArray(data.notes)||Array.isArray(data.progress)||typeof data.notes!=='object'||typeof data.progress!=='object')throw new Error('请选择佛经精读导出的备份文件');
        var valid={};flatSections().forEach(function(e){valid[e.sec.id]=e.sec;});
        var incomingNotes={}, incomingProgress={};
        Object.keys(data.notes).forEach(function(id){
          var v=data.notes[id];if(!valid[id]||!v||typeof v.text!=='string'||v.text.length>200000||!Number.isFinite(v.at)||v.at<0)throw new Error('备份中的笔记格式不正确');
          incomingNotes[id]={text:v.text,at:v.at};
        });
        Object.keys(data.progress).forEach(function(id){
          var v=data.progress[id];if(!valid[id]||!v||typeof v.done!=='boolean'||!Number.isInteger(v.pos)||v.pos<0||v.pos>valid[id].pairs.length||!Number.isFinite(v.at)||v.at<0||!v.revealed||typeof v.revealed!=='object'||Array.isArray(v.revealed))throw new Error('备份中的进度格式不正确');
          var revealed={};Object.keys(v.revealed).forEach(function(k){if(!/^\d+$/.test(k)||Number(k)>=valid[id].pairs.length||v.revealed[k]!==true)throw new Error('备份中的句子标记不正确');revealed[k]=true;});
          incomingProgress[id]={done:v.done,pos:v.pos,at:v.at,revealed:revealed};
        });
        var count=Object.keys(incomingNotes).filter(function(k){return incomingNotes[k].text;}).length;
        if(!confirm('导入 '+count+' 条笔记和 '+Object.keys(incomingProgress).length+' 节阅读记录？同一节会保留修改时间较新的记录。'))return;
        Object.keys(incomingNotes).forEach(function(id){if(!mynotes[id]||incomingNotes[id].at>mynotes[id].at)mynotes[id]=incomingNotes[id];});
        Object.keys(incomingProgress).forEach(function(id){if(!progress[id]||incomingProgress[id].at>progress[id].at)progress[id]=incomingProgress[id];});
        var notesSaved=persistNotes(), progressSaved=persistProgress();route();toast(notesSaved&&progressSaved?'备份已合并导入':'导入到内存，存储失败，请立即导出备份');
      }catch(err){toast(err.message||'无法读取这个备份文件');}finally{e.target.value='';}
    });
  }

  function bindDialogAccessibility() {
    function trap(e){
      var dialog=!$('#settingsDrawer').hidden?$('#settingsDrawer'):(!$('#searchModal').hidden?$('#searchModal'):null);
      if(!dialog||e.key!=='Tab')return;
      var controls=$$('button,input,select,a[href]',dialog).filter(function(el){return !el.disabled&&!el.hidden&&el.getClientRects().length;});
      if(!controls.length)return;
      var first=controls[0],last=controls[controls.length-1];
      if(e.shiftKey&&(document.activeElement===first||!dialog.contains(document.activeElement))){e.preventDefault();last.focus();}
      else if(!e.shiftKey&&(document.activeElement===last||!dialog.contains(document.activeElement))){e.preventDefault();first.focus();}
    }
    document.addEventListener('keydown',trap);
  }

  function boot() {
    applySettings();
    bindOnce();
    bindBackup();
    bindDialogAccessibility();
    document.title = CONFIG.documentTitle || CONFIG.title + " · " + CONFIG.subtitle;
    $(".brand-text strong").textContent=CONFIG.title;
    $(".brand-text em").textContent=CONFIG.subtitle;
    route();
    registerSW();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
