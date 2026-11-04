/*
 * Ядро судоку: генерация решения, генерация задания с единственным решением,
 * поиск конфликтов. Работает для 9x9 (блоки 3x3) и 16x16 (блоки 4x4, цифры 0-F).
 *
 * Значения клеток: 0..size-1 — цифра, EMPTY (-1) — пустая клетка.
 * -1, а не 0, потому что в 16x16 ноль — полноценная цифра.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.SudokuEngine = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EMPTY = -1;
  var DIGITS = '0123456789ABCDEF';

  // Классическое судоку печатают цифрами 1..9, а шестнадцатеричное — 0..F.
  // Внутренние значения всегда 0..size-1, алфавит — только способ их показать.
  var ALPHABETS = {
    9: '123456789',
    16: '0123456789ABCDEF'
  };

  // Ограничиваем перебор, чтобы генерация 16x16 не зависала на редких ветках.
  var SEARCH_NODE_LIMIT = 60000;

  var configs = {};

  function popcount(mask) {
    var c = 0;
    while (mask) {
      mask &= mask - 1;
      c++;
    }
    return c;
  }

  function getConfig(size) {
    if (configs[size]) return configs[size];
    var boxRows = size === 9 ? 3 : 4;
    var boxCols = size === 9 ? 3 : 4;
    var peers = [];
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        var set = [];
        var seen = {};
        var k, i, j;
        for (k = 0; k < size; k++) {
          if (k !== c) seen[r * size + k] = 1;
          if (k !== r) seen[k * size + c] = 1;
        }
        var br = Math.floor(r / boxRows) * boxRows;
        var bc = Math.floor(c / boxCols) * boxCols;
        for (i = br; i < br + boxRows; i++) {
          for (j = bc; j < bc + boxCols; j++) {
            if (i !== r || j !== c) seen[i * size + j] = 1;
          }
        }
        for (var key in seen) set.push(Number(key));
        set.sort(function (a, b) { return a - b; });
        peers[r * size + c] = set;
      }
    }
    var digits = [];
    for (var d = 0; d < size; d++) digits.push(d);
    configs[size] = {
      size: size,
      boxRows: boxRows,
      boxCols: boxCols,
      peers: peers,
      full: (1 << size) - 1,
      digits: digits,
      symbols: (ALPHABETS[size] || DIGITS).slice(0, size).split('')
    };
    return configs[size];
  }

  function shuffle(arr, rng) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  // Кандидаты клетки: битовая маска значений, не встречающихся у соседей.
  function candidatesOf(grid, index, cfg) {
    var used = 0;
    var peers = cfg.peers[index];
    for (var k = 0; k < peers.length; k++) {
      var v = grid[peers[k]];
      if (v !== EMPTY) used |= 1 << v;
    }
    return cfg.full & ~used;
  }

  /**
   * Контекст перебора. Кандидаты поддерживаются инкрементально, иначе
   * 16x16 на высоких сложностях считается минутами.
   *
   * used[index * size + v] — сколько соседей клетки index имеют значение v.
   * Значение v является кандидатом ровно при used === 0; маска кандидатов
   * mask[index] обновляется только в моменты перехода 0 -> 1 и 1 -> 0.
   * Простой битовой маски тут мало: значение могут запрещать два соседа
   * сразу, и откат одного из них не имеет права возвращать кандидат.
   */
  function refreshCell(ctx, index) {
    var cfg = ctx.cfg;
    var size = cfg.size;
    var base = index * size;
    var v;
    for (v = 0; v < size; v++) ctx.used[base + v] = 0;
    var peers = cfg.peers[index];
    for (var k = 0; k < peers.length; k++) {
      var pv = ctx.grid[peers[k]];
      if (pv !== EMPTY) ctx.used[base + pv]++;
    }
    if (ctx.grid[index] !== EMPTY) {
      ctx.mask[index] = 0;
      return;
    }
    var mask = cfg.full;
    for (v = 0; v < size; v++) {
      if (ctx.used[base + v] > 0) mask &= ~(1 << v);
    }
    ctx.mask[index] = mask;
  }

  function createContext(grid, cfg) {
    var ctx = {
      grid: grid,
      cfg: cfg,
      used: new Uint8Array(grid.length * cfg.size),
      mask: new Uint16Array(grid.length)
    };
    for (var i = 0; i < grid.length; i++) refreshCell(ctx, i);
    return ctx;
  }

  /** Ставит значение; false — если у какого-то соседа не осталось кандидатов. */
  function assign(ctx, index, value) {
    var size = ctx.cfg.size;
    var bit = 1 << value;
    var peers = ctx.cfg.peers[index];
    var alive = true;
    ctx.grid[index] = value;
    ctx.mask[index] = 0;
    for (var k = 0; k < peers.length; k++) {
      var p = peers[k];
      if (ctx.grid[p] !== EMPTY) continue;
      var slot = p * size + value;
      if (++ctx.used[slot] === 1) {
        ctx.mask[p] &= ~bit;
        if (ctx.mask[p] === 0) alive = false;
      }
    }
    return alive;
  }

  function unassign(ctx, index, value) {
    var size = ctx.cfg.size;
    var bit = 1 << value;
    var peers = ctx.cfg.peers[index];
    ctx.grid[index] = EMPTY;
    for (var k = 0; k < peers.length; k++) {
      var p = peers[k];
      if (ctx.grid[p] !== EMPTY) continue;
      var slot = p * size + value;
      if (--ctx.used[slot] === 0) ctx.mask[p] |= bit;
    }
    // У самой клетки счётчики пока не велись (она была занята) — пересчитываем.
    refreshCell(ctx, index);
  }

  // Эвристика MRV: клетка с наименьшим числом кандидатов — перебор сходится быстрее.
  function pickEmpty(ctx) {
    var mask = ctx.mask;
    var grid = ctx.grid;
    var best = -1;
    var bestMask = 0;
    var bestCount = Infinity;
    for (var i = 0; i < grid.length; i++) {
      if (grid[i] !== EMPTY) continue;
      var count = popcount(mask[i]);
      if (count < bestCount) {
        bestCount = count;
        best = i;
        bestMask = mask[i];
        if (count <= 1) break;
      }
    }
    if (best < 0) return null;
    return { index: best, mask: bestMask, count: bestCount };
  }

  function digitsOf(mask, cfg) {
    var out = [];
    for (var d = 0; d < cfg.size; d++) {
      if (mask & (1 << d)) out.push(d);
    }
    return out;
  }

  function range(n) {
    var out = [];
    for (var i = 0; i < n; i++) out.push(i);
    return out;
  }

  /**
   * Заполнение перебором со случайным порядком кандидатов.
   * Даёт хорошее смешивание, но на 16x16 иногда уходит в глубокую ветку —
   * поэтому ограничен узлами и при неудаче уступает место fallback ниже.
   */
  function randomBacktrackSolution(size, rng, nodeLimit) {
    var cfg = getConfig(size);
    var grid = new Array(size * size);
    for (var i = 0; i < grid.length; i++) grid[i] = EMPTY;
    var ctx = createContext(grid, cfg);
    var nodes = 0;

    function fill() {
      if (++nodes > nodeLimit) return false;
      var pick = pickEmpty(ctx);
      if (!pick) return true;
      if (pick.count === 0) return false;
      var options = shuffle(digitsOf(pick.mask, cfg), rng);
      for (var k = 0; k < options.length; k++) {
        if (assign(ctx, pick.index, options[k]) && fill()) return true;
        unassign(ctx, pick.index, options[k]);
      }
      return false;
    }

    return fill() ? grid : null;
  }

  /**
   * Резервное заполнение: канонический латинский квадрат плюс операции,
   * сохраняющие корректность (перестановка полос и строк внутри полосы,
   * то же для столбцов, транспонирование, пересимволизация).
   * Сложность строго O(size^2), отказ не возможен.
   */
  function symmetricSolution(size, rng) {
    var cfg = getConfig(size);
    var R = cfg.boxRows;
    var C = cfg.boxCols;
    var grid = new Array(size * size);
    var r, c, i;

    for (r = 0; r < size; r++) {
      for (c = 0; c < size; c++) {
        grid[r * size + c] = (R * (r % C) + Math.floor(r / C) + c) % size;
      }
    }

    // Порядок полос plus строки внутри полосы; lineSize — высота полосы.
    function permutedLines(lineSize) {
      var order = [];
      var bands = shuffle(range(size / lineSize), rng);
      for (var band = 0; band < bands.length; band++) {
        var inner = shuffle(range(lineSize), rng);
        for (var k = 0; k < lineSize; k++) order.push(bands[band] * lineSize + inner[k]);
      }
      return order;
    }

    var next = grid.slice();
    var order = permutedLines(R);
    for (r = 0; r < size; r++) {
      for (c = 0; c < size; c++) next[r * size + c] = grid[order[r] * size + c];
    }
    grid = next;

    next = grid.slice();
    order = permutedLines(C);
    for (r = 0; r < size; r++) {
      for (c = 0; c < size; c++) next[r * size + c] = grid[r * size + order[c]];
    }
    grid = next;

    if (R === C && rng() < 0.5) {
      next = grid.slice();
      for (r = 0; r < size; r++) {
        for (c = 0; c < size; c++) next[r * size + c] = grid[c * size + r];
      }
      grid = next;
    }

    var map = shuffle(range(size), rng);
    for (i = 0; i < grid.length; i++) grid[i] = map[grid[i]];

    return grid;
  }

  /** Случайное корректное заполнение всей доски. Всегда возвращает доску. */
  function generateSolution(size, rng) {
    rng = rng || Math.random;
    // На 9x9 перебор сходся мгновенно, на 16x16 лимит держим скромным.
    var budget = size === 9 ? SEARCH_NODE_LIMIT : 20000;
    return randomBacktrackSolution(size, rng, budget) || symmetricSolution(size, rng);
  }

  /**
   * Считает решения (не больше limit).
   * null — если перебор превысил nodeLimit: решение не доказано,
   * вызывающий код должен считать такой вариант неподходящим.
   */
  function countSolutions(grid, size, limit, nodeLimit) {
    limit = limit || 2;
    nodeLimit = nodeLimit || SEARCH_NODE_LIMIT;
    var cfg = getConfig(size);
    if (findConflicts(grid, size).length) return 0;
    var ctx = createContext(grid.slice(), cfg);
    var nodes = 0;
    var aborted = false;

    function rec() {
      if (aborted) return 0;
      if (++nodes > nodeLimit) {
        aborted = true;
        return 0;
      }
      var pick = pickEmpty(ctx);
      if (!pick) return 1;
      if (pick.count === 0) return 0;
      var total = 0;
      for (var d = 0; d < cfg.size; d++) {
        if (!(pick.mask & (1 << d))) continue;
        if (!assign(ctx, pick.index, d)) {
          unassign(ctx, pick.index, d);
          continue;
        }
        total += rec();
        unassign(ctx, pick.index, d);
        if (total >= limit || aborted) break;
      }
      return total;
    }

    var result = rec();
    return aborted ? null : result;
  }

  /** Первое найденное решение или null. */
  function solve(grid, size) {
    var cfg = getConfig(size);
    if (findConflicts(grid, size).length) return null;
    var ctx = createContext(grid.slice(), cfg);
    var nodes = 0;

    function rec() {
      if (++nodes > SEARCH_NODE_LIMIT) return false;
      var pick = pickEmpty(ctx);
      if (!pick) return true;
      if (pick.count === 0) return false;
      for (var d = 0; d < cfg.size; d++) {
        if (!(pick.mask & (1 << d))) continue;
        if (!assign(ctx, pick.index, d)) {
          unassign(ctx, pick.index, d);
          continue;
        }
        if (rec()) return true;
        unassign(ctx, pick.index, d);
      }
      return false;
    }

    return rec() ? ctx.grid.slice() : null;
  }

  /**
   * Сколько подсказок оставляем на поле. Для 16x16 значения выбраны по
   * замерам: ниже ~100 жадное удаление деградирует в десятки секунд,
   * поэтому «эксперт» здесь — 106, а не теоретический минимум.
   */
  var TARGET_CLUES = {
    9: { easy: 40, medium: 32, hard: 27, expert: 24 },
    16: { easy: 150, medium: 128, hard: 116, expert: 106 }
  };

  function targetClues(size, difficulty) {
    var table = TARGET_CLUES[size] || TARGET_CLUES[9];
    return table[difficulty] || table.easy;
  }

  /**
   * Готовое задание: из полного решения клетки удаляются по одной,
   * и удаление принимается только если решение осталось единственным.
   * Если время вышло на середине — возвращаем текущую доску: она всё равно
   * корректна, просто подсказок на ней больше, чем планировалось.
   */
  function generatePuzzle(size, difficulty, options) {
    options = options || {};
    var rng = options.rng || Math.random;
    var timeLimit = options.timeLimit || (size === 16 ? 8000 : 5000);
    var nodeLimit = options.nodeLimit || (size === 16 ? 60000 : SEARCH_NODE_LIMIT);
    var deadline = Date.now() + timeLimit;
    var target = options.targetClues || targetClues(size, difficulty);
    var total = size * size;

    var solution = generateSolution(size, rng);
    var puzzle = solution.slice();
    var filled = total;
    var all = [];
    for (var i = 0; i < total; i++) all.push(i);
    var order = shuffle(all, rng);

    for (var k = 0; k < order.length && filled > target; k++) {
      if (Date.now() > deadline) break;
      var idx = order[k];
      if (puzzle[idx] === EMPTY) continue;
      var backup = puzzle[idx];
      puzzle[idx] = EMPTY;
      var count = countSolutions(puzzle, size, 2, nodeLimit);
      // count === null значит «не доказали» — такую клетку оставляем на месте.
      if (count === 1) {
        filled--;
      } else {
        puzzle[idx] = backup;
      }
    }

    return {
      size: size,
      difficulty: difficulty,
      puzzle: puzzle,
      solution: solution,
      clues: filled
    };
  }

  /** Индексы клеток, значение которого повторяется в строке/столбце/блоке. */
  function findConflicts(grid, size) {
    var cfg = getConfig(size);
    var conflicts = [];
    for (var i = 0; i < grid.length; i++) {
      var v = grid[i];
      if (v === EMPTY) continue;
      var peers = cfg.peers[i];
      var found = false;
      for (var k = 0; k < peers.length; k++) {
        if (grid[peers[k]] === v) {
          found = true;
          break;
        }
      }
      if (found) conflicts.push(i);
    }
    return conflicts;
  }

  function isComplete(grid, size) {
    var cfg = getConfig(size);
    var seen = 0;
    for (var i = 0; i < grid.length; i++) {
      if (grid[i] === EMPTY) return false;
      seen |= 1 << grid[i];
    }
    return seen === cfg.full;
  }

  function isValidPlacement(grid, size, index, value) {
    var cfg = getConfig(size);
    if (value < 0 || value >= size) return false;
    var peers = cfg.peers[index];
    for (var k = 0; k < peers.length; k++) {
      if (grid[peers[k]] === value) return false;
    }
    return true;
  }

  function toChar(value, size) {
    var alpha = ALPHABETS[size] || DIGITS;
    return alpha.charAt(value);
  }

  /** Символ -> внутреннее значение с учётом алфавита размера. */
  function fromChar(ch, size) {
    if (ch == null) return EMPTY;
    var alpha = ALPHABETS[size] || DIGITS;
    return alpha.indexOf(String(ch).toUpperCase());
  }

  return {
    EMPTY: EMPTY,
    DIGITS: DIGITS,
    getConfig: getConfig,
    generateSolution: generateSolution,
    generatePuzzle: generatePuzzle,
    countSolutions: countSolutions,
    solve: solve,
    findConflicts: findConflicts,
    isComplete: isComplete,
    isValidPlacement: isValidPlacement,
    targetClues: targetClues,
    toChar: toChar,
    fromChar: fromChar
  };
});
