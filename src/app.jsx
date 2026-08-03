import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

/* ============================================================
   CONFIG — edit these two values if your backend changes
   ============================================================ */
const API_URL = "https://script.google.com/macros/s/AKfycbzHEtFbPBd9LBd6GOAdceJmp_b_Z4E7uISiPXaB3y_J1V_wEOnZDMgVbFo7XaSF_ZSS-A/exec";
// Optional shared secret. Leave "" to disable. If set, it is sent with every
// write — your Apps Script should verify it (see README).
const API_SECRET = "";

/* ============================================================
   CONSTANTS
   ============================================================ */
const MONTH_NAMES = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];
const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
// Fixed: original list contained a duplicate ("#fa709a" twice)
const PRESET_COLORS = [
  "#667eea", "#764ba2", "#11998e", "#38ef7d",
  "#ff416c", "#ff4b2b", "#f093fb", "#f5576c",
  "#4facfe", "#43e97b", "#fa709a", "#fee140",
  "#fda085", "#a8edea",
];

/* ============================================================
   DATE UTILITIES — all in LOCAL timezone.
   Fixed: original code used new Date().toISOString() (UTC), which
   highlighted the wrong "today" and misfiled archive entries
   around midnight in any non-UTC timezone.
   ============================================================ */
const DAY_MS = 86400000;

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toLocalISO(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function todayISO() {
  return toLocalISO(new Date());
}

/** "YYYY-MM-DD" -> local Date, or null for garbage input */
function parseISO(iso) {
  if (!iso || typeof iso !== "string") return null;
  const parts = iso.split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Inclusive day count between two ISO dates. <= 0 means invalid range. */
function daysInclusive(startISO, endISO) {
  const a = parseISO(startISO);
  const b = parseISO(endISO);
  if (!a || !b) return 0;
  return Math.round((b - a) / DAY_MS) + 1;
}

function addDaysISO(iso, n) {
  const d = parseISO(iso);
  if (!d) return iso;
  d.setDate(d.getDate() + n);
  return toLocalISO(d);
}

/** "YYYY-MM-DD" -> "DD.MM.YYYY" */
function fmtDMY(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

function fmtHM(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 42 cells (6 weeks), weeks start on Monday */
function buildMonthMatrix(year, month) {
  const first = new Date(year, month, 1);
  const startOffset = (first.getDay() + 6) % 7;
  const gridStart = new Date(year, month, 1 - startOffset);
  const today = todayISO();
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    const iso = toLocalISO(d);
    cells.push({ iso, day: d.getDate(), inMonth: d.getMonth() === month, isToday: iso === today });
  }
  return cells;
}

/* ============================================================
   MONEY / COLOR UTILITIES
   ============================================================ */
/** Accepts "1200", "1200,50", "1200.5" -> Number (0 on garbage) */
function parsePrice(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = parseFloat(String(v ?? "").trim().replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function fmtMoney(n) {
  return `${Math.round(n).toLocaleString("ru-RU")} ₽`;
}

/** Pick readable text color for a hex background (fixes unreadable black-on-dark-purple labels) */
function textColorFor(bg) {
  const m = /^#?([0-9a-f]{6})$/i.exec(bg || "");
  if (!m) return "#1f2937";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.62 ? "#1f2937" : "#ffffff";
}

/* ============================================================
   STATS — monthly earnings (prorated per day), booked days, active count
   ============================================================ */
function computeMonthStats(bookings, year, month) {
  const monthStart = new Date(year, month, 1);
  const monthEnd = new Date(year, month + 1, 0);
  const today = todayISO();

  let earnings = 0;
  let activeCount = 0;
  const bookedDays = new Set();

  for (const b of bookings) {
    if (b.endDate >= today) activeCount++;

    const start = parseISO(b.startDate);
    const end = parseISO(b.endDate);
    if (!start || !end) continue;

    const totalDays = daysInclusive(b.startDate, b.endDate);
    if (totalDays <= 0) continue; // skip invalid ranges instead of miscalculating

    const perDay = (Number(b.price) || 0) / totalDays;

    const overlapStart = start < monthStart ? monthStart : start;
    const overlapEnd = end > monthEnd ? monthEnd : end;
    if (overlapStart <= overlapEnd) {
      const overlapDays = Math.round((overlapEnd - overlapStart) / DAY_MS) + 1;
      earnings += overlapDays * perDay;
      const d = new Date(overlapStart);
      for (let i = 0; i < overlapDays; i++) {
        bookedDays.add(toLocalISO(d));
        d.setDate(d.getDate() + 1);
      }
    }
  }
  return { earnings: Math.round(earnings), bookedDays: bookedDays.size, activeCount };
}

/* ============================================================
   API LAYER — same wire contract as the original app:
     GET  API_URL            -> [{id, petName, startDate, endDate, price, color}]
     POST API_URL {action:"save"|"delete", data:{...}}   (no-cors, opaque)
   ============================================================ */
function normalizeBooking(b) {
  return {
    id: String(b?.id ?? ""),
    petName: String(b?.petName ?? "").trim(),
    startDate: String(b?.startDate ?? "").split("T")[0],
    endDate: String(b?.endDate ?? "").split("T")[0],
    price: parsePrice(b?.price),
    color: b?.color || PRESET_COLORS[0],
  };
}

async function apiFetchBookings() {
  const res = await fetch(API_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("Unexpected payload");
  return data.filter((b) => b && b.id != null && b.id !== "").map(normalizeBooking);
}

async function apiPost(action, payload) {
  const body = { action, data: payload };
  if (API_SECRET) body.secret = API_SECRET;
  await fetch(API_URL, {
    method: "POST",
    mode: "no-cors", // same as the original app — response is intentionally opaque
    cache: "no-cache",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/* ============================================================
   SMALL UI PIECES
   ============================================================ */
function Spinner({ label }) {
  return (
    <span className="spinner-wrap" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      {label ? <span className="spinner-label">{label}</span> : null}
    </span>
  );
}

function Toast({ toast }) {
  if (!toast) return null;
  return (
    <div className={`toast toast-${toast.type}`} role="status">
      {toast.type === "error" ? "⚠️ " : "✅ "}
      {toast.msg}
    </div>
  );
}

function EmptyState({ icon, children }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <p>{children}</p>
    </div>
  );
}

/* ============================================================
   BOOKING MODAL (add / edit)
   ============================================================ */
function BookingModal({ initial, editing, onClose, onSave, onDelete }) {
  const [petName, setPetName] = useState(initial.petName || "");
  const [startDate, setStartDate] = useState(initial.startDate);
  const [endDate, setEndDate] = useState(initial.endDate);
  const [price, setPrice] = useState(initial.price ? String(initial.price) : "");
  const [color, setColor] = useState(initial.color || PRESET_COLORS[0]);

  // Scroll-lock + Escape handling with guaranteed cleanup (fixed: original
  // relied on a manual timer and could leave the page frozen)
  useEffect(() => {
    document.body.classList.add("modal-open");
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.classList.remove("modal-open");
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const days = daysInclusive(startDate, endDate);
  const datesValid = days > 0;
  const priceNum = parsePrice(price);
  const perDay = datesValid && priceNum > 0 ? priceNum / days : null;
  const canSubmit = petName.trim().length > 0 && datesValid;

  function handleSubmit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    onSave({
      id: initial.id || makeId(),
      petName: petName.trim(),
      startDate,
      endDate,
      price: priceNum,
      color,
    });
  }

  function handleStartChange(v) {
    setStartDate(v);
    // keep range sane: if end < new start, snap end to start
    if (v && endDate && v > endDate) setEndDate(v);
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
        <div className="modal-header">
          <h2 id="modalTitle">{editing ? "✏️ Редактировать бронь" : "➕ Новая бронь"}</h2>
          <button type="button" className="icon-btn" aria-label="Закрыть" onClick={onClose}>
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="petName">Кличка питомца</label>
            <input
              id="petName"
              type="text"
              value={petName}
              onChange={(e) => setPetName(e.target.value)}
              placeholder="Например: Барсик"
              maxLength={60}
              autoFocus={!editing}
              required
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="startDate">Заезд</label>
              <input
                id="startDate"
                type="date"
                value={startDate}
                onChange={(e) => handleStartChange(e.target.value)}
                required
              />
            </div>
            <div className="form-group">
              <label htmlFor="endDate">Выезд</label>
              <input
                id="endDate"
                type="date"
                value={endDate}
                min={startDate}
                onChange={(e) => setEndDate(e.target.value)}
                required
              />
            </div>
          </div>

          {!datesValid && startDate && endDate ? (
            <p className="field-comment field-comment-error">⚠️ Дата выезда раньше даты заезда</p>
          ) : startDate && endDate ? (
            <p className="field-comment">📊 Всего дней: {days}</p>
          ) : null}

          <div className="form-group">
            <label htmlFor="price">Цена за всю передержку</label>
            <input
              id="price"
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="0"
            />
            {perDay != null ? (
              <p className="field-comment">📊 Цена за день: {fmtMoney(perDay)}</p>
            ) : null}
          </div>

          <div className="form-group">
            <label>Цвет метки</label>
            <div className="color-row">
              <input
                type="color"
                className="color-input"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                aria-label="Свой цвет"
              />
              <div className="color-presets">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`color-preset${c === color ? " selected" : ""}`}
                    style={{ backgroundColor: c }}
                    aria-label={`Цвет ${c}`}
                    onClick={() => setColor(c)}
                  />
                ))}
              </div>
            </div>
            <div className="color-preview" style={{ backgroundColor: color, color: textColorFor(color) }}>
              {petName.trim() || "Пример метки"}
            </div>
          </div>

          <div className="modal-actions">
            <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
              {editing ? "💾 Сохранить" : "Добавить бронь"}
            </button>
            {editing ? (
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => onDelete(initial)}
              >
                🗑 Удалить
              </button>
            ) : null}
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Отмена
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ============================================================
   DAY MODAL — list of bookings overlapping one calendar day
   ============================================================ */
function DayModal({ dateISO, bookings, onClose, onEdit, onAdd }) {
  useEffect(() => {
    document.body.classList.add("modal-open");
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.classList.remove("modal-open");
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card modal-card-slim" role="dialog" aria-modal="true" aria-labelledby="dayModalTitle">
        <div className="modal-header">
          <h2 id="dayModalTitle">📅 {fmtDMY(dateISO)}</h2>
          <button type="button" className="icon-btn" aria-label="Закрыть" onClick={onClose}>
            ✕
          </button>
        </div>

        {bookings.length === 0 ? (
          <EmptyState icon="🐾">В этот день никого нет</EmptyState>
        ) : (
          <ul className="day-list">
            {bookings.map((b) => (
              <li key={b.id}>
                <button type="button" className="day-list-item" onClick={() => onEdit(b)}>
                  <span className="legend-dot" style={{ backgroundColor: b.color }} />
                  <span className="day-list-name">{b.petName}</span>
                  <span className="day-list-meta">
                    {fmtDMY(b.startDate)} — {fmtDMY(b.endDate)} · {fmtMoney(b.price)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="modal-actions">
          <button type="button" className="btn btn-primary" onClick={onAdd}>
            ➕ Бронь на этот день
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   CALENDAR
   ============================================================ */
const MAX_BARS_PER_DAY = 3;

function DayCell({ cell, bookings, onBarClick, onMoreClick, onEmptyClick }) {
  const visible = bookings.slice(0, MAX_BARS_PER_DAY);
  const hiddenCount = bookings.length - visible.length;

  return (
    <div
      className={`cell${cell.inMonth ? "" : " cell-out"}${cell.isToday ? " cell-today" : ""}`}
      onClick={() => onEmptyClick(cell.iso)}
    >
      <div className="cell-top">
        <span className="cell-num">
          {cell.day}
          {cell.day === 1 ? <span className="cell-month-short"> {MONTH_NAMES[parseISO(cell.iso).getMonth()].slice(0, 3).toLowerCase()}</span> : null}
        </span>
        {cell.isToday ? <span className="today-dot" title="Сегодня" /> : null}
      </div>

      <div className="cell-bars">
        {visible.map((b) => {
          const isSingle = b.startDate === b.endDate;
          const cls = isSingle
            ? "bar bar-single"
            : cell.iso === b.startDate
              ? "bar bar-start"
              : cell.iso === b.endDate
                ? "bar bar-end"
                : "bar bar-middle";
          return (
            <button
              key={b.id}
              type="button"
              className={cls}
              style={{ backgroundColor: b.color, color: textColorFor(b.color) }}
              title={`${b.petName}: ${fmtDMY(b.startDate)} — ${fmtDMY(b.endDate)}, ${fmtMoney(b.price)}`}
              onClick={(e) => {
                e.stopPropagation();
                onBarClick(b);
              }}
            >
              {b.petName}
            </button>
          );
        })}
        {hiddenCount > 0 ? (
          <button
            type="button"
            className="bar-more"
            onClick={(e) => {
              e.stopPropagation();
              onMoreClick(cell.iso);
            }}
          >
            +{hiddenCount} ещё
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Calendar({ view, bookingsByDay, onBarClick, onMoreClick, onEmptyClick }) {
  const cells = useMemo(() => buildMonthMatrix(view.y, view.m), [view.y, view.m]);
  return (
    <div className="calendar-wrap">
      <div className="weekdays">
        {WEEKDAYS.map((w) => (
          <div key={w} className="weekday">
            {w}
          </div>
        ))}
      </div>
      <div className="calendar">
        {cells.map((cell) => (
          <DayCell
            key={cell.iso}
            cell={cell}
            bookings={bookingsByDay.get(cell.iso) || []}
            onBarClick={onBarClick}
            onMoreClick={onMoreClick}
            onEmptyClick={onEmptyClick}
          />
        ))}
      </div>
    </div>
  );
}

/* ============================================================
   LEGEND (active / archive)
   ============================================================ */
function Legend({ bookings, tab, setTab, query, setQuery, onEdit }) {
  const today = todayISO();
  const q = query.trim().toLowerCase();

  const { active, archive } = useMemo(() => {
    const a = [];
    const r = [];
    for (const b of bookings) (b.endDate < today ? r : a).push(b);
    a.sort((x, y) => x.startDate.localeCompare(y.startDate));
    r.sort((x, y) => y.startDate.localeCompare(x.startDate)); // archive: newest first
    return { active: a, archive: r };
  }, [bookings, today]);

  const list = (tab === "active" ? active : archive).filter(
    (b) => !q || b.petName.toLowerCase().includes(q)
  );

  return (
    <section className="legend">
      <div className="legend-head">
        <div className="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "active"}
            className={`tab${tab === "active" ? " active" : ""}`}
            onClick={() => setTab("active")}
          >
            📋 Активные <span className="badge">{active.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "archive"}
            className={`tab${tab === "archive" ? " active" : ""}`}
            onClick={() => setTab("archive")}
          >
            📦 Архив <span className="badge">{archive.length}</span>
          </button>
        </div>
        <input
          type="search"
          className="search-input"
          placeholder="Поиск по кличке…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Поиск по кличке"
        />
      </div>

      {list.length === 0 ? (
        <EmptyState icon={q ? "🔍" : tab === "active" ? "🏡" : "📦"}>
          {q
            ? `Ничего не найдено по запросу «${query.trim()}»`
            : tab === "active"
              ? "Активных броней пока нет — самое время добавить!"
              : "Архив пуст"}
        </EmptyState>
      ) : (
        <ul className="legend-list">
          {list.map((b) => {
            const days = daysInclusive(b.startDate, b.endDate);
            return (
              <li key={b.id}>
                <button type="button" className="legend-item" onClick={() => onEdit(b)}>
                  <span className="legend-dot" style={{ backgroundColor: b.color }} />
                  <span className="legend-main">
                    <span className="legend-name">{b.petName}</span>
                    <span className="legend-dates">
                      {fmtDMY(b.startDate)} — {fmtDMY(b.endDate)}
                      {days > 0 ? ` · ${days} дн.` : ""}
                    </span>
                  </span>
                  <span className="legend-price">{fmtMoney(b.price)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* ============================================================
   APP
   ============================================================ */
function App() {
  const [bookings, setBookings] = useState([]);
  const [phase, setPhase] = useState("loading"); // loading | ready | error
  const [syncing, setSyncing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [view, setView] = useState(() => {
    const t = new Date();
    return { y: t.getFullYear(), m: t.getMonth() };
  });
  const [tab, setTab] = useState("active");
  const [query, setQuery] = useState("");
  const [modal, setModal] = useState(null); // {type:'add',dateISO} | {type:'edit',booking} | {type:'day',dateISO}
  const [toast, setToast] = useState(null);

  const toastTimer = useRef(null);
  const refreshTimer = useRef(null);
  // Fixed: request sequencing guard — prevents stale responses from
  // overwriting fresher state when multiple fetches race
  const fetchSeq = useRef(0);

  const showToast = useCallback((msg, type = "success") => {
    setToast({ msg, type, key: Date.now() });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3600);
  }, []);

  const load = useCallback(
    async ({ initial = false, silent = false } = {}) => {
      const seq = ++fetchSeq.current;
      setSyncing(true);
      try {
        const data = await apiFetchBookings();
        if (seq !== fetchSeq.current) return true; // a newer fetch is in flight
        setBookings(data);
        setPhase("ready");
        setLastUpdated(new Date());
        return true;
      } catch (err) {
        console.error("Ошибка загрузки данных:", err);
        if (seq === fetchSeq.current && initial) setPhase("error");
        if (!silent) showToast("Не удалось загрузить данные из Google. Проверьте интернет.", "error");
        return false;
      } finally {
        if (seq === fetchSeq.current) setSyncing(false);
      }
    },
    [showToast]
  );

  useEffect(() => {
    load({ initial: true });
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, [load]);

  /** POST → wait a beat for the sheet to commit → refresh from source of truth */
  const postAndRefresh = useCallback(
    async (action, payload, successMsg) => {
      setSyncing(true);
      try {
        await apiPost(action, payload);
        if (successMsg) showToast(successMsg, "success");
      } catch (err) {
        console.error("Ошибка сохранения:", err);
        showToast("Ошибка при сохранении данных", "error");
      } finally {
        // Apps Script needs a moment to commit before doGet reflects it
        refreshTimer.current = setTimeout(() => {
          load({ silent: true });
        }, 900);
        setSyncing(false);
      }
    },
    [load, showToast]
  );

  const handleSave = useCallback(
    (booking) => {
      const isNew = !bookings.some((b) => b.id === booking.id);
      // Optimistic UI so the calendar feels instant despite no-cors POST
      setBookings((prev) => {
        const idx = prev.findIndex((b) => b.id === booking.id);
        if (idx === -1) return [...prev, booking];
        const next = prev.slice();
        next[idx] = booking;
        return next;
      });
      setModal(null);
      postAndRefresh("save", booking, isNew ? "Бронь добавлена ✓" : "Бронь обновлена ✓");
    },
    [bookings, postAndRefresh]
  );

  const handleDelete = useCallback(
    (booking) => {
      if (!window.confirm(`Удалить бронь «${booking.petName}»?`)) return;
      setBookings((prev) => prev.filter((b) => b.id !== booking.id));
      setModal(null);
      postAndRefresh("delete", { id: booking.id }, "Бронь удалена");
    },
    [postAndRefresh]
  );

  /* ---- derived data ---- */
  const bookingsByDay = useMemo(() => {
    const map = new Map();
    for (const b of bookings) {
      if (!parseISO(b.startDate) || !parseISO(b.endDate)) continue;
      if (b.startDate > b.endDate) continue; // skip corrupt ranges
      let cur = b.startDate;
      let guard = 0;
      while (cur <= b.endDate && guard < 370) {
        if (!map.has(cur)) map.set(cur, []);
        map.get(cur).push(b);
        cur = addDaysISO(cur, 1);
        guard++;
      }
    }
    return map;
  }, [bookings]);

  const stats = useMemo(
    () => computeMonthStats(bookings, view.y, view.m),
    [bookings, view.y, view.m]
  );

  const isCurrentMonth = useMemo(() => {
    const t = new Date();
    return view.y === t.getFullYear() && view.m === t.getMonth();
  }, [view]);

  /* ---- render ---- */
  if (phase === "loading") {
    return (
      <div className="fullscreen-state">
        <Spinner label="Подождите, данные загружаются…" />
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="fullscreen-state">
        <EmptyState icon="😿">
          Не удалось загрузить данные из Google Sheets.
          <br />
          Проверьте подключение к интернету.
        </EmptyState>
        <button type="button" className="btn btn-primary" onClick={() => { setPhase("loading"); load({ initial: true }); }}>
          🔄 Повторить
        </button>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="title">🐾 Календарь передержки животных</h1>

        <div className="topbar-row">
          <div className="month-nav">
            <button
              type="button"
              className="icon-btn"
              aria-label="Предыдущий месяц"
              onClick={() => setView((v) => ({ y: v.m === 0 ? v.y - 1 : v.y, m: (v.m + 11) % 12 }))}
            >
              ‹
            </button>
            <div className="month-label" aria-live="polite">
              {MONTH_NAMES[view.m]} {view.y}
            </div>
            <button
              type="button"
              className="icon-btn"
              aria-label="Следующий месяц"
              onClick={() => setView((v) => ({ y: v.m === 11 ? v.y + 1 : v.y, m: (v.m + 1) % 12 }))}
            >
              ›
            </button>
            {!isCurrentMonth ? (
              <button
                type="button"
                className="btn btn-ghost btn-small"
                onClick={() => {
                  const t = new Date();
                  setView({ y: t.getFullYear(), m: t.getMonth() });
                }}
              >
                Сегодня
              </button>
            ) : null}
          </div>

          <div className="topbar-actions">
            <button
              type="button"
              className="icon-btn"
              aria-label="Обновить данные"
              title="Обновить данные"
              onClick={() => load({ silent: false })}
              disabled={syncing}
            >
              {syncing ? <span className="spinner spinner-mini" aria-hidden="true" /> : "↻"}
            </button>
            {lastUpdated ? (
              <span className="sync-note" title="Время последнего обновления">
                Обновлено {fmtHM(lastUpdated)}
              </span>
            ) : null}
            <button
              type="button"
              className="btn btn-success"
              onClick={() => setModal({ type: "add", dateISO: todayISO() })}
            >
              + Добавить бронь
            </button>
          </div>
        </div>

        <div className="stats">
          <div className="stat stat-earnings">
            <span className="stat-label">💰 Выручка за {MONTH_NAMES[view.m].toLowerCase()}</span>
            <span className="stat-value">{fmtMoney(stats.earnings)}</span>
          </div>
          <div className="stat">
            <span className="stat-label">📅 Занято дней</span>
            <span className="stat-value">{stats.bookedDays}</span>
          </div>
          <div className="stat">
            <span className="stat-label">🐶 Активных броней</span>
            <span className="stat-value">{stats.activeCount}</span>
          </div>
        </div>
      </header>

      <main>
        <Calendar
          view={view}
          bookingsByDay={bookingsByDay}
          onBarClick={(b) => setModal({ type: "edit", booking: b })}
          onMoreClick={(iso) => setModal({ type: "day", dateISO: iso })}
          onEmptyClick={(iso) => setModal({ type: "add", dateISO: iso })}
        />

        <Legend
          bookings={bookings}
          tab={tab}
          setTab={setTab}
          query={query}
          setQuery={setQuery}
          onEdit={(b) => setModal({ type: "edit", booking: b })}
        />
      </main>

      {modal && modal.type !== "day" ? (
        <BookingModal
          initial={
            modal.type === "edit"
              ? modal.booking
              : {
                  id: "",
                  petName: "",
                  startDate: modal.dateISO,
                  endDate: modal.dateISO,
                  price: 0,
                  color: PRESET_COLORS[0],
                }
          }
          editing={modal.type === "edit"}
          onClose={() => setModal(null)}
          onSave={handleSave}
          onDelete={handleDelete}
        />
      ) : null}

      {modal && modal.type === "day" ? (
        <DayModal
          dateISO={modal.dateISO}
          bookings={bookingsByDay.get(modal.dateISO) || []}
          onClose={() => setModal(null)}
          onEdit={(b) => setModal({ type: "edit", booking: b })}
          onAdd={() => setModal({ type: "add", dateISO: modal.dateISO })}
        />
      ) : null}

      <Toast toast={toast} />
    </div>
  );
}

/* ============================================================
   MOUNT (guarded so the file can also be imported in tests)
   ============================================================ */
if (typeof document !== "undefined") {
  const rootEl = document.getElementById("root");
  if (rootEl) createRoot(rootEl).render(<App />);
}

export {
  App,
  buildMonthMatrix,
  daysInclusive,
  toLocalISO,
  textColorFor,
  parseISO,
  parsePrice,
  computeMonthStats,
};
