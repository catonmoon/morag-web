// Минимальный Markdown для ответа агента.
//
// Строим DOM-узлы, а не строку HTML: текст ответа сочиняет модель, и innerHTML
// на нём — это дыра для инъекции. Поддерживаем ровно то, что модель реально
// использует: абзацы, заголовки, списки, таблицы, **жирный**, *курсив*, `код`, ссылки,
// черту `---`, формулы TeX и наши маркеры цитат [N].
//
// Формулы: модели пишут LaTeX — `\(…\)` и `\[…\]` (так deepseek), `$…$` и `$$…$$`
// (так многие другие). Здесь формула на время разбора разметки прячется за меткой
// (иначе `_` и `*` внутри TeX стали бы курсивом, см. MASK) и кладётся узлом
// `.math[data-tex]` с исходником внутри; набирает её KaTeX (`ui/math.js`).
import { el } from "../ui/dom.js";

const INLINE =
  /\*\*((?:`[^`]*`|[^*])+)\*\*|__([^_]+)__|`([^`]+)`|\[(\d+)\]|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*([^*\n]+)\*/g;

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*•]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const RULE = /^(?:-{3,}|\*{3,}|_{3,})$/;

// Таблица: строка начинается с «|», под заголовком — строка-разделитель `|---|:--:|--:|`.
const TABLE_ROW = /^\|.*\|?$/;
const TABLE_SEP = /^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?$/;

/** Ячейки строки `| a | b |`: без крайних «|», экранированный `\|` остаётся внутри ячейки. */
function tableCells(line) {
  const MARK = "\u0000";
  let body = line.trim().replaceAll("\\|", MARK);
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|")) body = body.slice(0, -1);
  return body.split("|").map((cell) => cell.replaceAll(MARK, "|").trim());
}

/** Выравнивание столбцов из строки-разделителя: `:--:` — центр, `--:` — вправо. */
function tableAligns(sepLine) {
  return tableCells(sepLine).map((c) =>
    c.startsWith(":") && c.endsWith(":") ? "al-c" : c.endsWith(":") ? "al-r" : "");
}

// Формула в строке. `$…$` — по правилу pandoc: после открывающего и перед
// закрывающим нет пробела, за закрывающим нет цифры — иначе «от $5 до $10»
// стало бы формулой. Группы: 1 `\(…\)`, 2 `\[…\]`, 3 `$$…$$`, 4 `$…$`.
const MATH_INLINE =
  /\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]|\$\$([^$]+?)\$\$|(?<![\\$])\$(?=[^\s$])([^$\n]*?[^\s\\$])\$(?![\d$])/g;
// Формула блоком: строка начинается с `\[` или `$$`, конец — та же или одна из следующих.
const MATH_FENCES = { "\\[": "\\]", $$: "$$" };

function mathNode(tex, display, source, tag = "span") {
  return el(tag, {
    class: display ? "math math-display" : "math",
    "data-tex": tex.trim(),
    text: source, // пока KaTeX не набрал (или не смог) — виден исходник
  });
}

/** Отрезки текста, занятые формулами: внутри них нет ни сносок, ни границ предложений. */
function mathRanges(src) {
  return [...src.matchAll(MATH_INLINE)].map((m) => [m.index, m.index + m[0].length]);
}
const inside = (ranges, i) => ranges.some(([a, b]) => i > a && i < b);

// Жирное, код и ссылка не должны рваться границей предложения: иначе «**2. Название**» разъезжается
// по двум кускам (точка после «2.» — «конец предложения»), и «**» остаются в тексте ответа.
const SPAN = /\*\*(?:`[^`]*`|[^*])+\*\*|__[^_]+__|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\)/g;
const spanRanges = (src) => [...src.matchAll(SPAN)].map((m) => [m.index, m.index + m[0].length]);

/**
 * @param {string} text  сырой текст ответа
 * @param {(n:number)=>Node|null} makeRef  ссылка на карточку-момент (null — оставить текстом)
 */
// Замерено на живых ответах: модель ставит подзаголовок ОТДЕЛЬНОЙ строкой,
// целиком жирной, а тело — следующими строками через одинарный перенос.
// Поэтому разбираем построчно, а не только по пустым строкам.
const BOLD_LINE = /^\*\*([^*]+?)\*\*[:：]?$/;

export function renderMarkdown(text, { makeRef, onClaim } = {}) {
  const frag = document.createDocumentFragment();
  const lines = String(text || "")
    .replace(/\r\n/g, "\n")
    .split("\n");

  let paragraph = [];  // копим строки обычного текста
  let list = null;     // текущий список
  let math = null;     // формула блоком, которая ещё не закрылась: {close, lines}

  const flushParagraph = () => {
    if (!paragraph.length) return;
    frag.append(withClaims(el("p"), paragraph.join(" "), makeRef, onClaim));
    paragraph = [];
  };
  const flushList = () => {
    if (list) frag.append(list);
    list = null;
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
  };

  for (let row = 0; row < lines.length; row++) {
    const line = lines[row].trim();

    if (math) {
      math.lines.push(line);
      if (line.endsWith(math.close)) {
        const source = math.lines.join("\n");
        frag.append(mathNode(source.slice(math.open.length, -math.close.length), true, source, "div"));
        math = null;
      }
      continue;
    }

    if (!line) {
      flushAll();
      continue;
    }

    const open = line.startsWith("\\[") ? "\\[" : line.startsWith("$$") ? "$$" : null;
    if (open) {
      const close = MATH_FENCES[open];
      const at = line.indexOf(close, open.length);
      if (at === -1) {
        flushAll(); // открылась и не закрылась на этой строке — копим до закрывающей
        math = { open, close, lines: [line] };
        continue;
      }
      if (at === line.length - close.length) {
        flushAll();
        frag.append(mathNode(line.slice(open.length, at), true, line, "div"));
        continue;
      }
      // `\[…\]` и дальше текст — это формула в строке, её разберёт inlineInto
    }

    if (RULE.test(line)) {
      flushAll();
      frag.append(el("hr"));
      continue;
    }

    if (line.startsWith("|") && TABLE_ROW.test(line) && TABLE_SEP.test((lines[row + 1] || "").trim())
        && (lines[row + 1] || "").includes("|")) {
      flushAll();
      const head = tableCells(line);
      const aligns = tableAligns(lines[row + 1]);
      const cols = head.length;
      const cell = (tag, text, i) => {
        const node = withClaims(el(tag, { class: aligns[i] || null }), text, makeRef, onClaim);
        return node;
      };
      const table = el("table");
      const thead = el("thead");
      const headRow = el("tr");
      head.forEach((text, i) => headRow.append(cell("th", text, i)));
      thead.append(headRow);
      table.append(thead);
      const tbody = el("tbody");
      let next = row + 2;
      while (next < lines.length && lines[next].trim().startsWith("|")) {
        const cells = tableCells(lines[next]);
        const tr = el("tr");
        for (let i = 0; i < cols; i++) tr.append(cell("td", cells[i] ?? "", i)); // лишние ячейки отбрасываем, недостающие — пустые
        tbody.append(tr);
        next++;
      }
      table.append(tbody);
      const wrap = el("div", { class: "table-wrap" });
      wrap.append(table);
      frag.append(wrap);
      row = next - 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushAll();
      const level = Math.min(4, Math.max(3, heading[1].length)); // h1/h2 в ответе не нужны
      frag.append(inlineInto(el(`h${level}`), heading[2], makeRef));
      continue;
    }

    const boldHeading = BOLD_LINE.exec(line);
    if (boldHeading) {
      flushAll();
      frag.append(inlineInto(el("h3"), boldHeading[1], makeRef));
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      const wanted = bullet ? "ul" : "ol";
      if (!list || list.tagName.toLowerCase() !== wanted) {
        flushList();
        list = el(wanted);
      }
      list.append(withClaims(el("li"), (bullet || ordered)[1], makeRef, onClaim));
      continue;
    }

    flushList();
    paragraph.push(line);
  }
  // Блок так и не закрылся (оборван ответ) — показываем как текст, ничего не теряя.
  if (math) paragraph.push(...math.lines);
  flushAll();
  return frag;
}

// Конец предложения в живом ответе модели: точка/восклицание/вопрос, а ещё
// перенос строки и начало пункта списка — маркер часто стоит в самом конце
// пункта, и без этого «предложение» уползало в соседний.
const CLAIM_EDGE = /[.!?…]\s|\n/g;
const CLAIM_MAX = 260; // длиннее — уже не «утверждение», а пересказ ответа

/** Границы предложений вне формул: точка в `\(0.17\)` или `\(x. y\)` — не конец. */
function claimEdges(src, ranges) {
  return [...src.matchAll(CLAIM_EDGE)]
    .filter((e) => !inside(ranges, e.index))
    .map((e) => ({ start: e.index, end: e.index + e[0].length }));
}

/** Утверждение вокруг сноски: от конца предыдущего предложения до конца текущего. */
function claimSpan(edges, at, floor, length) {
  let from = floor;
  for (const e of edges) if (e.end <= at && e.start >= floor) from = e.end;
  const tail = edges.find((e) => e.start >= at);
  return [from, tail ? tail.end : length];
}

/**
 * Утверждения ответа по номерам цитат: `[N]` → предложения, где он стоит.
 *
 * Это самый честный ответ на «зачем эта цитата»: не ранжирование и не совпадение
 * слов, а то место, ради подкрепления которого агент её и привёл. Считается
 * даром из уже полученного текста — движок для этого не нужен.
 *
 * @returns {Map<number, string[]>}
 */
export function claimsByRef(text) {
  const src = String(text || "").replace(/\r\n/g, "\n");
  const out = new Map();
  const ranges = mathRanges(src);
  const edges = claimEdges(src, [...ranges, ...spanRanges(src)]);
  for (const m of src.matchAll(/\[(\d+)\]/g)) {
    const n = Number(m.group?.[1] ?? m[1]);
    if (!Number.isFinite(n) || inside(ranges, m.index)) continue;

    // Границы предложения вокруг маркера: назад — до конца предыдущего,
    // вперёд — до конца текущего.
    const [from, to] = claimSpan(edges, m.index, 0, src.length);

    let claim = src
      .slice(from, to)
      .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "") // маркер списка в утверждение не входит
      .replace(/\s+/g, " ")
      .trim();
    if (claim.length > CLAIM_MAX) claim = `${claim.slice(0, CLAIM_MAX - 1).trimEnd()}…`;
    if (!claim || claim === m[0]) continue;

    const list = out.get(n) || [];
    if (!list.includes(claim)) list.push(claim);
    out.set(n, list);
  }
  return out;
}

/**
 * Разложить текст в узел, обернув предложения со сносками в отдельные span'ы.
 *
 * Обёртка НИЧЕГО не меняет в виде текста — она нужна, чтобы потом подсветить
 * ровно то утверждение, ради которого открыли цитату. Границы предложения те
 * же, что у `claimsByRef`: точка/восклицание/вопрос либо конец строки.
 */
function withClaims(node, text, makeRef, onClaim) {
  const src = String(text);
  const ranges = mathRanges(src);
  const marks = [...src.matchAll(/\[(\d+)\]/g)].filter((m) => !inside(ranges, m.index));
  if (!marks.length) return inlineInto(node, src, makeRef);
  const edges = claimEdges(src, [...ranges, ...spanRanges(src)]);

  let cursor = 0;
  for (const mark of marks) {
    if (mark.index < cursor) continue; // сноска внутри уже обёрнутого предложения
    const [from, to] = claimSpan(edges, mark.index, cursor, src.length);

    if (from > cursor) inlineInto(node, src.slice(cursor, from), makeRef);
    const claim = el("span", { class: "claim", "data-n": mark[1] });
    inlineInto(claim, src.slice(from, to), makeRef);
    node.append(claim);
    // Узел отдаём наружу, а не ищем потом селектором: подсветка не должна
    // зависеть от того, как разметка устроена внутри.
    onClaim?.(Number(mark[1]), claim);
    cursor = to;
  }
  if (cursor < src.length) inlineInto(node, src.slice(cursor), makeRef);
  return node;
}

// Голый адрес в тексте тоже делаем ссылкой. Замерено на живом ответе: модель
// пишет URL как придётся — просили markdown-ссылку, получили `**адрес**`
// жирным. Полагаться на её разметку нельзя, поэтому ловим сам адрес.
// Схема обязательна: без неё под «адрес» подошли бы `config.yml/x` и `и т.д./`.
const BARE_URL = /https?:\/\/[^\s<>()[\]«»"']+/g;
const URL_TAIL = /[.,;:!?»)]+$/; // точка в конце предложения — не часть адреса

// Формула на время разбора разметки — непрозрачная метка «N» (символы
// частной области Юникода, в тексте модели их не бывает). Вырезать формулу из
// текста совсем нельзя: модель пишет `**\(b\)**` и «**…параметров \(b\)**» —
// без метки звёздочки оказывались по разные стороны формулы, и жирный не узнавался
// (живой ответ, 05.10). С меткой жирный/курсив видят формулу как обычное слово,
// а TeX внутри (`_`, `*`, `[…]`) разметке недоступен.
const MASK = /(\d+)/g;
const unmask = (text, maths) => (maths ? text.replace(MASK, (_, i) => maths[i][0]) : text);

/** Текст в узел; метки формул — обратно в формулы. */
function put(node, text, maths) {
  if (!maths) return void node.append(text);
  let last = 0;
  for (const m of text.matchAll(MASK)) {
    if (m.index > last) node.append(text.slice(last, m.index));
    const [whole, paren, bracket, dollars, dollar] = maths[Number(m[1])];
    node.append(mathNode(paren ?? bracket ?? dollars ?? dollar, Boolean(bracket ?? dollars), whole));
    last = m.index + m[0].length;
  }
  if (last < text.length) node.append(text.slice(last));
}

function withLinks(node, text, maths) {
  let last = 0;
  for (const m of String(text).matchAll(BARE_URL)) {
    const url = m[0].replace(URL_TAIL, "");
    if (!url) continue;
    if (m.index > last) put(node, text.slice(last, m.index), maths);
    node.append(el("a", { href: url, target: "_blank", rel: "noopener", text: url }));
    last = m.index + url.length;
  }
  if (last < text.length) put(node, text.slice(last), maths);
  return node;
}

function inlineInto(node, text, makeRef) {
  const src = String(text);
  const maths = [];
  const masked = src.replace(MATH_INLINE, (...m) => `${maths.push(m.slice(0, 5)) - 1}`);
  return inlinePlain(node, maths.length ? masked : src, makeRef, maths.length ? maths : null);
}

function inlinePlain(node, text, makeRef, maths) {
  let last = 0;
  for (const m of String(text).matchAll(INLINE)) {
    if (m.index > last) withLinks(node, text.slice(last, m.index), maths);
    const [, bold, boldAlt, code, refNum, linkText, linkUrl, italic] = m;

    // Внутри жирного и курсива адрес тоже бывает — там его и ловим.
    if (bold || boldAlt) {
      const inner = bold || boldAlt;
      // Код внутри жирного (`**`b*`**`) раньше светился обратными кавычками: разбираем вложенное целиком.
      const strong = inner.includes("`") ? inlinePlain(el("strong"), inner, makeRef, maths) : withLinks(el("strong"), inner, maths);
      node.append(strong);
    }
    else if (code) node.append(el("code", { text: unmask(code, maths) })); // в коде адрес и TeX — текст
    else if (refNum) {
      const ref = makeRef?.(Number(refNum));
      node.append(ref || m[0]); // цитаты нет — оставляем как было, не врём ссылкой
    } else if (linkText) {
      node.append(el("a", { href: linkUrl, target: "_blank", rel: "noopener", text: unmask(linkText, maths) }));
    } else if (italic) node.append(withLinks(el("em"), italic, maths));

    last = m.index + m[0].length;
  }
  if (last < text.length) withLinks(node, text.slice(last), maths);
  return node;
}
