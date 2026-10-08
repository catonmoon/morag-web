// Ядро фильтров списка: отбор, порядок, фасеты, адрес.
//
// Проверяется КЛАСС ошибки, а не один вызов: у фасетов легко получить «выбрал чип — у всех
// соседей ноль», у сортировки — курс задом наперёд, у адреса — потерянный при возврате отбор.
//     node tests/js/records.test.mjs
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const {
  EMPTY, MULTI, applyFilters, facet, fromQuery, hasValue, isEmpty, listOf, sortFor, sortRecords,
  subAxis, toQuery, withValue, outline, isOutline, inFeed,
} = await import(join(repo, "web/js/records/filter.js"));

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log("  ✓", name);
  } catch (error) {
    failures += 1;
    console.log("  ✗", name, "\n     ", error.message.split("\n")[0]);
  }
};

const rec = (id, date, extra = {}) => ({
  id, date, title: id, summary: "", speakers: [], tags: [], duration_sec: 600,
  section: "", subgroup: "", ...extra,
});

// Корпус в миниатюре: две ветки, у одной год второй осью, у другой курс.
const CORPUS = [
  rec("свежая", "2026-05-01", { section: "Летучка", subgroup: "2026", tags: ["Демо"],
                                speakers: ["Кузнецова"], title: "Демо по лимитам",
                                category: "Очереди", topics: ["Kafka", "партиции"] }),
  rec("прошлогодняя", "2025-03-01", { section: "Летучка", subgroup: "2025", tags: ["Демо", "Kafka"],
                                      participants: ["Ковалёв", "Соколова"], kind: ["Воркшоп"] }),
  rec("занятие-2", "2025-01-01", { section: "Курс", subgroup: "Питон 2023", title: "Занятие 2",
                                   category: "Базы данных", topics: ["PostgreSQL"] }),
  rec("занятие-10", "2025-01-01", { section: "Курс", subgroup: "Питон 2023", title: "Занятие 10" }),
  rec("сирота", "2024-01-01", { title: "Без раздела" }),
];
const state = (patch) => ({ ...EMPTY, ...patch });

console.log("фильтры списка записей:");

check("раздел сужает список", () => {
  assert.deepEqual(applyFilters(CORPUS, state({ section: "Курс" })).map((r) => r.id),
                   ["занятие-2", "занятие-10"]);
});

check("подраздел и год — разные оси", () => {
  assert.equal(applyFilters(CORPUS, state({ sub: "Питон 2023" })).length, 2);
  assert.equal(applyFilters(CORPUS, state({ year: "2025" })).length, 3);
});

check("метка и спикер отбирают по вхождению в список", () => {
  assert.deepEqual(applyFilters(CORPUS, state({ tag: "Kafka" })).map((r) => r.id), ["прошлогодняя"]);
  assert.deepEqual(applyFilters(CORPUS, state({ speaker: "Кузнецова" })).map((r) => r.id), ["свежая"]);
});

check("человек находится в любой роли — участник тоже человек записи", () => {
  // По человеку ищут, не зная, выступал он или спрашивал: фильтр «человек» смотрит в оба
  // списка, и подстрочный поиск тоже.
  assert.deepEqual(applyFilters(CORPUS, state({ speaker: "Ковалёв" })).map((r) => r.id), ["прошлогодняя"]);
  assert.deepEqual(applyFilters(CORPUS, state({ speaker: "Соколова" })).map((r) => r.id), ["прошлогодняя"]);
  assert.deepEqual(applyFilters(CORPUS, state({ q: "соколов" })).map((r) => r.id), ["прошлогодняя"]);
});

check("формат записи — своё измерение", () => {
  assert.deepEqual(applyFilters(CORPUS, state({ kind: "Воркшоп" })).map((r) => r.id), ["прошлогодняя"]);
  assert.deepEqual(applyFilters(CORPUS, state({ q: "воркшоп" })).map((r) => r.id), ["прошлогодняя"]);
});

check("категория — одна на запись, тема — из списка; поиск видит обе", () => {
  assert.deepEqual(applyFilters(CORPUS, state({ category: "Очереди" })).map((r) => r.id), ["свежая"]);
  assert.deepEqual(applyFilters(CORPUS, state({ topic: "PostgreSQL" })).map((r) => r.id), ["занятие-2"]);
  assert.deepEqual(applyFilters(CORPUS, state({ q: "партиц" })).map((r) => r.id), ["свежая"]);
  assert.deepEqual([...facet(CORPUS, state({}), "category").keys()].sort(), ["Базы данных", "Очереди"]);
});

check("год берётся из поля year, если корпус его дал — у лекций дата это дата выкладки", () => {
  // Лекция датирована 2025-м (выкладка), но курс 2023 года: «2025» её НЕ отдаёт, «2023» — отдаёт.
  const lecture = [rec("лекция", "2025-01-01", { section: "Курс", year: "2023" })];
  assert.equal(applyFilters(lecture, state({ year: "2025" })).length, 0);
  assert.equal(applyFilters(lecture, state({ year: "2023" })).length, 1);
  assert.deepEqual([...facet(lecture, state({}), "year").keys()], ["2023"]);
});

check("поиск ищет не только в заголовке", () => {
  // Спрашивают и «про что», и «кто» — заголовка мало.
  assert.deepEqual(applyFilters(CORPUS, state({ q: "кузнец" })).map((r) => r.id), ["свежая"]);
  assert.deepEqual(applyFilters(CORPUS, state({ q: "ЛИМИТ" })).map((r) => r.id), ["свежая"]);
});

check("фильтры складываются", () => {
  assert.equal(applyFilters(CORPUS, state({ section: "Летучка", year: "2025" })).length, 1);
  assert.equal(applyFilters(CORPUS, state({ section: "Курс", year: "2026" })).length, 0);
});

check("запись без раздела остаётся в общем списке", () => {
  assert.ok(applyFilters(CORPUS, state({})).some((r) => r.id === "сирота"));
});

console.log("порядок:");

check("свежие сверху, а ничья — по номеру ПО ВОЗРАСТАНИЮ", () => {
  // ⚠️ Ничья не редкость: у курса все занятия выложены одним днём. Перевёрнутый кортеж дал бы
  // «занятие-10, занятие-2» — курс читался бы вперемешку.
  assert.deepEqual(sortRecords(CORPUS, "new").map((r) => r.id),
                   ["свежая", "прошлогодняя", "занятие-2", "занятие-10", "сирота"]);
});

check("сначала старые разворачивает список, но не номера", () => {
  assert.deepEqual(sortRecords(CORPUS, "old").map((r) => r.id),
                   ["сирота", "занятие-2", "занятие-10", "прошлогодняя", "свежая"]);
});

check("по названию — «по-человечески», 2 раньше 10", () => {
  const titles = sortRecords(CORPUS, "title").map((r) => r.title);
  assert.ok(titles.indexOf("Занятие 2") < titles.indexOf("Занятие 10"));
});

check("порядок раздела приходит с сервера, а не выводится из дат", () => {
  const reading = { default: "desc", sections: { Курс: "asc" } };
  assert.equal(sortFor(state({}), reading), "new");
  assert.equal(sortFor(state({ section: "Курс" }), reading), "old");
  // Выбор человека сильнее умолчания: иначе сортировку нельзя было бы переспорить.
  assert.equal(sortFor(state({ section: "Курс", sort: "new" }), reading), "new");
  // Курс из записей разных лет: порядок — по номеру в названии, а не по дате.
  assert.equal(sortFor(state({}), { default: "title", sections: {} }), "title");
});

console.log("фасеты:");

check("счётчик считается БЕЗ своего измерения", () => {
  // Иначе у выбранного чипа стоит его число, у соседних ноль, и переключиться некуда.
  const counts = facet(CORPUS, state({ section: "Курс" }), "section");
  assert.equal(counts.get("Курс"), 2);
  assert.equal(counts.get("Летучка"), 2);
});

check("счётчик учитывает ОСТАЛЬНЫЕ фильтры", () => {
  const counts = facet(CORPUS, state({ year: "2025" }), "section");
  assert.equal(counts.get("Курс"), 2);
  assert.equal(counts.get("Летучка"), 1);
});

check("вторая ось показывается только там, где это не год", () => {
  // У летучки подраздел — год, и рядом со строкой годов он был бы вторым тем же самым.
  assert.deepEqual(subAxis(CORPUS, state({ section: "Летучка" })), []);
  assert.deepEqual(subAxis(CORPUS, state({ section: "Курс" })), ["Питон 2023"]);
  assert.deepEqual(subAxis(CORPUS, state({})), []);
});

check("глубокое дерево: чип — первый уровень, фильтр — по префиксу пути", () => {
  const deep = [
    rec("a", "2025-06-26", { section: "Лекции", subgroup: "Курсы/QA/2025 весна/Неделя 01" }),
    rec("b", "2025-06-26", { section: "Лекции", subgroup: "Курсы/QA/2024/Неделя 03" }),
    rec("c", "2025-01-01", { section: "Лекции", subgroup: "Видеолекции/Неделя 01/Тема" }),
  ];
  assert.deepEqual(subAxis(deep, state({ section: "Лекции" })), ["Видеолекции", "Курсы"]);
  assert.deepEqual(applyFilters(deep, state({ section: "Лекции", sub: "Курсы" })).map((r) => r.id), ["a", "b"]);
  assert.deepEqual(applyFilters(deep, state({ section: "Лекции", sub: "Курсы/QA/2024" })).map((r) => r.id), ["b"]);
  // «Курсы/QA/202» — не префикс уровня: «2024» не начинается с границы.
  assert.deepEqual(applyFilters(deep, state({ section: "Лекции", sub: "Курсы/QA/202" })), []);
});

check("оглавление: дерево по пути, natural-порядок, своё рядом с неделями — в «Общее»", () => {
  const recs = [
    rec("w10", "2025-01-01", { title: "Моки", section: "Л", subgroup: "QA/2025/Неделя 10", duration_sec: 60 }),
    rec("w2", "2025-01-01", { title: "REST", section: "Л", subgroup: "QA/2025/Неделя 2", duration_sec: 120 }),
    rec("org", "2025-01-01", { title: "Оргсобрание", section: "Л", subgroup: "QA/2025", duration_sec: 30 }),
    rec("cv", "2024-01-01", { title: "Доклад", section: "Л", subgroup: "CV/2024", duration_sec: 10 }),
  ];
  const tree = outline(recs);
  assert.equal(tree.count, 4);
  assert.equal(tree.sec, 220);
  assert.deepEqual(tree.kids.map((k) => k.name), ["CV", "QA"]);
  const y2025 = tree.kids[1].kids[0];
  assert.deepEqual(y2025.kids.map((k) => k.name), ["Неделя 2", "Неделя 10", "Общее"]);
  assert.equal(y2025.leaves.length, 0);
  assert.equal(y2025.kids[2].rest, true);
  assert.deepEqual(y2025.kids[2].leaves.map((r) => r.id), ["org"]);
});

check("оглавление включается конфигом, лента — `view=cards`; общая лента прячет feed_hide", () => {
  const reading = { outline: ["Л"], feed_hide: ["Л/Ролики"] };
  assert.equal(isOutline(state({ section: "Л" }), reading), true);
  assert.equal(isOutline(state({ section: "Л", view: "cards" }), reading), false);
  assert.equal(isOutline(state({}), reading), false);
  const clip = rec("c", "2025-01-01", { section: "Л", subgroup: "Ролики/Неделя 01" });
  assert.equal(inFeed(clip, state({}), reading), false);
  assert.equal(inFeed(clip, state({ section: "Л" }), reading), true);
  assert.equal(inFeed(clip, state({ q: "mock" }), reading), true);
  assert.equal(inFeed(rec("x", "2025-01-01", { section: "Л", subgroup: "Ролики2" }), state({}), reading), true);
});

console.log("адрес:");

check("состояние уезжает в адрес и возвращается из него", () => {
  const s = state({ section: "Курс", tag: "Демо", q: "kafka" });
  const back = fromQuery(toQuery(s));
  assert.deepEqual(back, s);
});

check("пустые ключи в адрес не пишутся", () => {
  assert.equal(toQuery(state({})), "");
  assert.equal(toQuery(state({ year: "2026" })), "?year=2026");
});

check("пустое состояние опознаётся — по нему прячется «сбросить всё»", () => {
  assert.ok(isEmpty(state({})));
  assert.ok(isEmpty(state({ q: "   " })));
  assert.ok(!isEmpty(state({ year: "2026" })));
});

check("множественный выбор: внутри измерения ИЛИ, между измерениями И", () => {
  assert.deepEqual(applyFilters(CORPUS, state({ category: "Очереди|Базы данных" })).map((r) => r.id).sort(),
                   ["занятие-2", "свежая"]);
  assert.deepEqual(applyFilters(CORPUS, state({ tag: "Kafka|Демо" })).map((r) => r.id).sort(),
                   ["прошлогодняя", "свежая"]);
  assert.deepEqual(applyFilters(CORPUS, state({ tag: "Kafka|Демо", category: "Очереди" })).map((r) => r.id),
                   ["свежая"]);
  assert.equal(applyFilters(CORPUS, state({ category: "Очереди" })).length, 1, "одно значение читается как раньше");
});

check("список значений хранится строкой через «|»: включить, выключить, спросить", () => {
  assert.deepEqual(listOf("a|b| c ||"), ["a", "b", "c"]);
  assert.equal(withValue("", "x", true), "x");
  assert.equal(withValue("x", "y", true), "x|y");
  assert.equal(withValue("x|y", "x", false), "y");
  assert.equal(withValue("x|y", "x", true), "y|x", "повторное включение не дублирует");
  assert.ok(hasValue("x|y", "y") && !hasValue("x|y", "z"));
  assert.ok(MULTI.has("category") && !MULTI.has("section"), "раздел остаётся одиночным");
});

check("адрес с несколькими значениями переживает круг состояние → адрес → состояние", () => {
  const s = state({ category: "Очереди|Базы данных", year: "2025" });
  assert.deepEqual(fromQuery(toQuery(s)), s);
});

console.log(failures ? `\n${failures} проверок упало` : "\nвсе проверки прошли");
process.exit(failures ? 1 : 0);
