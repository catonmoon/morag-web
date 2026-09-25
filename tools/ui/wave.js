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

import { el, reduced } from "./dom.js";
import { colour, mix } from "./voices.js";

const REVEAL_MS = 600;        // проявление ленты голосов: одно движение, не мигание

export function wave(root) {
  const canvas = el("canvas", { class: "wv-c" });
  const legend = el("div", { class: "wv-legend" });
  root.append(canvas, legend);

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
  let dirty = true;
  let raf = null;

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function fit() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
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

    if (!n) {
      ctx.fillStyle = css("--ink-faint") || "#66788a";
      ctx.globalAlpha = 0.38;
      ctx.fillRect(0, H / 2 - 1, W, 2);
      ctx.globalAlpha = 1;
      return;
    }

    const back = css("--surface-2") || "#1E2C3B";
    let style = "";
    for (let i = 0; i < n; i++) {
      const idx = voiceAt[i];
      const want = idx < 0
        ? `${css("--ink-faint") || "#66788a"}66`
        : (heard[i] ? colour(idx) : mix(colour(idx), back, 0.55));
      if (want !== style) { style = want; ctx.fillStyle = want; }
      const v = (peaks[i] / 255) * H;
      ctx.fillRect(i * bw, (H - v) / 2, Math.max(1, bw - 0.6), Math.max(1, v));
    }
    if (cursor != null && audioSec > 0) {
      const x = (cursor / audioSec) * W;
      ctx.fillStyle = css("--accent") || "#E7A857";
      ctx.fillRect(Math.min(W - 2, x), 0, 2, H);
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

  /** Как звать голос: имя с сайта, иначе честно — «номер корпуса · новый» или сырая метка.
   *
   * ⚠️ «Не спросили» и «спросили, но голос новый» обязаны различаться: первое чинится
   * входом на сайт, второе — именем в режиме правки после загрузки.
   */
  function title(label) {
    const known = named[label];
    if (known && known.name) return known.name;
    if (known && known.voice) return `${known.voice} · новый`;
    return label;
  }

  function showLegend() {
    legend.replaceChildren(...speakers.map((label, idx) =>
      el("span", { class: "wv-who" },
         el("i", { style: `background:${colour(idx, 2)}` }), title(label))));
  }

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
      if (e.t === "chunk.start") {
        const idx = Math.max(0, speakers.indexOf(e.spk));
        live.push([e.from, e.to, idx < 0 ? 0 : idx]);
        window_ = [e.from, e.to];
        cursor = e.to;
        paint();
      }
    },
    reset() {
      peaks = null; audioSec = 0; speakers = []; spans = []; live = []; cursor = null; named = {}; window_ = null;
      revealFrom = 0;
      legend.replaceChildren();
      paint();
    },
    fit,
    /** Для тестов и стенда: что сцена считает своим состоянием. */
    state: () => ({ audioSec, speakers, spans: spans.length, live: live.length, cursor }),
  };
}
