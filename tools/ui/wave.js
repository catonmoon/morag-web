// Сцена 1: волна звука, раскрашенная диаризацией, и бегущая метка распознавания.
//
// Почему canvas, а не DOM: 1200 столбиков, перекрашиваемых по ходу работы, — ровно тот случай,
// про который сказано, что DOM не тянет (в символьной сцене сайта узлом сделан блок из восьми
// знаков именно поэтому). Здесь три слоя, и каждый перерисовывается только когда испачкан:
//   1) пики — один раз, когда пришла огибающая;
//   2) лента голосов — один раз на событие диаризации, с проявлением слева направо;
//   3) живой слой — на каждый кусок пасса-2 закрашивается ТОЛЬКО его окно.
//
// ⚠️ Цвета берём из токенов страницы (`--accent`, `--sonar`, `--ink-faint`) и разводим ПОВОРОТОМ
// тона, а не своей палитрой: окно должно выглядеть продолжением сайта, а не чужой утилитой.
// ⚠️ Цвет — не единственный канал: рядом легенда с подписями голосов. Иначе сцена бесполезна
// тому, кто цвета различает плохо.

import { clock, el, reduced } from "./dom.js";
import { colour, mix, rgb } from "./voices.js";

const REVEAL_MS = 600;        // проявление ленты голосов: одно движение, не мигание
const SPARK_MS = 620;         // сколько живёт искра на кромке прогресса
const SPARKS = 9;             // сколько их сыплется на каждый новый кусок
const DIM = 0.62;             // насколько приглушён НЕ пройденный пассом-2 звук
const AWAY = 0.74;            // насколько уходят чужие голоса, когда один под курсором

export function wave(root) {
  const canvas = el("canvas", { class: "wv-c" });
  // Подсказка «кто говорит» — слоем НАД канвасом: рисовать её в канвасе значило бы верстать
  // текст руками (шрифт, фон, скругление) и перерисовывать волну на каждое движение мыши.
  const tip = el("span", { class: "wv-tip", hidden: true });
  const legend = el("div", { class: "wv-legend" });
  root.classList.add("wv");   // ориентир для подсказки: `position: relative`
  root.append(canvas, tip, legend);

  let peaks = null;           // Uint8Array огибающей
  let audioSec = 0;
  let speakers = [];          // метки голосов в порядке появления
  let spans = [];             // [[from, to, idx], …]
  let revealFrom = 0;         // когда началось проявление ленты
  let live = [];              // закрашенные окна: [[from, to, idx], …]
  let cursor = null;          // бегущая метка: секунда
  let window_ = null;         // кусок, который распознаётся прямо сейчас: [от, до]
  // ⚠️⚠️ Имена, узнанные САЙТОМ по отпечаткам. Без них легенда светит `SPEAKER_00` — ровно то,
  // что владелец видел три прогона подряд: узнавание работало, а показать его было некому.
  let named = {};             // метка диаризатора → {voice, name}
  let frames = [];            // секунды снятых кадров экрана
  let frameAt = null;         // кадр, который показан в сцене экрана прямо сейчас
  let hoverIdx = -1;          // голос под курсором (с волны или из легенды)
  let hoverSec = null;        // секунда под курсором — только когда курсор на волне
  let sparks = [];            // искры на кромке прогресса: {sec, born, vx, vy, r}
  let scale = 1;              // плотность экрана: канвас в пикселях устройства, размеры — в CSS
  let dirty = true;
  let raf = null;

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  /** Цвет токена с прозрачностью — для свечения и искр (у токенов её нет). */
  const fade = (hex, a) => {
    const v = rgb(hex);
    return v ? `rgba(${v[0]},${v[1]},${v[2]},${a})` : hex;
  };

  function fit() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    scale = dpr;               // искры и засечки меряются в ЭКРАННЫХ пикселях, а не в устройстве
    const w = Math.max(320, root.clientWidth);
    const h = 132;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    dirty = true;
    draw();
  }

  function draw() {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { width: W, height: H } = canvas;
    ctx.clearRect(0, 0, W, H);
    const n = peaks ? peaks.length : 0;
    const bw = n ? W / n : W;
    const at = (sec) => (audioSec > 0 ? (sec / audioSec) * n : 0);

    // ⚠️⚠️ Ленты голосов НЕТ (владелец, 25.09): полоса под волной говорила то же самое,
    // что и сама волна, только мельче и раньше. Теперь всё на одной картинке:
    //   — столбик красится в цвет голоса сразу после диаризации, но приглушённо;
    //   — распознанное пассом-2 горит в полную силу;
    //   — текущий кусок подсвечен полосой позади столбиков.
    const voiceAt = new Int16Array(n).fill(-1);
    if (spans.length && audioSec > 0 && n) {
      const done = reduced() || !revealFrom
        ? 1
        : Math.min(1, (performance.now() - revealFrom) / REVEAL_MS);
      const eased = 1 - (1 - done) ** 3;
      const limit = Math.floor(n * eased);
      for (const [a, b, idx] of spans) {
        for (let i = Math.max(0, Math.floor(at(a))); i < Math.min(limit, Math.ceil(at(b))); i++) {
          voiceAt[i] = idx;
        }
      }
      if (done < 1) dirty = true;
    }
    const heard = new Uint8Array(n);
    for (const [a, b] of live) {
      for (let i = Math.max(0, Math.floor(at(a))); i < Math.min(n, Math.ceil(at(b))); i++) heard[i] = 1;
    }

    // Текущий кусок — подложкой, чтобы было видно даже на тихом месте.
    if (window_ && audioSec > 0) {
      const x0 = (window_[0] / audioSec) * W;
      const x1 = (window_[1] / audioSec) * W;
      ctx.fillStyle = css("--accent-wash") || "rgba(228,160,75,.14)";
      ctx.fillRect(x0, 0, Math.max(2, x1 - x0), H);
    }
    // ⚠️ Свечение кромки — ПОД столбиками: поверх оно замыливало волну мутным пятном (видно
    // сразу на светлой теме). Линия кромки и искры остаются сверху — им замыливать нечего.
    if (cursor != null && audioSec > 0 && !reduced()) {
      const accent0 = css("--accent") || "#E7A857";
      const cx = Math.min(W - 2, (cursor / audioSec) * W);
      const glow = ctx.createRadialGradient(cx, H / 2, 0, cx, H / 2, Math.max(16, H * 0.55));
      glow.addColorStop(0, fade(accent0, 0.42));
      glow.addColorStop(0.5, fade(accent0, 0.14));
      glow.addColorStop(1, fade(accent0, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(cx - H, 0, H * 2, H);
    }

    if (!n) {
      ctx.fillStyle = css("--ink-faint") || "#66788a";
      ctx.globalAlpha = 0.38;
      ctx.fillRect(0, H / 2 - 1, W, 2);
      ctx.globalAlpha = 1;
      return;
    }

    const back = css("--surface-2") || "#1E2C3B";
    const faint = css("--ink-faint") || "#66788a";
    const accent = css("--accent") || "#E7A857";
    let style = "";
    for (let i = 0; i < n; i++) {
      const idx = voiceAt[i];
      // Три состояния столбика: чей голос неизвестен; голос известен, но пасс-2 сюда не дошёл;
      // распознано. Пройденное горит в полную силу — так видно, где идёт работа (владелец, 25.09).
      let want = idx < 0 ? `${faint}66` : (heard[i] ? colour(idx) : mix(colour(idx), back, DIM));
      // Голос под курсором — единственный в полную силу; остальные уходят в фон.
      if (hoverIdx >= 0 && idx !== hoverIdx) want = mix(idx < 0 ? faint : colour(idx), back, AWAY);
      if (want !== style) { style = want; ctx.fillStyle = want; }
      const v = (peaks[i] / 255) * H;
      ctx.fillRect(i * bw, (H - v) / 2, Math.max(1, bw - 0.6), Math.max(1, v));
    }

    // ⚠️ Кадры экрана — засечками сверху (владелец, 25.09: «подсвечивалась линия, где именно
    // взят этот скриншот»). Тонко и мелко: их бывает несколько сотен, и волну они закрывать
    // не должны; выделен только тот кадр, который прямо сейчас показан сценой экрана.
    const notch = Math.max(3, H * 0.08);
    if (frames.length && audioSec > 0) {
      ctx.fillStyle = fade(faint, 0.75);
      for (const t of frames) ctx.fillRect(Math.min(W - 1, (t / audioSec) * W), 0, scale, notch);
    }
    if (frameAt != null && audioSec > 0) {
      const x = Math.min(W - 2, (frameAt / audioSec) * W);
      ctx.fillStyle = css("--sonar") || "#5FC0C8";
      ctx.fillRect(x, 0, 2 * scale, H);
      ctx.fillRect(Math.max(0, x - 3 * scale), 0, 8 * scale, notch);
    }

    // Кромка прогресса: линия и искры. Движение здесь оправдано тем, что оно ПОКАЗЫВАЕТ работу —
    // где именно сейчас распознаётся звук; под «меньше движения» остаётся просто линия.
    if (cursor != null && audioSec > 0) {
      ctx.fillStyle = accent;
      ctx.fillRect(Math.min(W - 2, (cursor / audioSec) * W), 0, 2 * scale, H);
    }
    if (sparks.length && audioSec > 0) {
      const now = performance.now();
      sparks = sparks.filter((s) => now - s.born < SPARK_MS);
      for (const s of sparks) {
        const k = (now - s.born) / SPARK_MS;
        const x = (s.sec / audioSec) * W + s.vx * H * k;
        const y = H / 2 + s.vy * H * k;
        // ⚠️ Размер — в CSS-пикселях: в пикселях устройства искра на retina выходила в полпикселя
        // и её не было видно вовсе.
        const r = s.r * scale;
        ctx.fillStyle = fade(accent, (1 - k) ** 2);
        ctx.fillRect(x - r / 2, y - r / 2, r, r);
      }
      if (sparks.length) dirty = true;    // ⚠️ кадры просим ТОЛЬКО пока искры живы
    }

    // Курсор мыши — тонкой линией: подсказка говорит «кто», линия — «где».
    if (hoverSec != null && audioSec > 0) {
      ctx.fillStyle = fade(css("--ink") || "#E8EEF4", 0.5);
      ctx.fillRect(Math.min(W - 1, (hoverSec / audioSec) * W), 0, scale, H);
    }
  }

  function tick() {
    raf = null;
    if (!dirty) return;
    dirty = false;
    draw();
    if (dirty) raf = requestAnimationFrame(tick);   // проявление ленты продолжается
  }

  function paint() {
    dirty = true;
    if (raf === null) raf = requestAnimationFrame(tick);
  }

  /** Искры на кромке: сыплются на каждый новый кусок пасса-2 и гаснут за полсекунды. */
  function spawnSparks(sec) {
    if (reduced() || !Number.isFinite(sec)) return;
    const now = performance.now();
    for (let i = 0; i < SPARKS; i++) {
      const a = (Math.random() - 0.5) * Math.PI;       // веером вперёд, по ходу распознавания
      sparks.push({ sec, born: now, r: 1.1 + Math.random() * 1.4,
                    vx: Math.cos(a) * (0.12 + Math.random() * 0.42),
                    vy: Math.sin(a) * (0.22 + Math.random() * 0.6) });
    }
    if (sparks.length > 60) sparks.splice(0, sparks.length - 60);
  }

  /** Как звать голос: имя с сайта, иначе его КОРПУСНЫЙ номер, иначе сырая метка диаризатора.
   *
   * ⚠️ Приписки «новый» здесь больше нет (владелец, 25.09: «приписка лишняя»). Корпусный номер
   * сам по себе и означает «голос известен серверу, но не назван»: под этим номером его и
   * подписывают на сайте после загрузки. А `SPEAKER_00` — это «сервер не спросили вовсе».
   */
  function title(label) {
    const known = named[label];
    if (known && known.name) return known.name;
    if (known && known.voice) return String(known.voice);
    return label;
  }

  /** Какой голос звучит в эту секунду. Отрезков немного (десятки), перебор дешевле индекса. */
  function voiceAtSec(sec) {
    for (const [a, b, idx] of spans) if (sec >= a && sec <= b) return idx;
    return -1;
  }

  function markLegend() {
    // ⚠️ `children` в браузере — HTMLCollection, у неё НЕТ `forEach` (в заглушке тестов —
    // массив, поэтому тест был зелёным, а в окне подсветка легенды молча не работала).
    [...legend.children].forEach((node, i) => {
      node.classList.toggle("dim", hoverIdx >= 0 && i !== hoverIdx);
      node.classList.toggle("on", i === hoverIdx);
    });
  }

  function showLegend() {
    legend.replaceChildren(...speakers.map((label, idx) =>
      // ⚠️ Наведение — в ОБЕ стороны (владелец, 25.09): на волне видно, кто говорит, а на
      // голосе в легенде — где он говорит. Механизм один: `hoverIdx` плюс перерисовка.
      el("span", { class: "wv-who",
                   onmouseenter: () => hoverVoice(idx),
                   onmouseleave: () => hoverVoice(-1) },
         el("i", { style: `background:${colour(idx)}` }), title(label))));
    markLegend();
  }

  function hoverVoice(idx) {
    hoverIdx = idx;
    hoverSec = null;
    tip.setAttribute("hidden", "");
    markLegend();
    paint();
  }

  /** Курсор на волне: показать, кто говорит в эту секунду, и подсветить его же в легенде. */
  function hoverSecond(sec, x = null, width = 0) {
    if (sec == null) {
      hoverSec = null; hoverIdx = -1; tip.setAttribute("hidden", "");
      markLegend(); paint();
      return;
    }
    hoverSec = Math.max(0, Math.min(audioSec || sec, sec));
    hoverIdx = voiceAtSec(hoverSec);
    const label = speakers[hoverIdx];
    tip.textContent = `${label ? title(label) : "тишина"} · ${clock(hoverSec)}`;
    if (x != null) tip.style.left = `${Math.max(34, Math.min(width - 34, x))}px`;
    tip.removeAttribute("hidden");
    markLegend();
    paint();
  }

  canvas.addEventListener("mousemove", (e) => {
    if (!audioSec) return;
    const box = canvas.getBoundingClientRect();
    const x = e.clientX - box.left;
    hoverSecond((x / (box.width || 1)) * audioSec, x, box.width || 0);
  });
  canvas.addEventListener("mouseleave", () => hoverSecond(null));

  return {
    /** Одно событие меняет состояние сцены; рисование — отдельно и по кадрам. */
    apply(e) {
      if (e.t === "job.meta") { audioSec = e.audio_sec || 0; paint(); return; }
      if (e.t === "wave.peaks") {
        peaks = Uint8Array.from(atob(e.b64), (c) => c.charCodeAt(0));
        paint();
        return;
      }
      if (e.t === "diar.spans") {
        speakers = e.speakers || [];
        spans = e.spans || [];
        revealFrom = performance.now();
        showLegend();
        paint();
        return;
      }
      if (e.t === "voices.named") {
        named = e.by_label || {};
        showLegend();
        return;
      }
      if (e.t === "screen.frame") {
        // Кадр экрана: секунду помним навсегда (засечка), «текущим» считаем последний — сцена
        // экрана показывает именно его.
        const at = Number(e.sec);      // секунда кадра в записи (`at` — время прогона)
        if (Number.isFinite(at)) {
          frames.push(at);
          frameAt = at;
          paint();
        }
        return;
      }
      if (e.t === "chunk.start") {
        const idx = Math.max(0, speakers.indexOf(e.spk));
        live.push([e.from, e.to, idx < 0 ? 0 : idx]);
        window_ = [e.from, e.to];
        cursor = e.to;
        spawnSparks(e.to);
        paint();
      }
    },
    reset() {
      peaks = null; audioSec = 0; speakers = []; spans = []; live = []; cursor = null; named = {}; window_ = null;
      revealFrom = 0;
      frames = []; frameAt = null; sparks = [];
      hoverIdx = -1; hoverSec = null;
      tip.setAttribute("hidden", "");
      legend.replaceChildren();
      paint();
    },
    fit,
    /** Наведение снаружи — для стенда и тестов: канваса с мышью там нет. */
    hoverSecond,
    hoverVoice,
    /** Для тестов и стенда: что сцена считает своим состоянием. */
    state: () => ({ audioSec, speakers, spans: spans.length, live: live.length, cursor,
                    frames: frames.length, frameAt, hoverIdx, hoverSec, tip: tip.textContent,
                    names: speakers.map(title) }),
  };
}
