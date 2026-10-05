// Знак в шапке: рисунок корпуса (если дал) + слово рамочным шрифтом + фазы для переливания.
//
// Знак — часть БРЕНДА (`brand.mark`, `brand.wordmark` из `/api/site`, витрины или сервера
// входа): у платформы он — одно слово, у корпуса — его зверь. Поэтому монтируется ПОСЛЕ
// прихода конфига, а до того в шапке пусто: запасной текст из index.html снимается сразу —
// он для мира без скриптов. Поле общее на рисунок и слово, поэтому волна крутится вокруг
// всего знака.
import { $, reducedMotion } from "./dom.js";
import { morphFrames, renderMark, renderText, startIdle, layout } from "./mark.js";
import * as boxfont from "./boxfont.js";
import { DEFAULT_WORDMARK } from "./brand.js";
import { drive as driveHalo, haloOptions, live as haloLive, withoutShadow } from "./halo.js";
import { measureTopbar } from "./topbar.js";

// Слово набрано кеглем 11, рисунок — 4: клетка слова в 2.75 раза крупнее, и координаты слова
// пересчитываются в клетки рисунка (`layout`), иначе вертушка на слове крутилась бы своим,
// более быстрым кругом.
const SCALE = 11 / 4;

let stopIdle = () => {};
let acts = null;
// Знак из нескольких кадров: что сейчас нарисовано и как перерисовать (см. `nextFrame`).
let shown = null;   // {host, field, art, index, timer}


/** Строки справа от слова (`brand.wordmark_aside`): обычный текст, кириллица — то, чего рамочный
 *  шрифт не умеет. Стоит после блока слова, зазор — тот же пробел рамочного шрифта. */
function renderAside(brand) {
  const word = $(".logo-word");
  if (!word) return;
  word.parentElement.querySelector(".logo-aside")?.remove();
  const lines = Array.isArray(brand.wordmark_aside) ? brand.wordmark_aside.filter(Boolean) : [];
  if (!lines.length) return;
  const aside = document.createElement("span");
  aside.className = "logo-aside";
  lines.forEach((t) => { const row = document.createElement("span"); row.textContent = t; aside.append(row); });
  word.after(aside);
}

/** Смонтировать знак по бренду. Можно звать повторно — прежний покой снимается. */
export function showMark(brand = {}) {
  const markHost = $("#logo-mark"), wordHost = $("#logo-word");
  if (!markHost || !wordHost) return null;
  stopIdle();
  // Векторный знак (`brand.mark` — SVG-файлы): тонкие сглаженные линии и полутона вместо клеток.
  if (Array.isArray(brand.mark?.svg) && brand.mark.svg.length) return showSvgMark(brand, markHost, wordHost);
  markHost.classList.remove("logo-svg");
  markHost.style.width = markHost.style.height = "";
  svgShown = null;
  const art = brand.mark && Array.isArray(brand.mark.lines) ? brand.mark : null;
  const lines = boxfont.render(brand.wordmark || DEFAULT_WORDMARK, { weight: brand.wordmark_weight });
  // `size: word` — маленький рисунок в несколько строк рядом со словом: в поле знака клетки
  // считаются как у слова (без пересчёта 11/4), а кегль подгоняется по высоте слова (ниже).
  const wordSize = art?.size === "word";
  const { field, ox, oy, sx, sy } = layout(art, lines, art && !wordSize ? SCALE : 1);
  acts = renderMark(markHost, field, art);
  markHost.hidden = !art;
  if (shown?.timer) clearInterval(shown.timer);
  shown = art?.frames?.length > 1 ? { host: markHost, field, art, index: 0, timer: null } : null;
  markHost.classList.toggle("word-size", wordSize);
  renderText(wordHost, lines, field, { ox, oy, sx, sy });
  renderAside(brand);
  // Подпись под словом: у корпуса со своим словом — «morag» (на чём сделано), у платформы — «web».
  const sub = $(".logo-word em");
  if (sub) sub.textContent = brand.wordmark ? "morag" : "web";
  stopIdle = startIdle(acts, { disabled: reducedMotion() });
  const logo = $(".logo");
  if (logo) {
    // Маленький знак стоит рядом со словом как ещё одно слово: зазор — ровно пробел рамочного
    // шрифта, в колонках (`ch` того же кегля), а не CSS-зазор (владелец, 04.10).
    logo.style.gap = wordSize ? `${boxfont.spaceCols()}ch` : "";
    logo.dataset.cols = field.cols;
    logo.dataset.rows = field.rows;
    logo.classList.toggle("no-art", !art);
  }
  // Маленький знак — РОВНО по высоте слова вместе с подписью (владелец, 04.10: кот как «ML CLASSIC
  // с надписью morag» по высоте). Кегль считается от фактической высоты блока слова: строки
  // знака при line-height 1 — это кегль × строки. Меряем после загрузки шрифтов — до неё высота
  // подписи другая. Зазор остаётся в `ch` шрифта шапки (пробел рамочного набора).
  markHost.style.fontSize = "";
  if (wordSize && art.lines.length) {
    const fit = () => {
      // Блок слова — буквы ВМЕСТЕ с подписью (`.logo-word` = `#logo-word` + `<em>`).
      const h = (wordHost.closest(".logo-word") || wordHost).getBoundingClientRect().height;
      if (h > 0) markHost.style.fontSize = `${(h / art.lines.length).toFixed(2)}px`;
      measureTopbar();
    };
    fit();
    document.fonts?.ready.then(fit).catch(() => {});
  }
  measureTopbar(); // высота шапки зависит от того, есть ли рисунок
  return acts;
}

// Векторный знак: кадры стопкой, виден один (`.on`); по наведению — следующий, сменой прозрачности.
let svgShown = null;   // {host, index, count}

/**
 * Знак из SVG-кадров рядом со словом. Разметка пришла с сервера уже проверенной (`_mark_svg`:
 * корень svg, без скриптов, обработчиков и ссылок). Высота — по блоку слова с подписью (как у
 * `mark_size: word`), ширина — по пропорции viewBox первого кадра; зазор — пробел рамочного шрифта.
 */
function showSvgMark(brand, markHost, wordHost) {
  const lines = boxfont.render(brand.wordmark || DEFAULT_WORDMARK, { weight: brand.wordmark_weight });
  const { field, ox, oy, sx, sy } = layout(null, lines, 1);
  markHost.textContent = "";
  markHost.className = "logo-mark logo-svg";
  markHost.hidden = false;
  brand.mark.svg.forEach((svg, k) => {
    const frame = document.createElement("span");
    frame.className = k ? "logo-frame" : "logo-frame on";
    frame.innerHTML = svg;
    markHost.append(frame);
  });
  svgShown = brand.mark.svg.length > 1 ? { host: markHost, index: 0, count: brand.mark.svg.length } : null;
  shown = null;
  acts = { blink() {}, sniff() {}, live: false };
  renderText(wordHost, lines, field, { ox, oy, sx, sy });
  renderAside(brand);
  const sub = $(".logo-word em");
  if (sub) sub.textContent = brand.wordmark ? "morag" : "web";
  const logo = $(".logo");
  if (logo) {
    logo.style.gap = `${boxfont.spaceCols()}ch`;
    logo.classList.remove("no-art");
  }
  const first = markHost.querySelector("svg");
  const vb = first?.viewBox?.baseVal;
  const ratio = vb && vb.height ? vb.width / vb.height : 2;
  const fit = () => {
    const h = (wordHost.closest(".logo-word") || wordHost).getBoundingClientRect().height;
    if (h > 0) {
      markHost.style.height = `${h.toFixed(2)}px`;
      markHost.style.width = `${(h * ratio).toFixed(2)}px`;
    }
    measureTopbar();
  };
  fit();
  document.fonts?.ready.then(fit).catch(() => {});
  return acts;
}

/** Следующий SVG-кадр: плавная смена прозрачности (CSS); «уменьшить движение» — без перехода. */
function nextSvgFrame() {
  if (!svgShown) return;
  const frames = svgShown.host.querySelectorAll(".logo-frame");
  frames[svgShown.index]?.classList.remove("on");
  svgShown.index = (svgShown.index + 1) % svgShown.count;
  frames[svgShown.index]?.classList.add("on");
}

/**
 * Следующий кадр знака — по наведению (владелец, 05.10: «только при наведении»): клетки
 * пересыпаются за ~0.3 с; при «уменьшить движение» — сразу. Пока идёт пересыпание, новое
 * наведение его не перезапускает.
 */
function nextFrame() {
  if (!shown || shown.timer) return;
  const { host, field, art } = shown;
  const from = art.frames[shown.index];
  shown.index = (shown.index + 1) % art.frames.length;
  const to = art.frames[shown.index];
  const draw = (lines) => { renderMark(host, field, { ...art, lines }); };
  if (reducedMotion()) { draw(to); return; }
  const steps = morphFrames(from, to, 7);
  let k = 0;
  shown.timer = setInterval(() => {
    if (k < steps.length) { draw(steps[k++]); return; }
    clearInterval(shown.timer);
    shown.timer = null;
    draw(to);
  }, 45);
}

/** Слушатели наведения — один раз; знак под ними может пересобираться. */
export function initLogo() {
  const wordHost = $("#logo-word");
  if (wordHost) wordHost.textContent = "";
  const logo = $(".logo");
  if (!logo) return;
  // Живой перелив (узор или цель из `theme.halo`, которым нужен пересчёт кадров) — только на
  // наведении, как и CSS-ореол; без такого конфига всё делает CSS, как раньше.
  let run = null;
  logo.addEventListener("mouseenter", () => {
    // Наведение — повод нюхнуть: жест по действию человека, а не по таймеру.
    acts?.sniff();
    nextFrame();
    nextSvgFrame();
    if (haloLive() && !reducedMotion()) {
      run?.stop();
      // Светлая тема — без теней (владелец, 16.09): на белой шапке свечение читается как
      // грязь. Ореол тогда выпадает вовсе, «символы» играют без свечения.
      const light = document.documentElement.getAttribute("data-theme") === "light";
      const opts = light ? withoutShadow(haloOptions()) : haloOptions();
      logo.classList.add("halo-live");
      run = opts ? driveHalo(logo, opts) : null;
    }
  });
  logo.addEventListener("mouseleave", () => {
    run?.stop();
    run = null;
    logo.classList.remove("halo-live");
  });
}
