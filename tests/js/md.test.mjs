// Проверка рендерера markdown на РЕАЛЬНОМ ответе движка (из записанной фикстуры).
// Браузера нет — подставляем минимальный DOM и смотрим на получившееся дерево.
//     node tests/js/md.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");

// --- крошечный DOM ---------------------------------------------------------
class Node_ {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.kids = [];
    this.attrs = {};
  }
  set textContent(value) {
    this.kids = [String(value)];
  }
  get textContent() {
    return this.kids.map((k) => (typeof k === "string" ? k : k.textContent)).join("");
  }
  set className(v) {
    this.attrs.class = v;
  }
  set innerHTML(v) {
    this.kids = [String(v)];
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener() {}
  append(...kids) {
    for (const kid of kids.flat()) {
      if (kid == null) continue;
      if (kid instanceof Frag) this.kids.push(...kid.kids);
      else this.kids.push(kid);
    }
  }
}
class Frag extends Node_ {
  constructor() {
    super("#fragment");
  }
}
globalThis.document = {
  compatMode: "CSS1Compat", // иначе KaTeX ворчит про quirks mode
  createElement: (tag) => new Node_(tag),
  createDocumentFragment: () => new Frag(),
  createTextNode: (t) => String(t),
};

const { renderMarkdown, claimsByRef } = await import(join(repo, "web/js/chat/md.js"));

// --- текст ответа из фикстуры ---------------------------------------------
function answerFromFixture(name) {
  const raw = readFileSync(join(repo, "tests/fixtures", name), "utf8");
  let text = "";
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6);
    if (payload.trim() === "[DONE]") continue;
    const obj = JSON.parse(payload);
    const content = obj?.choices?.[0]?.delta?.content;
    if (content) text += content;
  }
  return text;
}

const tags = (frag) => frag.kids.filter((k) => k instanceof Node_).map((k) => k.tagName);
const flat = (frag) => frag.kids.map((k) => (typeof k === "string" ? k : k.textContent)).join("\n");

// --- проверки --------------------------------------------------------------
let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log("  ✓", name);
  } catch (error) {
    failures += 1;
    console.log("  ✗", name, "\n     ", error.message.split("\n")[0]);
  }
}

console.log("рендер реального ответа (engine_h200.sse):");
const answer = answerFromFixture("engine_h200.sse");
const seen = new Set();
const out = renderMarkdown(answer, {
  makeRef: (n) => {
    seen.add(n);
    const a = new Node_("a");
    a.textContent = String(n);
    return a;
  },
});

check("текст не пустой", () => assert.ok(flat(out).length > 500));
check("звёздочки markdown не остались", () => assert.ok(!flat(out).includes("**")));
check("подзаголовки распознаны", () => {
  const h3 = tags(out).filter((t) => t === "H3").length;
  assert.ok(h3 >= 4, `ожидал ≥4 h3, получил ${h3}`);
});
check("есть абзацы", () => assert.ok(tags(out).filter((t) => t === "P").length >= 2));
check("список собран", () => {
  const lists = out.kids.filter((k) => k instanceof Node_ && ["UL", "OL"].includes(k.tagName));
  assert.ok(lists.length >= 1, "не нашёл списка");
  assert.ok(lists.some((l) => l.kids.length >= 2), "список из одного пункта — подозрительно");
});
check("маркеры [N] стали ссылками", () => {
  assert.ok(seen.size >= 5, `ссылок на цитаты: ${seen.size}`);
  assert.ok(!flat(out).match(/\[\d+\]/), "остались неразобранные [N]");
});
check("подзаголовок не склеен с телом", () => {
  const first = out.kids.find((k) => k instanceof Node_ && k.tagName === "H3");
  assert.ok(first.textContent.length < 90, `слишком длинный h3: ${first.textContent.slice(0, 60)}…`);
});

console.log("\nсинтетические случаи:");
const cases = renderMarkdown(
  "Обычный текст с **жирным** и *курсивом* и `кодом`.\n\n" +
    "**Заголовок раздела**\nТело раздела.\n\n" +
    "- пункт один\n- пункт два\n\n" +
    "1. первый\n2. второй",
  { makeRef: () => null }
);
check("структура блоков", () =>
  assert.deepEqual(tags(cases), ["P", "H3", "P", "UL", "OL"])
);
check("инлайн-разметка снята", () => {
  const p = cases.kids[0];
  assert.ok(p.textContent.includes("жирным") && !p.textContent.includes("*"));
});
check("неизвестная цитата остаётся текстом", () => {
  const frag = renderMarkdown("Ответ [7] без карточки.", { makeRef: () => null });
  assert.ok(frag.kids[0].textContent.includes("[7]"));
});

console.log("\nутверждения ответа по цитатам:");

check("берётся предложение с маркером, а не весь абзац", () => {
  const claims = claimsByRef(
    "Первое предложение без ссылок. Малых оценил объём в 640 ГБ [1]. И третье."
  );
  assert.deepEqual(claims.get(1), ["Малых оценил объём в 640 ГБ [1]."]);
});

check("маркер в конце пункта списка не утягивает соседний пункт", () => {
  // модель почти всегда пишет списком — на этом «предложение» и уползало
  const claims = claimsByRef("*   Первый пункт про H200 [2]\n*   Второй пункт про другое [3]");
  assert.deepEqual(claims.get(2), ["Первый пункт про H200 [2]"]);
  assert.deepEqual(claims.get(3), ["Второй пункт про другое [3]"]);
});

check("одна цитата подпирает несколько мест — собираем все", () => {
  const claims = claimsByRef("Раз про карты [1]. Два про них же [1]. Три без ссылки.");
  assert.equal(claims.get(1).length, 2);
});

check("повторы не дублируются, а длинное режется", () => {
  const long = `${"очень длинное утверждение ".repeat(20)}[4].`;
  const claims = claimsByRef(long);
  assert.ok(claims.get(4)[0].length <= 260, claims.get(4)[0].length);
  assert.ok(claims.get(4)[0].endsWith("…"));
});

check("несколько маркеров подряд — общее утверждение у каждого", () => {
  const claims = claimsByRef("Наценка могла бы вырасти до 5000% [1][3].");
  assert.equal(claims.get(1)[0], claims.get(3)[0]);
});

// --- адреса становятся ссылками -------------------------------------------
// Замерено на живом ответе: просили markdown-ссылку — модель написала `**адрес**`
// жирным. Значит ловим сам адрес, а не надеемся на её разметку.
const links = (frag) => {
  const found = [];
  const walk = (n) => {
    for (const k of n.kids || []) {
      if (typeof k === "string") continue;
      if (k.tagName === "A") found.push({ href: k.attrs.href, text: k.textContent });
      walk(k);
    }
  };
  walk(frag);
  return found;
};

check("голый адрес становится ссылкой", () => {
  const got = links(renderMarkdown("Код на https://github.com/catonmoon/morag."));
  assert.equal(got.length, 1);
  assert.equal(got[0].href, "https://github.com/catonmoon/morag");
});

check("точка в конце предложения не уезжает в адрес", () => {
  const [a] = links(renderMarkdown("Смотри https://example.com/x."));
  assert.ok(!a.href.endsWith("."), a.href);
});

check("адрес внутри жирного тоже ссылка", () => {
  const got = links(renderMarkdown("Код: **https://github.com/catonmoon/morag**"));
  assert.equal(got.length, 1, JSON.stringify(got));
  assert.equal(got[0].href, "https://github.com/catonmoon/morag");
});

check("markdown-ссылка по-прежнему работает и подпись остаётся своей", () => {
  const [a] = links(renderMarkdown("[github.com/catonmoon/morag](https://github.com/catonmoon/morag)"));
  assert.equal(a.text, "github.com/catonmoon/morag");
  assert.equal(a.href, "https://github.com/catonmoon/morag");
});

check("без схемы адресом не считаем — иначе им станет config.yml/x", () => {
  assert.equal(links(renderMarkdown("правь app/config.yml/секцию и жди")).length, 0);
});

check("в `коде` адрес остаётся текстом", () => {
  assert.equal(links(renderMarkdown("запусти `curl https://example.com/a`")).length, 0);
});

// --- формулы ---------------------------------------------------------------
// Модель пишет LaTeX: deepseek — `\(…\)` и `\[…\]`, другие — `$…$` и `$$…$$`. Разбор
// только вырезает формулу узлом `.math[data-tex]`; набирает её KaTeX (ui/math.js).
console.log("\nформулы:");
const maths = (frag) => {
  const found = [];
  const walk = (n) => {
    for (const k of n.kids || []) {
      if (typeof k === "string") continue;
      if (/\bmath\b/.test(k.attrs.class || "")) {
        found.push({ tag: k.tagName, tex: k.attrs["data-tex"], display: k.attrs.class.includes("math-display") });
      }
      walk(k);
    }
  };
  walk(frag);
  return found;
};

check("\\(…\\) в строке — формула, текст вокруг цел", () => {
  const frag = renderMarkdown("Пусть \\(P(X)\\) — вероятность события \\(X\\).");
  assert.deepEqual(maths(frag).map((m) => m.tex), ["P(X)", "X"]);
  assert.ok(frag.kids[0].textContent.includes("— вероятность события"));
});

check("\\[…\\] на своей строке — блок", () => {
  const frag = renderMarkdown("Тогда:\n\n\\[ c = \\sqrt{a^2 + b^2} \\]\n\nи дальше.");
  assert.deepEqual(tags(frag), ["P", "DIV", "P"]);
  assert.deepEqual(maths(frag), [{ tag: "DIV", tex: "c = \\sqrt{a^2 + b^2}", display: true }]);
});

check("блок на несколько строк, пустая строка внутри не рвёт", () => {
  const frag = renderMarkdown("$$\n\\sum_{i=1}^{n} x_i\n\n= S\n$$\nпосле");
  const [m] = maths(frag);
  assert.ok(m.display && m.tex.includes("\\sum_{i=1}^{n} x_i") && m.tex.includes("= S"), m.tex);
  assert.ok(flat(frag).includes("после"));
});

check("подчёркивания и звёздочки внутри TeX не становятся курсивом", () => {
  const frag = renderMarkdown("Вес \\(w_1 * x_1 + w_2 * x_2\\) и *курсив*.");
  assert.equal(maths(frag)[0].tex, "w_1 * x_1 + w_2 * x_2");
  const ems = frag.kids[0].kids.filter((k) => k.tagName === "EM");
  assert.equal(ems.length, 1);
  assert.equal(ems[0].textContent, "курсив");
});

check("жирный вокруг формулы и через формулу — жирный, формула внутри", () => {
  // живой ответ 05.10: «**\(Y\)** — зависимая» и «**линейной относительно \(b\)**»
  const one = renderMarkdown("- **\\(Y\\)** — зависимая переменная.");
  const strong = one.kids[0].kids[0].kids.find((k) => k.tagName === "STRONG");
  assert.ok(strong, flat(one));
  assert.equal(maths(strong)[0]?.tex, "Y");
  assert.ok(!flat(one).includes("**"), flat(one));
  const two = renderMarkdown("Модель **линейна относительно \\(b\\)**, даже если \\(f\\) нелинейна.");
  const s2 = two.kids[0].kids.find((k) => k.tagName === "STRONG");
  assert.ok(s2 && s2.textContent.startsWith("линейна относительно"), flat(two));
  assert.deepEqual(maths(two).map((m) => m.tex), ["b", "f"]);
});

check("в `коде` TeX остаётся текстом, а не меткой", () => {
  const frag = renderMarkdown("Пишите `\\(x\\)` так.");
  assert.ok(flat(frag).includes("\\(x\\)"), JSON.stringify(flat(frag)));
  assert.ok(!/[]/.test(flat(frag)));
});

check("$…$ — формула, а «от $5 до $10» — нет", () => {
  assert.deepEqual(maths(renderMarkdown("Сумма $a+b$ и $$x^2$$ в строке.")).map((m) => [m.tex, m.display]),
    [["a+b", false], ["x^2", true]]);
  assert.equal(maths(renderMarkdown("Стоит от $5 до $10 в месяц.")).length, 0);
});

check("точка внутри формулы — не конец утверждения", () => {
  const claims = claimsByRef("Если шансы 1 к 6, то \\(OR = 1/6 \\approx 0.17\\). Логарифм \\(\\log 6 \\approx 1.79\\) симметричен [2].");
  assert.equal(claims.get(2)[0], "Логарифм \\(\\log 6 \\approx 1.79\\) симметричен [2].");
});

check("сноска рядом с формулой остаётся сноской", () => {
  const frag = renderMarkdown("Значение \\(\\log 6\\) положительно [3].", { makeRef: (n) => `REF${n}` });
  assert.ok(flat(frag).includes("REF3"), flat(frag));
});

check("незакрытый блок не теряется — остаётся текстом", () => {
  const frag = renderMarkdown("\\[ a = b\nи всё");
  assert.equal(maths(frag).length, 0);
  assert.ok(flat(frag).includes("a = b") && flat(frag).includes("и всё"));
});

check("--- — горизонтальная черта", () => {
  assert.deepEqual(tags(renderMarkdown("раз\n\n---\n\nдва")), ["P", "HR", "P"]);
});

// Сам KaTeX — тот, что лежит у сайта: набирает, битое не роняет, опасное не пускает.
const { createRequire } = await import("node:module");
globalThis.katex = createRequire(import.meta.url)(join(repo, "web/assets/vendor/katex/katex.min.js"));
const { texToHtml } = await import(join(repo, "web/js/ui/math.js"));
check("KaTeX набирает дробь", () => {
  const html = texToHtml(globalThis.katex, "\\frac{a}{1-a}", true);
  assert.ok(html && html.includes("katex-display") && html.includes("mfrac"), html?.slice(0, 80));
});
check("битая формула → null (покажем исходник)", () => {
  assert.equal(texToHtml(globalThis.katex, "\\frac{a}{", false), null);
});
check("\\href и \\url не проходят (trust: false)", () => {
  for (const tex of ["\\href{javascript:alert(1)}{x}", "\\url{https://example.com}"]) {
    const html = texToHtml(globalThis.katex, tex, false);
    assert.ok(!html || !/<a\s|href=/.test(html), html);
  }
});
check("слишком длинная — не набираем", () => {
  assert.equal(texToHtml(globalThis.katex, "x+".repeat(1500) + "x", false), null);
});

console.log(failures ? `\n${failures} провал(ов)` : "\nвсё зелёное");
process.exit(failures ? 1 : 0);
