/*
 * Интеграционный тест UI без браузера: минимальный DOM-стаб + реальные
 * index.html, js/sudoku.js и js/app.js. Проверяет связку «клик -> состояние
 * -> отрисовка -> сохранение», а не только движок.
 *
 * Стаб покрывает ровно тот подмножитель DOM API, которым пользуется app.js.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const E = require('../js/sudoku.js');

/* -------------------------------------------------------------- DOM stub */

class ClassList {
  constructor(el) { this.el = el; }
  get set() { return new Set((this.el._class || '').split(/\s+/).filter(Boolean)); }
  save(s) { this.el._class = [...s].join(' '); }
  add(...names) { const s = this.set; names.forEach((n) => s.add(n)); this.save(s); }
  remove(...names) { const s = this.set; names.forEach((n) => s.delete(n)); this.save(s); }
  contains(n) { return this.set.has(n); }
  toggle(n, force) {
    const s = this.set;
    const on = force === undefined ? !s.has(n) : !!force;
    if (on) s.add(n); else s.delete(n);
    this.save(s);
    return on;
  }
}

// Разбор намеренно упрощённый: плоские <span class="...">текст</span>,
// ровно как их генерирует app.js. Полноценный парсер здесь не нужен.
const FLAT_TAG = /<(\w+)([^>]*)>([^<]*)<\/\1>/g;

function parseFlat(html, parent) {
  let m;
  FLAT_TAG.lastIndex = 0;
  while ((m = FLAT_TAG.exec(html))) {
    const el = new El(m[1]);
    const cls = /class="([^"]*)"/.exec(m[2]);
    if (cls) el.className = cls[1];
    const data = /data-\w+="[^"]*"/.exec(m[2]);
    if (data) {
      const [, key, val] = /data-(\w+)="([^"]*)"/.exec(m[2]);
      el.dataset[key] = val;
    }
    el._text = m[3];
    el.parentNode = parent;
    parent.children.push(el);
  }
}

// Поддержка селекторов, которые реально использует app.js: '.class', 'TAG', '[data-x]'.
function matches(el, sel) {
  if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
  const attr = /^\[data-([\w-]+)\]$/.exec(sel);
  if (attr) return camel(attr[1]) in el.dataset;
  return el.tagName === sel.toUpperCase();
}

function camel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = { setProperty() {} };
    this.dataset = {};
    this.attrs = {};
    this.listeners = {};
    this._text = '';
    this._html = '';
    this._class = '';
    this.disabled = false;
    this.checked = false;
    this.classList = new ClassList(this);
  }
  get className() { return this._class; }
  set className(v) { this._class = v; }
  get textContent() {
    return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text;
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get innerHTML() {
    if (!this.children.length) return this._html;
    return this.children.map((c) => `<${c.tagName.toLowerCase()} class="${c.className}">${c.textContent}</${c.tagName.toLowerCase()}>`).join('');
  }
  set innerHTML(v) {
    this._html = v;
    this.children = [];
    parseFlat(v, this);
  }
  appendChild(child) {
    if (child._frag) { child.children.slice().forEach((c) => this.appendChild(c)); return child; }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (matches(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  closest(sel) {
    let node = this;
    while (node) {
      if (matches(node, sel)) return node;
      node = node.parentNode;
    }
    return null;
  }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  // Событие всплывает к предкам, как в браузере: обработчики висят на контейнерах.
  dispatch(type, ev = {}) {
    let node = this;
    while (node) {
      const target = this;
      (node.listeners[type] || []).forEach((fn) =>
        fn({ ...ev, target, currentTarget: node, preventDefault() {} })
      );
      node = node.parentNode;
    }
  }
  get offsetWidth() { return 100; }
  scrollIntoView() {}
}

function makeDoc() {
  const byId = {};
  return {
    documentElement: new El('html'),
    body: new El('body'),
    readyState: 'complete',
    hidden: false,
    getElementById: (id) => byId[id] || null,
    createElement: (tag) => new El(tag),
    createDocumentFragment: () => { const f = new El('fragment'); f._frag = true; return f; },
    addEventListener() {},
    _byId: byId
  };
}

/**
 * Создаёт элемент на каждый id из index.html, плюс вложенные <button>
 * (переключатели размера/сложности) — их крепим к ближайшему предку с id,
 * идущему раньше по разметке. Точное дерево здесь не нужно, важна привязка.
 */
function collectIds(html, doc) {
  const tagRe = /<(\w+)([^>]*)>/g;
  let current = doc.body;
  let m;
  while ((m = tagRe.exec(html))) {
    const [, tag, attrs] = m;
    if (attrs.endsWith('/')) continue; // самозакрывающиеся (svg-элементы) нам не нужны
    const idMatch = /\bid="([^"]+)"/.exec(attrs);
    const isButton = tag === 'button';
    if (!idMatch && !isButton) continue;

    const el = new El(tag);
    const cls = /class="([^"]+)"/.exec(attrs);
    if (cls) el.className = cls[1];
    const data = /\bdata-[\w-]+="[^"]*"/g;
    let d;
    while ((d = data.exec(attrs))) {
      const [, key, val] = /data-([\w-]+)="([^"]*)"/.exec(d[0]);
      el.dataset[camel(key)] = val;
    }
    if (tag === 'input') el.checked = attrs.includes('checked');

    if (idMatch) {
      el.id = idMatch[1];
      doc._byId[el.id] = el;
      current = el;
    } else {
      current.appendChild(el);
    }

    // app.js обращается к этим span'ам через querySelector — добавляем кнопкам.
    if ((cls && /\btool\b|icon-btn/.test(cls[1])) || /^btn-/.test(el.id || '')) {
      ['tool-ico', 'tool-label', 'icon-theme'].forEach((name) => {
        const s = new El('span');
        s.className = name;
        el.appendChild(s);
      });
    }
  }
}

/* ------------------------------------------------------------- окружение */

// app.js заводит setInterval для таймера; без очистки процесс теста не завершится.
const liveTimers = [];
after(() => liveTimers.splice(0).forEach((id) => clearInterval(id)));

function runApp(doc, localStorage) {
  const appSrc = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  const run = new Function(
    'window', 'document', 'localStorage', 'setTimeout', 'clearTimeout',
    'setInterval', 'clearInterval', 'Date', 'Math', 'JSON', 'console', appSrc
  );
  const setIntervalTracked = (fn, ms) => {
    const id = setInterval(fn, ms);
    liveTimers.push(id);
    return id;
  };
  run({ SudokuEngine: E, addEventListener() {} }, doc, localStorage,
    setTimeout, clearTimeout, setIntervalTracked, clearInterval, Date, Math, JSON, console);
}

function makeStorage(store) {
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };
}

function makeDocFromHtml(html) {
  const doc = makeDoc();
  collectIds(html, doc);
  return doc;
}

function boot() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const doc = makeDocFromHtml(html);
  const store = new Map();
  runApp(doc, makeStorage(store));
  return { doc, store };
}

/** Повторный запуск app.js поверх уже заполненного хранилища — «перезагрузка». */
function bootWith(store) {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const doc = makeDocFromHtml(html);
  runApp(doc, makeStorage(store));
  return { doc, store };
}

const tick = (ms) => new Promise((res) => setTimeout(res, ms));

function click(el) { el.dispatch('click', { target: el }); }

/** app.js выбирает клетку по pointerdown — эмулируем именно его. */
function tap(el) { el.dispatch('pointerdown', { target: el }); }

function clickDigit(doc, value) {
  const btn = doc.getElementById('pad-digits').children.find((b) => b.dataset.v === String(value));
  assert.ok(btn, `кнопка цифры ${value} не найдена`);
  click(btn);
}

function cellByIndex(doc, index) {
  return doc.getElementById('board').children.find((c) => Number(c.dataset.i) === index);
}

/** Текст именно крупной цифры, без заметок в той же клетке. */
function digitText(cell) {
  const digit = cell.children.find((c) => c.classList.contains('digit'));
  return digit ? digit.textContent.trim() : '';
}

function firstEmpty(doc) {
  return doc.getElementById('board').children.find((c) => !c.classList.contains('given'));
}

function saved(store) {
  return JSON.parse(store.get('hexdoku:v1'));
}

function savedStreak(store) {
  return JSON.parse(store.get('hexdoku:streak:v1') || 'null');
}

/** Заполняет и решает текущую партию до оверлея победы. */
async function solveCurrent(doc, store) {
  await tick(600);
  const solution = saved(store).game.solution;
  for (let i = 0; i < solution.length; i++) {
    const cell = cellByIndex(doc, i);
    if (cell.classList.contains('given')) continue;
    tap(cell);
    clickDigit(doc, solution[i]);
  }
  await tick(600);
}

function streakSquares(doc) {
  const weeks = doc.getElementById('streak-grid').children;
  return weeks.reduce((acc, w) => acc.concat(w.children), []);
}

/** Ждём, пока генерация (через setTimeout) не построит поле нужного размера. */
async function waitForCells(doc, count, timeoutMs = 30000) {
  const start = Date.now();
  while (doc.getElementById('board').children.length !== count) {
    if (Date.now() - start > timeoutMs) {
      assert.fail(`поле так и не построилось: ${doc.getElementById('board').children.length} вместо ${count}`);
    }
    await tick(50);
  }
}

/* ----------------------------------------------------------------- тесты */

test('init: поле 9x9 отрисовано, panel ввода собрана', async () => {
  const { doc } = boot();
  await waitForCells(doc, 81);
  const board = doc.getElementById('board');
  assert.ok(board.classList.contains('size-9'));

  const givens = board.children.filter((c) => c.classList.contains('given'));
  assert.ok(givens.length >= 20 && givens.length <= 60, `подсказок: ${givens.length}`);
  assert.equal(doc.getElementById('pad-digits').children.length, 9);
});

test('клик выбирает клетку, ввод цифры отображается', async () => {
  const { doc } = boot();
  await waitForCells(doc, 81);
  const cell = firstEmpty(doc);
  tap(cell);
  assert.ok(cell.classList.contains('selected'), 'клетка выбрана кликом');

  clickDigit(doc, 0); // внутреннее 0 -> символ "1"
  assert.equal(digitText(cellByIndex(doc, Number(cell.dataset.i))), '1');
});

test('кнопка «Стереть» очищает клетку', async () => {
  const { doc } = boot();
  await waitForCells(doc, 81);
  const cell = firstEmpty(doc);
  const idx = Number(cell.dataset.i);
  tap(cell);
  clickDigit(doc, 0);
  // После ввода выделение ушло на следующую пустую клетку — возвращаемся.
  tap(cellByIndex(doc, idx));
  click(doc.getElementById('btn-erase'));
  assert.equal(digitText(cellByIndex(doc, idx)), '');
});

test('undo/redo снимают и возвращают ввод', async () => {
  const { doc } = boot();
  await waitForCells(doc, 81);
  const cell = firstEmpty(doc);
  const idx = Number(cell.dataset.i);
  tap(cell);
  clickDigit(doc, 0);
  click(doc.getElementById('btn-undo'));
  assert.equal(digitText(cellByIndex(doc, idx)), '', 'undo снял ввод');
  click(doc.getElementById('btn-redo'));
  assert.equal(digitText(cellByIndex(doc, idx)), '1', 'redo вернул ввод');
});

test('подсказка ставит правильное значение и увеличивает счётчик', async () => {
  const { doc, store } = boot();
  await waitForCells(doc, 81);
  await tick(600);
  const before = saved(store).game;
  click(doc.getElementById('btn-hint'));
  await tick(600);
  const after = saved(store).game;
  const filledBefore = before.grid.filter((v) => v !== E.EMPTY).length;
  const filledAfter = after.grid.filter((v) => v !== E.EMPTY).length;
  assert.equal(filledAfter, filledBefore + 1, 'заполнена ровно одна клетка');
  assert.equal(after.hints, before.hints + 1);
  const changed = after.grid.findIndex((v, i) => v !== before.grid[i]);
  assert.equal(after.grid[changed], after.solution[changed], 'подсказка совпадает с решением');
});

test('режим заметок пишет кандидатов, а не цифру', async () => {
  const { doc, store } = boot();
  await waitForCells(doc, 81);
  const cell = firstEmpty(doc);
  const idx = Number(cell.dataset.i);
  tap(cell);
  click(doc.getElementById('btn-note'));
  clickDigit(doc, 3);
  await tick(600);
  const game = saved(store).game;
  assert.equal(game.grid[idx], E.EMPTY, 'в режиме заметок цифра не ставится');
  assert.notEqual(game.notes[idx] & (1 << 3), 0, 'заметка попала в битовую маску');
  assert.ok(cell.classList.contains('notes-only'), 'клетка помечена как «только заметки»');
});

test('переключение на 16x16: 256 клеток, 16 клавиш, алфавит 0-F', async () => {
  const { doc, store } = boot();
  await waitForCells(doc, 81);
  const btn16 = doc.getElementById('size-switch').children.find((b) => b.dataset.size === '16');
  click(btn16);
  await waitForCells(doc, 256);

  const board = doc.getElementById('board');
  assert.ok(board.classList.contains('size-16'));
  assert.equal(doc.getElementById('pad-digits').children.length, 16);

  await tick(600);
  const game = saved(store).game;
  assert.equal(game.size, 16);
  const symbols = E.getConfig(16).symbols;
  assert.equal(symbols[0], '0');
  assert.equal(symbols[15], 'F');
  const letters = game.grid.filter((v) => v !== E.EMPTY).map((v) => symbols[v]).filter((s) => s >= 'A');
  assert.ok(letters.length > 0, 'на поле есть буквы A–F');
});

test('решённая доска: оверлей победы и рекорд в хранилище', async () => {
  const { doc, store } = boot();
  await waitForCells(doc, 81);
  await tick(600);
  const solution = saved(store).game.solution;

  for (let i = 0; i < solution.length; i++) {
    const cell = cellByIndex(doc, i);
    if (cell.classList.contains('given')) continue;
    tap(cell);
    clickDigit(doc, solution[i]);
  }
  await tick(600);

  const data = saved(store);
  assert.ok(data.game.finished, 'игра помечена завершённой');
  assert.ok(data.best[`${data.game.size}:${data.game.difficulty}`] > 0, 'рекорд записан');
  const overlay = doc.getElementById('overlay');
  assert.ok(!overlay.classList.contains('hidden'), 'оверлей показан');
  assert.match(doc.getElementById('overlay-body').innerHTML, /Решено!/);
});

test('настройки сохраняются между сессиями', async () => {
  const { doc, store } = boot();
  await waitForCells(doc, 81);
  click(doc.getElementById('btn-theme'));
  const opt = doc.getElementById('opt-errors');
  opt.checked = false;
  opt.dispatch('change', {});
  await tick(600);
  const settings = saved(store).settings;
  assert.equal(settings.theme, 'light');
  assert.equal(settings.errors, false);
});

test('автопереход: выключение оставляет выделение на той же клетке', async () => {
  const { doc } = boot();
  await waitForCells(doc, 81);
  const opt = doc.getElementById('opt-autoadvance');
  const cell = firstEmpty(doc);
  const idx = Number(cell.dataset.i);

  tap(cell);
  clickDigit(doc, 0);
  const advancedTo = doc.getElementById('board').children.find((c) => c.classList.contains('selected'));
  assert.equal(Number(advancedTo.dataset.i) !== idx, true, 'по умолчанию выделение ушло вперёд');

  opt.checked = false;
  opt.dispatch('change', {});
  const cell2 = cellByIndex(doc, idx);
  tap(cell2);
  clickDigit(doc, 5);
  const stay = doc.getElementById('board').children.find((c) => c.classList.contains('selected'));
  assert.equal(Number(stay.dataset.i), idx, 'с автопереходом выделение осталось на месте');
});

test('кисть: цифра ставится кликом по клетке без предварительного выбора', async () => {
  const { doc, store } = boot();
  await waitForCells(doc, 81);

  // Заряжаем кисть значением 3 (в 9x9 это символ "4").
  click(doc.getElementById('btn-stamp'));
  clickDigit(doc, 3);
  await tick(600);
  assert.equal(saved(store).game.stampValue, 3, 'значение кисти сохранено');

  const target = firstEmpty(doc);
  const idx = Number(target.dataset.i);
  tap(target);
  assert.equal(digitText(cellByIndex(doc, idx)), '4', 'кисть поставила цифру');

  // Выделение при этом не двигается — кисть работает «поверх» выбора.
  const selected = doc.getElementById('board').children.filter((c) => c.classList.contains('selected'));
  assert.equal(selected.length, 0, 'кисть не выделяет клетки');

  // Клик по той же цифре выключает режим.
  clickDigit(doc, 3);
  await tick(600);
  assert.equal(saved(store).game.stampValue, -1, 'повторный клик по цифре гасит кисть');
});

test('кисть: несколько нажатий подряд красят клетки', async () => {
  const { doc } = boot();
  await waitForCells(doc, 81);
  click(doc.getElementById('btn-stamp'));
  // 0 («1») уже стоит краской по умолчанию, поэтому берём другую цифру.
  clickDigit(doc, 2);

  const board = doc.getElementById('board');
  const cells = board.children.filter((c) => !c.classList.contains('given')).slice(0, 3);
  cells.forEach((c) => tap(c));
  const painted = cells.filter((c) => digitText(cellByIndex(doc, Number(c.dataset.i))) === '3');
  assert.equal(painted.length, 3, 'все три клетки покрашены кистью');
});

test('кисть: клетки с выбранной цифрой подсвечиваются', async () => {
  const { doc } = boot();
  await waitForCells(doc, 81);

  // Ищем подсказку, которая точно не «1» (value=0), иначе клик по 0 гасит кисть.
  const board = doc.getElementById('board');
  const sample = board.children.find((c) => {
    const t = digitText(c);
    return c.classList.contains('given') && t !== '1';
  });
  const symbol = digitText(sample);
  const value = symbol.charCodeAt(0) - '1'.charCodeAt(0);

  click(doc.getElementById('btn-stamp'));
  clickDigit(doc, value);
  await tick(600);

  const matching = board.children.filter((c) => digitText(c) === symbol);
  assert.ok(matching.length > 0, 'на поле есть клетки с выбранной цифрой');
  matching.forEach((c) => {
    assert.ok(c.classList.contains('same'), `клетка «${symbol}» подсвечена как совпадение`);
  });

  // Цифры других значений не подсвечиваются.
  const other = board.children.find((c) => {
    const t = digitText(c);
    return t !== '' && t !== symbol;
  });
  assert.ok(other, 'на поле есть клетка с другой цифрой');
  assert.equal(other.classList.contains('same'), false, 'чужие цифры не подсвечены');

  // После выключения кисти подсветка уходит.
  clickDigit(doc, value);
  await tick(600);
  assert.equal(matching[0].classList.contains('same'), false, 'подсветка снята вместе с кистью');
});

test('кисть гасит выделение клетки', async () => {
  const { doc, store } = boot();
  await waitForCells(doc, 81);

  tap(firstEmpty(doc));
  const board = doc.getElementById('board');
  assert.equal(board.children.filter((c) => c.classList.contains('selected')).length, 1,
    'клетка выделена до включения кисти');

  click(doc.getElementById('btn-stamp'));
  await tick(600);
  assert.equal(board.children.filter((c) => c.classList.contains('selected')).length, 0,
    'с включением кисти выделение пропало');
  assert.equal(saved(store).game.selected, null, 'выделение сброшено и в состоянии');
});

test('кисть и заметки: кисть расставляет кандидатов, если заметки включены', async () => {
  const { doc, store } = boot();
  await waitForCells(doc, 81);
  const cell = firstEmpty(doc);
  const idx = Number(cell.dataset.i);

  click(doc.getElementById('btn-note'));
  click(doc.getElementById('btn-stamp'));
  clickDigit(doc, 5); // «6» — красим кисть шестёркой
  await tick(600);
  const game = saved(store).game;
  assert.equal(game.noteMode, true, 'заметки остались включены');
  assert.equal(game.stampValue, 5, 'кисть заряжена');

  tap(cell);
  await tick(600);
  const game2 = saved(store).game;
  assert.equal(game2.grid[idx], E.EMPTY, 'цифра не поставлена');
  assert.notEqual(game2.notes[idx] & (1 << 5), 0, 'заметка 6 попала в битовую маску');
  assert.ok(cellByIndex(doc, idx).classList.contains('notes-only'), 'клетка shows заметку');

  // Выключение заметок возвращает кисть к обычным цифрам.
  click(doc.getElementById('btn-note'));
  await tick(600);
  tap(cellByIndex(doc, idx));
  await tick(600);
  assert.equal(digitText(cellByIndex(doc, idx)), '6', 'кисть без заметок ставит цифру');
});

test('кисть не перезаписывает данные игрой подсказки', async () => {
  const { doc, store } = boot();
  await waitForCells(doc, 81);
  click(doc.getElementById('btn-stamp'));
  clickDigit(doc, 0);
  const givenCell = doc.getElementById('board').children.find((c) => c.classList.contains('given'));
  const idx = Number(givenCell.dataset.i);
  const before = digitText(givenCell);
  tap(givenCell);
  await tick(600);
  assert.equal(digitText(cellByIndex(doc, idx)), before, 'подсказка осталась нетронутой');
});

test('восстановление из хранилища: перезагрузка продолжает игру', async () => {
  const { doc, store } = boot();
  await waitForCells(doc, 81);
  const cell = firstEmpty(doc);
  const idx = Number(cell.dataset.i);
  tap(cell);
  clickDigit(doc, 4);
  await tick(600);
  const savedValue = saved(store).game.grid[idx];
  assert.notEqual(savedValue, E.EMPTY, 'ход записан в хранилище');

  const reloaded = bootWith(store);
  await waitForCells(reloaded.doc, 81);
  assert.equal(
    digitText(cellByIndex(reloaded.doc, idx)),
    E.toChar(savedValue, 9),
    'клетка восстановлена после перезагрузки'
  );
});

/* ------------------------------------------------------------------ streak */

test('серия: решённая партия окрашивает сегодняшний день в level 1', async () => {
  const { doc, store } = boot();
  await waitForCells(doc, 81);
  await solveCurrent(doc, store);

  const today = new Date();
  const key = today.getFullYear() + '-' + (today.getMonth() + 1) + '-' + today.getDate();
  const data = savedStreak(store);
  assert.ok(data, 'дневник серии записан в отдельный ключ');
  assert.equal(data[key].nine, true, 'отмечен режим 9×9');
  assert.equal(data[key].sixteen, false, 'шестнадцатеричный не отмечен');

  const doc2 = bootWith(store).doc;
  const squares = streakSquares(doc2);
  const todaySq = squares.filter((s) => s.classList.contains('today'));
  assert.equal(todaySq.length, 1, 'сегодняшний день подсвечен рамкой');
  assert.ok(todaySq[0].classList.contains('l1'), 'один режим — средний уровень');
  assert.match(doc2.getElementById('streak-count').textContent, /1 день/);
});

test('серия: второй решённый режим поднимает день до level 2', async () => {
  const { doc, store } = boot();
  await waitForCells(doc, 81);
  await solveCurrent(doc, store);

  // переключаемся на 16×16 и решаем её
  const btn16 = doc.getElementById('size-switch').children.find((b) => b.dataset.size === '16');
  click(btn16);
  await waitForCells(doc, 256);
  await solveCurrent(doc, store);

  const today = new Date();
  const key = today.getFullYear() + '-' + (today.getMonth() + 1) + '-' + today.getDate();
  const data = savedStreak(store);
  assert.equal(data[key].nine, true);
  assert.equal(data[key].sixteen, true, 'оба режима за один день');

  const squares = streakSquares(bootWith(store).doc);
  const todaySq = squares.find((s) => s.classList.contains('today'));
  assert.ok(todaySq.classList.contains('l2'), 'полный день — максимальный уровень');
});

test('серия: сетка 18 недель по 7 дней, прошлое пустое, будущее приглушено', async () => {
  const { doc } = boot();
  await waitForCells(doc, 81);

  const weeks = doc.getElementById('streak-grid').children;
  assert.equal(weeks.length, 18, '18 столбцов-недель');
  weeks.forEach((w) => assert.equal(w.children.length, 7, 'по 7 дней в неделе'));

  const squares = streakSquares(doc);
  assert.equal(squares.filter((s) => s.classList.contains('l0')).length > 100, true,
    'пустые дни заполняют сетку');
  // Сетка заканчивается субботой текущей недели: будущих клеток ровно
  // столько, сколько дней осталось до субботы (в субботу — ноль).
  const expectedFuture = 6 - new Date().getDay();
  assert.equal(squares.filter((s) => s.classList.contains('future')).length, expectedFuture,
    'будущие дни помечены');
  assert.equal(squares.filter((s) => s.classList.contains('today')).length, 1);
});

test('серия: восстановление решённой партии не добавляет день задним числом', async () => {
  const { doc, store } = boot();
  await waitForCells(doc, 81);
  await solveCurrent(doc, store);
  const before = JSON.stringify(savedStreak(store));

  // «Перезагрузка» поверх решённой игры: checkWin не должен ничего менять.
  bootWith(store);
  await tick(600);
  assert.equal(JSON.stringify(savedStreak(store)), before,
    'дневник не изменился при восстановлении');
});
