import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('../js/sudoku.js');

const SIZES = [9, 16];

/** Проверка «в лоб»: строки, столбцы и блоки содержат все значения по одному разу. */
function assertValidFull(grid, size) {
  const boxRows = size === 9 ? 3 : 4;
  const boxCols = size === 9 ? 3 : 4;
  const want = new Set(Array.from({ length: size }, (_, i) => i));

  const lines = [];
  for (let r = 0; r < size; r++) {
    lines.push(Array.from({ length: size }, (_, c) => grid[r * size + c]));
  }
  for (let c = 0; c < size; c++) {
    lines.push(Array.from({ length: size }, (_, r) => grid[r * size + c]));
  }
  for (let br = 0; br < size; br += boxRows) {
    for (let bc = 0; bc < size; bc += boxCols) {
      const box = [];
      for (let i = br; i < br + boxRows; i++) {
        for (let j = bc; j < bc + boxCols; j++) box.push(grid[i * size + j]);
      }
      lines.push(box);
    }
  }

  for (const line of lines) {
    assert.deepEqual(new Set(line), want, `строка/столбец/блок несовпадает: ${line}`);
  }
}

for (const size of SIZES) {
  test(`generateSolution ${size}x${size} даёт корректное заполнение`, () => {
    const grid = E.generateSolution(size);
    assert.equal(grid.length, size * size);
    assertValidFull(grid, size);
    assert.deepEqual(E.findConflicts(grid, size), []);
    assert.ok(E.isComplete(grid, size));
  });

  test(`из решения ${size}x${size} решение единственное`, () => {
    const grid = E.generateSolution(size);
    assert.equal(E.countSolutions(grid, size, 2), 1);
  });
}

test('решение 9x9 лёгкого уровня единственное и совпадает с эталоном', () => {
  const { puzzle, solution } = E.generatePuzzle(9, 'easy');
  assert.equal(E.countSolutions(puzzle, 9, 2), 1);
  assert.deepEqual(E.solve(puzzle, 9), solution);
  assertValidFull(solution, 9);
  for (let i = 0; i < puzzle.length; i++) {
    if (puzzle[i] !== E.EMPTY) assert.equal(puzzle[i], solution[i]);
  }
});

test('пазл 16x16 имеет ровно одно решение', { timeout: 120000 }, () => {
  const { puzzle, solution, clues } = E.generatePuzzle(16, 'easy');
  assert.equal(puzzle.length, 256);
  assert.equal(E.countSolutions(puzzle, 16, 2), 1);
  assertValidFull(solution, 16);
  assert.ok(clues > 0 && clues < 256);
});

test('число подсказок уменьшается с ростом сложности', () => {
  const easy = E.targetClues(9, 'easy');
  const expert = E.targetClues(9, 'expert');
  assert.ok(easy > expert, `${easy} должно быть больше ${expert}`);
});

test('findConflicts находит дубль в строке', () => {
  const grid = new Array(81).fill(E.EMPTY);
  grid[0] = 5;
  grid[8] = 5; // одна строка, разные блоки
  assert.deepEqual(E.findConflicts(grid, 9).sort((a, b) => a - b), [0, 8]);
});

test('isValidPlacement учитывает строку, столбец и блок', () => {
  const grid = new Array(81).fill(E.EMPTY);
  grid[0] = 3;
  assert.equal(E.isValidPlacement(grid, 9, 1, 3), false); // строка
  assert.equal(E.isValidPlacement(grid, 9, 9, 3), false); // столбец
  assert.equal(E.isValidPlacement(grid, 9, 4, 3), false); // тот же блок 3x3
  assert.equal(E.isValidPlacement(grid, 9, 30, 3), true);
  assert.equal(E.isValidPlacement(grid, 9, 30, 9), false); // вне алфавита
});

test('алфавит: 9x9 — 1..9, 16x16 — 0..F', () => {
  assert.deepEqual(E.getConfig(9).symbols, ['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  assert.equal(E.getConfig(16).symbols[0], '0');
  assert.equal(E.getConfig(16).symbols[15], 'F');
  assert.equal(E.fromChar('f', 16), 15);
  assert.equal(E.fromChar('0', 9), E.EMPTY); // в классическом судоку нуля нет
  assert.equal(E.fromChar('9', 9), 8);
  assert.equal(E.fromChar('9', 16), 9);
  assert.equal(E.toChar(0, 9), '1');
  assert.equal(E.toChar(10, 16), 'A');
});

test('блок 16x16 — 4x4', () => {
  const cfg = E.getConfig(16);
  assert.equal(cfg.boxRows, 4);
  assert.equal(cfg.boxCols, 4);
  // строка(15) + столбец(15) + блок(15) минус двойной счёт клеток блока
  assert.equal(cfg.peers[0].length, 39);
  assert.equal(E.getConfig(9).peers[0].length, 20);
});
