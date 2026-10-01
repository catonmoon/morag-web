// Показ работы в окне загрузки: темп, честность подписи и сцена исправлений.
//     node tests/js/upload-scenes.test.mjs
//
// ⚠️ Анимация проверяется БЕЗ прогона расшифровки — по записанной трассе событий. Иначе каждая
// правка шрифта стоила бы двадцати минут транскрибации, и её просто не стали бы делать.
// ⚠️ Заглушка DOM здесь простая и `dataset` НЕ знает — в сценах только `setAttribute`.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

class El {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.kids = [];
    this.attrs = {};
    this.style = { setProperty() {} };
    // Минимальная геометрия: сцена листает окно текста, и проверяется именно то, что она
    // листает (сколько раз), а не куда: раскладки в заглушке нет и быть не может.
    this.clientHeight = 200;
    this.scrollHeight = 900;      // текста больше, чем окно — иначе прокрутку не проверить
    this.scrolls = 0;
    this._scroll = 0;
    this._on = {};
    this.classList = {
      _s: new Set(),
      add: (c) => this.classList._s.add(c),
      remove: (c) => this.classList._s.delete(c),
      contains: (c) => this.classList._s.has(c),
      toggle: (c, on) => (on ? this.classList._s.add(c) : this.classList._s.delete(c)),
    };
  }
  set className(v) { for (const c of String(v).split(/\s+/).filter(Boolean)) this.classList._s.add(c); }
  set textContent(v) { const t = new TextNode(v); t.parentElement = this; this.kids = [t]; }
  get textContent() { return this.kids.map((k) => (typeof k === "string" ? k : k.textContent)).join(""); }
  get children() { return this.kids.filter((k) => k instanceof El); }
  get childNodes() { return this.kids; }
  get lastElementChild_() { return this.children.at(-1) || null; }
  get lastElementChild() { return this.children.at(-1) || null; }
  setAttribute(k, v) { this.attrs[k] = v; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn) { (this._on[type] = this._on[type] || []).push(fn); }
  getBoundingClientRect() { return { top: this._top || 0, left: 0 }; }
  get scrollTop() { return this._scroll; }
  // ⚠️ Событие шлётся СИНХРОННО — строже, чем в браузере (там оно придёт перед кадром):
  // проверка «это не я прокрутил» не имеет права зависеть от момента доставки.
  set scrollTop(v) {
    this._scroll = Number.isFinite(v) ? v : 0;
    this.scrolls += 1;
    for (const fn of this._on.scroll || []) fn({ target: this });
  }
  append(...kids) {
    for (const k of kids.flat()) {
      if (k == null) continue;
      if (typeof k === "string") { this.kids.push(new TextNode(k)); this.kids.at(-1).parentElement = this; continue; }
      k.parentElement = this;
      this.kids.push(k);
    }
  }
  prepend(k) { if (k instanceof El) k.parentElement = this; this.kids.unshift(k); }
  insertBefore(node, before) {
    const at = this.kids.indexOf(before);
    node.parentElement = this;
    this.kids.splice(at < 0 ? this.kids.length : at, 0, node);
    return node;
  }
  replaceChildren(...kids) { this.kids = []; this.append(...kids); }
  // ⚠️ Узел обязан уходить У РОДИТЕЛЯ: без этого обрезка списка («пока карточек больше сорока —
  // удаляй последнюю») превращается в бесконечный цикл, и тест просто виснет.
  remove() {
    const p = this.parentElement;
    if (p) p.kids = p.kids.filter((k) => k !== this);
    this.parentElement = null;
  }
  replaceWith(node) {
    const p = this.parentElement;
    if (!p) return;
    p.kids[p.kids.indexOf(this)] = node;
    node.parentElement = p;
    this.parentElement = null;
  }
  getContext() { return null; }
}

// ⚠️ Правка идёт ВНУТРИ текста, значит заглушке нужны настоящие текстовые узлы с `splitText`:
// на строках это не проверить, и сцена бы «работала» в тесте, ничего не меняя на экране.
class TextNode {
  constructor(t) { this.nodeType = 3; this.textContent = String(t); this.parentElement = null; }
  splitText(i) {
    const rest = new TextNode(this.textContent.slice(i));
    this.textContent = this.textContent.slice(0, i);
    const p = this.parentElement;
    if (p) { p.kids.splice(p.kids.indexOf(this) + 1, 0, rest); rest.parentElement = p; }
    return rest;
  }
  replaceWith(node) {
    const p = this.parentElement;
    if (!p) return;
    p.kids[p.kids.indexOf(this)] = node;
    node.parentElement = p;
  }
}

globalThis.document = {
  createElement: (t) => new El(t),
  createTextNode: (t) => new TextNode(t),
  documentElement: { getAttribute: () => "dark" },
};
globalThis.matchMedia = () => ({ matches: false });
globalThis.window = globalThis;
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "#E4A04B" });
// ⚠️ Кадры — УПРАВЛЯЕМЫЕ, и вызывать колбэк синхронно прямо из `requestAnimationFrame` нельзя:
// сцена сбрасывает свою защёлку внутри кадра, а синхронный вызов возвращает номер уже ПОСЛЕ
// сброса — цикл встаёт навсегда, и сцена замирает после первой правки. Ровно на этом и попались.
let CLOCK = 0;
const FRAMES = [];
globalThis.requestAnimationFrame = (fn) => FRAMES.push(fn);
globalThis.setTimeout = (fn) => { fn(); return 1; };
/** Прокрутить n кадров, каждый на 500 мс вперёд — быстрее любого темпа сцены. */
function flush(n = 12) {
  for (let i = 0; i < n; i++) {
    const batch = FRAMES.splice(0, FRAMES.length);
    CLOCK += 500;
    for (const fn of batch) fn(CLOCK);
  }
}
globalThis.performance = { now: () => 0 };

const { budget, state, MIN_RATE, MAX_RATE } = await import(join(repo, "tools/ui/play.js"));
const { textScene } = await import(join(repo, "tools/ui/text.js"));
const { screenScene } = await import(join(repo, "tools/ui/screen.js"));
const { wave } = await import(join(repo, "tools/ui/wave.js"));
const { sendScene, size } = await import(join(repo, "tools/ui/send.js"));

// --- темп ------------------------------------------------------------------------------------

{
  // Пачка в 500 событий (например, клиент отстал и догоняет) разбирается быстро, но не за кадр:
  // иначе окно моргнёт и человек ничего не увидит.
  const per = budget(500, 1 / 60);
  assert.ok(per <= Math.ceil(MAX_RATE / 60) + 1, `за кадр не больше потолка, вышло ${per}`);
  assert.ok(500 / (per * 60) < 5, "но и не за минуту: пачка разбирается за секунды");
}
{
  // Мало событий — всё равно живо: пасс-2 отдаёт примерно кусок в секунду, и показ не должен
  // выглядеть замершим.
  assert.equal(budget(2, 1 / 60), Math.max(1, Math.ceil((MIN_RATE * 1) / 60)));
  assert.ok(budget(2, 0.2) >= 1);
}
{
  // «Меньше движения» — никакого темпа вовсе: применяем пачкой и рисуем конечное состояние.
  assert.equal(budget(37, 1 / 60, { reduced: true }), 37);
  assert.equal(budget(0, 1 / 60), 0);
}

// --- честность -------------------------------------------------------------------------------

{
  // Полоса двигается ТОЛЬКО по настоящему счётчику: это прямая замена прежней, которая искала
  // в логе процент, не находила и стояла на 30 % всю расшифровку.
  const a = state({ stage: "pass2", counter: { i: 0, n: 195 }, lastAt: 0, now: 0 });
  const b = state({ stage: "pass2", counter: { i: 100, n: 195 }, lastAt: 0, now: 0 });
  assert.ok(b.pct > a.pct, "счётчик кусков двигает полосу");
  const c = state({ stage: "pass2", counter: null, lastAt: 0, now: 2 });
  assert.equal(c.pct, a.pct, "без счётчика полоса стоит — и это честно");
}
{
  const live = state({ stage: "pass2", counter: { i: 84, n: 195 }, lastAt: 10, now: 11 });
  assert.equal(live.mood, "работает");
  assert.match(live.say, /84 из 195/);

  const thinking = state({ stage: "pass1", stageAt: 5, lastAt: 10, now: 25 });
  assert.equal(thinking.mood, "считает", "стадия молчит по своей природе — так и говорим");
  assert.match(thinking.say, /обычно/);
  // ⚠️ Мерим время СТАДИИ (20 с с её начала), а не тишину канала (15 с): «что происходит»
  // отвечает первое. Прежняя подпись говорила «120 с без вестей — работа, вероятно, идёт», и
  // владелец справедливо назвал её неуверенной (25.09).
  assert.match(thinking.say, /0:20/);
  assert.ok(!/вероятно/.test(thinking.say), "догадок в подписи нет");

  const lost = state({ stage: "final-round", stageAt: 0, lastAt: 10, now: 70 });
  assert.equal(lost.mood, "молчит");
  assert.match(lost.say, /тихо 1:00/, "молчание канала — короткой пометкой, а не целой фразой");

  const late = state({ stage: "diarize", stageAt: 1, lastAt: 10, now: 400 });
  assert.match(late.say, /дольше обычного/, "идёт втрое дольше типичного — говорим прямо");

  // Часы: общее время работы приходит снаружи (у окна — от сервера, у стенда — из трассы).
  assert.equal(state({ stage: "pass2", lastAt: 0, now: 0, elapsed: 754 }).clock, "12:34");
  assert.equal(state({ stage: "pass2", lastAt: 0, now: 0 }).clock, "", "не передали — не врём");

  const failed = state({ error: "Не получилось: стек не отвечает" });
  assert.equal(failed.mood, "ошибка");
  assert.equal(failed.pct, null, "у ошибки полосы нет вовсе");
  assert.equal(failed.label, "Не получилось: стек не отвечает", "ошибка — это и есть подпись");
}
{
  // Подпись разобрана на части: переливается ТОЛЬКО название стадии, числа остаются ровными.
  const live = state({ stage: "pass2", counter: { i: 84, n: 195 }, lastAt: 10, now: 11 });
  assert.equal(live.label, "распознаю по кускам");
  assert.equal(live.tail, " · 84 из 195");
  assert.equal(live.say, live.label + live.tail);
}

// --- сцена исправлений -------------------------------------------------------------------------

{
  const root = new El("div");
  const scene = textScene(root);
  scene.apply({ t: "stage.start", stage: "final-round" });

  // Реплика, над которой идёт работа, — и правки прямо в ней.
  scene.apply({ t: "turn.text", turn: 0, start: 61, whole: true,
                text: "Мы берём эйр флоу и ставим его в H200, а звонил Ковалёв." });
  scene.apply({ t: "turn.fix", turn: 0, start: 61, was: "эйр флоу", now: "Airflow", ok: true, why: "" });
  scene.apply({ t: "turn.fix", turn: 1, start: 150, was: "H200", now: "H100", ok: false, why: "number" });
  scene.apply({ t: "turn.fix", turn: 2, start: 30, was: "Ковалёв", now: "Ковалев", ok: false,
                why: "breaks_term", term: "Мария Ковалёва" });
  flush();

  // ⚠️ В тексте остаётся ИСПРАВЛЕННОЕ слово, а прежнее уходит в слой над текстом и
  // всплывает по наведению: конец работы — готовая расшифровка, а не лист корректуры.
  assert.equal(scene.state().edits, 3, "все три правки легли в текст");

  const all = [];
  (function walk(node) {
    for (const kid of node.kids || []) if (kid instanceof El) { all.push(kid); walk(kid); }
  })(root);
  const cls = (c) => all.filter((n) => n.classList.contains(c)).map((n) => n.textContent);

  // ⚠️ Узлы — обычные inline-`span`: у `ruby` и `inline-block` своя высота и свои точки переноса,
  // из-за них строка с правкой становилась выше соседних.
  assert.equal(all.filter((n) => n.classList.contains("ed")).length, 3, "каждая правка — свой узел");
  assert.ok(all.filter((n) => n.classList.contains("ed")).every((n) => n.tagName === "SPAN"),
            "и это обычный span, а не ruby");
  assert.deepEqual(cls("ed-now"), ["Airflow"], "принятая правка — это новое слово в тексте");
  assert.deepEqual(cls("ed-kept"), ["H200", "Ковалёв"], "отвергнутая текст не меняет вовсе");

  const over = cls("ed-old");
  assert.equal(over.length, 3, "слой есть у каждой");
  // ⚠️ Слово в слое ЗАЧЁРКНУТО, а не подписано «было»: зачёркивание и значит «этого в тексте
  // нет» — у принятой правки это прежнее слово, у отвергнутой — предложенная замена.
  const gone = all.filter((n) => n.classList.contains("ed-gone"));
  assert.ok(gone.every((n) => n.tagName === "S"), "зачёркнуто разметкой, а не словами");
  assert.deepEqual(gone.map((n) => n.textContent), ["эйр флоу", "H100", "Ковалев"]);
  assert.ok(!over.join(" ").includes("было:"), "подписи «было» нет");
  assert.match(over[1], /меняет число/, "…и почему не взяли");
  assert.match(over[2], /сломало бы известный термин.*Мария Ковалёва/, "и какой именно термин");
  assert.ok(!all.some((n) => n.classList.contains("ed-i")), "знака ⓘ больше нет — причина в том же слое");

  scene.apply({ t: "turn.done", turn: 0, start: 61, n: 5, changed: true });
  assert.equal(scene.state().turns, 5);
}
{
  // ⚠️ Черновик пасса-1 ложится в окно ЦЕЛИКОМ, а чистовик пасса-2 ВСТАЁТ НА ЕГО МЕСТО
  // (решение владельца 24.09): второй проход виден глазом, а не догадкой.
  const root = new El("div");
  const scene = textScene(root);
  scene.apply({ t: "diar.spans", speakers: ["SPEAKER_00", "SPEAKER_01"], spans: [] });
  scene.apply({ t: "stage.start", stage: "pass1" });
  scene.apply({ t: "draft.window", from: 0, to: 30, text: "мы берём эйр флоу и ставим", bulk: true });
  scene.apply({ t: "draft.window", from: 30, to: 60, text: "потом всё в кафка", bulk: true });
  flush();
  assert.equal(scene.state().mode, "draft");
  assert.match(scene.state().text, /эйр флоу/, "черновик виден сразу после пасса-1");

  // Черновик ложится РАЗОМ (не по кадрам) — пачка из сотни окон приходит за сотые секунды.
  assert.ok(scene.state().text.includes("всё в кафка"), "черновик готов сразу, без кадров");

  scene.apply({ t: "stage.start", stage: "pass2" });
  // …и после пачки фокус возвращается в НАЧАЛО: чистовой проход пойдёт сверху.
  assert.equal(root.children[1].scrollTop, 0, "после черновика окно стоит в начале");
  scene.apply({ t: "chunk.start", i: 1, n: 2, from: 0, to: 30, spk: "SPEAKER_00" });
  scene.apply({ t: "chunk.done", i: 1, raw: "Мы берём Airflow и ставим его в работу." });
  flush();
  const after = scene.state().text;
  assert.match(after, /Airflow/, "чистовик встал на место");
  assert.ok(!after.includes("эйр флоу"), "черновой текст этого куска заменён, а не дописан");
  assert.match(after, /всё в кафка/, "соседнее окно не тронуто");
  assert.equal(scene.state().speakers, 1, "смена голоса отмечена меткой");
  assert.match(after, /SPEAKER_00/, "и метка подписана");

  // ⚠️⚠️ ВТОРОЙ кусок того же чернового окна дописывается В НЕГО. Окно черновика — 30 с,
  // кусков пасса-2 на него два (живьём 243 на 119), и пока окно «занималось» первым, второй
  // уезжал в КОНЕЦ текста вместе со своей меткой говорящего — именно так «пропадали подписи».
  scene.apply({ t: "chunk.start", i: 2, n: 3, from: 15, to: 30, spk: "SPEAKER_01" });
  scene.apply({ t: "chunk.done", i: 2, raw: "И сразу же второй кусок." });
  flush();
  const both = scene.state().text;
  assert.ok(both.indexOf("второй кусок") < both.indexOf("всё в кафка"),
            "второй кусок встал в своё окно, а не в конец текста");
  assert.equal(scene.state().speakers, 2, "смена голоса внутри окна тоже отмечена");

  // Имена пришли с сайта — подписи переписываются на месте, без пересборки текста.
  scene.apply({ t: "voices.named", by_label: { SPEAKER_00: { voice: "Speaker_7", name: "Мария Кузнецова" } } });
  assert.match(scene.state().text, /Мария Кузнецова/, "имя встало вместо метки");
  assert.ok(!scene.state().text.includes("SPEAKER_00"), "а метки больше нет");
}

{
  // ⚠️ Слежение за правкой не должно выключаться НАШЕЙ же прокруткой. `scrollTop = …`
  // поднимает событие `scroll`, и пока сцена считала его человеческим, она после первой же замены
  // замирала на четыре секунды, и корректура ложилась за краем окна — человек не видел ни одной.
  const root = new El("div");
  const scene = textScene(root);
  scene.apply({ t: "stage.start", stage: "final-round" });
  scene.apply({ t: "turn.text", turn: 0, start: 10,
                text: "Мы берём эйр флоу, а в очереди кафка." });
  const body = root.children[1];
  const before = body.scrolls;
  scene.apply({ t: "turn.fix", turn: 0, start: 10, was: "эйр флоу", now: "Airflow", ok: true });
  flush();
  const one = body.scrolls;
  scene.apply({ t: "turn.fix", turn: 0, start: 10, was: "кафка", now: "Kafka", ok: true });
  flush();
  assert.ok(one > before, "к первой правке сцена листает");
  assert.ok(body.scrolls > one, "и ко второй тоже — своя прокрутка слежение не выключает");
  assert.equal(scene.state().edits, 2, "и обе правки легли в текст");

  // А вот НАСТОЯЩИЙ жест человека слежение останавливает: он читает своё место, и увозить
  // его оттуда нельзя.
  const two = body.scrolls;
  for (const fn of body._on.wheel || []) fn({});
  scene.apply({ t: "turn.fix", turn: 0, start: 10, was: "очереди", now: "очередь", ok: false, why: "empty" });
  flush();
  assert.equal(body.scrolls, two, "после жеста человека сцена за ним не бегит");
  assert.equal(scene.state().edits, 3, "но правку в текст всё равно ставит");
}
{
  // Текст печатается ПО МЕРЕ появления: событие пришло одно, а читается оно кадрами.
  const root = new El("div");
  const scene = textScene(root);
  scene.apply({ t: "stage.start", stage: "pass2" });
  scene.apply({ t: "chunk.done", i: 1, raw: "Смотрите, здесь у нас обычная очередь." });
  const first = scene.state().text.length;
  flush(1);
  const mid = scene.state().text.length;
  flush(60);
  const done = scene.state().text.length;
  assert.ok(first < mid && mid < done, `печать идёт кадрами: ${first} → ${mid} → ${done}`);
  // ⚠️ Пишущийся текст сам держится КОНЦА: смотрят ради того, что появляется прямо
  // сейчас, а оно приходит снизу.
  assert.equal(root.children[1].scrollTop, 900, "окно догнало конец текста");
  assert.match(scene.state().text, /обычная очередь/);
  assert.equal(scene.state().mode, "writing");
}

// --- сцена экрана ---------------------------------------------------------------------------

{
  // ⚠️ `describe_slides.py` возвращает УСПЕХ, если описан хотя бы один кадр: половина может
  // упасть, и без этой сцены человек не узнает об этом вовсе.
  const root = new El("div");
  const scene = screenScene(root);
  scene.apply({ t: "client.step", step: "screen" });
  // ⚠️ `sec` — секунда кадра В ЗАПИСИ. У события есть и `at`, но это время прогона (`emit`), и
  // раньше секунда кадра ехала под тем же именем, затирая конверт.
  scene.apply({ t: "screen.frame", path: "/w/rec/slides/s001.jpg", sec: 61, at: 812, kind: "slide",
                title: "Очереди", text: "Схема потока", done: 1, n: 3 });
  assert.equal(scene.state().done, 1);
  assert.match(root.textContent, /Очереди/);
  assert.match(root.textContent, /1:01/, "время кадра подписано минутами");
  scene.apply({ t: "screen.frame", path: "/w/rec/slides/s002.jpg", sec: 90, at: 840,
                error: "ConnectError: сертификат", done: 2, n: 3 });
  assert.equal(scene.state().bad, 1, "упавший кадр посчитан");
  assert.match(root.textContent, /не далось 1/, "…и сказан вслух, а не пропущен молча");
  assert.match(root.textContent, /кадр 2 из 3/);
}

// --- легенда голосов -----------------------------------------------------------------------

{
  // ⚠️⚠️ Имена с сайта обязаны доходить ДО ЛЕГЕНДЫ. Узнавание работало три прогона
  // подряд, а человек видел `SPEAKER_00`: событие разбирала только сцена текста.
  const root = new El("div");
  const scene = wave(root);
  scene.apply({ t: "job.meta", audio_sec: 600 });
  scene.apply({ t: "diar.spans", speakers: ["SPEAKER_00", "SPEAKER_01"], spans: [[0, 10, 0]] });
  assert.match(root.textContent, /SPEAKER_00/, "без имён — сырая метка");
  scene.apply({ t: "voices.named", by_label: {
    SPEAKER_00: { voice: "Speaker_7", name: "Мария Кузнецова" },
    SPEAKER_01: { voice: "Speaker_41", name: "" } } });
  assert.match(root.textContent, /Мария Кузнецова/, "имя встало в легенду");
  assert.ok(!root.textContent.includes("SPEAKER_00"), "сырой метки больше нет");
  // ⚠️ Безымянный голос — просто корпусный номер: приписка «новый» лишняя (владелец, 25.09),
  // номер и сам значит «сервер знает голос, но имени нет». А `SPEAKER_00` — «не спросили вовсе».
  assert.match(root.textContent, /Speaker_41/, "безымянный — под корпусным номером");
  assert.ok(!root.textContent.includes("новый"), "без приписки");
}

// --- наведение: волна ↔ легенда --------------------------------------------------------------

{
  // ⚠️ Мыши в заглушке нет, поэтому наведение вызывается снаружи — тем же путём, каким его
  // зовут обработчики канваса и строк легенды. Проверяется СОСТОЯНИЕ, а не пиксели.
  const root = new El("div");
  const scene = wave(root);
  scene.apply({ t: "job.meta", audio_sec: 600 });
  scene.apply({ t: "diar.spans", speakers: ["SPEAKER_00", "SPEAKER_01"],
                spans: [[0, 100, 0], [100, 240, 1]] });
  scene.apply({ t: "voices.named", by_label: { SPEAKER_01: { voice: "Speaker_9", name: "Нина Ковалёва" } } });

  scene.hoverSecond(150);
  assert.equal(scene.state().hoverIdx, 1, "по секунде нашли голос");
  assert.match(scene.state().tip, /Нина Ковалёва · 2:30/, "в подсказке имя и время");
  const legend = root.children.at(-1);
  assert.ok(legend.children[0].classList.contains("dim"), "чужой голос в легенде приглушён");
  assert.ok(legend.children[1].classList.contains("on"), "а этот — выделен");

  scene.hoverSecond(400);
  assert.equal(scene.state().hoverIdx, -1, "за отрезками голоса нет");
  assert.match(scene.state().tip, /тишина/);

  scene.hoverVoice(0);                       // курсор в легенде
  assert.equal(scene.state().hoverIdx, 0);
  assert.equal(scene.state().hoverSec, null, "из легенды подсвечивается голос, а не секунда");
  scene.hoverSecond(null);
  assert.equal(scene.state().hoverIdx, -1, "ушли — сняли подсветку");
}

// --- кадры экрана и искры прогресса ----------------------------------------------------------

{
  const root = new El("div");
  const scene = wave(root);
  scene.apply({ t: "job.meta", audio_sec: 600 });
  scene.apply({ t: "diar.spans", speakers: ["SPEAKER_00"], spans: [[0, 600, 0]] });
  // ⚠️ Секунды кадров нужны волне, а не только сцене экрана: человек спрашивает «откуда этот
  // снимок» (владелец, 25.09), и ответ — засечка на шкале записи.
  scene.apply({ t: "screen.frame", path: "/w/rec/slides/s001.jpg", sec: 61, kind: "slide" });
  scene.apply({ t: "screen.frame", path: "/w/rec/slides/s002.jpg", sec: 145, kind: "slide" });
  assert.equal(scene.state().frames, 2);
  assert.equal(scene.state().frameAt, 145, "выделен последний показанный кадр");
  scene.apply({ t: "screen.frame", path: "", error: "ConnectError" });
  assert.equal(scene.state().frames, 2, "кадр без секунды засечкой не становится");

  scene.apply({ t: "chunk.start", i: 1, n: 40, from: 0, to: 28, spk: "SPEAKER_00" });
  assert.equal(scene.state().cursor, 28, "кромка прогресса идёт по кускам");
  scene.reset();
  assert.equal(scene.state().frames, 0, "сброс убирает и кадры");
}

// --- две дорожки работы ------------------------------------------------------------------------

{
  // ⚠️ Разбор экрана идёт ПАРАЛЛЕЛЬНО расшифровке (25.09), и главную стадию он подменять не
  // имеет права: «делю по голосам» обязано оставаться правдой, пока рядом сыплются кадры.
  const both = state({ stage: "diarize", stageAt: 0, lastAt: 9, now: 10,
                       side: { stage: "screen", say: "описания кадров (Vision)",
                               counter: { i: 12, n: 40, say: "кадр 12 из 40" } } });
  assert.equal(both.label, "делю по голосам", "главная стадия своя");
  assert.equal(both.side, "описания кадров (Vision) · кадр 12 из 40", "боковая — своей строкой");

  const alone = state({ stage: "diarize", lastAt: 9, now: 10 });
  assert.equal(alone.side, "", "боковой работы нет — и строки нет");

  // Полоса двигается от обеих дорожек, но вес стадии считается ОДИН раз: ту же стадию конвейер
  // потом пришлёт главной дорожкой, когда доделает экран.
  const idle = state({ stage: "diarize", lastAt: 9, now: 10, side: null }).pct;
  const busy = state({ stage: "diarize", lastAt: 9, now: 10,
                       side: { stage: "screen", say: "экран", counter: { i: 20, n: 40 } } }).pct;
  assert.ok(busy > idle, "параллельная работа двигает полосу");
  const twice = state({ stage: "screen", lastAt: 9, now: 10,
                        side: { stage: "screen", say: "экран", done: true } }).pct;
  const once = state({ stage: "screen", lastAt: 9, now: 10 }).pct;
  assert.equal(twice, once, "тот же экран не посчитан дважды");
  const counted = state({ stage: "pass2", done: ["screen"], lastAt: 9, now: 10,
                          side: { stage: "screen", say: "экран", done: true } }).pct;
  assert.equal(counted, state({ stage: "pass2", done: ["screen"], lastAt: 9, now: 10 }).pct);
}

// --- отправка пакета на сайт -------------------------------------------------------------------

{
  // ⚠️ Отправка видео — единственный шаг, который человек ждёт, глядя в окно, и до 25.09 её
  // было видно только в консоли. Проверяется то, что делает сцену полезной: список файлов
  // известен ДО первого байта, у каждого своя полоса, общий счёт — В БАЙТАХ (видео это 95 %
  // веса пакета, и счёт «файл 2 из 3» стоял бы на месте всё время, которое реально идёт).
  const root = new El("div");
  const scene = sendScene(root);
  assert.equal(root.attrs.hidden, "", "до отправки сцены не видно");

  scene.apply({ t: "upload.begin", files: [{ name: "artifact.json", bytes: 400000 },
                                           { name: "video.mp4", bytes: 1200000000 }],
                bytes: 1200400000 });
  assert.equal(scene.state().files, 2);
  assert.equal(root.attrs.hidden, undefined, "сцена показалась");
  assert.match(root.textContent, /расшифровка/, "имя файла человеческое, а не artifact.json");
  assert.match(root.textContent, /видео/);

  scene.apply({ t: "upload.file", name: "video.mp4", i: 2, n: 2, sent: 600000000,
                bytes: 1200000000, moved: 600400000, whole: 1200400000 });
  assert.match(root.textContent, /572 МБ из 1\.1 ГБ/, "сколько уехало у самого файла");
  assert.match(root.textContent, /50 %/, "общий счёт — по байтам");
  assert.equal(scene.state().moved, 600400000);

  scene.apply({ t: "upload.file", name: "video.mp4", i: 2, n: 2, sent: 1200000000,
                bytes: 1200000000, moved: 1200400000, whole: 1200400000, done: true });
  scene.apply({ t: "upload.state", state: "building" });
  assert.match(root.textContent, /сервер собирает запись/, "состояние сервера — словами");
  scene.apply({ t: "upload.state", state: "done", search: "later" });
  assert.match(root.textContent, /плановой индексации/, "и «в поиске позже» сказано прямо");
  assert.equal(scene.state().server, "done");

  scene.reset();
  assert.equal(scene.state().files, 0);
  assert.equal(root.attrs.hidden, "");
}
{
  assert.equal(size(0), "0 Б");
  assert.equal(size(2048), "2 КБ");
  assert.equal(size(50 * 1024 * 1024), "50 МБ");
  assert.equal(size(3 * 1024 * 1024 * 1024), "3.0 ГБ");
}
{
  // Подпись работы берёт у счётчика ЕГО слова, когда они есть: у отправки счёт в байтах.
  const s = state({ stage: "send", counter: { i: 5, n: 10, say: "512 МБ из 1.0 ГБ" },
                    lastAt: 0, now: 0 });
  assert.equal(s.tail, " · 512 МБ из 1.0 ГБ");
  assert.ok(s.pct > 0);
}

// --- переслушивание -----------------------------------------------------------------------------

{
  // Переслушивание — В ОБЩЕМ ТЕКСТЕ (владелец, 30.09), а не отдельным списком: петля сменяется
  // услышанным на месте, прежнее — в слое над ним; тишина и неудача тоже видны.
  const root = new El("div");
  const scene = textScene(root);
  scene.apply({ t: "stage.start", stage: "relisten" });
  scene.apply({ t: "turn.text", turn: 0, start: 610, text: "ИИИИИИИИИИИИ и дальше обычная речь ах ах ах ах" });
  scene.apply({ t: "relisten.span", from: 610, to: 623, kind: "char", verdict: "речь",
                was: "ИИИИИИИИИИИИ", now: "Нам нужно обсудить это отдельно." });
  scene.apply({ t: "relisten.span", from: 800, to: 812, kind: "word", verdict: "петля осталась",
                was: "ах ах ах ах", now: "ах ах ах ах" });
  flush();
  const s = scene.state();
  assert.equal(s.heard, 2); assert.equal(s.back, 1);
  assert.match(s.text, /^Нам нужно обсудить это отдельно\./, "услышанное встало на место петли");
  assert.match(s.text, /ИИИИИИИИИИИИ/, "прежняя петля осталась видна — в слое");
  assert.match(s.text, /вернулась речь/);
  assert.match(s.text, /не вышло — оставлено как было/, "неудача показана тоже");
  assert.match(root.textContent, /переслушано 2 · вернулась речь в 1/);
}


// --- сверка: арбитраж и редактор (30.09) -------------------------------------------------------
{
  // ⚠️ Владелец: «показывать максимально наглядно на волне или даже тексте». Проверяется, что
  // над словом стоят ВСЕ варианты выбора и чем решено, а в тексте — выбранное.
  const root = new El("div");
  const scene = textScene(root);
  scene.apply({ t: "stage.start", stage: "arbitrate" });
  scene.apply({ t: "turn.text", turn: 0, start: 10, text: "он поставил задачу и ушёл в отпуск" });
  scene.apply({ t: "arbitrate.chunk", done: 1, n: 3, from: 10, to: 20, heard: true, flags: ["поставил"] });
  scene.apply({ t: "arbitrate.swap", from: 10, to: 20, was: "поставил", now: "поставила",
                clean: "поставила", by: "голосование", taken: true });
  scene.apply({ t: "arbitrate.swap", from: 10, to: 20, was: "отпуск", now: "отпуске",
                by: "спорно", taken: false });
  flush();
  const s = scene.state();
  assert.equal(s.taken, 1); assert.equal(s.kept, 1);
  assert.match(s.text, /^он поставила/, "выбранное встало в текст (слой вариантов идёт за словом)");
  assert.match(s.text, /1-е ухо/); assert.match(s.text, /2-е ухо/); assert.match(s.text, /3-й голос/);
  assert.match(s.text, /два уха из трёх/, "чем решено — словами");
  assert.match(s.text, /уши не сошлись/, "спор, оставленный как было, тоже виден");
  assert.match(s.text, /ушёл в отпуск/, "непринятое решение текст не меняет");
  assert.match(root.textContent, /второе ухо: взято 1 · оставлено 1/);

  // Редактор: шапка говорит, какую страницу читает и что переслушивает; свидетель — у правки.
  scene.apply({ t: "stage.start", stage: "editor" });
  scene.apply({ t: "editor.page", page: 1, of: 6, from: 240, to: 480 });
  assert.match(scene.state().head, /страница 2 из 6 \(4:00–8:00\)/);
  scene.apply({ t: "editor.listen", page: 1, ear: "second", from: 300, to: 325, text: "…" });
  assert.match(scene.state().head, /переслушивает 5:00–5:25 вторым ухом/);
  scene.apply({ t: "turn.fix", turn: 0, start: 10, was: "задачу", now: "задачи", ok: true,
                why: "", witness: "sound" });
  flush();
  assert.match(scene.state().text, /по звуку/, "свидетель правки виден");
}
{
  // Волна: где слушали второй раз, решения точками, правки тиками — и подсказка словами.
  const root = new El("div");
  const scene = wave(root);
  scene.apply({ t: "job.meta", audio_sec: 600 });
  scene.apply({ t: "arbitrate.chunk", done: 1, n: 2, from: 10, to: 20, heard: true, flags: ["x"] });
  scene.apply({ t: "arbitrate.chunk", done: 2, n: 2, from: 20, to: 30, heard: false, flags: [] });
  scene.apply({ t: "arbitrate.swap", from: 10, to: 20, was: "поставил", now: "поставила",
                clean: "поставила", by: "голосование", taken: true });
  scene.apply({ t: "editor.listen", page: 0, ear: "clean", from: 40, to: 65, text: "" });
  scene.apply({ t: "turn.fix", start: 50, was: "кафка", now: "Kafka", ok: true });
  const st = scene.state();
  assert.equal(st.checks, 1, "пропущенный воротами кусок второе ухо не слушало");
  assert.equal(st.votes, 1); assert.equal(st.ears, 1); assert.equal(st.edits, 1);
  assert.equal(st.cursor, 30, "кромка идёт за арбитражем");
  scene.hoverSecond(15);
  assert.match(scene.state().tip, /поставил → поставила · два уха из трёх/);
  const keyNode = root.children.find((n) => n.classList.contains("wv-key"));
  assert.match(keyNode.textContent, /слушало второе ухо/, "ключ к значкам появился");
}
{
  // Полоса: редактор ВМЕСТО финал-раунда — в сумму входит один из них, конец = 100 %.
  const all = ["audio", "voices", "record", "screen", "pack", "send", "diarize", "pass1", "glossary",
               "pass2", "relisten", "arbitrate", "speakers", "naming", "align"];
  assert.equal(state({ done: [...all, "final-round"] }).pct, 100);
  assert.equal(state({ done: [...all, "editor"] }).pct, 100, "с редактором полоса тоже доходит до конца");
  assert.match(state({ stage: "editor" }).say, /редактор перечитывает страницы/);
  assert.match(state({ stage: "arbitrate" }).say, /сверяю вторым ухом/);
}


{
  // ⚠️⚠️ Гонка, пойманная на стенде 30.09: в фоновой вкладке браузер придерживает таймеры, кусок
  // чистовика встаёт на место черновика ПОЗЖЕ, чем пришло решение арбитража, — и стирал его.
  const held = [];
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => { held.push(fn); return 1; };
  const root = new El("div");
  const scene = textScene(root);
  scene.apply({ t: "stage.start", stage: "pass1" });
  scene.apply({ t: "draft.window", from: 0, to: 30, text: "он поставил задачу черновик" });
  scene.apply({ t: "stage.start", stage: "pass2" });
  scene.apply({ t: "chunk.start", i: 1, n: 1, from: 0, to: 30, spk: "S0" });
  scene.apply({ t: "chunk.done", i: 1, raw: "он поставил задачу и ушёл" });
  scene.apply({ t: "stage.start", stage: "arbitrate" });
  scene.apply({ t: "arbitrate.swap", from: 0, to: 30, was: "поставил", now: "поставила",
                clean: "поставила", by: "голосование", taken: true });
  flush(40);                                   // кадры идут, а таймеры стоят
  assert.equal(scene.state().edits, 0, "решение ждёт, пока кусок не встанет на место");
  while (held.length) { held.shift()(); flush(4); }
  flush(40);
  while (held.length) { held.shift()(); flush(4); }
  globalThis.setTimeout = realTimeout;
  assert.equal(scene.state().edits, 1, "решение легло после куска");
  assert.match(scene.state().text, /он поставила1-е ухо/, "и не стёрто им");
}


{
  // ⚠️⚠️ Правка ложится в СВОЮ реплику (замер 30.09): термин повторяется в каждой реплике, реплики
  // приходят сразу, правки — очередью. Поиск от последней пришедшей реплики клал все правки со сдвигом.
  const root = new El("div");
  const scene = textScene(root);
  const body = root.children.find((n) => n.classList.contains("tx-body"));
  scene.apply({ t: "stage.start", stage: "pass2" });
  const T = ["Первая про графана и метрики.", "Вторая про графана и алерты.", "Третья про графана и дашборды."];
  T.forEach((text, i) => { scene.apply({ t: "chunk.start", i, n: 3, from: i * 60, to: i * 60 + 30, spk: "S0" });
                           scene.apply({ t: "chunk.done", i, raw: text }); });
  flush(40);
  scene.apply({ t: "stage.start", stage: "final-round" });
  T.forEach((text, i) => scene.apply({ t: "turn.text", turn: i, start: i * 60, text }));
  T.forEach((_, i) => scene.apply({ t: "turn.fix", turn: i, start: i * 60, was: "графана", now: `G${i + 1}`, ok: true }));
  flush(80);
  const pieces = body.children.filter((n) => n.classList.contains("tx-piece")).map((p) => p.textContent);
  pieces.forEach((text, i) => assert.match(text, new RegExp(`^${["Первая", "Вторая", "Третья"][i]} про G${i + 1}`),
                                           `правка реплики ${i + 1} легла в неё же`));
}


{
  // Владелец 30.09: «процесса не видно, пользователь думает, что всё зависло». Сверка идёт по волне
  // как пасс-2: на старте стадии волна гаснет, кусок за куском загорается, кромка движется.
  const scene = wave(new El("div"));
  scene.apply({ t: "job.meta", audio_sec: 120 });
  scene.apply({ t: "chunk.start", i: 1, n: 2, from: 0, to: 60, spk: "S0" });
  scene.apply({ t: "chunk.start", i: 2, n: 2, from: 60, to: 120, spk: "S0" });
  assert.equal(scene.state().live, 2, "пасс-2 прошёл всё");
  scene.apply({ t: "stage.start", stage: "arbitrate" });
  assert.equal(scene.state().live, 0, "сверка начинает проход заново — волна гаснет");
  scene.apply({ t: "arbitrate.chunk", done: 1, n: 2, from: 0, to: 60, heard: true, flags: ["x"] });
  assert.equal(scene.state().live, 1); assert.equal(scene.state().cursor, 60, "кромка движется за сверкой");
  scene.apply({ t: "stage.start", stage: "editor" });
  scene.apply({ t: "editor.page", page: 0, of: 1, from: 0, to: 120 });
  scene.apply({ t: "editor.done", page: 0, done: 1, of: 1, proposed: 0, accepted: 0 });
  assert.equal(scene.state().live, 1); assert.equal(scene.state().cursor, 120, "страница редактора загорелась");
}


{
  // Экран разобран — сцена уходит, место отдаётся тексту (владелец, 30.09).
  const root = new El("div");
  const scene = screenScene(root, { frameUrl: (x) => x });
  scene.apply({ t: "client.step", step: "screen", lane: "side", say: "разбираю" });
  assert.equal(root.attrs.hidden, undefined, "идёт разбор — сцена видна");
  scene.apply({ t: "client.step", step: "screen", lane: "side", say: "экран разобран", done: true });
  assert.equal(root.attrs.hidden, "", "разобран — спрятана");
  scene.apply({ t: "screen.frame", sec: 10, kind: "slide", n: 1, done: 1 });
  assert.equal(root.attrs.hidden, "", "поздний кадр её не возвращает");
}
{
  // Клик по волне и слежение по видимости фронта (владелец, 30.09): фронт не виден — читаем,
  // окно не дёргается; вернулись к фронту — снова следим.
  const root = new El("div");
  const scene = textScene(root);
  const body = root.children.find((n) => n.classList.contains("tx-body"));
  body.getBoundingClientRect = () => ({ top: 0, bottom: 200, left: 0 });
  scene.apply({ t: "stage.start", stage: "pass1" });
  for (let i = 0; i < 6; i++) scene.apply({ t: "draft.window", from: i * 30, to: i * 30 + 30, text: `кусок ${i}` });
  scene.apply({ t: "stage.start", stage: "pass2" });
  const pieces = body.children.filter((n) => n.classList.contains("tx-piece"));
  // фронт — последний кусок, «далеко внизу»; первые куски — «в окне»
  pieces.forEach((n, i) => { n.getBoundingClientRect = () => ({ top: i * 100 - body.scrollTop, bottom: i * 100 + 20 - body.scrollTop }); n.offsetTop = i * 100; });
  scene.apply({ t: "chunk.start", i: 6, n: 6, from: 155, to: 180, spk: "S0" });
  scene.apply({ t: "chunk.done", i: 6, raw: "чистовик последнего куска" });
  flush(20);
  scene.seek(0);
  assert.equal(scene.state().following, false, "ушли к началу, фронт внизу не виден — читаем");
  const before = body.scrollTop;
  scene.apply({ t: "chunk.start", i: 6, n: 6, from: 155, to: 180, spk: "S0" });
  scene.apply({ t: "chunk.done", i: 6, raw: "ещё чистовик" });
  flush(20);
  assert.equal(body.scrollTop, before, "окно не уехало от читающего");
  scene.seek(160);
  assert.equal(scene.state().following, true, "вернулись к фронту — снова следим");
}

{
  // Экран слоем над текстом своей секунды (владелец, 01.10): кадр раньше текста ждёт его,
  // встаёт перед куском этой секунды и ПОСЛЕ метки говорящего; блок с кадром уходит с текстом.
  const sroot = new El("div");
  const screen = screenScene(sroot, { frameUrl: (x) => x });
  screen.apply({ t: "client.step", step: "screen", lane: "side", say: "разбираю" });
  screen.apply({ t: "screen.frame", path: "/w/s001.jpg", sec: 40, kind: "slide", title: "Очереди", n: 3, done: 1 });
  assert.equal(sroot.attrs.hidden, undefined, "текста нет — кадр в блоке");

  const root = new El("div");
  const scene = textScene(root, { frameUrl: (x) => `/f?${x}` });
  const body = root.children.find((n) => n.classList.contains("tx-body"));
  scene.apply({ t: "screen.frame", path: "/w/s001.jpg", sec: 40, kind: "slide", title: "Очереди", text: "Схема", n: 3, done: 1 });
  scene.apply({ t: "screen.frame", path: "", error: "ConnectError", n: 3, done: 2 });
  scene.apply({ t: "screen.frame", path: "/w/p.jpg", sec: 50, kind: "people", n: 3, done: 3 });
  assert.equal(scene.state().waiting, 1, "текста нет — кадр ждёт");
  assert.equal(scene.state().shots, 0);

  scene.apply({ t: "stage.start", stage: "pass1" });
  for (let i = 0; i < 3; i++) scene.apply({ t: "draft.window", from: i * 30, to: i * 30 + 30, text: `кусок ${i}` });
  screen.apply({ t: "draft.window", from: 0, to: 30, text: "кусок 0" });
  assert.equal(sroot.attrs.hidden, "", "пошёл текст — блок кадра ушёл");
  screen.apply({ t: "screen.frame", path: "/w/s002.jpg", sec: 70, kind: "slide", n: 4, done: 4 });
  assert.equal(sroot.attrs.hidden, "", "и поздний кадр его не возвращает");

  assert.equal(scene.state().shots, 1, "кадр встал, когда появился текст его секунды");
  const kids = body.children;
  const mark = kids.find((n) => n.classList.contains("shot"));
  assert.equal(kids[kids.indexOf(mark) + 1].textContent.trim(), "кусок 1", "перед куском 0:30–1:00");
  assert.match(mark.textContent, /0:40 · слайд/);
  assert.match(mark.textContent, /Очереди/);
  assert.match(root.textContent, /не далось 1/, "упавший кадр сказан вслух");

  // живой кадр после текста — раскрыт сам
  scene.apply({ t: "screen.frame", path: "/w/s003.jpg", sec: 75, kind: "slide", n: 5, done: 5 });
  assert.equal(scene.state().shots, 2);

  // метка говорящего встаёт ПЕРЕД значком экрана, а не между значком и текстом
  scene.apply({ t: "stage.start", stage: "pass2" });
  scene.apply({ t: "chunk.start", i: 2, n: 3, from: 30, to: 58, spk: "S1" });
  scene.apply({ t: "chunk.done", i: 2, raw: "чистовик" });
  flush(20);
  const who = body.children.findIndex((n) => n.classList.contains("tx-who"));
  const at = body.children.findIndex((n) => n.classList.contains("shot"));
  assert.ok(who >= 0 && who < at, "метка, потом значок, потом текст");
}

console.log("ok upload-scenes");
