/*
 * UI судоку. Вся логика игры живёт здесь, генерация — в SudokuEngine.
 * Состояние целиком сериализуемо и складывается в localStorage, поэтому
 * игру можно закрыть и открыть позже (GitHub Pages, без сервера).
 */
(function () {
  'use strict';

  var E = window.SudokuEngine;
  var EMPTY = E.EMPTY;
  var STORE_KEY = 'hexdoku:v1';
  var MAX_HISTORY = 200;

  var DIFF_LABELS = { easy: 'Лёгкий', medium: 'Средний', hard: 'Сложный', expert: 'Эксперт' };

  var dom = {
    board: document.getElementById('board'),
    boardWrap: document.getElementById('board-wrap'),
    padDigits: document.getElementById('pad-digits'),
    pad: document.getElementById('pad'),
    statDiff: document.getElementById('stat-diff'),
    statTime: document.getElementById('stat-time'),
    statMistakes: document.getElementById('stat-mistakes'),
    statLeft: document.getElementById('stat-left'),
    sizeSwitch: document.getElementById('size-switch'),
    diffSwitch: document.getElementById('diff-switch'),
    btnNew: document.getElementById('btn-new'),
    btnErase: document.getElementById('btn-erase'),
    btnNote: document.getElementById('btn-note'),
    btnHint: document.getElementById('btn-hint'),
    btnUndo: document.getElementById('btn-undo'),
    btnRedo: document.getElementById('btn-redo'),
    btnPause: document.getElementById('btn-pause'),
    btnResume: document.getElementById('btn-resume'),
    btnTheme: document.getElementById('btn-theme'),
    btnRules: document.getElementById('btn-rules'),
    pauseCover: document.getElementById('pause-cover'),
    overlay: document.getElementById('overlay'),
    overlayBody: document.getElementById('overlay-body'),
    optErrors: document.getElementById('opt-errors'),
    optAutoNotes: document.getElementById('opt-autonotes'),
    optConflicts: document.getElementById('opt-conflicts'),
    saveNote: document.getElementById('save-note')
  };

  var state = null;
  var settings = { theme: 'dark', errors: true, autoNotes: true, conflicts: true };
  var best = {};
  var cells = [];
  var digitBtns = [];
  var history = [];
  var future = [];
  var tickTimer = null;
  var saveTimer = null;
  var generating = false;

  /* ------------------------------------------------------------------ utils */

  function fmtTime(ms) {
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    var mm = (h > 0 && m < 10 ? '0' : '') + m;
    var ss = (sec < 10 ? '0' : '') + sec;
    return h > 0 ? h + ':' + mm + ':' + ss : mm + ':' + ss;
  }

  function esc(str) {
    return String(str).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* -------------------------------------------------------------- new game */

  function freshState(size, difficulty) {
    var total = size * size;
    var grid = [];
    var notes = [];
    for (var i = 0; i < total; i++) {
      grid.push(EMPTY);
      notes.push(0);
    }
    return {
      size: size,
      difficulty: difficulty,
      puzzle: null,
      solution: null,
      grid: grid,
      notes: notes,
      given: [],
      selected: null,
      noteMode: false,
      mistakes: 0,
      hints: 0,
      clues: 0,
      elapsed: 0,
      paused: false,
      finished: false,
      startedAt: Date.now()
    };
  }

  function resetHistory() {
    history = [];
    future = [];
  }

  function snapshot() {
    return {
      grid: state.grid.slice(),
      notes: state.notes.slice(),
      mistakes: state.mistakes,
      hints: state.hints
    };
  }

  function pushHistory() {
    history.push(snapshot());
    if (history.length > MAX_HISTORY) history.shift();
    future.length = 0;
  }

  function applySnapshot(snap) {
    state.grid = snap.grid.slice();
    state.notes = snap.notes.slice();
    state.mistakes = snap.mistakes;
    state.hints = snap.hints;
  }

  function startTimer() {
    stopTimer();
    state.startedAt = Date.now();
    tickTimer = setInterval(function () {
      if (state.paused || state.finished) return;
      state.elapsed += Date.now() - state.startedAt;
      state.startedAt = Date.now();
      renderTime();
    }, 1000);
  }

  function stopTimer() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
  }

  function bankTime() {
    if (!state.paused && !state.finished && state.startedAt) {
      state.elapsed += Date.now() - state.startedAt;
    }
    state.startedAt = state.paused ? 0 : Date.now();
  }

  /**
   * Генерация идёт в main thread, поэтому показываем оверлей и даём браузеру
   * кадр на отрисовку до блокировки.
   */
  function newGame(size, difficulty, opts) {
    opts = opts || {};
    if (generating) return;
    generating = true;
    showOverlay(
      '<div class="center"><div class="spin"></div>' +
      '<h2 class="center">Генерируем ' + size + '×' + size + '</h2>' +
      '<p class="center">' + DIFF_LABELS[difficulty] + ' · единственный вариант решения…</p></div>'
    );

    setTimeout(function () {
      var data;
      try {
        data = E.generatePuzzle(size, difficulty);
      } catch (err) {
        hideOverlay();
        generating = false;
        showOverlay(
          '<h2>Не повезло</h2><p>' + esc(err.message) +
          '</p><div class="overlay-actions"><button class="btn btn-primary" data-act="retry">Ещё раз</button>' +
          '<button class="btn" data-act="close">Закрыть</button></div>'
        );
        return;
      }
      state = freshState(size, difficulty);
      state.puzzle = data.puzzle;
      state.solution = data.solution;
      state.grid = data.puzzle.slice();
      state.given = data.puzzle.map(function (v) { return v !== EMPTY; });
      state.clues = data.clues;
      state.finished = false;
      resetHistory();
      buildBoard();
      buildPad();
      syncSizeButtons();
      hideOverlay();
      generating = false;
      startTimer();
      renderAll();
      save();
      if (!opts.silent) dom.boardWrap.scrollTop = 0;
    }, 40);
  }

  /* ------------------------------------------------------------------- DOM */

  function buildBoard() {
    var cfg = E.getConfig(state.size);
    var size = state.size;
    dom.board.className = 'board size-' + size;
    dom.board.innerHTML = '';
    cells = [];
    var frag = document.createDocumentFragment();
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        var i = r * size + c;
        var cell = document.createElement('div');
        var cls = 'cell';
        if (Math.floor(r / cfg.boxRows) % 2 === Math.floor(c / cfg.boxCols) % 2) cls += ' box-alt';
        if (c % cfg.boxCols === cfg.boxCols - 1 && c !== size - 1) cls += ' edge-r';
        if (r % cfg.boxRows === cfg.boxRows - 1 && r !== size - 1) cls += ' edge-b';
        if (c === size - 1) cls += ' no-r';
        if (r === size - 1) cls += ' no-b';
        cell.className = cls;
        cell.setAttribute('role', 'gridcell');
        cell.dataset.i = String(i);
        var digit = document.createElement('span');
        digit.className = 'digit';
        var notes = document.createElement('span');
        notes.className = 'notes';
        for (var d = 0; d < size; d++) {
          var n = document.createElement('span');
          n.dataset.v = String(d);
          n.textContent = cfg.symbols[d];
          notes.appendChild(n);
        }
        cell.appendChild(digit);
        cell.appendChild(notes);
        frag.appendChild(cell);
        cells.push({ el: cell, digit: digit, notes: notes });
      }
    }
    dom.board.appendChild(frag);
  }

  function buildPad() {
    var cfg = E.getConfig(state.size);
    dom.padDigits.innerHTML = '';
    dom.padDigits.classList.toggle('cols-16', state.size === 16);
    digitBtns = [];
    for (var d = 0; d < state.size; d++) {
      var b = document.createElement('button');
      b.type = 'button';
      b.dataset.v = String(d);
      b.innerHTML = '<span>' + cfg.symbols[d] + '</span><span class="cnt">' + state.size + '</span>';
      dom.padDigits.appendChild(b);
      digitBtns.push(b);
    }
  }

  /* --------------------------------------------------------------- render */

  function renderAll() {
    renderCells();
    renderPad();
    renderStatus();
    renderTools();
  }

  function conflictSet() {
    if (!settings.conflicts && !settings.errors) return {};
    var map = {};
    var list = E.findConflicts(state.grid, state.size);
    for (var k = 0; k < list.length; k++) map[list[k]] = 1;
    return map;
  }

  function renderCells() {
    var cfg = E.getConfig(state.size);
    var conflicts = conflictSet();
    var sel = state.selected;
    var selValue = sel !== null && sel >= 0 ? state.grid[sel] : EMPTY;
    var peerSet = null;
    if (sel !== null) {
      peerSet = {};
      var peers = cfg.peers[sel];
      for (var p = 0; p < peers.length; p++) peerSet[peers[p]] = 1;
      peerSet[sel] = 1;
    }

    for (var i = 0; i < cells.length; i++) {
      var cell = cells[i];
      var v = state.grid[i];
      var hasNotes = state.notes[i] !== 0;

      cell.digit.textContent = v === EMPTY ? '' : cfg.symbols[v];
      cell.el.classList.toggle('given', !!state.given[i]);
      cell.el.classList.toggle('notes-only', v === EMPTY && hasNotes);

      for (var d = 0; d < state.size; d++) {
        var node = cell.notes.children[d];
        node.classList.toggle('on', (state.notes[i] & (1 << d)) !== 0);
      }

      var wrong = false;
      if (v !== EMPTY && !state.given[i]) {
        if (settings.errors && v !== state.solution[i]) wrong = true;
        else if (conflicts[i]) wrong = true;
      }
      cell.el.classList.toggle('error', wrong);
      cell.el.classList.toggle('selected', sel === i);
      cell.el.classList.toggle('peer', !!(peerSet && peerSet[i] && sel !== i));
      cell.el.classList.toggle(
        'same',
        selValue !== EMPTY && v === selValue && i !== sel &&
        !(peerSet && peerSet[i]) && v !== EMPTY
      );
    }
  }

  function renderPad() {
    var remaining = [];
    for (var d = 0; d < state.size; d++) remaining.push(0);
    for (var i = 0; i < state.grid.length; i++) {
      var v = state.grid[i];
      if (v !== EMPTY) remaining[v]++;
    }
    for (var k = 0; k < digitBtns.length; k++) {
      var left = state.size - remaining[k];
      digitBtns[k].querySelector('.cnt').textContent = left > 0 ? left : '';
      digitBtns[k].classList.toggle('done', left <= 0);
    }
  }

  function renderStatus() {
    dom.statDiff.textContent = DIFF_LABELS[state.difficulty] + ' · ' + state.size + '×' + state.size;
    renderTime();
    dom.statMistakes.textContent = String(state.mistakes);
    dom.statMistakes.classList.toggle('is-bad', state.mistakes > 0);
    var empty = 0;
    for (var i = 0; i < state.grid.length; i++) if (state.grid[i] === EMPTY) empty++;
    dom.statLeft.textContent = state.finished ? 'готово' : String(empty);
  }

  function renderTime() {
    dom.statTime.textContent = state.paused ? 'пауза' : fmtTime(state.elapsed);
  }

  function renderTools() {
    dom.btnNote.setAttribute('aria-pressed', state.noteMode ? 'true' : 'false');
    dom.btnUndo.disabled = history.length === 0;
    dom.btnRedo.disabled = future.length === 0;
    dom.btnPause.querySelector('.tool-label').textContent = state.paused ? 'Продолжить' : 'Пауза';
    dom.pauseCover.classList.toggle('hidden', !state.paused);
    dom.btnHint.disabled = state.finished;
  }

  /* ----------------------------------------------------------------- input */

  function select(i) {
    if (state.finished || state.paused) return;
    if (state.selected === i) return;
    state.selected = i;
    renderCells();
    scheduleSave();
  }

  function moveSelection(dr, dc) {
    if (state.selected === null) { select(0); return; }
    var size = state.size;
    var r = Math.floor(state.selected / size) + dr;
    var c = (state.selected % size) + dc;
    if (r < 0) r = 0;
    if (c < 0) c = 0;
    if (r > size - 1) r = size - 1;
    if (c > size - 1) c = size - 1;
    select(r * size + c);
    ensureVisible(state.selected);
  }

  function ensureVisible(i) {
    var el = cells[i] && cells[i].el;
    if (!el || !el.scrollIntoView) return;
    if (el.scrollIntoViewBlock) el.scrollIntoViewBlock({ block: 'nearest', inline: 'nearest' });
    else el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function removeNoteFromPeers(index, value) {
    var peers = E.getConfig(state.size).peers[index];
    for (var k = 0; k < peers.length; k++) {
      state.notes[peers[k]] &= ~(1 << value);
    }
  }

  function input(value) {
    if (!canPlay()) return;
    var i = state.selected;
    if (i === null) return;
    if (state.given[i]) return;

    if (state.noteMode) {
      if (state.grid[i] !== EMPTY) return;
      pushHistory();
      var bit = 1 << value;
      state.notes[i] ^= bit;
      renderCells();
      renderStatus();
      scheduleSave();
      return;
    }

    if (state.grid[i] === value) return;
    pushHistory();
    state.grid[i] = value;
    state.notes[i] = 0;
    if (settings.autoNotes) removeNoteFromPeers(i, value);

    if (value !== state.solution[i]) {
      state.mistakes++;
    } else {
      var cfg = E.getConfig(state.size);
      var peers = cfg.peers[i];
      for (var p = 0; p < peers.length; p++) state.notes[peers[p]] &= ~(1 << value);
    }

    autoAdvance();
    renderAll();
    scheduleSave();
    checkWin();
  }

  function autoAdvance() {
    // Следующая пустая клетка — удобно вводить подряд на телефоне.
    var size = state.size;
    var start = state.selected;
    for (var step = 1; step <= size * size; step++) {
      var j = (start + step) % (size * size);
      if (state.grid[j] === EMPTY && !state.given[j]) { state.selected = j; return; }
    }
  }

  function erase() {
    if (!canPlay()) return;
    var i = state.selected;
    if (i === null || state.given[i]) return;
    if (state.grid[i] === EMPTY && state.notes[i] === 0) return;
    pushHistory();
    state.grid[i] = EMPTY;
    state.notes[i] = 0;
    renderAll();
    scheduleSave();
  }

  function toggleNoteMode(force) {
    state.noteMode = typeof force === 'boolean' ? force : !state.noteMode;
    renderTools();
    scheduleSave();
  }

  function undo() {
    if (!canPlay() || !history.length) return;
    future.push(snapshot());
    applySnapshot(history.pop());
    renderAll();
    scheduleSave();
  }

  function redo() {
    if (!canPlay() || !future.length) return;
    history.push(snapshot());
    applySnapshot(future.pop());
    renderAll();
    scheduleSave();
  }

  function hint() {
    if (!canPlay()) return;
    var i = state.selected;
    var candidates = [];
    if (i !== null && !state.given[i] && state.grid[i] !== state.solution[i]) {
      candidates.push(i);
    } else {
      for (var k = 0; k < state.grid.length; k++) {
        if (!state.given[k] && state.grid[k] !== state.solution[k]) candidates.push(k);
      }
    }
    if (!candidates.length) return;
    var target = candidates[Math.floor(Math.random() * candidates.length)];
    pushHistory();
    state.grid[target] = state.solution[target];
    state.notes[target] = 0;
    state.hints++;
    state.selected = target;
    removeNoteFromPeers(target, state.solution[target]);
    renderAll();
    var el = cells[target].el;
    el.classList.remove('hint-flash');
    void el.offsetWidth;
    el.classList.add('hint-flash');
    scheduleSave();
    checkWin();
  }

  function canPlay() {
    return !!state && !state.finished && !state.paused && !generating;
  }

  function togglePause() {
    if (!state || state.finished) return;
    bankTime();
    state.paused = !state.paused;
    state.startedAt = state.paused ? 0 : Date.now();
    renderTools();
    renderTime();
    scheduleSave();
  }

  /* ------------------------------------------------------------------ win */

  function checkWin() {
    if (state.finished) return;
    for (var i = 0; i < state.grid.length; i++) {
      if (state.grid[i] !== state.solution[i]) return;
    }
    bankTime();
    state.finished = true;
    state.paused = false;
    var key = state.size + ':' + state.difficulty;
    var prev = best[key];
    var isRecord = !prev || prev > state.elapsed;
    if (isRecord) best[key] = state.elapsed;
    renderAll();
    save();
    var bestText = fmtTime(best[key]);
    showOverlay(
      '<h2 class="center">Решено!</h2>' +
      '<p class="center">' + state.size + '×' + state.size + ' · ' + DIFF_LABELS[state.difficulty] +
      (isRecord ? ' · новый рекорд' : '') + '</p>' +
      '<div class="win-stats">' +
      '<div><span>Время</span><b>' + fmtTime(state.elapsed) + '</b></div>' +
      '<div><span>Ошибки</span><b>' + state.mistakes + '</b></div>' +
      '<div><span>Подсказки</span><b>' + state.hints + '</b></div>' +
      '</div>' +
      '<p class="center">Лучшее результат в этом режиме: ' + bestText + '</p>' +
      '<div class="overlay-actions">' +
      '<button class="btn btn-primary" data-act="new">Новая игра</button>' +
      '<button class="btn" data-act="board">Показать поле</button>' +
      '</div>'
    );
  }

  /* -------------------------------------------------------------- overlays */

  function showOverlay(html) {
    dom.overlayBody.innerHTML = html;
    dom.overlay.classList.remove('hidden');
  }

  function hideOverlay() {
    dom.overlay.classList.add('hidden');
  }

  function rulesHtml() {
    return '<h2>Как играть</h2>' +
      '<p>Заполните поле так, чтобы в каждой строке, каждом столбце и каждом жирном блоке ' +
      'каждая цифра встречалась ровно один раз.</p>' +
      '<h3>16×16</h3>' +
      '<p>Шестнадцатеричная версия: блоки 4×4, цифры <kbd>0</kbd>…<kbd>9</kbd>, <kbd>A</kbd>…<kbd>F</kbd> ' +
      '(это значения 0…15).</p>' +
      '<h3>Управление</h3>' +
      '<ul>' +
      '<li>Клик или тап по клетке — выбрать, затем цифра на панели или с клавиатуры.</li>' +
      '<li>Стрелки — перемещение по полю, <kbd>Backspace</kbd> / <kbd>Delete</kbd> — стереть.</li>' +
      '<li><kbd>N</kbd> — режим заметок, <kbd>H</kbd> — подсказка, <kbd>P</kbd> — пауза.</li>' +
      '<li><kbd>Ctrl</kbd>+<kbd>Z</kbd> — отменить, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> — вернуть.</li>' +
      '<li>На телефоне можно вести пальцем по клеткам, чтобы выбрать нужную.</li>' +
      '</ul>' +
      '<p>Прогресс и рекорды хранятся только в этом браузере (localStorage), ничего не отправляется.</p>' +
      '<div class="overlay-actions"><button class="btn btn-primary" data-act="close">Понятно</button></div>';
  }

  /* ----------------------------------------------------------------- store */

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 350);
  }

  function save() {
    try {
      var payload = { v: 1, settings: settings, best: best };
      if (state) {
        bankTime();
        payload.game = {
          size: state.size,
          difficulty: state.difficulty,
          puzzle: state.puzzle,
          solution: state.solution,
          grid: state.grid,
          notes: state.notes,
          mistakes: state.mistakes,
          hints: state.hints,
          elapsed: state.elapsed,
          finished: state.finished,
          paused: state.paused,
          noteMode: state.noteMode,
          selected: state.selected,
          clues: state.clues
        };
      }
      localStorage.setItem(STORE_KEY, JSON.stringify(payload));
      dom.saveNote.textContent = 'Сохранено в этом браузере · ' + new Date().toLocaleTimeString();
    } catch (err) {
      dom.saveNote.textContent = 'Не удалось сохранить прогресс (localStorage недоступен)';
    }
  }

  function loadStored() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      return data && data.v === 1 ? data : null;
    } catch (err) {
      return null;
    }
  }

  function restoreGame(g) {
    state = freshState(g.size, g.difficulty);
    state.puzzle = g.puzzle;
    state.solution = g.solution;
    state.grid = g.grid;
    state.notes = g.notes;
    state.given = g.puzzle.map(function (v) { return v !== EMPTY; });
    state.mistakes = g.mistakes || 0;
    state.hints = g.hints || 0;
    state.elapsed = g.elapsed || 0;
    state.finished = !!g.finished;
    state.paused = !!g.paused;
    state.noteMode = !!g.noteMode;
    state.selected = typeof g.selected === 'number' ? g.selected : null;
    state.clues = g.clues;
    resetHistory();
    buildBoard();
    buildPad();
    startTimer();
    renderAll();
    if (state.finished) checkWin();
  }

  function applySettings() {
    document.documentElement.setAttribute('data-theme', settings.theme);
    dom.btnTheme.querySelector('.icon-theme').textContent = settings.theme === 'dark' ? '☀' : '☾';
    dom.optErrors.checked = settings.errors;
    dom.optAutoNotes.checked = settings.autoNotes;
    dom.optConflicts.checked = settings.conflicts;
  }

  function syncSizeButtons() {
    var list = dom.sizeSwitch.querySelectorAll('.seg-btn');
    for (var i = 0; i < list.length; i++) {
      list[i].classList.toggle('is-active', Number(list[i].dataset.size) === state.size);
    }
    var diffs = dom.diffSwitch.querySelectorAll('.seg-btn');
    for (var k = 0; k < diffs.length; k++) {
      diffs[k].classList.toggle('is-active', diffs[k].dataset.diff === state.difficulty);
    }
  }

  /* --------------------------------------------------------------- events */

  var dragging = false;

  function bindBoard() {
    dom.board.addEventListener('pointerdown', function (e) {
      if (!canPlay()) return;
      var cell = e.target.closest('.cell');
      if (!cell) return;
      dragging = true;
      select(Number(cell.dataset.i));
    });
    dom.board.addEventListener('pointermove', function (e) {
      if (!dragging || !canPlay()) return;
      var el = document.elementFromPoint(e.clientX, e.clientY);
      var cell = el && el.closest ? el.closest('.cell') : null;
      if (cell) select(Number(cell.dataset.i));
    });
    window.addEventListener('pointerup', function () { dragging = false; });
    window.addEventListener('pointercancel', function () { dragging = false; });
    // Долгое нажатие на телефоне не должно открывать системное контекстное меню.
    dom.board.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  function bindControls() {
    dom.sizeSwitch.addEventListener('click', function (e) {
      var btn = e.target.closest('.seg-btn');
      if (!btn || generating) return;
      var size = Number(btn.dataset.size);
      if (state && state.size === size && !state.finished) return;
      newGame(size, state ? state.difficulty : 'easy');
    });

    dom.diffSwitch.addEventListener('click', function (e) {
      var btn = e.target.closest('.seg-btn');
      if (!btn || generating) return;
      var diff = btn.dataset.diff;
      if (state && state.difficulty === diff && !state.finished) return;
      newGame(state ? state.size : 9, diff);
    });

    dom.btnNew.addEventListener('click', function () {
      newGame(state ? state.size : 9, state ? state.difficulty : 'easy');
    });
    dom.padDigits.addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (btn) input(Number(btn.dataset.v));
    });
    dom.btnErase.addEventListener('click', erase);
    dom.btnNote.addEventListener('click', function () { toggleNoteMode(); });
    dom.btnHint.addEventListener('click', hint);
    dom.btnUndo.addEventListener('click', undo);
    dom.btnRedo.addEventListener('click', redo);
    dom.btnPause.addEventListener('click', togglePause);
    dom.btnResume.addEventListener('click', togglePause);
    dom.btnTheme.addEventListener('click', function () {
      settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
      applySettings();
      save();
    });
    dom.btnRules.addEventListener('click', function () { showOverlay(rulesHtml()); });

    dom.optErrors.addEventListener('change', function () {
      settings.errors = dom.optErrors.checked;
      renderCells();
      save();
    });
    dom.optAutoNotes.addEventListener('change', function () {
      settings.autoNotes = dom.optAutoNotes.checked;
      save();
    });
    dom.optConflicts.addEventListener('change', function () {
      settings.conflicts = dom.optConflicts.checked;
      renderCells();
      save();
    });

    dom.overlay.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) {
        if (e.target === dom.overlay) hideOverlay();
        return;
      }
      var act = btn.dataset.act;
      if (act === 'new' || act === 'retry') {
        hideOverlay();
        newGame(state ? state.size : 9, state ? state.difficulty : 'easy');
      } else hideOverlay();
    });

    document.addEventListener('keydown', onKey);

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (state && !state.finished && !state.paused) {
          bankTime();
          state.paused = true;
          state.startedAt = 0;
          renderTools();
          renderTime();
        }
        save();
      }
    });
    window.addEventListener('pagehide', function () { save(); });
  }

  function onKey(e) {
    if (!state) return;
    var overlayOpen = !dom.overlay.classList.contains('hidden');
    if (overlayOpen) {
      if (e.key === 'Escape') hideOverlay();
      return;
    }
    var k = e.key;
    var lower = k.length === 1 ? k.toLowerCase() : k;

    if ((e.ctrlKey || e.metaKey) && lower === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && lower === 'y') { e.preventDefault(); redo(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    switch (lower) {
      case 'arrowup': e.preventDefault(); moveSelection(-1, 0); return;
      case 'arrowdown': e.preventDefault(); moveSelection(1, 0); return;
      case 'arrowleft': e.preventDefault(); moveSelection(0, -1); return;
      case 'arrowright': e.preventDefault(); moveSelection(0, 1); return;
      case 'backspace': case 'delete': case ' ': e.preventDefault(); erase(); return;
      case 'n': toggleNoteMode(); return;
      case 'h': hint(); return;
      case 'p': togglePause(); return;
      case 'escape': state.selected = null; renderCells(); return;
      default: break;
    }

    var value = E.fromChar(k, state ? state.size : 9);
    if (value !== EMPTY) {
      e.preventDefault();
      input(value);
    }
  }

  /* ----------------------------------------------------------------- start */

  function init() {
    var stored = loadStored();
    if (stored && stored.settings) {
      settings = Object.assign(settings, stored.settings);
      best = stored.best || {};
    }
    applySettings();

    var restored = false;
    if (stored && stored.game && stored.game.puzzle && stored.game.grid &&
        stored.game.grid.length === stored.game.size * stored.game.size) {
      restoreGame(stored.game);
      syncSizeButtons();
      restored = true;
    }

    bindBoard();
    bindControls();

    if (!restored) {
      newGame(9, 'easy');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
