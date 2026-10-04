// Метки экранов на полосе плеера: позиции, выбор под курсором, подсветка, место карточки.
import { strict as assert } from "node:assert";
import { cardLeft, markAt, marksOf, pickMark } from "../../web/js/records/marks.js";

const frames = [
  { frame: "slides/s002.jpg", t0: 50, t1: 80, title: "Kafka" },
  { frame: "slides/s001.jpg", t0: 0, title: "Титул" },          // без t1 — до следующего
  { frame: "slides/s003.jpg", t0: 90 },                        // последний — до конца записи
  { frame: "slides/bad.jpg", t0: 120 },                        // за пределами записи
  { frame: "slides/nan.jpg", t0: NaN },
];
const marks = marksOf(frames, 100);
assert.deepEqual(marks.map((m) => m.t0), [0, 50, 90], "по времени, без мусора и хвоста");
assert.deepEqual(marks.map((m) => m.t1), [50, 80, 100], "конец: свой, следующего или записи");
assert.deepEqual(marks.map((m) => m.left), [0, 0.5, 0.9]);
assert.deepEqual(marksOf(frames, 0), [], "без длительности меток нет");

// Полоса 400 px: риска 50 с — на 200 px. Курсор в 5 px от неё — примагничивает.
assert.deepEqual(pickMark(marks, 205 / 400, 400, 100), { index: 1, snap: true });
// Далеко от рисок, но внутри экрана 50–80 с (≈ 65 с).
assert.deepEqual(pickMark(marks, 0.65, 400, 100), { index: 1, snap: false });
// Между экранами (80–90 с) — ничего.
assert.deepEqual(pickMark(marks, 0.85, 400, 100), { index: -1, snap: false });
// Экран с нулевой секунды — выбирается и вдали от риски.
assert.deepEqual(pickMark(marks, 0.2, 400, 100), { index: 0, snap: false });
assert.deepEqual(pickMark([], 0.5, 400, 100), { index: -1, snap: false });

assert.equal(markAt(marks, 49), 0);
assert.equal(markAt(marks, 49.6), 1, "полсекунды вперёд — как у ленты кадров");
assert.equal(markAt(marks, 95), 2);
assert.equal(markAt([], 10), -1);

assert.equal(cardLeft(10, 200, 600), 0, "у левого края не вылезает");
assert.equal(cardLeft(590, 200, 600), 400, "у правого края не вылезает");
assert.equal(cardLeft(300, 200, 600), 200, "в середине — по центру курсора");
assert.equal(cardLeft(50, 200, 150), 0, "полоса уже карточки — прижать влево");
console.log("ok marks");
