// Формулы в ответе агента — KaTeX, лениво.
//
// Разбор Markdown (`chat/md.js`) не знает KaTeX: формулу он кладёт узлом
// `span.math[data-tex]` с исходным текстом внутри. Здесь эти узлы набираются.
// Пока библиотека грузится (или если не загрузилась) — виден исходный TeX: он
// читаем, и ответ не пропадает.
//
// Библиотека (~270 КБ скрипт + шрифты) лежит у себя (`assets/vendor/katex`, сборки
// и внешних CDN у сайта нет) и подтягивается только при первой формуле: корпусу
// без математики она не достаётся вовсе.
//
// ⚠️ Здесь — единственное место, где текст модели попадает в innerHTML. Можно,
// потому что вставляем не текст, а разметку KaTeX: она экранирует всё, что
// набирает, а опасное (\href, \url, \htmlClass, \includegraphics…) выключено
// `trust: false`. Плюс потолки на длину и раскрытие макросов — против «бомбы».

const BASE = new URL("../../assets/vendor/katex/", import.meta.url);
const MAX_TEX = 2000;      // длиннее — это уже не формула, а сбой модели
const CACHE_MAX = 500;
const OPTIONS = {
  throwOnError: true,      // битая формула → исходный текст, а не красная простыня KaTeX
  trust: false,
  strict: "ignore",
  maxExpand: 1000,
  maxSize: 20,
  output: "htmlAndMathml",  // MathML — для чтения с экрана
};

let loading = null;
// Ответ во время печати пересобирается целиком много раз в секунду — набранное
// держим по исходнику, чтобы не набирать одну формулу заново на каждом кадре.
const cache = new Map();

function loadKatex() {
  if (globalThis.katex) return Promise.resolve(globalThis.katex);
  loading ||= new Promise((resolve, reject) => {
    document.head.append(Object.assign(document.createElement("link"), {
      rel: "stylesheet",
      href: new URL("katex.min.css", BASE).href,
    }));
    const script = Object.assign(document.createElement("script"), {
      src: new URL("katex.min.js", BASE).href,
      async: true,
    });
    script.onload = () => (globalThis.katex ? resolve(globalThis.katex) : reject(new Error("katex")));
    script.onerror = () => {
      loading = null;      // сеть мигнула — следующий ответ попробует снова
      reject(new Error("katex"));
    };
    document.head.append(script);
  });
  return loading;
}

/** Набрать TeX в разметку; null — не формула (сбой разбора или слишком длинная). */
export function texToHtml(katex, tex, display) {
  const key = `${display ? "D" : "I"}${tex}`;
  if (cache.has(key)) return cache.get(key);
  let html = null;
  if (tex.length <= MAX_TEX) {
    try {
      html = katex.renderToString(tex, { ...OPTIONS, displayMode: display });
    } catch {
      html = null;
    }
  }
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, html);
  return html;
}

/** Набрать все ещё не набранные формулы внутри `root`. */
export function typesetMath(root) {
  const nodes = root?.querySelectorAll?.(".math:not(.math-done)");
  if (!nodes?.length) return;
  const katex = globalThis.katex;
  if (!katex) {
    // root — постоянный контейнер ответа: к загрузке в нём уже могут быть другие
    // узлы (печать продолжается) — наберём те, что будут на тот момент.
    loadKatex().then(() => typesetMath(root), () => {});
    return;
  }
  for (const node of nodes) {
    const html = texToHtml(katex, node.dataset.tex || "", node.classList.contains("math-display"));
    if (html) node.innerHTML = html;
    else node.classList.add("math-bad");
    node.classList.add("math-done");
  }
}
