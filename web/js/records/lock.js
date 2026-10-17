// Замок доступа записи — ОДИН на карточку списка и на страницу записи (владелец, 17.10:
// «единообразно через этот замок»).
//
// Закрытый — запись личная (признак, виден всегда, цветом рамки/ветки). Открытый — своя общая
// запись (действие, виден при наведении). Наведение — подсказка сразу (своя, не `title`: браузерная
// ждёт секунду). Щелчок у автора и админа — меню доступа на месте; у остальных щелчок проходит
// дальше (на карточке — открывает запись). Права решает сервер (`app/api/access.py`): меню лишь
// не предлагает заведомо чужого.
import { el } from "../ui/dom.js";
import { getAccess, resetLink, revokeAccess, setAccess } from "../api.js";
import { current as sessionUser } from "../session.js";

const LOCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 10.5V8a4.5 4.5 0 0 1 9 0v2.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><rect x="4.5" y="10.5" width="15" height="10.5" rx="2.6" fill="currentColor"/><circle cx="12" cy="15.4" r="1.6" fill="var(--surface)"/><rect x="11.2" y="15.6" width="1.6" height="2.8" rx=".8" fill="var(--surface)"/></svg>';
// Открытый — тот же рисунок, дужка откинута вправо.
const UNLOCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 10.5V8a4.5 4.5 0 0 1 8.7-1.6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><rect x="4.5" y="10.5" width="15" height="10.5" rx="2.6" fill="currentColor"/><circle cx="12" cy="15.4" r="1.6" fill="var(--surface)"/><rect x="11.2" y="15.6" width="1.6" height="2.8" rx=".8" fill="var(--surface)"/></svg>';

/** Нужен ли замок записи: личная — всегда; общая — только своя и с автором (её можно скрыть). */
export function hasLock(record) {
  return !!(record.private || (record.mine && record.owner));
}

/**
 * Замок записи. `full` — страница записи: в меню ещё «Новая ссылка» и кто открывал (с ✕);
 * на карточке хватает главного — ссылка и показать всем.
 */
export function lockOf(record, { full = false } = {}) {
  const open = !record.private;
  const tip = open
    ? "Запись видна всем. Нажмите — сделать личной: видна будет только вам и тем, кому дадите ссылку"
    : "Скрытая запись — видна только вам и тем, кому вы дали ссылку. В общем списке и поиске её нет";
  const me = sessionUser();
  const login = String(me?.login || "").toLowerCase();
  const manage = !!(record.mine || (login && login === record.owner) || me?.role === "admin");
  const lock = el("span", { class: `rec-lock${manage ? " can" : ""}${open ? " unlocked" : ""}`,
                            html: open ? UNLOCK : LOCK, role: manage ? "button" : "img",
                            "aria-label": tip, ...(manage ? { tabindex: "0" } : {}) });
  lock.append(el("span", { class: "rec-lock-tip",
                           text: manage && !open ? `${tip}. Нажмите — ссылка или показать всем` : tip }));
  if (!manage) return lock;

  const msg = el("span", { class: "rec-lock-msg" });
  const item = (text, run) => {
    const b = el("button", { class: "rec-lock-item", type: "button", text });
    b.addEventListener("click", async (event) => {
      event.stopPropagation();
      try { await run(b); } catch (error) { msg.textContent = error.message; }
    });
    return b;
  };
  // Опасное — вторым щелчком в течение 4 с, без диалогов браузера.
  const twice = (text, ask, run) => {
    let armed = 0;
    return item(text, async (b) => {
      if (Date.now() - armed > 4000) {
        armed = Date.now();
        b.textContent = ask;
        setTimeout(() => { if (Date.now() - armed >= 4000) b.textContent = text; }, 4100);
        return;
      }
      b.disabled = true;
      await run();
    });
  };
  const copyLink = item("Скопировать ссылку", async () => {
    const st = await getAccess(record.id);
    const slug = location.pathname.split("/").filter(Boolean)[0] || "";
    const link = `${location.origin}/${slug}/rec/${encodeURIComponent(record.id)}?k=${st.key}`;
    try { await navigator.clipboard.writeText(link); msg.textContent = "Ссылка скопирована — откроется у вошедших"; }
    catch { msg.textContent = link; }
  });
  const who = el("div", { class: "rec-lock-who" });
  const paintWho = (st) => {
    const granted = st?.granted || [];
    who.replaceChildren(...(granted.length
      ? [el("span", { class: "rec-lock-who-head", text: "Открывали по ссылке:" }),
         ...granted.map((g) => {
           const x = el("button", { class: "rec-lock-x", type: "button", text: "✕", title: `Убрать доступ: ${g.name || g.login}` });
           x.addEventListener("click", async (event) => {
             event.stopPropagation();
             try { paintWho(await revokeAccess(record.id, g.login)); } catch (error) { msg.textContent = error.message; }
           });
           return el("span", { class: "rec-lock-person" }, g.name || g.login, x);
         })]
      : []));
  };
  const menu = el("div", { class: "rec-lock-menu", hidden: "" },
    ...(open
      ? [twice("Сделать личной", "Точно скрыть от всех?", async () => {
          await setAccess(record.id, "private");
          location.reload();
        })]
      : [copyLink,
         ...(full ? [twice("Новая ссылка", "Старые ссылки умрут — точно?", async () => {
           paintWho(await resetLink(record.id));
           msg.textContent = "Ссылка заменена: старые больше не открывают";
         })] : []),
         twice("Показать всем", "Точно показать всем?", async () => {
           await setAccess(record.id, "public");
           location.reload();
         }),
         ...(full ? [who] : [])]),
    msg);
  lock.append(menu);

  const close = (event) => {
    if (event && lock.contains(event.target)) return;
    menu.hidden = true;
    lock.classList.remove("open");
    document.removeEventListener("click", close, true);
  };
  const toggle = (event) => {
    event.stopPropagation();
    if (!menu.hidden) return close();
    menu.hidden = false;
    msg.textContent = "";
    lock.classList.add("open");
    document.addEventListener("click", close, true);
    if (full && !open) getAccess(record.id).then(paintWho).catch(() => {});
  };
  lock.addEventListener("click", (event) => { if (!menu.contains(event.target)) toggle(event); });
  lock.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(event); }
    if (event.key === "Escape") close();
  });
  return lock;
}
