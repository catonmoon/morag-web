// Страница «Загрузить свою запись»: откуда взять приложение для мака и что дальше.
//
// Зачем страница, если есть приложение. Человек, у которого есть запись, приходит на сайт, а не
// в репозиторий: страница — единственное место, где он вообще узнаёт, что запись можно выложить
// самому. Поэтому здесь одно действие — строка в Терминале — и честные числа: сколько ждать и
// сколько места нужно.
//
// ⚠️ Сервер подставляет в установщик свой адрес и пропуск (`app/api/upload.py`,
// `app/content/dist.py`). Пропуск живёт неделю, но страница этого не говорит (владелец, 01.10:
// лишний текст) — строка выдаётся заново при каждом открытии, а просроченная отвечает сама.
// Путь «скачать файлом» со страницы убран (там же): строка работает, а файл на macOS 26
// двойным щелчком не запускается вовсе. Ручка `app.zip` на сервере осталась.
//
// Раздачи может не быть вовсе (публичная платформа, разработка): тогда страница честно говорит,
// что зеркала нет, и показывает путь для тех, у кого есть репозиторий.
import { $, el, copyLink, toast } from "./ui/dom.js";
import { getDist } from "./api.js";

const GB = 1024 ** 3;

/** «2.8 ГБ» — одна цифра после запятой: точность здесь не нужна, порядок важен. */
const gb = (bytes) => `${(bytes / GB).toFixed(1)} ГБ`;

function steps() {
  return el("ol", { class: "ing-steps" },
    el("li", {}, el("b", { text: "Поставить" }), " — 20–40 минут: скачается всё нужное и соберутся окружения. Пароль администратора и Homebrew не нужны."),
    el("li", {}, el("b", { text: "Войти" }), " — своей учётной записью, прямо в приложении. Ключи и адреса оно пропишет само: стадии с ИИ пойдут через сайт от вашего имени."),
    el("li", {}, el("b", { text: "Перетащить видео" }), " в окно. Название придумается само, если не задать; категория, темы и аннотация появятся на сайте."),
  );
}

function command(line) {
  const code = el("code", { class: "ing-cmd", text: line });
  const copy = el("button", { class: "dl-btn", type: "button", text: "Скопировать" });
  copy.addEventListener("click", () => copyLink(line, "Команда скопирована"));
  return el("div", { class: "ing-cmdrow" }, code, copy);
}

/** «питон, ffmpeg, движок и 4 модели» — перечислять модели поимённо незачем: их читает машина. */
function composition(files = []) {
  const models = files.filter((f) => f.title.startsWith("модель"));
  const rest = files.filter((f) => !f.title.startsWith("модель") && !f.title.includes("значок"));
  const tail = models.length ? `${rest.map((f) => f.title).join(", ")} и ${models.length} модели` : rest.map((f) => f.title).join(", ");
  return `В составе: ${tail}.`;
}


export async function renderUpload() {
  document.body.setAttribute("data-view", "upload");
  const mount = $("#upload-body");
  if (!mount) return;
  mount.replaceChildren(el("p", { class: "ing-note", text: "Смотрю, что готово…" }));

  let data = null;
  let failed = "";
  try {
    data = await getDist();
  } catch (error) {
    failed = error?.status === 404 ? "no-mirror" : "error";
  }

  if (failed) {
    mount.replaceChildren(
      el("p", { class: "ing-note", text: failed === "no-mirror"
        ? "На этом сайте раздача приложения не настроена."
        : "Не получилось спросить сервер о раздаче — попробуйте обновить страницу." }),
      el("p", { class: "ing-note" },
        "Всё то же самое умеет командная строка: ",
        el("code", { text: "python3 tools/upload.py ui" }),
        " из чекаута платформы."),
    );
    return;
  }

  mount.replaceChildren(
    el("p", { class: "ing-lead" },
      "Расшифровка идёт ", el("b", { text: "у вас на маке" }),
      " — сервера с моделями у сайта нет. Приложение скачивает всё нужное отсюда же: ни Homebrew, ни прав администратора, ни учёток на стороне."),
    el("p", { class: "ing-note", text: "Нужен Mac на Apple Silicon (M1 и новее) и 15 ГБ свободного места." }),

    el("p", { class: "ing-note ing-or" }, el("b", { text: "Скопируйте строку, вставьте в Терминал и нажмите Enter" }),
      " (Терминал — в «Программы → Утилиты» или через Spotlight по слову «Терминал»):"),
    command(data.install),
    el("p", { class: "ing-note", text: `При установке приедет ${gb(data.bytes || 0)}.` }),

    el("h3", { class: "ing-h", text: "Как это выглядит" }),
    steps(),
    el("p", { class: "ing-note", text: "Час записи — примерно 15–25 минут работы на ноутбуке: расшифровка, разметка говорящих, при желании разбор экрана из видео. Дальше сайт соберёт запись сам." }),
    el("p", { class: "ing-note ing-built" }, composition(data.files), data.built ? ` Собрано ${data.built}.` : ""),
  );
  if ((data.files || []).some((f) => f.missing)) {
    mount.append(el("p", { class: "ing-warn", text: "⚠️ Зеркало неполное — установка остановится. Напишите тому, кто дал ссылку." }));
    toast("Зеркало на сервере неполное");
  }
}
