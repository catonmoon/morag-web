// Перетекание знака из кадра в кадр (brand.mark списком): сетка постоянна, каждая клетка
// меняется ровно один раз и назад не возвращается — иначе знак «мерцал» бы, а не пересыпался.
import { strict as assert } from "node:assert";
import { morphFrames } from "../../web/js/ui/mark.js";

const from = ["ab", "cd"], to = ["xy", "zw"];
let seed = 1;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const steps = morphFrames(from, to, 6, rnd);
assert.equal(steps.length, 5, "промежуточных кадров — steps-1");
for (const s of steps) assert.deepEqual(s.map((l) => l.length), [2, 2], "сетка не прыгает");
// у каждой клетки: сначала старый символ, потом новый, без возврата
for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) {
  const seq = [from[r][c], ...steps.map((s) => s[r][c]), to[r][c]];
  const flip = seq.findIndex((ch) => ch === to[r][c]);
  assert.ok(seq.slice(0, flip).every((ch) => ch === from[r][c]) && seq.slice(flip).every((ch) => ch === to[r][c]), seq.join(""));
}
// кадры разной высоты/ширины — добиваются пробелами
const odd = morphFrames(["a"], ["xy", "z"], 3, () => 0.99);
assert.deepEqual(odd[0], ["a ", "  "], "пока порог не пройден — старый кадр в общей сетке");
console.log("ok mark-morph");
