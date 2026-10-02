// Рамка обрезки кадра экрана: сырые кадры `slides/sNNN.jpg` несут полосу миниатюр участников
// и подпись говорящего (лица, фамилии), поэтому их показывают через ту же рамку, что вырезала
// обложку (`crop` из `/api/records/<id>/frames`, доли кадра). Общая для слайдшоу на карточке
// (`records/list.js`) и ленты кадров под видео (`records/reader.js`).

/** Вписать рамку `box` (доли кадра) в обёртку так, чтобы она заполнила её целиком, как
 *  `object-fit: cover`, только для ПОДобласти кадра: считаем по натуральному размеру картинки. */
export function fitBox(img, wrap, box) {
  const [x0, y0, x1, y1] = box;
  const W = img.naturalWidth, H = img.naturalHeight;
  if (!W || !H) return;
  const bw = (x1 - x0) * W, bh = (y1 - y0) * H;
  const scale = Math.max(wrap.clientWidth / bw, wrap.clientHeight / bh);
  Object.assign(img.style, {
    position: "absolute", objectFit: "fill", maxWidth: "none",
    width: `${W * scale}px`, height: `${H * scale}px`,
    left: `${-x0 * W * scale - (bw * scale - wrap.clientWidth) / 2}px`,
    top: `${-y0 * H * scale - (bh * scale - wrap.clientHeight) / 2}px`,
  });
}
