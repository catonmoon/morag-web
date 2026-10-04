// Метки моментов экрана на полосе плеера (владелец, 04.10): экран записи — риской на таймлайне,
// а кадр с текстом — карточкой при наведении. Здесь только арифметика, без DOM: её проверяет
// тест (tests/js/marks.test.mjs), а читалка рисует по её ответам.

/** Метки по кадрам: только с временем и в пределах записи, по возрастанию; `left` — доля полосы. */
export function marksOf(frames, duration) {
  const len = Number(duration) || 0;
  if (!(len > 0)) return [];
  return (frames || [])
    .filter((f) => Number.isFinite(f?.t0) && f.t0 >= 0 && f.t0 < len)
    .sort((a, b) => a.t0 - b.t0)
    .map((f, i, all) => ({
      ...f,
      // Конец экрана: свой t1, иначе — начало следующего, иначе — конец записи.
      t1: Number.isFinite(f.t1) && f.t1 > f.t0 ? f.t1 : (all[i + 1]?.t0 ?? len),
      left: f.t0 / len,
    }));
}

/**
 * Какую метку показать под курсором. Сначала — ближайшая риска в пределах `snapPx` (по ней же
 * «примагничивается» щелчок: попасть мышью в риску в 2 px нельзя); иначе — экран, на чей отрезок
 * пришлась точка полосы. Вне экранов — -1.
 */
export function pickMark(marks, frac, widthPx, duration, snapPx = 8) {
  if (!marks.length || !(widthPx > 0)) return { index: -1, snap: false };
  let near = -1, best = Infinity;
  marks.forEach((m, i) => {
    const d = Math.abs(m.left - frac) * widthPx;
    if (d < best) { best = d; near = i; }
  });
  if (best <= snapPx) return { index: near, snap: true };
  const at = frac * (Number(duration) || 0);
  for (let i = marks.length - 1; i >= 0; i--) {
    if (marks[i].t0 <= at && at < marks[i].t1) return { index: i, snap: false };
  }
  return { index: -1, snap: false };
}

/** Текущий экран по времени — для подсветки риски: последняя метка, начавшаяся до `time`. */
export function markAt(marks, time) {
  let i = -1;
  for (let k = 0; k < marks.length && marks[k].t0 <= time + 0.5; k++) i = k;
  return i;
}

/** Левый край карточки шириной `cardW` над точкой `x`, не вылезая за полосу шириной `trackW`. */
export function cardLeft(x, cardW, trackW) {
  return Math.max(0, Math.min(x - cardW / 2, Math.max(0, trackW - cardW)));
}
