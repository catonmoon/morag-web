// Сцена текста — главное в окне. Это ОДИН документ, который сначала пишется, а потом правится
// на месте; по нему можно листать назад, как по расшифровке.
//
//   1) «пишется» (пасс-2): распознанный кусок печатается по мере появления. Печатаем ПО КАДРУ и
//      пачкой знаков, а не по знаку в таймере: узел один, переписывается его текст — это дёшево,
//      в отличие от посимвольной анимации узлами, которая в этом проекте признана неподъёмной.
//      Текст настоящий: он ровно в этот момент и распознан, мы лишь показываем его со скоростью
//      чтения.
//   2) «правится» (финал-раунд): слово подсвечивается ТЕМ ЖЕ единственным способом, что и всегда,
//      зачёркивается — и сменяется заменой. В тексте остаётся ИСПРАВЛЕННОЕ слово,
//      написанное оранжевым; прежнее уходит в слой над текстом и всплывает по наведению
//      вместе с причиной, если она есть. Конец работы — готовая расшифровка, а не лист корректуры.
//   3) «сверяется» (арбитраж): над спорным словом встают ВСЕ варианты, из которых шёл выбор —
//      первое ухо, второе, третий голос, — и чем решено; выбранное встаёт в текст. Варианты видны
//      сами, без наведения (владелец, 30.09: «показывать максимально наглядно»), потом уходят в
//      слой по наведению, как у правок.
//   2б) «переслушивается» (петля или выпавшая речь): место, где модель сорвалась, заменяется
//      услышанным ПРЯМО В ТЕКСТЕ; прежнее («ИИИИИИ») — в слое над ним вместе с исходом. Отдельной
//      сцены-списка больше нет (владелец, 30.09: «можно ли показать на общем тексте?»).
//   4) редактор: правки те же, что у финал-раунда, плюс свидетель; в шапке — какую страницу он
//      читает и какое окно переслушивает.
//
// ⚠️ Подсветка ОДНА на всю сцену. Разные анимации на разные случаи читаются как рябь: глаз ищет
// правило и не находит. Правило здесь простое — жёлтым отмечено то, над чем работают ПРЯМО СЕЙЧАС.
// ⚠️ Правки приходят пачками (шесть реплик считаются разом), поэтому у сцены свой темп: замена
// показывается не быстрее, чем её можно прочитать.
// ⚠️ Прокрутка — МГНОВЕННАЯ. Плавная в браузере владельца не работает вовсе (замерено 08.09), и
// показ, зависящий от неё, просто стоял бы на месте.

import { clock, el, reduced } from "./dom.js";
import { colour } from "./voices.js";

const TYPE_MS = 900;       // за столько печатается кусок, если не торопимся
const HOLD_MS = 460;       // сколько слово подсвечено до замены — время заметить глазом
const GAP_MS = 240;        // пауза между правками
const LOOK_MS = 160;       // после жеста человека — через столько смотрим, виден ли фронт работы
const FRESH_MS = 1600;     // сколько прежнее слово видно само, без курсора
const CUT_MS = 340;        // сколько слово зачёркнуто до того, как его сменит замена
const DWELL_MS = 900;      // сколько правка остаётся в кадре ПОСЛЕ замены, прежде чем окно уйдёт к следующей
const VARS_MS = 2600;      // сколько варианты арбитража видны сами — их три-четыре строки, не одно слово

/** Чем решил арбитраж — человеческими словами (ключи — `by` движка). */
export const BY = {
  "частота": "второе ухо — обычное слово, первое — нет",
  "канон": "написание второго уха известно записи",
  "голосование": "два уха из трёх",
  "вето": "запись знает прежнее слово — большинство не указ",
  "спорно": "уши не сошлись — оставлено как было",
};

/** Исход переслушивания — словами стадии. */
export const HEARD = {
  "речь": "вернулась речь",
  "коротко": "услышано короче",
  "тишина": "тишина — речи там нет",
  "петля осталась": "не вышло — оставлено как было",
  "без изменений": "без изменений",
};

/** Свидетель правки редактора. */
export const WITNESS = { sound: "по звуку", canon: "по канону" };

const EAR = { second: "вторым ухом", clean: "чистым ухом" };

export const WHY = {
  empty: "пусто или ничего не меняет",
  too_long: "слишком длинная — это уже не сущность",
  not_found: "в тексте нет по границам слова",
  number: "меняет число — его решает акустика",
  excision: "выбрасывает слова",
  translation: "перевод обычной речи",
  invented_name: "выдуманное имя",
  breaks_term: "сломало бы известный термин",
};

/** Границы слова — как у движка: замена внутри слова это не сущность, а порча. */
export function wordRe(word) {
  return new RegExp(`(?<![\\w])${String(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`);
}

export function textScene(root) {
  const head = el("p", { class: "tx-head" });
  const body = el("div", { class: "tx-body" });
  const count = el("p", { class: "fx-count" });
  root.append(head, body, count);

  let mode = "idle";
  let speakers = [];         // метки голосов в порядке появления — тот же, что у ленты волны
  let named = {};            // метка → имя, когда его узнал сайт
  let badges = [];           // поставленные метки говорящего: их переписываем, когда придут имена
  let lastSpk = null;        // кто говорил в предыдущем куске
  let chunk = null;          // текущий кусок пасса-2: {from, to, spk}
  let toTop = false;         // пришёл черновик — после пачки вернуть фокус в начало
  let pending = "";          // что печатается сейчас
  let typed = 0;
  let marks = [];            // узлы уже поставленной корректуры — их не трогаем
  let tail = null;           // текстовый узел, в который печатаем
  let anchors = [];          // [[секунда, узел]] — куда листать по времени реплики
  let applied = 0, dropped = 0, turns = 0;
  let taken = 0, kept = 0;   // решения арбитража: взято / оставлено
  let heard = 0, back = 0;   // переслушано мест / из них вернулась речь
  let edPage = "";           // шапка редактора: какая страница читается
  const jobs = [];
  let busy = 0;
  let landing = 0;           // кусков, которые ещё встают на место черновика (отложено таймером)
  let raf = null;
  // ⚠️⚠️ Слежение — по ВИДИМОСТИ ФРОНТА, а не по таймеру (владелец, 30.09): «если перемотались
  // туда, где виден фронт работы, — следим за ним; если нет — просто читаем». Фронт — узел, над
  // которым сцена работает прямо сейчас (печатаемый кусок, подсвеченное слово). Человек ушёл
  // жестом или кликом по волне туда, где фронта не видно, — окно больше не дёргается; вернулся
  // к нему — снова ведёт. Прежний таймер «4 с не бежим за человеком» возвращал окно через
  // четыре секунды посреди чтения.
  let following = true;
  let front = null;

  // ⚠️⚠️ «Человек листает сам» берём из ЕГО ЖЕСТОВ, а не из события `scroll`. Событие поднимает
  // и наша собственная прокрутка, и сам браузер — подстановка корректуры меняет высоту строки
  // (надпись над ней), и он подтягивает scrollTop сам. Пока признаком считался `scroll`,
  // слежение выключалось САМО себя после первой же замены, и корректура ложилась за краем окна
  // (замерено на стенде: 2 корректуры в тексте, ни одной в видимой части). Тот же приём, что
  // в читалке сайта (`web/js/records/reader.js`), и по той же причине.
  let lookTimer = null;
  function look() {
    // Решаем после того, как прокрутка от жеста состоялась: сам жест приходит до неё.
    if (lookTimer) clearTimeout(lookTimer);
    lookTimer = setTimeout(() => { lookTimer = null; following = frontVisible(); }, LOOK_MS);
  }
  for (const type of ["wheel", "touchmove", "keydown"]) {
    body.addEventListener(type, () => { following = false; look(); }, { passive: true });
  }

  function pump() { if (raf === null) raf = requestAnimationFrame(tick); }

  /** Смещение узла ВНУТРИ окна текста.
   *
   * ⚠️ Меряем ПРЯМОУГОЛЬНИКАМИ, а не `offsetTop`: тот считается от ближайшего
   * позиционированного предка, а окно текста позиционировано не всегда — тогда к смещению
   * приплюсовывалась вся шапка страницы, прокрутка улетала в конец и корректура оставалась за
   * кадром. Разница прямоугольников не зависит от вёрстки вокруг; `offsetTop` остаётся запасным
   * путём для узлов без геометрии (тесты).
   */
  function offsetIn(node) {
    if (typeof node.getBoundingClientRect !== "function"
        || typeof body.getBoundingClientRect !== "function") return node.offsetTop || 0;
    return node.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
  }

  /** Пока текст ПИШЕТСЯ, окно держится КОНЦА, а не начала последнего куска.
   *
   * ⚠️ Прежде слежение выводило на середину окна НАЧАЛО куска — а кусок бывает в несколько
   * строк, и самое свежее (то, ради чего смотрят) оказывалось ниже края. Здесь нужно
   * поведение ленты: новое приходит снизу, окно его догоняет.
   */
  /** Виден ли фронт работы в окне текста (хоть краем). Фронта нет — считаем, что виден. */
  function frontVisible() {
    if (!front || front.isConnected === false) return true;   // фронта нет или он заменён
    if (typeof front.getBoundingClientRect !== "function" || typeof body.getBoundingClientRect !== "function") return true;
    const f = front.getBoundingClientRect(), b = body.getBoundingClientRect();
    return f.bottom >= b.top && f.top <= b.bottom;
  }

  function toEnd() {
    if (!following) return;
    body.scrollTop = body.scrollHeight;
  }

  function follow(node) {
    // ⚠️ Без behavior:"smooth" — см. шапку файла.
    if (node) front = node;
    if (!node || !following) return;
    body.scrollTop = Math.max(0, offsetIn(node) - body.clientHeight * 0.45);
  }

  /** Темп показа правок.
   *
   * ⚠️ Финал-раунд считает реплики ПАЧКАМИ (шесть разом), и при ровном темпе очередь
   * растёт, а окно показывает то, что было минуту назад. Окно показывает работу СЕЙЧАС — значит,
   * чем длиннее очередь, тем короче пауза; при пустой очереди замена показана не быстрее,
   * чем её можно прочитать.
   */
  function pace(queued) {
    const k = queued > 24 ? 0.25 : queued > 8 ? 0.5 : 1;
    return { hold: Math.round(HOLD_MS * k), gap: Math.round(GAP_MS * k) };
  }

  /** Сколько правка стоит в кадре после замены. ⚠️ Прежде окно уходило к следующей правке через
   * четверть секунды после замены: правка производилась, но увидеть её было нельзя (владелец,
   * 30.09). Очередь длинная — меньше, но не до нуля: смысл показа — увидеть. */
  function dwell(queued) {
    return Math.round(DWELL_MS * (queued > 24 ? 0.35 : queued > 8 ? 0.6 : 1));
  }

  function tick(now) {
    raf = null;
    let more = false;
    if (pending) {
      const step = reduced() ? pending.length
                             : Math.max(1, Math.ceil(pending.length / (TYPE_MS / 16)));
      typed = Math.min(pending.length, typed + step);
      if (tail) tail.textContent = pending.slice(0, typed);
      if (typed >= pending.length) { pending = ""; typed = 0; tail = null; }
      else more = true;
      toEnd();
    }
    // ⚠️⚠️ Правка и решение арбитража ждут, пока ВСЕ отложенные куски не встанут на место: кусок
    // переписывает свой текст целиком и стёр бы пометку, поставленную раньше него. В видимой
    // вкладке порядок держат таймеры, но в фоне браузер их придерживает, а решения арбитража
    // приходят сразу за пассом-2 (поймано на стенде 30.09: счётчик решений рос, пометок — ноль).
    const blocked = landing > 0 && jobs.length && jobs[0].t !== "chunk";
    if (jobs.length && now >= busy && !blocked) { runJob(jobs.shift(), now); more = true; }
    if (jobs.length) more = true;
    if (more) pump();
  }

  // --- текст пишется ---------------------------------------------------------------------

  function append(sec, raw, { draft = false, to = 0 } = {}) {
    // ⚠️ Черновик приходит ПАЧКОЙ (замерено на живой записи: 119 окон за 0.04 с) — печатать
    // его по кадрам незачем: получается долгая рябь вместо текста, и фокус уезжает в конец, а
    // чистовой проход начнётся сначала (решение владельца 25.09).
    if (draft) {
      finishTyping();
      const piece = el("span", { class: "tx-piece tx-draft", text: `${(raw || "").trim()} ` });
      piece.at = sec;
      piece.till = to || sec;
      body.append(piece);
      anchors.push([sec, piece]);
      return piece;
    }
    // ⚠️ Прежний кусок дописываем ЦЕЛИКОМ, а не по напечатанному: иначе при быстром потоке
    // (или перемотке на стенде) каждый новый кусок обрезал бы предыдущий на полуслове, и от
    // текста оставались бы огрызки. Печать — это скорость показа, а не содержимое.
    finishTyping();
    const piece = el("span", { class: draft ? "tx-piece tx-draft" : "tx-piece" });
    piece.at = sec;                       // окно куска: по нему чистовик находит свой черновик
    piece.till = to || sec;
    body.append(piece);
    anchors.push([sec, piece]);
    tail = piece;
    front = piece;
    pending = (raw || "").trim() + " ";
    typed = 0;
    toEnd();          // кусок уже в разметке — показываем конец сразу, а не со следующего кадра
    pump();
    return piece;
  }

  /** Имя или метка голоса для подписи. */
  function who(spk) {
    return named[spk] || spk;
  }

  /** Метка говорящего перед куском.
   *
   * ⚠️ Смена голоса есть ТОЛЬКО в `chunk.start.spk`: ни в `chunk.done`, ни в событиях
   * финал-раунда говорящего нет вовсе (реплики получают имя позже, уже внутри движка). Поэтому
   * метки расставляет пасс-2, и дальше они просто остаются в тексте.
   * ⚠️ Метка БЛОЧНАЯ — сама переносит строку. Перестраивать уже разложенный черновик в абзацы
   * задним числом нельзя: он лежит сплошным потоком, и перекладка сбила бы прокрутку.
   */
  function badge(spk, before, { into = null } = {}) {
    if (!spk || spk === lastSpk) return null;
    lastSpk = spk;
    const idx = Math.max(0, speakers.indexOf(spk));
    const mark = el("span", { class: "tx-who" },
      el("i", { style: `background:${colour(idx)}` }), who(spk));
    mark.spk = spk;
    badges.push(mark);
    if (into) into.append(mark);
    else if (before && before.parentElement) before.parentElement.insertBefore(mark, before);
    else body.append(mark);
    return mark;
  }

  // --- текст правится --------------------------------------------------------------------

  /** Узел, ближе всего стоящий к этой секунде записи: по нему ищем слово и туда листаем. */
  function near(sec) {
    let best = null;
    for (const [at, node] of anchors) {
      if (at <= sec + 1) best = node;
      else break;
    }
    return best;
  }

  /** Найти слово в тексте — в куске, где оно звучит, потом в ближайших ПО ВРЕМЕНИ.
   *
   * ⚠️⚠️ Искать надо от секунды САМОЙ ПРАВКИ (`sec`), а не от последней пришедшей реплики, и
   * соседей брать по близости во времени, а не с начала документа. Реплики приходят в ленте сразу,
   * а правки идут очередью с отставанием: поиск от «текущей» реплики находил термин в ЧУЖОЙ реплике
   * (замер 30.09: три правки «графана» в трёх репликах — все три легли со сдвигом), а запасной ход
   * «первое совпадение с начала» уводил окно наверх, и правку было не видно вовсе.
   */
  function locate(word, sec = current) {
    const re = wordRe(word);
    const pieces = [...body.children].filter((n) => n.classList.contains("tx-piece"));
    const inside = (p) => p.at != null && sec + 1 >= p.at && sec - 1 <= (p.till ?? p.at);
    const dist = (p) => (inside(p) ? -1 : p.at == null ? 1e9 : p.at >= sec ? p.at - sec : (sec - p.at) * 2);
    const order = pieces.map((p, i) => [dist(p), i, p]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
    for (const piece of order) {
      for (const node of [...piece.childNodes]) {
        if (node.nodeType !== 3) continue;                   // текстовые узлы; корректуру не трогаем
        const hit = re.exec(node.textContent);
        if (hit) return { node, index: hit.index, word: hit[0], piece };
      }
    }
    return null;
  }

  let current = 0;

  function finishTyping() {
    // ⚠️ Правка ищет слово в готовом тексте. Если в этот момент что-то ещё печатается, слово может
    // быть «ещё не напечатано» — и правка молча не найдёт его. Дописываем немедленно: текст и так
    // весь пришёл, печать — только скорость показа.
    if (!pending) return;
    if (tail) tail.textContent = pending;
    pending = ""; typed = 0; tail = null;
  }

  /** Черновой кусок, накрывающий эту секунду: в него встанет чистовик.
   *
   * ⚠️ Забираем кусок СРАЗУ (`taken`), а не в момент подмены: между постановкой в очередь и
   * заменой проходит доля секунды, и соседний чанк успел бы выбрать тот же черновик.
   */
  /** Остались ли черновые куски (хоть один незаменённый). */
  function drafts() {
    for (const node of body.children) if (node.classList.contains("tx-draft")) return true;
    return false;
  }

  /** Окно черновика, в которое попадает эта секунда.
   *
   * ⚠️⚠️ Окно НЕ ЗАНИМАЕТСЯ первым же куском. Черновое окно — 30 секунд, а кусков пасса-2
   * на него приходится ДВА (замерено на живой записи: 243 куска на 119 окон). Когда окно
   * занималось, второй кусок не находил себе места и дописывался В КОНЕЦ текста — вместе со
   * своей меткой говорящего. Снаружи это выглядело как «подписей спикеров нет» (они были внизу, за
   * сотней кусков черновика) и «чистовик идёт не сначала».
   */
  function windowAt(sec) {
    let last = null;
    for (const node of body.children) {
      if (!node.classList.contains("tx-piece")) continue;
      if (node.at == null) continue;
      if (sec + 0.5 >= node.at && sec - 0.5 <= (node.till ?? node.at)) return node;
      if (node.at <= sec) last = node;
    }
    return last && last.classList.contains("tx-draft") ? last : null;
  }

  function runJob(job, now) {
    if (job.t === "chunk") runChunk(job, now);
    else if (job.t === "arb") runArb(job, now);
    else if (job.t === "rl") runRelisten(job, now);
    else runFix(job, now);
  }

  /** Переслушанное место: сорвавшийся текст куска сменяется услышанным прямо в тексте.
   *
   * Ищем прежний текст куска целиком (событие несёт его начало, до 200 знаков); не нашли —
   * берём черновое окно этой секунды. «Тишина» оставляет место пустым, но пометку ставит: пустое
   * место без пометки выглядело бы как потерянный текст.
   */
  function runRelisten(e, now) {
    finishTyping();
    heard += 1;
    const ok = e.verdict === "речь" || e.verdict === "коротко";
    if (ok) back += 1;
    summary();
    current = e.from ?? current;
    const { hold, gap } = pace(jobs.length);
    const was = (e.was || "").trim();
    const spot = was ? locate(was, Number(e.from ?? current)) : null;
    if (!spot) { busy = now + gap; return; }
    const rest = spot.node.splitText(spot.index);
    rest.splitText(spot.word.length);
    const mark = el("span", { class: "tx-hit", text: spot.word });
    rest.replaceWith(mark);
    follow(mark);
    busy = now + hold + (ok ? CUT_MS : 0) + dwell(jobs.length) + gap;
    const land = () => {
      const say = HEARD[e.verdict] || e.verdict || "";
      const shown = ok ? (e.now || "").trim() : e.verdict === "тишина" ? "…" : spot.word;
      const layer = el("span", { class: "ed-old" },
        el("s", { class: "ed-gone", text: spot.word.length > 48 ? `${spot.word.slice(0, 46)}…` : spot.word }),
        el("span", { class: "ed-note", text: `${clock(e.from)}–${clock(e.to)} · ${say}` }));
      const fix = el("span", { class: `ed rl ${ok ? "" : "no "}fresh`.replace(/\s+/g, " ") },
        el("span", { class: ok ? "ed-now" : "ed-kept", text: shown }), layer);
      mark.replaceWith(fix);
      marks.push(fix);
      fit(layer);
      fix.addEventListener("mouseenter", () => fit(layer));
      setTimeout(() => fix.classList.remove("fresh"), VARS_MS);
    };
    if (reduced()) land();
    else if (ok) { setTimeout(() => mark.classList.add("cut"), hold); setTimeout(land, hold + CUT_MS); }
    else setTimeout(land, hold);
  }

  /** Решение арбитража на слове: подсветка → варианты над словом → выбранное в тексте.
   *
   * ⚠️ Варианты — СПИСКОМ строк «чьё ухо — что услышало», а не стрелкой «было → стало»: выбор
   * идёт из двух-трёх равноправных версий, и стрелка врала бы, будто одна из них — исправление
   * другой. Первая строка зачёркнута, только если слово действительно заменено.
   */
  function runArb(e, now) {
    finishTyping();
    if (e.taken) taken += 1; else kept += 1;
    summary();
    current = e.from ?? current;
    const { hold, gap } = pace(jobs.length);
    const spot = locate(e.was || "", Number(e.from ?? current));
    if (!spot) { busy = now + gap; return; }
    const rest = spot.node.splitText(spot.index);
    rest.splitText(spot.word.length);
    const mark = el("span", { class: "tx-hit", text: spot.word });
    rest.replaceWith(mark);
    follow(mark);
    busy = now + hold + dwell(jobs.length) + gap;
    const land = () => {
      const rows = [["1-е ухо", spot.word, e.taken], ["2-е ухо", e.now, false]];
      if (e.clean) rows.push(["3-й голос", e.clean, false]);
      const layer = el("span", { class: "ed-old ed-vars" },
        ...rows.map(([ear, word, gone]) => el("span", { class: "ed-var" },
          el("span", { class: "ed-ear", text: ear }),
          gone ? el("s", { class: "ed-gone", text: word }) : el("b", { text: word }))),
        el("span", { class: "ed-note", text: BY[e.by] || e.by || "" }));
      const fix = el("span", { class: e.taken ? "ed arb fresh" : "ed arb no fresh" },
        el("span", { class: e.taken ? "ed-now" : "ed-kept", text: e.taken ? e.now : spot.word }), layer);
      mark.replaceWith(fix);
      marks.push(fix);
      fit(layer);
      fix.addEventListener("mouseenter", () => fit(layer));   // окно прокрутили — место над словом другое
      setTimeout(() => fix.classList.remove("fresh"), VARS_MS);
    };
    if (reduced()) land(); else setTimeout(land, hold);
  }

  /** Чистовой кусок пасса-2 ВСТАЁТ НА МЕСТО чернового (решение владельца 24.09).
   *
   * Так виден смысл второго прохода: текст записи лежит целиком уже после пасса-1, а пасс-2
   * проходит по нему и уточняет кусок за куском. Подсветка — та же единственная, что у правок.
   */
  function runChunk(job, now) {
    finishTyping();
    const { hold, gap } = pace(jobs.length);
    const spot = windowAt(job.from);
    if (!spot) {                       // черновика нет (окно открыли позже) — просто дописываем
      badge(job.spk, null);
      append(job.from, job.raw, { to: job.to });
      busy = now + gap;
      return;
    }
    const fresh = spot.classList.contains("tx-draft");
    if (fresh) badge(job.spk, spot);   // метка перед куском — когда кусок только начинается
    spot.classList.add("tx-hit");
    follow(spot);
    busy = now + hold + gap;
    landing += 1;
    const land = () => {
      landing = Math.max(0, landing - 1);
      pump();
      spot.classList.remove("tx-hit");
      const text = `${(job.raw || "").trim()} `;
      if (fresh) {
        spot.classList.remove("tx-draft");
        spot.textContent = text;
      } else {
        // Второй кусок того же окна: дописываем В НЕГО, а не в конец текста; метка
        // говорящего тоже встаёт внутрь — голос сменился серединой окна, а не перед ним.
        const mark = badge(job.spk, null, { into: spot });
        if (!mark) spot.append(document.createTextNode(text));
        else spot.append(document.createTextNode(text));
      }
      spot.till = job.to || spot.till;
    };
    if (reduced()) land(); else setTimeout(land, hold);
  }

  function runFix(e, now) {
    finishTyping();
    const ok = e.ok === true;
    if (ok) applied += 1; else dropped += 1;
    summary();
    const { hold, gap } = pace(jobs.length);
    const spot = locate(e.was || "", Number(e.start ?? current));
    if (!spot) { busy = now + gap; return; }                   // вне показанного — честно молчим

    // Разрезаем текстовый узел и ставим на слово ОДНУ подсветку — ту же, что и всегда.
    const rest = spot.node.splitText(spot.index);
    const after = rest.splitText(spot.word.length);
    const mark = el("span", { class: "tx-hit", text: spot.word });
    rest.replaceWith(mark);
    void after;
    follow(mark);                                             // листаем к СЛОВУ, а не к куску: кусок бывает выше окна
    busy = now + hold + (ok ? CUT_MS : 0) + dwell(jobs.length) + gap;

    // Зачёркивание — ОТДЕЛЬНЫЙ шаг перед заменой, и только у принятой правки: мгновенная
    // подмена читается как опечатка показа — глаз не успевает увидеть, ЧТО именно исправили.
    const cut = () => mark.classList.add("cut");

    const land = () => {
      // ⚠️ В тексте остаётся ИСПРАВЛЕННОЕ слово (оранжевым), а прежнее уходит в слой над
      // текстом и всплывает по наведению (решение владельца 24.09). Конец работы — это готовая
      // расшифровка, а не лист корректуры: читать надо то, что получилось.
      // ⚠️ Отвергнутая правка текст НЕ меняет вовсе — остаётся только точечная пометка, иначе
      // наводить было бы незачем и некуда.
      // ⚠️ Слова «было» не нужно: зачёркнутое слово и значит «было и ушло» — подпись к
      // очевидному только занимает место. У отвергнутой правки зачёркнута ПРЕДЛОЖЕННАЯ замена
      // (её в тексте нет), а рядом — почему.
      const gone = ok ? spot.word : e.now;
      const note = ok ? (WITNESS[e.witness] || "")
                      : [WHY[e.why] || e.why || "", e.term ? `«${e.term}»` : ""].filter(Boolean).join(" ");
      // ⚠️ Простые `span`, а НЕ `ruby`/`rt`: у `ruby` своя раскладка, а у `inline-block`, которым
      // её приходилось гасить, — своя высота и свои точки переноса: строка с правкой становилась
      // выше соседних, а знак препинания за словом уезжал на следующую. Замена обязана
      // вести себя как обычное слово — иначе текст дёргается на каждой правке.
      const fix = el("span", { class: ok ? "ed fresh" : "ed no fresh" },
        el("span", { class: ok ? "ed-now" : "ed-kept", text: ok ? e.now : spot.word }));
      const rt = el("span", { class: "ed-old" }, el("s", { class: "ed-gone", text: gone }));
      if (note) rt.append(el("span", { class: "ed-note", text: note }));
      fix.append(rt);
      mark.replaceWith(fix);
      marks.push(fix);
      fit(rt);
      setTimeout(() => fix.classList.remove("fresh"), FRESH_MS);
    };

    if (reduced()) land();
    else if (ok) { setTimeout(cut, hold); setTimeout(land, hold + CUT_MS); }
    else setTimeout(land, hold);
  }

  /** Слой со старым словом — внутрь окна. Он висит над словом, а слово бывает у самого края:
   * без сдвига фраза уезжала бы за границу (у окна `overflow-x:hidden`) и обрезалась молча. */
  function fit(node) {
    if (typeof node.getBoundingClientRect !== "function") return;
    node.style.marginLeft = "0px";
    const box = body.getBoundingClientRect();
    const over = node.getBoundingClientRect().right - (box.right - 10);
    if (over > 0) node.style.marginLeft = `${-over}px`;
    // Слой вариантов арбитража высокий (три-четыре строки): у верхнего края окна он уходил за край
    // и терял первую строку — «1-е ухо» (стенд 30.09). Места сверху нет — открываем под словом.
    node.classList.remove("below");
    if (node.getBoundingClientRect().top < box.top + 4) node.classList.add("below");
  }

  function summary() {
    const parts = [];
    if (heard) parts.push(`переслушано ${heard} · вернулась речь в ${back}`);
    if (taken || kept) parts.push(`второе ухо: взято ${taken} · оставлено ${kept}`);
    if (applied || dropped) parts.push(`правки: принято ${applied} · отброшено ${dropped}`);
    if (turns) parts.push(`реплик ${turns}`);
    count.textContent = parts.join(" · ");
  }

  return {
    apply(e) {
      // ⚠️ Пачка черновика кончилась — ставим фокус В НАЧАЛО: чистовой проход пойдёт
      // сверху вниз, и человек должен видеть его начало, а не конец черновика.
      if (toTop && e.t !== "draft.window") { body.scrollTop = 0; toTop = false; }
      if (e.t === "diar.spans") { speakers = e.speakers || []; return; }
      // ⚠️ Черновик приходит ПАЧКОЙ в конце пасса-1 (whisper слушает файл одним вызовом),
      // и это не недоработка показа, а устройство модели. Зато уже к третьей минуте в окне лежит
      // весь текст записи, и дальше он на глазах уточняется.
      if (e.t === "stage.start" && e.stage === "pass1") {
        root.removeAttribute("hidden");
        mode = "draft";
        head.textContent = "слушаю целиком — черновик";
        return;
      }
      if (e.t === "draft.window") {
        root.removeAttribute("hidden");
        if (mode === "idle") mode = "draft";
        append(e.from || 0, e.text || "", { draft: true, to: e.to || 0 });
        toTop = true;
        return;
      }
      if (e.t === "stage.start" && e.stage === "pass2") {
        root.removeAttribute("hidden");
        mode = "writing";
        head.textContent = body.children.length
          ? "распознаю по кускам — чистовик встаёт на место черновика"
          : "распознаю — текст появляется по мере готовности";
        return;
      }
      if (e.t === "chunk.start") {
        current = e.from ?? current;
        chunk = { from: e.from ?? current, to: e.to ?? current, spk: e.spk || "" };
        return;
      }
      if (e.t === "chunk.done" && mode === "writing" && e.raw) {
        const job = { t: "chunk", raw: e.raw, ...(chunk || { from: current, to: current, spk: "" }) };
        // ⚠️ Через очередь идёт только ЗАМЕНА черновика: её надо успеть увидеть. Когда
        // черновика нет (окно открыли позже), кусок просто дописывается СРАЗУ — тормозить
        // появление текста ради темпа незачем.
        if (drafts()) { jobs.push(job); pump(); } else { runChunk(job, performance.now()); }
        return;
      }
      if (e.t === "stage.start" && e.stage === "relisten") {
        root.removeAttribute("hidden");
        head.textContent = "слушаю ещё раз места, где модель сорвалась — услышанное встаёт в текст";
        return;
      }
      if (e.t === "relisten.span") { jobs.push({ ...e, t: "rl" }); pump(); return; }
      if (e.t === "stage.start" && e.stage === "arbitrate") {
        root.removeAttribute("hidden");
        mode = "arbitrating";
        head.textContent = "сверяю вторым ухом — над словом все варианты, выбранное оранжевым";
        return;
      }
      if (e.t === "arbitrate.chunk") { current = e.from ?? current; return; }
      if (e.t === "arbitrate.swap") { jobs.push({ ...e, t: "arb" }); pump(); return; }
      if (e.t === "stage.start" && e.stage === "editor") {
        root.removeAttribute("hidden");
        mode = "fixing";
        edPage = "";
        head.textContent = "редактор перечитывает страницы — исправленное оранжевым; наведите, чтобы увидеть прежнее";
        return;
      }
      // Шапка редактора: какую страницу читает и где сомневается (что переслушивает и каким ухом).
      if (e.t === "editor.page") {
        edPage = `редактор · страница ${(e.page ?? 0) + 1} из ${e.of} (${clock(e.from)}–${clock(e.to)})`;
        head.textContent = edPage;
        return;
      }
      if (e.t === "editor.listen") {
        head.textContent = `${edPage || "редактор"} · переслушивает ${clock(e.from)}–${clock(e.to)} ${EAR[e.ear] || ""}`.trim();
        return;
      }
      if (e.t === "stage.start" && e.stage === "final-round") {
        root.removeAttribute("hidden");
        mode = "fixing";
        head.textContent = "правлю сущности — исправленное оранжевым; наведите, чтобы увидеть прежнее";
        return;
      }
      if (e.t === "turn.text") {
        // ⚠️ Реплика НЕ уводит окно, пока в очереди правки: иначе окно металось между новой
        // репликой и правкой из прошлой (правка сама листает к своему слову, когда до неё дойдёт).
        const sec = e.start || 0;
        if (!body.children.length) { current = sec; append(sec, e.text || ""); }
        else if (!jobs.length) { current = sec; follow(near(sec)); }
        return;
      }
      if (e.t === "turn.fix") { jobs.push(e); pump(); return; }
      if (e.t === "turn.done") { turns = e.n || turns; summary(); return; }
      // Имена узнал сайт — подписи переписываются НА МЕСТЕ, без пересборки текста.
      if (e.t === "voices.named") {
        named = {};
        for (const [label, v] of Object.entries(e.by_label || {})) named[label] = v.name || label;
        for (const mark of badges) {
          const dot = mark.children && mark.children[0];
          mark.textContent = who(mark.spk);
          if (dot) mark.prepend(dot);
        }
      }
    },
    reset() {
      mode = "idle"; pending = ""; typed = 0; tail = null; jobs.length = 0; busy = 0; landing = 0;
      following = true; front = null;
      speakers = []; named = {}; badges = []; lastSpk = null; chunk = null; toTop = false;
      applied = dropped = turns = current = 0;
      taken = kept = 0; edPage = ""; heard = back = 0;
      marks = []; anchors = [];
      head.textContent = ""; body.replaceChildren(); count.textContent = "";
      root.setAttribute("hidden", "");
    },
    /** Клик по волне: текст — к этой секунде. Фронт работы там виден — слежение продолжается,
     *  нет — человек читает, и окно его не дёргает, пока он сам не вернётся к фронту. */
    seek(sec) {
      const node = near(Number(sec) || 0) || windowAt(Number(sec) || 0);
      if (!node) return;
      body.scrollTop = Math.max(0, offsetIn(node) - body.clientHeight * 0.2);
      node.classList.add("tx-seek");
      setTimeout(() => node.classList.remove("tx-seek"), 1200);
      following = frontVisible();
    },
    state: () => ({ mode, applied, dropped, turns, taken, kept, heard, back, following, head: head.textContent,
                    text: body.textContent, speakers: badges.length,
                    edits: marks.length, queued: jobs.length }),
  };
}
