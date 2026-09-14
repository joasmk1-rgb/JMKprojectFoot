// ===================== GRID.JS =====================
// Construction de la grille horaire de disponibilité, repris du mécanisme
// d'agenda-conseil (mêmes fonctions de base) mais simplifié : pas de cours
// bloqués ni d'événements ici, juste des créneaux dispo/pas dispo par équipe.

import { DISPO_CONFIG } from "./config.js";

export const WEEKDAYS_FULL = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];
export const MONTHS_FULL = [
  "Janvier", "Février", "Mars", "Avril", "Mai", "Juin",
  "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre",
];

export const LAYOUT = {
  timeColWidth: 70,
  dayColWidth: 86,
  monthRowHeight: 20,
  dayRowHeight: 38,
  hourRowHeight: 14,
};

const HOUR_ROW_OFFSET = 3; // bandeau mois (1) + jour (2), puis les heures

export function toISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function minutesToLabel(totalMinutes) {
  const h = String(Math.floor(totalMinutes / 60)).padStart(2, "0");
  const m = String(totalMinutes % 60).padStart(2, "0");
  return `${h}:${m}`;
}

export function buildTimeSlots() {
  const slots = [];
  for (let t = DISPO_CONFIG.dayStartHour * 60; t < DISPO_CONFIG.dayEndHour * 60; t += DISPO_CONFIG.slotMinutes) {
    slots.push(minutesToLabel(t));
  }
  return slots;
}

export function buildDateList(startDate, rangeDays) {
  const dates = [];
  let cursor = new Date(startDate);
  cursor.setHours(0, 0, 0, 0);
  for (let i = 0; i < rangeDays; i++) {
    dates.push(new Date(cursor));
    cursor = addDays(cursor, 1);
  }
  return dates;
}

export function slotKey(dateISO, timeLabel) {
  return `${dateISO}|${timeLabel}`;
}

function addMinutesToLabel(label, minutes) {
  const [h, m] = label.split(":").map(Number);
  const total = h * 60 + m + minutes;
  const hh = String(Math.floor(total / 60) % 24).padStart(2, "0");
  const mm = String(total % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

// Convertit des marks de grille ({ "date|heure": "available"|"unavailable" })
// en plages continues { date, heureDebut, heureFin }, en ne gardant que les
// créneaux "available" et en fusionnant les cases consécutives d'une même
// journée. Sert à transformer le peint-sur-grille des terrains en "creneaux"
// exploitables par scheduleMatches (qui attend des plages, pas des cases).
export function marksToCreneaux(marks) {
  const parDate = {};
  Object.entries(marks).forEach(([key, val]) => {
    if (val !== "available") return;
    const [date, heure] = key.split("|");
    (parDate[date] = parDate[date] || []).push(heure);
  });

  const creneaux = [];
  Object.entries(parDate).forEach(([date, heures]) => {
    heures.sort();
    let debut = heures[0];
    let prec = heures[0];
    for (let i = 1; i <= heures.length; i++) {
      const cur = heures[i];
      const attendu = addMinutesToLabel(prec, DISPO_CONFIG.slotMinutes);
      if (cur !== attendu) {
        creneaux.push({ date, heureDebut: debut, heureFin: attendu });
        if (cur) debut = cur;
      }
      prec = cur;
    }
  });
  return creneaux;
}

export function gridTemplateColumns(dateCount) {
  return `${LAYOUT.timeColWidth}px repeat(${dateCount}, ${LAYOUT.dayColWidth}px)`;
}

export function gridTemplateRows(timeCount) {
  return `${LAYOUT.monthRowHeight}px ${LAYOUT.dayRowHeight}px repeat(${timeCount}, ${LAYOUT.hourRowHeight}px)`;
}

export function buildMonthGroups(dates) {
  const groups = [];
  dates.forEach((date, i) => {
    const label = `${MONTHS_FULL[date.getMonth()]} ${date.getFullYear()}`;
    const last = groups[groups.length - 1];
    if (last && last.label === label) {
      last.span += 1;
    } else {
      groups.push({ label, startIndex: i, span: 1 });
    }
  });
  return groups;
}

function buildDayHeaderCell(date) {
  const dow = date.getDay();
  const isWeekend = dow === 0 || dow === 6;
  const isToday = toISODate(date) === toISODate(new Date());
  const el = document.createElement("div");
  el.className = "cell day-header" + (isWeekend ? " weekend" : "") + (isToday ? " today" : "");
  el.dataset.dateIso = toISODate(date);
  const weekdayLabel = document.createElement("span");
  weekdayLabel.className = "weekday";
  weekdayLabel.textContent = WEEKDAYS_FULL[dow];
  const dayNumber = document.createElement("span");
  dayNumber.className = "day-number";
  dayNumber.textContent = String(date.getDate());
  el.appendChild(weekdayLabel);
  el.appendChild(dayNumber);
  return el;
}

export function renderGridHeaders(container, dates) {
  const corner = document.createElement("div");
  corner.className = "cell corner";
  corner.style.gridRow = "1 / 3";
  corner.style.gridColumn = "1";
  container.appendChild(corner);

  buildMonthGroups(dates).forEach((group) => {
    const el = document.createElement("div");
    el.className = "cell month-band";
    el.textContent = group.label;
    el.style.gridRow = "1";
    el.style.gridColumn = `${group.startIndex + 2} / span ${group.span}`;
    container.appendChild(el);
  });

  dates.forEach((date, i) => {
    const el = buildDayHeaderCell(date);
    el.style.gridRow = "2";
    el.style.gridColumn = String(i + 2);
    container.appendChild(el);
  });
}

// cellFactory(cellEl, { date, dateISO, timeLabel }) personnalise chaque case
// (couleur dispo/pas dispo, écouteurs de clic/glissé...).
export function renderHourRows(container, dates, times, cellFactory) {
  times.forEach((timeLabel, r) => {
    const isHourMark = timeLabel.endsWith(":00");
    const labelEl = document.createElement("div");
    labelEl.className = "cell time-label" + (isHourMark ? " hour-mark" : "");
    labelEl.textContent = isHourMark ? timeLabel : `:${timeLabel.split(":")[1]}`;
    labelEl.style.gridRow = String(r + HOUR_ROW_OFFSET);
    labelEl.style.gridColumn = "1";
    container.appendChild(labelEl);

    dates.forEach((date, i) => {
      const dateISO = toISODate(date);
      const cell = document.createElement("div");
      cell.className = "cell slot" + (isHourMark ? " hour-mark" : "");
      cell.style.gridRow = String(r + HOUR_ROW_OFFSET);
      cell.style.gridColumn = String(i + 2);
      if (cellFactory) cellFactory(cell, { date, dateISO, timeLabel });
      container.appendChild(cell);
    });
  });
}
