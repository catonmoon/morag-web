// События просмотра для журнала сайта (`/api/events`, сервер — `app/events.py`).
//
// Что шлём: открыт экран (без секунды и без id диалога), пуск, пауза, перемотка, «пульс» раз
// в 15 с, пока играет, и факт вопроса. Текстов не шлём никаких. Кто смотрел, подписывает СЕРВЕР
// по сессии — браузер логина не передаёт.
//
// Копим и шлём пачкой раз в 15 с; при уходе со страницы — `sendBeacon`, он переживает закрытие
// вкладки, а обычный запрос в этот момент браузер обрывает.
import * as player from "./player.js";

const FLUSH_MS = 15000;
const BEAT_MS = 15000;
let enabled = false;
let slug = "";
const queued = [];

function send(beacon = false) {
  if (!queued.length) return;
  const body = JSON.stringify({ events: queued.splice(0, 50) });
  try {
    if (beacon && navigator.sendBeacon?.("/api/events", new Blob([body], { type: "application/json" }))) return;
    fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
      credentials: "same-origin",
    }).catch(() => {});
  } catch {
    /* статистика не повод ломать страницу */
  }
}

/** Событие в очередь. Без включённого журнала — ничего. */
export function emit(kind, fields = {}) {
  if (!enabled) return;
  queued.push({ kind, slug, ...fields });
  if (queued.length >= 50) send();
}

/** Экран открыт. Чистка пути — как у счётчика посещений (`analytics.js::pageview`). */
export function view(route = {}) {
  const path = location.pathname
    .replace(/^(\/[^/]+\/(?:rec|ep)\/[^/]+)\/\d+$/, "$1")
    .replace(/^(\/[^/]+\/chat)\/[^/]+$/, "$1");
  emit("view", { path, record: route.view === "reader" ? route.id || "" : "" });
}

function watchPlayer() {
  const video = player.element();
  const at = () => ({ record: player.state().record || "", pos: video.currentTime });
  let beat = null;
  const stopBeat = () => {
    clearInterval(beat);
    beat = null;
  };
  video.addEventListener("play", () => {
    emit("play", at());
    stopBeat();
    beat = setInterval(() => emit("beat", { ...at(), val: video.playbackRate }), BEAT_MS);
  });
  for (const name of ["pause", "ended"]) {
    video.addEventListener(name, () => {
      if (!beat) return; // пауза из «прогрева» перед перемоткой — не действие человека
      stopBeat();
      emit("pause", at());
    });
  }
  video.addEventListener("seeked", () => emit("seek", at()));
}

/** @param {boolean} on флаг `events` из описания пространства @param {string} corpus слаг */
export function initEvents(on, corpus = "") {
  const local = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
  if (!on || local || enabled) return;
  enabled = true;
  slug = corpus;
  watchPlayer();
  setInterval(() => send(), FLUSH_MS);
  addEventListener("visibilitychange", () => document.visibilityState === "hidden" && send(true));
  addEventListener("pagehide", () => send(true));
}
