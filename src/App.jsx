import { useState, useMemo, useEffect, useCallback } from "react";
import { supabase } from './supabase.js';
import {
  fetchClients, updateClient, insertClient, insertLegacyClient, insertSavedPoints,
  insertClientPhone, updateClientPhone,
  insertClientEmail, updateClientEmail,
  insertClientAddress, updateClientAddress,
  insertClientComment,
  fetchPayments, insertPayment, softDeletePayment,
  fetchReservations, insertReservation, updateReservation,
  fetchUnits, insertUnit, updateUnit,
  fetchUnitTypes, insertUnitType, updateUnitType, deleteUnitType,
  fetchFxRate, insertFxRate,
  fetchPaymentMethods, insertPaymentMethod, updatePaymentMethod,
  fetchPromises, insertPromise, updatePromise, deletePromise,
  fetchPendingPayments, insertPendingPayment, updatePendingPayment,
  fetchUsers, updateUser, insertUser,
  insertPointSale,
  fetchCommissionRates, upsertCommissionRate,
  fetchSystemConfig, upsertSystemConfig,
  cancelClientContract,
  insertCourtesy, fetchCourtesies,
  fetchCondonations, insertCondonation,
  fetchPointSales,
  fetchPointPrices, upsertPointPrice, getPriceForYear,
  fetchUnitAvailability, insertUnitAvailability, updateUnitAvailability, deleteUnitAvailability, getAvailableRooms,
  insertUnitSeasonRange, updateUnitSeasonRange, deleteUnitSeasonRange,
} from './lib/db.js';
const BG = "#030912", BG2 = "#060d19", BG3 = "#0b1628", BD = "#18263d";
const T1 = "#e2e8f0", T2 = "#8aa8c0", T3 = "#2e4a66", T4 = "#1e3558", T5 = "#2d4563"; // Corregido: T5 definido aquí
const G = "#22c55e", R = "#ef4444", Y = "#f59e0b", B = "#3b82f6", P = "#8b5cf6", O = "#f97316", C = "#06b6d4", IND = "#1d4ed8";
const f$ = n => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fUSD = n => "USD $" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fMXN = n => "MXN $" + Number(n).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fP = n => Number(n).toLocaleString() + " pts";
const IS = { background: BG3, border: `1px solid ${BD}`, borderRadius: 6, padding: "7px 10px", color: T1, fontSize: 12, fontFamily: "inherit", outline: "none", width: "100%", boxSizing: "border-box" };
const sc = s => ({ Active: G, Delinquent: R, Partial: Y, Confirmed: G, Waitlisted: Y, Cancelled: R, Liquidado: G, Pendiente: Y, "Cancelado s/pago": R, "Cancelado c/pago": P, "Al corriente": G, "Promoción Prepago": "#10b981", "1–30 días": "#a3e635", "31–60 días": Y, "61–90 días": O, "91–180 días": R, "+180 días": "#dc2626", Validada: G, Cancelada: R, Expirada: "#64748b", "Por Validar": Y, Recibo: B }[s] || "#64748b");
const TODAY = new Date(), CY = TODAY.getFullYear(), TOD = TODAY.toISOString().split("T")[0], TOM = TOD.slice(0, 7);
function dOvr(ds) { if (!ds) return 0; return Math.floor((TODAY - new Date(ds)) / 86400000); }
function cDel(d) { if (d <= 0) return { l: "Al corriente", c: G, r: 0 }; if (d <= 30) return { l: "1–30 días", c: "#a3e635", r: 0.5 }; if (d <= 60) return { l: "31–60 días", c: Y, r: 1 }; if (d <= 90) return { l: "61–90 días", c: O, r: 1.5 }; if (d <= 180) return { l: "91–180 días", c: R, r: 2 }; return { l: "+180 días", c: "#dc2626", r: 2.5 }; }
function cInt(bal, d, r) { if (bal <= 0 || d <= 0) return 0; return bal * (r / 100) * (d / 365); }
// Determina el año de mantenimiento pendiente de pago para un cliente
// Regla: si ya pagó este año → año siguiente (prepago). Si no → año en curso.
// Determina el año de mantenimiento pendiente de pago para un cliente
// Regla: año más antiguo desde inicio del contrato que NO esté completamente pagado
// Si TODOS los años hasta CY están pagados → CY+1 (prepago)
// Distribuye los puntos de pagos a años FIFO empezando por el más antiguo pendiente.
// Si un pago tiene maint_year explícito, ese año se llena primero pero el sobrante se aplica a los siguientes.
function getPaidPtsByYear(client, payments) {
  const paidByYear = {};
  if (!client) return paidByYear;
  const startYear = client.contractDate ? new Date(client.contractDate).getFullYear() : CY;
  const annualPts = client.annualPoints || 0;
  if (annualPts === 0) return paidByYear;

  // Inicializar todos los años con 0 desde el inicio del contrato hasta CY+1 (límite máximo de prepago)
  for (let yr = startYear; yr <= CY + 1; yr++) paidByYear[yr] = 0;

  // Procesar pagos ordenados por fecha (más antiguo primero)
  const maintPays = payments
    .filter(p => (p.type === "maintenance" || p.ptype === "maintenance") && p.clientId === client.id)
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  maintPays.forEach(p => {
    let remaining = p.points || 0;
    // Empezar desde el año del pago si está especificado, si no, desde el año más antiguo no pagado
    let startFromYear = p.maintYear || (p.date ? new Date(p.date).getFullYear() : startYear);
    if (startFromYear < startYear) startFromYear = startYear;
    // Aplicar al año del pago primero, luego avanzar a los siguientes (hasta CY+1 máximo)
    for (let yr = startFromYear; yr <= CY + 1 && remaining > 0; yr++) {
      const space = annualPts - (paidByYear[yr] || 0);
      if (space > 0) {
        const apply = Math.min(remaining, space);
        paidByYear[yr] = (paidByYear[yr] || 0) + apply;
        remaining -= apply;
      }
    }
  });
  return paidByYear;
}

function getMaintYear(client, payments, condonations) {
  if (!client || !client.contractDate) return CY;
  const startYear = new Date(client.contractDate).getFullYear();
  const annualPts = client.annualPoints || 0;
  if (annualPts === 0) return CY;
  const paidByYear = getPaidPtsByYear(client, payments);
  const condYears = (condonations || []).filter(c => c.clientId === client.id).map(c => c.maintYear);
  for (let yr = startYear; yr <= CY; yr++) {
    const covered = (paidByYear[yr] || 0) >= annualPts || condYears.includes(yr);
    if (!covered) return yr;
  }
  if ((paidByYear[CY + 1] || 0) >= annualPts) return CY + 2;
  return CY + 1;
}
function getMaintPointExpiry(maintYear) {
  return new Date(maintYear, 11, 31).toISOString().split("T")[0];
}
function getMaintDesglose(client, payments, pp, condonations) {
  if (!client || !client.contractDate) return [];
  const startYear = new Date(client.contractDate).getFullYear();
  const annualPts = client.annualPoints || 0;
  const montoAnual = Math.round(annualPts * pp);
  const paidByYear = getPaidPtsByYear(client, payments);
  const condYears = (condonations || []).filter(c => c.clientId === client.id).map(c => c.maintYear);
  const years = [];
  for (let yr = startYear; yr <= CY; yr++) {
    const ptsPagados = paidByYear[yr] || 0;
    const paid = ptsPagados >= annualPts;
    const partial = ptsPagados > 0 && !paid;
    const condonated = !paid && condYears.includes(yr);
    years.push({ year: yr, pts: annualPts, montoMXN: montoAnual, ptsPagados, paid, partial, condonated, pendientePts: condonated ? 0 : Math.max(0, annualPts - ptsPagados), pendienteMXN: condonated ? 0 : Math.max(0, montoAnual - Math.round(ptsPagados * pp)) });
  }
  return years;
}
// Días hasta el siguiente 1 de enero (fecha de asignación de puntos nuevos)
function daysToNextRenewal() { const next = new Date(CY + 1, 0, 1); return Math.floor((next - TODAY) / 86400000); }
// Días hasta el 31 de diciembre de este año
function daysToPointExpiry() { const exp = new Date(CY, 11, 31); if (TODAY > exp) exp.setFullYear(CY + 1); return Math.floor((exp - TODAY) / 86400000); }
function daysToMaintDeadline() { const d = new Date(CY, 0, 31); if (TODAY > d) d.setFullYear(CY + 1); return Math.floor((d - TODAY) / 86400000); }
function cDelEx(bal, dOvrDays) { if (bal === 0) { if (daysToNextRenewal() < 365) return { l: "Promoción Prepago", c: "#10b981", r: 0 }; return { l: "Al corriente", c: G, r: 0 }; } return cDel(dOvrDays); }

function getClientStatus(client, payments, condonations) {
  if (!client || !client.contractDate) return cDelEx(client?.balance || 0, 0);
  const startYear = new Date(client.contractDate).getFullYear();
  const annualPts = client.annualPoints || 0;
  const paidByYear = getPaidPtsByYear(client, payments);
  const condYears = (condonations || []).filter(c => c.clientId === client.id).map(c => c.maintYear);
  let oldestUnpaidYear = null;
  for (let yr = startYear; yr <= CY; yr++) {
    const covered = (paidByYear[yr] || 0) >= annualPts || condYears.includes(yr);
    if (!covered) { oldestUnpaidYear = yr; break; }
  }
  if (oldestUnpaidYear !== null) {
    const yearStart = new Date(oldestUnpaidYear, 0, 1);
    const daysOverdue = Math.max(0, Math.floor((TODAY - yearStart) / 86400000));
    return cDel(daysOverdue);
  }
  const nextPaid = paidByYear[CY + 1] || 0;
  if (nextPaid >= annualPts) return { l: "Al corriente", c: G, r: 0 };
  return { l: "Promoción Prepago", c: "#10b981", r: 0 };
}
function calcAP(tot, used, yr) { const r = Math.max(0, tot - (used || 0)); return yr <= 1 ? r : Math.ceil(r / yr); }
// calcPts: recibe la unidad con sus seasons y el id de la temporada detectada
function calcPts(unit, seasonId, isWe) {
  if (!unit || !seasonId) return 0;
  const s = (unit.seasons || []).find(x => (x.season || x.id) === seasonId);
  if (!s) return 0;
  return isWe ? (s.pts_weekend || s.ptsWe || 0) : (s.pts_weekday || s.ptsWd || 0);
}
// Helper: dado una fecha y un rango {startMonth,startDay,endMonth,endDay}, verifica si la fecha cae en el rango
const SEASON_ORDER_PRIORITY = ["platino", "oro", "plata"];
function inRange(date, r) {
  const m = date.getMonth() + 1, dy = date.getDate();
  const sm = r.start_month || r.startMonth || r.sm, sd = r.start_day || r.startDay || r.sd;
  const em = r.end_month || r.endMonth || r.em, ed = r.end_day || r.endDay || r.ed;
  if (!sm) return false;
  if (sm <= em) return (m > sm || (m === sm && dy >= sd)) && (m < em || (m === em && dy <= ed));
  return (m > sm || (m === sm && dy >= sd)) || (m < em || (m === em && dy <= ed));
}
// detS: dado fecha y unidad, encuentra la temporada de mayor prioridad que cubre esa fecha.
// Si no hay ninguna asignada, retorna oro como default.
function detS(ds, unit) {
  if (!ds || !unit) return { id: "oro", season: "oro", ...SEASON_META.find(m => m.id === "oro") };
  const d = new Date(ds + "T12:00:00");
  const seasons = unit.seasons || [];
  const matching = seasons.filter(s => inRange(d, s));
  if (matching.length === 0) return { id: "oro", season: "oro", ...SEASON_META.find(m => m.id === "oro"), pts_weekday: 0, pts_weekend: 0 };
  matching.sort((a, b) =>
    SEASON_ORDER_PRIORITY.indexOf(a.season || a.id || "") - SEASON_ORDER_PRIORITY.indexOf(b.season || b.id || "")
  );
  const best = matching[0];
  const sId = best.season || best.id || "oro";
  const meta = SEASON_META.find(m => m.id === sId) || SEASON_META[1];
  return { ...best, ...meta, id: sId };
}
const mkP = (label, number, active = true) => ({ label, number, active });
const mkE = (label, email, active = true) => ({ label, email, active });
const mkA = (label, text, active = true) => ({ label, text, active });
const mkC = (text, by, date) => ({ id: Math.random(), text, by, date });
const RM = { superadmin: { l: "Super Admin", c: B }, admin: { l: "Admin", c: Y }, cajero: { l: "Cajero", c: G }, gestor: { l: "Gestor", c: P } };
const RT = { superadmin: ["dash", "clients", "cashier", "res", "col", "reports", "cobranza", "config", "pmethods", "comp", "users", "special", "legacy"], admin: ["dash", "clients", "reports", "cobranza", "config", "team", "contracts", "courtesies", "ps", "special", "legacy"], cajero: ["cashier", "cobranza", "clients", "ps"], gestor: ["promesas", "res", "col", "cashier", "clients", "ec", "ps"] };
const ATABS = [{ id: "promesas", l: "Mis Promesas", i: "★" }, { id: "dash", l: "Dashboard", i: "◈" }, { id: "clients", l: "Clientes", i: "◉" }, { id: "cashier", l: "Caja", i: "◐" }, { id: "res", l: "Reservaciones", i: "◫" }, { id: "col", l: "Cobranzas", i: "◎" }, { id: "reports", l: "Reportes", i: "◧" }, { id: "cobranza", l: "Rep. Cobranza", i: "◑" }, { id: "config", l: "Config", i: "◬" }, { id: "pmethods", l: "Medios de Pago", i: "◆" }, { id: "comp", l: "Sueldos", i: "◇" }, { id: "users", l: "Usuarios", i: "◭" }, { id: "team", l: "Mi Equipo", i: "◩" }, { id: "contracts", l: "Contratos", i: "◪" }, { id: "courtesies", l: "Cortesías", i: "◤" }, { id: "ec", l: "Mi Estado de Cuenta", i: "◊" }, { id: "special", l: "Gestión Especial", i: "◈" }, { id: "legacy", l: "Alta Contratos", i: "⊕" }, { id: "ps", l: "Venta Puntos", i: "◥" }];
const INIT_U = [
  { id: 1, username: "superadmin", password: "admin", role: "superadmin", name: "Super Administrador", color: B, salary: 0, commissions: { collection: 0 }, active: true },
  { id: 2, username: "admin1", password: "admin", role: "admin", name: "Carmen Ríos", color: Y, salary: 5000, commissions: { collection: 0.015 }, active: true },
  { id: 3, username: "cajero1", password: "admin", role: "cajero", name: "Roberto Sanz", color: G, salary: 2500, commissions: { collection: 0.008 }, active: true },
  { id: 4, username: "gestor1", password: "admin", role: "gestor", name: "Ana López", color: P, salary: 3000, commissions: { collection: 0.02 }, active: true },
  { id: 5, username: "gestor2", password: "admin", role: "gestor", name: "Luis Mora", color: C, salary: 3000, commissions: { collection: 0.02 }, active: true },
];
// Las temporadas son fijas: Platino, Oro, Plata. Cada UNIDAD define sus rangos y costos.
const SEASON_META = [
  { id: "platino", name: "Platino", color: "#94a3b8" },
  { id: "oro", name: "Oro", color: "#fbbf24" },
  { id: "plata", name: "Plata", color: "#cbd5e1" },
];
const INIT_SEASON_ORDER = ["platino", "oro", "plata"]; // Orden configurable por admin
const INIT_L = []; // Ubicaciones ya no son globales; cada unidad tiene location:string libre
const INIT_UT = [{ id: 1, name: "Studio", basePts: 100, active: true }, { id: 2, name: "Suite 1 Rec", basePts: 160, active: true }, { id: 3, name: "Suite 2 Rec", basePts: 240, active: true }, { id: 4, name: "Villa 3 Rec", basePts: 350, active: true }, { id: 5, name: "Penthouse", basePts: 500, active: true }];
// Cada unidad tiene sus propias temporadas con fechas y costos por noche (Dom-Jue y Vie-Sab)
// seasons: [{id:"platino"|"oro"|"plata", ranges:[{startMonth,startDay,endMonth,endDay}], ptsWd, ptsWe}]
const mkSeason = (id, ranges, ptsWd, ptsWe) => ({ id, ranges, ptsWd, ptsWe });
const INIT_UNITS = [
  { id: 1, typeId: 1, location: "Playa Cancún", name: "Studio 101", active: true, occ: [], seasons: [mkSeason("platino", [{ startMonth: 12, startDay: 15, endMonth: 1, endDay: 5 }], 130, 170), mkSeason("oro", [{ startMonth: 7, startDay: 1, endMonth: 8, endDay: 31 }, { startMonth: 12, startDay: 1, endMonth: 12, endDay: 14 }], 100, 135), mkSeason("plata", [{ startMonth: 1, startDay: 6, endMonth: 6, endDay: 30 }, { startMonth: 9, startDay: 1, endMonth: 11, endDay: 30 }], 60, 85)] },
  { id: 2, typeId: 2, location: "Playa Cancún", name: "Suite 201", active: true, occ: [{ ci: "2025-07-04", co: "2025-07-11" }], seasons: [mkSeason("platino", [{ startMonth: 12, startDay: 15, endMonth: 1, endDay: 5 }], 210, 275), mkSeason("oro", [{ startMonth: 7, startDay: 1, endMonth: 8, endDay: 31 }, { startMonth: 12, startDay: 1, endMonth: 12, endDay: 14 }], 170, 220), mkSeason("plata", [{ startMonth: 1, startDay: 6, endMonth: 6, endDay: 30 }, { startMonth: 9, startDay: 1, endMonth: 11, endDay: 30 }], 100, 140)] },
  { id: 3, typeId: 3, location: "Montaña Tepoztlán", name: "Villa M-01", active: true, occ: [], seasons: [mkSeason("platino", [{ startMonth: 12, startDay: 15, endMonth: 1, endDay: 5 }, { startMonth: 7, startDay: 15, endMonth: 8, endDay: 15 }], 300, 390), mkSeason("oro", [{ startMonth: 3, startDay: 15, endMonth: 4, endDay: 15 }], 240, 310), mkSeason("plata", [{ startMonth: 1, startDay: 6, endMonth: 3, endDay: 14 }, { startMonth: 4, startDay: 16, endMonth: 7, endDay: 14 }, { startMonth: 8, startDay: 16, endMonth: 12, endDay: 14 }], 150, 200)] },
  { id: 4, typeId: 4, location: "Lago Valle de Bravo", name: "Villa L-05", active: true, occ: [], seasons: [mkSeason("platino", [{ startMonth: 12, startDay: 15, endMonth: 1, endDay: 5 }], 450, 580), mkSeason("oro", [{ startMonth: 3, startDay: 15, endMonth: 4, endDay: 15 }, { startMonth: 7, startDay: 1, endMonth: 8, endDay: 31 }], 360, 470), mkSeason("plata", [{ startMonth: 1, startDay: 6, endMonth: 3, endDay: 14 }, { startMonth: 4, startDay: 16, endMonth: 6, endDay: 30 }, { startMonth: 9, startDay: 1, endMonth: 12, endDay: 14 }], 220, 300)] },
  { id: 5, typeId: 5, location: "Playa Cancún", name: "PH Coral", active: true, occ: [], seasons: [mkSeason("platino", [{ startMonth: 12, startDay: 15, endMonth: 1, endDay: 5 }, { startMonth: 7, startDay: 1, endMonth: 8, endDay: 31 }], 650, 840), mkSeason("oro", [{ startMonth: 3, startDay: 15, endMonth: 4, endDay: 15 }], 520, 670), mkSeason("plata", [{ startMonth: 1, startDay: 6, endMonth: 3, endDay: 14 }, { startMonth: 4, startDay: 16, endMonth: 6, endDay: 30 }, { startMonth: 9, startDay: 1, endMonth: 12, endDay: 14 }], 320, 430)] },
  { id: 6, typeId: 2, location: "Centro CDMX", name: "Suite C-10", active: false, occ: [], seasons: [mkSeason("platino", [{ startMonth: 12, startDay: 15, endMonth: 1, endDay: 5 }], 180, 230), mkSeason("oro", [{ startMonth: 7, startDay: 1, endMonth: 8, endDay: 31 }], 140, 180), mkSeason("plata", [{ startMonth: 1, startDay: 6, endMonth: 6, endDay: 30 }, { startMonth: 9, startDay: 1, endMonth: 12, endDay: 14 }], 90, 120)] },
];
const INIT_PM = [{ id: 1, name: "Efectivo", costPct: 0, active: true }, { id: 2, name: "Tarjeta Créd.", costPct: 3.5, active: true }, { id: 3, name: "Tarjeta Déb.", costPct: 1.8, active: true }, { id: 4, name: "Transferencia", costPct: 0.5, active: true }, { id: 5, name: "Cheque", costPct: 0.8, active: true }, { id: 6, name: "ACH", costPct: 0.25, active: true }];
const INIT_CR = [
  { id: "maintenance", l: "Pago mantenimiento", pct: 2.0, active: true },
  { id: "prepago", l: "Mantenimiento adelantado (Prepago)", pct: 1.0, active: true },
  { id: "moratorios", l: "Moratorios", pct: 3.0, active: true },
  { id: "point_purchase", l: "Compra/Venta puntos", pct: 2.0, active: true },
  { id: "cancellation_payment", l: "Liquidación cancelación", pct: 0.5, active: true },
];
const INIT_C = [
  { id: 1, contractNo: "C-2018-001", name: "Margaret & Robert Ellis", phones: [mkP("Esposo", "555-0101"), mkP("Esposa", "555-0111"), mkP("Casa", "555-0121")], emails: [mkE("Principal", "rellis@email.com"), mkE("Esposa", "margaret@email.com")], addresses: [mkA("Casa", "142 Oakwood Dr, Austin TX"), mkA("Trabajo", "800 Congress Ave, Austin TX")], contractDate: "2018-03-15", dueDate: "2025-03-15", contractYears: 10, yearsElapsed: 7, totalPoints: 50000, pointsUsedToDate: 35000, annualPoints: 5000, paidPoints: 4000, balance: 4750, status: "Partial", contractStatus: "Active", assignedGestor: "gestor1", savedPoints: [], comments: [mkC("Cliente VIP, prefiere WhatsApp", "gestor1", "2025-01-10")] },
  { id: 2, contractNo: "C-2019-002", name: "James Nakamura", phones: [mkP("Celular", "555-0202"), mkP("Oficina", "555-0212")], emails: [mkE("Principal", "jnakamura@email.com"), mkE("Trabajo", "j.nakamura@corp.com")], addresses: [mkA("Casa", "87 Pine Ct, Seattle WA")], contractDate: "2019-07-22", dueDate: "2025-07-22", contractYears: 10, yearsElapsed: 6, totalPoints: 80000, pointsUsedToDate: 48000, annualPoints: 8000, paidPoints: 8000, balance: 0, status: "Active", contractStatus: "Active", assignedGestor: "gestor1", savedPoints: [], comments: [mkC("Pagó anticipado sin inconvenientes", "gestor1", "2025-01-16")] },
  { id: 3, contractNo: "C-2017-003", name: "Sofia & Carlos Reyes", phones: [mkP("Esposo", "555-0303"), mkP("Esposa", "555-0313"), mkP("Hijo 1", "555-0323")], emails: [mkE("Principal", "creyes@email.com"), mkE("Esposa", "sofia.reyes@email.com")], addresses: [mkA("Casa", "321 Coral Way, Miami FL")], contractDate: "2017-11-05", dueDate: "2024-11-05", contractYears: 15, yearsElapsed: 8, totalPoints: 108000, pointsUsedToDate: 48000, annualPoints: 12000, paidPoints: 0, balance: 57000, status: "Delinquent", contractStatus: "Active", assignedGestor: "gestor2", savedPoints: [], comments: [mkC("Sin respuesta en últimas 3 llamadas", "gestor2", "2025-03-01")] },
  { id: 4, contractNo: "C-2020-004", name: "Patricia Okonkwo", phones: [mkP("Celular", "555-0404"), mkP("Casa", "555-0414")], emails: [mkE("Principal", "pokonkwo@email.com")], addresses: [mkA("Casa", "56 Maple Ave, Chicago IL"), mkA("Trabajo", "233 S Wacker Dr, Chicago IL")], contractDate: "2020-01-18", dueDate: "2025-01-18", contractYears: 8, yearsElapsed: 5, totalPoints: 17500, pointsUsedToDate: 14000, annualPoints: 3500, paidPoints: 3500, balance: 0, status: "Active", contractStatus: "Active", assignedGestor: "gestor1", savedPoints: [], comments: [] },
  { id: 5, contractNo: "C-2016-005", name: "David & Lisa Chen", phones: [mkP("Esposo", "555-0505"), mkP("Esposa", "555-0515"), mkP("Hijo 1", "555-0525")], emails: [mkE("Principal", "dchen@email.com"), mkE("Esposa", "lisa.chen@email.com")], addresses: [mkA("Casa", "900 Harbor Blvd, SF CA"), mkA("Trabajo", "1 Market St, SF CA")], contractDate: "2016-06-30", dueDate: "2025-06-30", contractYears: 15, yearsElapsed: 9, totalPoints: 90000, pointsUsedToDate: 60000, annualPoints: 15000, paidPoints: 12000, balance: 14250, status: "Partial", contractStatus: "Active", assignedGestor: "gestor2", savedPoints: [], comments: [mkC("Pago parcial, liquidará resto en junio", "gestor2", "2025-03-11")] },
  { id: 6, contractNo: "C-2021-006", name: "Thomas Whitfield", phones: [mkP("Celular", "555-0606"), mkP("Oficina", "555-0616")], emails: [mkE("Principal", "twhitfield@email.com")], addresses: [mkA("Casa", "33 Birch Lane, Denver CO")], contractDate: "2021-09-12", dueDate: "2025-09-12", contractYears: 10, yearsElapsed: 4, totalPoints: 36000, pointsUsedToDate: 18000, annualPoints: 6000, paidPoints: 6000, balance: 0, status: "Active", contractStatus: "Active", assignedGestor: "gestor2", savedPoints: [], comments: [] },
  { id: 7, contractNo: "C-2019-007", name: "Amira Hassan", phones: [mkP("Celular", "555-0707"), mkP("Hijo 1", "555-0727")], emails: [mkE("Principal", "ahassan@email.com"), mkE("Trabajo", "a.hassan@clinic.com")], addresses: [mkA("Casa", "211 Desert Rose Dr, Phoenix AZ"), mkA("Trabajo", "3030 N 3rd St, Phoenix AZ")], contractDate: "2019-04-03", dueDate: "2025-01-03", contractYears: 10, yearsElapsed: 6, totalPoints: 24000, pointsUsedToDate: 16000, annualPoints: 4000, paidPoints: 2000, balance: 9500, status: "Partial", contractStatus: "Active", assignedGestor: "gestor1", savedPoints: [], comments: [mkC("Acordó pago en 2 partes, pendiente 2da", "gestor1", "2025-03-06")] },
];
const INIT_R = [
  { id: 1, clientId: 2, clientName: "James Nakamura", contractNo: "C-2019-002", unitId: 2, unitName: "Suite 201", locationId: 1, locationName: "Playa", seasonId: 1, seasonName: "Alta", checkIn: "2025-07-04", checkOut: "2025-07-11", nights: 7, pointsUsed: 2184, status: "Confirmed", processedBy: "gestor1" },
  { id: 2, clientId: 4, clientName: "Patricia Okonkwo", contractNo: "C-2020-004", unitId: 1, unitName: "Studio 101", locationId: 2, locationName: "Montaña", seasonId: 2, seasonName: "Media", checkIn: "2025-08-14", checkOut: "2025-08-21", nights: 7, pointsUsed: 686, status: "Confirmed", processedBy: "gestor1" },
  { id: 3, clientId: 6, clientName: "Thomas Whitfield", contractNo: "C-2021-006", unitId: 3, unitName: "Villa M-01", locationId: 2, locationName: "Montaña", seasonId: 2, seasonName: "Media", checkIn: "2025-09-01", checkOut: "2025-09-05", nights: 4, pointsUsed: 560, status: "Confirmed", processedBy: "gestor2" },
  { id: 4, clientId: 1, clientName: "Margaret & Robert Ellis", contractNo: "C-2018-001", unitId: 5, unitName: "PH Coral", locationId: 1, locationName: "Playa", seasonId: 1, seasonName: "Alta", checkIn: "2025-12-22", checkOut: "2025-12-29", nights: 7, pointsUsed: 4550, status: "Waitlisted", processedBy: "gestor2" },
];
const INIT_P = [
  { id: 1, clientId: 2, clientName: "James Nakamura", contractNo: "C-2019-002", date: "2025-01-15", amount: 38000, points: 8000, method: "ACH", costPct: 0.25, note: "Pago anual completo", status: "Liquidado", processedBy: "gestor1", processedByCajero: "cajero1", type: "maintenance", agentCommission: 760 },
  { id: 2, clientId: 4, clientName: "Patricia Okonkwo", contractNo: "C-2020-004", date: "2025-02-01", amount: 16625, points: 3500, method: "Tarjeta Créd.", costPct: 3.5, note: "Pago anual completo", status: "Liquidado", processedBy: "gestor1", processedByCajero: "cajero1", type: "maintenance", agentCommission: 332.5 },
  { id: 3, clientId: 1, clientName: "Margaret & Robert Ellis", contractNo: "C-2018-001", date: "2025-02-20", amount: 19000, points: 4000, method: "Cheque", costPct: 0.8, note: "Pago parcial 4000 pts", status: "Liquidado", processedBy: "gestor1", processedByCajero: "cajero1", type: "maintenance", agentCommission: 380 },
  { id: 4, clientId: 5, clientName: "David & Lisa Chen", contractNo: "C-2016-005", date: "2025-03-10", amount: 57000, points: 12000, method: "Transferencia", costPct: 0.5, note: "Pago parcial 12000 pts", status: "Liquidado", processedBy: "gestor2", processedByCajero: "cajero1", type: "maintenance", agentCommission: 1140 },
  { id: 5, clientId: 6, clientName: "Thomas Whitfield", contractNo: "C-2021-006", date: "2025-01-28", amount: 28500, points: 6000, method: "ACH", costPct: 0.25, note: "Pago anual completo", status: "Liquidado", processedBy: "gestor2", processedByCajero: "cajero1", type: "maintenance", agentCommission: 570 },
  { id: 6, clientId: 7, clientName: "Amira Hassan", contractNo: "C-2019-007", date: "2025-03-05", amount: 9500, points: 2000, method: "Tarjeta Créd.", costPct: 3.5, note: "Pago parcial", status: "Liquidado", processedBy: "gestor2", processedByCajero: "cajero1", type: "maintenance", agentCommission: 190 },
];
// ── BASE COMPONENTS ─────────────────────────────────────────────────────────
const Bdg = ({ l }) => { const c = sc(l); return <span style={{ background: c + "1a", color: c, border: `1px solid ${c}33`, borderRadius: 4, padding: "2px 7px", fontSize: 10, fontWeight: 700, textTransform: "uppercase", whiteSpace: "nowrap" }}>{l}</span>; };
const RBdg = ({ r }) => { const m = RM[r] || {}; return <span style={{ background: m.c + "1a", color: m.c, border: `1px solid ${m.c}33`, borderRadius: 4, padding: "2px 7px", fontSize: 10, fontWeight: 700, textTransform: "uppercase" }}>{m.l}</span>; };
const Kpi = ({ label, value, sub, accent, warn }) => (
  <div style={{ background: BG2, border: `1px solid ${warn ? R + "44" : BD}`, borderRadius: 10, padding: "14px 16px", flex: "1 1 140px", borderLeft: `3px solid ${accent || B}` }}>
    <div style={{ fontSize: 9, color: T4, letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
    <div style={{ fontSize: 20, fontWeight: 800, color: warn ? R : T1, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    {sub && <div style={{ fontSize: 9, color: T4, marginTop: 2 }}>{sub}</div>}
  </div>
);
const Sec = ({ t, a }) => (<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 11 }}><h2 style={{ margin: 0, fontSize: 9, fontWeight: 700, color: T4, letterSpacing: ".12em", textTransform: "uppercase" }}>{t}</h2>{a}</div>);
function Btn({ label, onClick, variant = "primary", small, disabled }) {
  const V = { primary: { bg: IND, col: "#fff", bd: "none" }, ghost: { bg: "transparent", col: T3, bd: `1px solid ${BD}` }, danger: { bg: R + "12", col: R, bd: `1px solid ${R}28` }, success: { bg: G + "12", col: G, bd: `1px solid ${G}28` }, warning: { bg: Y + "12", col: Y, bd: `1px solid ${Y}28` }, purple: { bg: P + "12", col: P, bd: `1px solid ${P}28` } }[variant] || {};
  return <button onClick={!disabled ? onClick : undefined} style={{ background: disabled ? "#0d1825" : V.bg, color: disabled ? "#1a2e4a" : V.col, border: V.bd, borderRadius: 6, padding: small ? "3px 9px" : "7px 13px", fontSize: small ? 10 : 12, fontWeight: 600, cursor: disabled ? "default" : "pointer", fontFamily: "inherit", opacity: disabled ? 0.5 : 1, whiteSpace: "nowrap" }}>{label}</button>;
}
function Inp({ label, value, onChange, type = "text", opts, readOnly }) {
  return (<div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
    {label && <label style={{ fontSize: 9, color: T4, letterSpacing: ".08em", textTransform: "uppercase" }}>{label}</label>}
    {opts ? <select value={value} onChange={e => onChange(e.target.value)} style={IS} disabled={readOnly}>{opts.map(o => <option key={o.v ?? o} value={o.v ?? o}>{o.l ?? o}</option>)}</select>
      : <input type={type} value={value} onChange={e => onChange(e.target.value)} style={IS} readOnly={readOnly} />}
  </div>);
}
function Modal({ title, onClose, children, wide }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "#000000d0", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", padding: 12 }}>
      <div style={{ background: BG2, border: `1px solid ${BD}`, borderRadius: 14, padding: 22, width: "100%", maxWidth: wide ? 740 : 520, maxHeight: "94vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <h3 style={{ margin: 0, color: T1, fontSize: 14, fontWeight: 700 }}>{title}</h3>
          <Btn label="✕" onClick={onClose} variant="ghost" small />
        </div>
        {children}
      </div>
    </div>
  );
}
function Tbl({ cols, rows }) { return (<div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}><thead><tr style={{ borderBottom: `1px solid ${BD}` }}>{cols.map(c => <th key={c} style={{ padding: "7px 9px", color: T4, fontWeight: 600, fontSize: 9, textAlign: "left", textTransform: "uppercase", letterSpacing: ".08em", whiteSpace: "nowrap" }}>{c}</th>)}</tr></thead><tbody>{rows}</tbody></table></div>); }
const td = (e = {}) => ({ padding: "8px 9px", ...e });
const tW = () => td({ color: T1, fontWeight: 600 });
const tS = () => td({ color: T4, fontSize: 10 });
const tBs = () => td({ color: B, fontSize: 10 });
const tG3 = () => td({ color: T3 });
const tPs = () => td({ color: P, fontSize: 10 });
const tFl = () => td({ display: "flex", gap: 5 });
const tY = () => td({ color: Y });
const tG = () => td({ color: G });
const tP = () => td({ color: P });
const tBb = () => td({ color: B, fontWeight: 700 });
const tRb = () => td({ color: R, fontWeight: 700 });
const tYs = () => td({ color: Y, fontSize: 10 });
const tG3s = () => td({ color: T3, fontSize: 10 });
const tT2 = () => td({ color: T2 });
const tW11 = () => td({ color: T1, fontWeight: 600, fontSize: 11 });
const tW12 = () => td({ color: T1, fontWeight: 600, fontSize: 12 });
const tGb = () => td({ color: G, fontWeight: 700 });
function SearchBox({ clients, onSelect, selectedId }) {
  const [q, setQ] = useState("");
  const found = useMemo(() => { if (!q || q.length < 2) return []; const ql = q.toLowerCase(); return clients.filter(c => c.name.toLowerCase().includes(ql) || c.contractNo.toLowerCase().includes(ql) || (c.phones || []).some(p => p.number.includes(q))).slice(0, 8); }, [q, clients]);
  const sel = clients.find(c => c.id === selectedId);
  return (<div style={{ position: "relative" }}>
    {sel ? (<div style={{ background: BG3, border: `1px solid ${G}44`, borderRadius: 6, padding: "7px 10px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <span style={{ color: T1, fontWeight: 600 }}>{sel.name}<span style={{ color: T3, fontSize: 10, marginLeft: 8 }}>{sel.contractNo}</span></span>
      <Btn label="✕" variant="ghost" small onClick={() => { onSelect(null); setQ(""); }} />
    </div>) : (
      <>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Nombre, Nº contrato, teléfono…" style={IS} />
        {found.length > 0 && <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: BG3, border: `1px solid ${BD}`, borderRadius: 7, zIndex: 50, marginTop: 2 }}>
          {found.map(c => {
            const d = dOvr(c.dueDate); const cl = cDelEx(c.balance, d); return (
              <div key={c.id} onClick={() => { onSelect(c.id); setQ(""); }} style={{ padding: "8px 12px", cursor: "pointer", borderBottom: `1px solid ${BD}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ color: T1, fontWeight: 600, fontSize: 12 }}>{c.name}<span style={{ color: T3, fontSize: 10, marginLeft: 8 }}>{c.contractNo}</span></span>
                <div style={{ display: "flex", gap: 6 }}><Bdg l={cl.l} />{c.balance > 0 && <span style={{ color: R, fontSize: 10, fontWeight: 700 }}>{f$(c.balance)}</span>}</div>
              </div>
            );
          })}
        </div>}
      </>
    )}
  </div>);
}
// ── LOGIN ───────────────────────────────────────────────────────────────────
function Login({ onLogin, users }) {
  const [u, setU] = useState(""),
    [pw, setPw] = useState(""),
    [err, setErr] = useState(""),
    [loading, setLoading] = useState(false);

  const doLogin = async () => {
    if (!u || !pw) return;
    setLoading(true);
    setErr("");
    try {
      // Buscar usuario en Supabase
      const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('username', u.trim())
        .eq('is_active', true)
        .single();

      if (error || !data) {
        setErr("Usuario no encontrado");
        setLoading(false);
        return;
      }

      // Por ahora verificamos contra los usuarios hardcoded como respaldo
      // Cuando tengamos bcrypt en el servidor esto cambiará
      const localUser = users.find(x => x.username === u.trim() && x.password === pw);
      if (!localUser) {
        setErr("Contraseña incorrecta");
        setLoading(false);
        return;
      }

      // Login exitoso — usar datos de Supabase
      onLogin({
        id: data.id,
        username: data.username,
        name: data.full_name,
        role: data.role,
        color: data.color_hex,
        salary: data.monthly_salary,
      });
    } catch (e) {
      setErr("Error de conexión");
    }
    setLoading(false);
  };

  return (
    <div style={{ minHeight: "100vh", background: BG, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: 340, background: BG2, border: `1px solid ${BD}`, borderRadius: 16, padding: 36 }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ width: 52, height: 52, background: "linear-gradient(135deg,#1d4ed8,#7c3aed)", borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, margin: "0 auto 10px" }}>◈</div>
          <div style={{ color: T1, fontWeight: 800, fontSize: 16, letterSpacing: ".1em" }}>POINTSUITE</div>
          <div style={{ color: T4, fontSize: 9, letterSpacing: ".15em" }}>MEMBERSHIP MANAGEMENT SYSTEM</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div><div style={{ fontSize: 9, color: T4, textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 4 }}>Usuario</div>
            <input value={u} onChange={e => setU(e.target.value)} onKeyDown={e => e.key === "Enter" && doLogin()}
              style={{ ...IS, fontSize: 13 }} autoFocus />
          </div>
          <div><div style={{ fontSize: 9, color: T4, textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 4 }}>Contraseña</div>
            <input type="password" value={pw} onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === "Enter" && doLogin()}
              style={{ ...IS, fontSize: 13 }} />
          </div>
          {err && <div style={{ color: R, fontSize: 11, textAlign: "center" }}>{err}</div>}
          <button onClick={doLogin} disabled={loading}
            style={{ background: loading ? "#334155" : IND, color: "#fff", border: "none", borderRadius: 8, padding: "10px", fontSize: 13, fontWeight: 700, cursor: loading ? "wait" : "pointer", marginTop: 4, fontFamily: "inherit" }}>
            {loading ? "Verificando..." : "Entrar →"}
          </button>
        </div>

      </div></div>
  );
}
// ── CONTACT COMPONENTS ───────────────────────────────────────────────────────
const PL = ["Esposo", "Esposa", "Celular", "Casa", "Oficina", "Hijo 1", "Hijo 2", "Hijo 3", "Otro"];
const EL = ["Principal", "Esposo", "Esposa", "Trabajo", "Hijo 1", "Hijo 2", "Otro"];
const AL = ["Casa", "Dirección 2", "Trabajo", "Vacaciones", "Otro"];
function ContactList({ title, items, onAdd, onToggle, labels, field, readOnly }) {
  const [nv, setNv] = useState(""), [nl, setNl] = useState(labels[0]);
  return (<div style={{ background: BG, borderRadius: 8, padding: "11px 13px", border: `1px solid ${BD}` }}>
    <div style={{ fontSize: 9, color: T4, textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 9, display: "flex", justifyContent: "space-between" }}>
      <span>{title}</span><span style={{ color: T3 }}>{items.filter(i => i.active !== false).length} activos</span>
    </div>
    {items.map((item, i) => (<div key={i} style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 5, opacity: item.active === false ? .4 : 1 }}>
      <span style={{ fontSize: 9, color: T3, width: 68, flexShrink: 0, background: BG3, borderRadius: 4, padding: "2px 5px", textAlign: "center" }}>{item.label}</span>
      <span style={{ color: item.active === false ? T3 : T2, fontSize: 12, flex: 1, fontFamily: "monospace" }}>{item[field]}</span>
      {!readOnly && (item.active === false ? <Btn label="↩" variant="success" small onClick={() => onToggle(i)} /> : <Btn label="F/S" variant="danger" small onClick={() => onToggle(i)} />)}
    </div>))}
    {!readOnly && <div style={{ display: "flex", gap: 5, marginTop: 7, alignItems: "flex-end" }}>
      <select value={nl} onChange={e => setNl(e.target.value)} style={{ ...IS, width: 100, fontSize: 11 }}>{labels.map(l => <option key={l}>{l}</option>)}</select>
      <input value={nv} onChange={e => setNv(e.target.value)} placeholder={`Nuevo…`} style={{ ...IS, flex: 1, fontSize: 11 }} onKeyDown={e => { if (e.key === "Enter" && nv.trim()) { onAdd(nl, nv.trim()); setNv(""); setNl(labels[0]); } }} />
      <Btn label="+" small onClick={() => { if (nv.trim()) { onAdd(nl, nv.trim()); setNv(""); setNl(labels[0]); } }} />
    </div>}
  </div>);
}
function Comments({ comments, onAdd, cu }) {
  const [t, setT] = useState("");
  const sorted = [...(comments || [])].sort((a, b) => b.id - a.id);
  return (<div style={{ background: BG, borderRadius: 8, padding: "11px 13px", border: `1px solid ${BD}` }}>
    <div style={{ fontSize: 9, color: T4, textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 9 }}>Comentarios ({sorted.length})</div>
    {sorted.map(c => (<div key={c.id} style={{ background: BG3, borderRadius: 6, padding: "8px 10px", marginBottom: 6, borderLeft: `2px solid ${BD}` }}>
      <div style={{ color: T2, fontSize: 12, marginBottom: 3, lineHeight: 1.5 }}>{c.text}</div>
      <div style={{ color: T4, fontSize: 9 }}>{c.by} · {c.date}</div>
    </div>))}
    {sorted.length === 0 && <div style={{ color: T4, fontSize: 11, marginBottom: 8 }}>Sin comentarios</div>}
    <div style={{ display: "flex", gap: 7, marginTop: 7 }}>
      <textarea value={t} onChange={e => setT(e.target.value)} placeholder="Agregar comentario…" rows={2} style={{ ...IS, flex: 1, fontSize: 11, resize: "vertical", fontFamily: "inherit" }} />
      <Btn label="+" small onClick={() => { if (!t.trim()) return; onAdd({ id: Date.now() + Math.random(), text: t.trim(), by: cu.username, date: new Date().toISOString().split("T")[0] }); setT(""); }} />
    </div>
  </div>);
}
// ── CLIENT MODAL ─────────────────────────────────────────────────────────────
function ClientModal({ client, onSave, onClose, pp, cu, onAddPhone, onSetPhoneActive, onAddEmail, onSetEmailActive, onAddAddress, onSetAddressActive, onAddComment }) {
  const isAdmin = ["superadmin", "admin"].includes(cu?.role);
  const blank = { contractNo: "", name: "", contractDate: "", dueDate: "", contractYears: 10, yearsElapsed: 0, totalPoints: 0, pointsUsedToDate: 0, paidPoints: 0, balance: 0, status: "Active", contractStatus: "Active", assignedGestor: "", phones: [], emails: [], addresses: [], comments: [], savedPoints: [] };
  const [f, setF] = useState(client || blank);
  const set = k => v => setF(x => ({ ...x, [k]: v }));
  const yr = Math.max(1, (f.contractYears || 1) - (f.yearsElapsed || 0));
  const cAP = calcAP(f.totalPoints || 0, f.pointsUsedToDate || 0, yr);
  const cBal = Math.max(0, (cAP - (f.paidPoints || 0)) * pp);
  // Add phones/emails/addresses → Llamar handlers de BD si existe el cliente
  const addPh = (l, n) => {
    set("phones")([...(f.phones || []), { label: l, number: n, active: true }]);
    if (client && onAddPhone) onAddPhone(client.id, l, n);
  };
  const addEm = (l, e) => {
    set("emails")([...(f.emails || []), { label: l, email: e, active: true }]);
    if (client && onAddEmail) onAddEmail(client.id, l, e);
  };
  const addAd = (l, t) => {
    set("addresses")([...(f.addresses || []), { label: l, text: t, active: true }]);
    if (client && onAddAddress) onAddAddress(client.id, l, t);
  };
  const togPh = i => {
    const item = f.phones[i];
    set("phones")(f.phones.map((p, x) => x === i ? { ...p, active: p.active === false ? true : false } : p));
    if (client && onSetPhoneActive && item.id) onSetPhoneActive(item.id, item.active === false);
  };
  const togEm = i => {
    const item = f.emails[i];
    set("emails")(f.emails.map((e, x) => x === i ? { ...e, active: e.active === false ? true : false } : e));
    if (client && onSetEmailActive && item.id) onSetEmailActive(item.id, item.active === false);
  };
  const togAd = i => {
    const item = f.addresses[i];
    set("addresses")(f.addresses.map((a, x) => x === i ? { ...a, active: a.active === false ? true : false } : a));
    if (client && onSetAddressActive && item.id) onSetAddressActive(item.id, item.active === false);
  };
  const addCm = c => {
    set("comments")([...(f.comments || []), c]);
    if (client && onAddComment) onAddComment(client.id, c.text || c.body || c);
  };
  if (!isAdmin && client) {
    return (<Modal title={`+ Info — ${client.name}`} onClose={onClose} wide>
      <div style={{ background: Y + "14", border: `1px solid ${Y}28`, borderRadius: 7, padding: "9px 12px", marginBottom: 13, fontSize: 11, color: Y }}>Como gestor solo puedes agregar. No puedes modificar ni eliminar datos existentes.</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <ContactList title="Teléfonos" items={f.phones} onAdd={addPh} onToggle={togPh} labels={PL} field="number" readOnly={false} />
        <ContactList title="Correos" items={f.emails} onAdd={addEm} onToggle={togEm} labels={EL} field="email" readOnly={false} />
        <ContactList title="Direcciones" items={f.addresses} onAdd={addAd} onToggle={togAd} labels={AL} field="text" readOnly={false} />
        <Comments comments={f.comments} onAdd={addCm} cu={cu} />
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 13 }}>
        <Btn label="Cancelar" variant="ghost" onClick={onClose} />
        <Btn label="Guardar" onClick={() => onSave({ ...client, phones: f.phones, emails: f.emails, addresses: f.addresses, comments: f.comments })} />
      </div>
    </Modal>);
  }
  return (<Modal title={client ? "Editar Cliente" : "Nuevo Cliente"} onClose={onClose} wide>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
      <Inp label="Nº Contrato" value={f.contractNo} onChange={set("contractNo")} />
      <Inp label="Estado contrato" value={f.contractStatus} onChange={set("contractStatus")} opts={["Active", "Cancelado s/pago", "Cancelado c/pago"]} />
      <div style={{ gridColumn: "1/-1" }}><Inp label="Nombre completo" value={f.name} onChange={set("name")} /></div>
      <Inp label="Fecha contrato" type="date" value={f.contractDate} onChange={set("contractDate")} />
      <Inp label="Vencimiento pago" type="date" value={f.dueDate} onChange={set("dueDate")} />
      <Inp label="Pts pagados este año" type="number" value={f.paidPoints} onChange={v => set("paidPoints")(+v)} />
      <Inp label="Estado cuenta" value={f.status} onChange={set("status")} opts={["Active", "Partial", "Delinquent"]} />
    </div>
    <div style={{ background: BG3, border: `1px solid ${BD}`, borderRadius: 8, padding: "12px", marginBottom: 12 }}>
      <div style={{ fontSize: 9, color: T4, textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 9 }}>Plazo y Puntos</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 9, marginBottom: 9 }}>
        <Inp label="Plazo total (años)" type="number" value={f.contractYears || 10} onChange={v => set("contractYears")(Math.max(1, +v))} />
        <Inp label="Años transcurridos" type="number" value={f.yearsElapsed || 0} onChange={v => set("yearsElapsed")(Math.max(0, +v))} readOnly={!!client} />
        <Inp label="Pts totales" type="number" value={f.totalPoints || 0} onChange={v => set("totalPoints")(+v)} />
        <Inp label="Pts usados (hist.)" type="number" value={f.pointsUsedToDate || 0} onChange={v => set("pointsUsedToDate")(+v)} readOnly={!!client} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8 }}>
        {[["Años rest.", yr, B], ["Pts rest.", fP((f.totalPoints || 0) - (f.pointsUsedToDate || 0)), P], ["Pts/año", fP(cAP), Y], ["Saldo", f$(cBal), cBal > 0 ? R : G]].map(([l, v, c]) => (
          <div key={l} style={{ background: BG, borderRadius: 6, padding: "7px 9px" }}><div style={{ fontSize: 8, color: T4, textTransform: "uppercase", marginBottom: 2 }}>{l}</div><div style={{ color: c, fontWeight: 700, fontSize: 13 }}>{v}</div></div>
        ))}
      </div>
    </div>
    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 }}>
      <ContactList title="Teléfonos" items={f.phones} onAdd={addPh} onToggle={togPh} labels={PL} field="number" readOnly={false} />
      <ContactList title="Correos" items={f.emails} onAdd={addEm} onToggle={togEm} labels={EL} field="email" readOnly={false} />
      <ContactList title="Direcciones" items={f.addresses} onAdd={addAd} onToggle={togAd} labels={AL} field="text" readOnly={false} />
      <Comments comments={f.comments} onAdd={addCm} cu={cu} />
    </div>
    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
      <Btn label="Cancelar" variant="ghost" onClick={onClose} />
      <Btn label="Guardar" onClick={() => onSave({ ...f, yearsRemaining: yr, annualPoints: cAP, balance: cBal })} />
    </div>
  </Modal>);
}

// ── CONTACTS PANEL — agregar / desactivar / activar (sin borrar ni editar) ─
function ContactsPanel({ selC, cu, onAddPhone, onSetPhoneActive, onAddEmail, onSetEmailActive, onAddAddress, onSetAddressActive }) {
  const [add, setAdd] = useState(null); // 'phones' | 'emails' | 'addresses'
  const [label, setLabel] = useState("");
  const [val, setVal] = useState("");
  const reset = () => { setAdd(null); setLabel(""); setVal(""); };
  const submit = () => {
    if (!label.trim() || !val.trim()) return;
    if (add === "phones" && onAddPhone) onAddPhone(selC.id, label, val);
    if (add === "emails" && onAddEmail) onAddEmail(selC.id, label, val);
    if (add === "addresses" && onAddAddress) onAddAddress(selC.id, label, val);
    reset();
  };
  const sections = [
    { key: "phones", title: "Teléfonos", items: selC.phones || [], field: "number", setActive: onSetPhoneActive, placeholder: "555-1234" },
    { key: "emails", title: "Correos", items: selC.emails || [], field: "email", setActive: onSetEmailActive, placeholder: "user@example.com" },
    { key: "addresses", title: "Direcciones", items: selC.addresses || [], field: "text", setActive: onSetAddressActive, placeholder: "Calle 123, Col., Ciudad" },
  ];
  return (<div>
    {sections.map(s => (
      <div key={s.key} style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
          <div style={{ fontSize: 9, color: T4, textTransform: "uppercase" }}>{s.title}</div>
          <Btn label="+ Agregar" small variant="ghost" onClick={() => { setAdd(s.key); setLabel(""); setVal(""); }} />
        </div>
        {s.items.map((it) => (<div key={it.id || it.label + it[s.field]} style={{ display: "flex", gap: 7, padding: "5px 0", borderBottom: `1px solid ${BG3}`, opacity: it.active === false ? .4 : 1, alignItems: "center" }}>
          <span style={{ fontSize: 9, color: T3, width: 68, flexShrink: 0, background: BG3, borderRadius: 4, padding: "2px 5px", textAlign: "center" }}>{it.label}</span>
          <span style={{ color: T2, fontSize: 11, flex: 1, fontFamily: s.field === "text" ? "inherit" : "monospace" }}>{it[s.field]}</span>
          {it.active === false && <span style={{ fontSize: 9, color: R, background: R + "12", borderRadius: 4, padding: "1px 5px" }}>F/S</span>}
          {it.id && <Btn label={it.active === false ? "↻" : "✗"} variant={it.active === false ? "success" : "ghost"} small onClick={() => s.setActive && s.setActive(it.id, !(it.active !== false))} />}
        </div>))}
        {s.items.length === 0 && <div style={{ color: T4, fontSize: 10, padding: "5px 0", textAlign: "center" }}>Sin {s.title.toLowerCase()}</div>}
        {add === s.key && (
          <div style={{ background: BG3, borderRadius: 6, padding: 8, marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
            <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Etiqueta (ej. Casa)" style={{ ...IS, fontSize: 11, padding: "4px 6px", flex: "0 0 110px" }} />
            <input value={val} onChange={e => setVal(e.target.value)} placeholder={s.placeholder} style={{ ...IS, fontSize: 11, padding: "4px 6px", flex: 1 }} />
            <Btn label="Guardar" small variant="success" onClick={submit} />
            <Btn label="Cancelar" small variant="ghost" onClick={reset} />
          </div>
        )}
      </div>
    ))}
    <div style={{ fontSize: 9, color: T4, marginTop: 10, fontStyle: "italic" }}>
      ✓ Cualquier rol puede agregar nueva información o marcar como vigente/no vigente.
      <br />⚠ La información existente NO se puede editar ni borrar.
    </div>
  </div>);
}

// ── COMMENTS PANEL — agregar (sin editar/borrar existentes) ─
function CommentsPanel({ selC, cu, onAddComment }) {
  const [text, setText] = useState("");
  const submit = () => {
    if (!text.trim() || !onAddComment) return;
    onAddComment(selC.id, text.trim());
    setText("");
  };
  return (<div>
    <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
      <input value={text} onChange={e => setText(e.target.value)} placeholder="Escribe un comentario..." style={{ ...IS, fontSize: 11 }} />
      <Btn label="+ Agregar" small variant="success" onClick={submit} disabled={!text.trim()} />
    </div>
    {[...(selC.comments || [])].sort((a, b) => (b.id || 0) - (a.id || 0)).map(c => (<div key={c.id || c.date} style={{ background: BG3, borderRadius: 6, padding: "9px 11px", marginBottom: 7, borderLeft: `2px solid ${T4}` }}>
      <div style={{ color: T2, fontSize: 12, marginBottom: 4, lineHeight: 1.5 }}>{c.text || c.body}</div>
      <div style={{ color: T4, fontSize: 9 }}>
        {c.authorName || c.by || c.author || "—"} · {c.date || (c.created_at ? c.created_at.slice(0, 10) : "")}
      </div>
    </div>))}
    {(selC.comments || []).length === 0 && <div style={{ color: T4, fontSize: 11, textAlign: "center", padding: "18px 0" }}>Sin comentarios</div>}
  </div>);
}

// ── CLIENTS VIEW ─────────────────────────────────────────────────────────────
function ClientsView({ clients, setClients, pp, cu, payments, reservations, users, condonations, fxRate, onGoToCashier, onGoToRes, onSaveClient, onAddPhone, onSetPhoneActive, onAddEmail, onSetEmailActive, onAddAddress, onSetAddressActive, onAddComment, onSaveSavedPoints, onSavePromise }) {
  const [srch, setSrch] = useState(""), [filt, setFilt] = useState("All"), [sortByMora, setSortByMora] = useState(false), [sel, setSel] = useState(null), [modal, setModal] = useState(null), [dtab, setDtab] = useState("info");
  const [saveModal, setSaveModal] = useState(null);
  const [promiseModal, setPromiseModal] = useState(null); // cliente al que crear promesa
  const canEdit = ["superadmin", "admin"].includes(cu.role);
  const en = useMemo(() => clients.map(c => { const d = dOvr(c.dueDate); const cl = getClientStatus(c, payments, condonations); const interest = cInt(c.balance, d, cl.r * 12); return { ...c, dOvr: d, cls: cl, interest, totalOwed: c.balance + interest, ph: (c.phones || []).find(p => p.active !== false)?.number || "—" }; }), [clients, payments, condonations]);
  const filtered = useMemo(() => {
    const ql = srch.toLowerCase();
    // Para gestor: solo ver sus clientes asignados
    const base = cu.role === "gestor"
      ? en.filter(c => String(c.assignedGestor) === String(cu.id))
      : en;
    const result = base.filter(c => {
      const ms = !srch || c.name.toLowerCase().includes(ql) || c.contractNo.toLowerCase().includes(ql) || (c.phones || []).some(p => p.number.includes(srch)) || (c.emails || []).some(e => e.email.toLowerCase().includes(ql));
      const mf = filt === "All" || c.status === filt || (filt === "Morosos" && c.balance > 0) || (filt === "Cancelados" && c.contractStatus !== "Active");
      return ms && mf;
    });
    if (sortByMora) result.sort((a, b) => b.totalOwed - a.totalOwed);
    return result;
  }, [en, srch, filt, sortByMora, cu]);
  const selC = en.find(c => c.id === sel);
  const canEditContract = cu && (cu.role === "admin" || cu.role === "superadmin");
  const save = f => {
    if (!canEditContract) { alert("Solo admin/superadmin puede modificar datos del contrato."); return; }
    const isNew = modal === "new";
    const obj = isNew ? { ...f, id: Date.now() } : { ...f, id: modal.id };
    if (isNew) setClients(cs => [...cs, obj]);
    else setClients(cs => cs.map(c => c.id === modal.id ? obj : c));
    if (onSaveClient) onSaveClient(obj);
    setModal(null);
  };
  const exportCSV = (rows, cols, name) => { const csv = [cols, ...rows].map(r => r.join(",")).join("\n"); const a = document.createElement("a"); a.href = "data:text/csv," + encodeURIComponent(csv); a.download = name; a.click(); };
  return (<div style={{ display: "grid", gridTemplateColumns: selC ? "1fr 380px" : "1fr", gap: 14 }}>
    <div>
      {modal && <ClientModal client={modal === "new" ? null : modal} onSave={save} onClose={() => setModal(null)} pp={pp} cu={cu} onAddPhone={onAddPhone} onSetPhoneActive={onSetPhoneActive} onAddEmail={onAddEmail} onSetEmailActive={onSetEmailActive} onAddAddress={onAddAddress} onSetAddressActive={onSetAddressActive} onAddComment={onAddComment} />}
      {saveModal && <SavePointsModal client={saveModal} cu={cu} onClose={() => setSaveModal(null)} onSave={sp => {
        setClients(cs => cs.map(c => c.id === saveModal.id ? { ...c, paidPoints: c.paidPoints - sp.points, savedPoints: [...(c.savedPoints || []), sp] } : c));
        if (onSaveSavedPoints) onSaveSavedPoints(saveModal.id, sp.points, sp.maintYear, sp.note);
        setSaveModal(null);
      }} />}
      {promiseModal && <PromiseModal client={promiseModal} fxRate={fxRate} cu={cu} onClose={() => setPromiseModal(null)} onSave={pr => { if (onSavePromise) onSavePromise(pr); }} />}
      <div style={{ display: "flex", gap: 8, marginBottom: 11, flexWrap: "wrap" }}>
        <input placeholder="Nombre, Nº contrato, teléfono, email…" value={srch} onChange={e => setSrch(e.target.value)} style={{ ...IS, flex: 1, minWidth: 200 }} />
        <select value={filt} onChange={e => setFilt(e.target.value)} style={{ ...IS, width: 130 }}>{["All", "Active", "Partial", "Delinquent", "Morosos", "Cancelados"].map(s => <option key={s}>{s}</option>)}</select>
        <button onClick={() => setSortByMora(m => !m)} style={{ background: sortByMora ? R + "22" : BG2, border: `1px solid ${sortByMora ? R : BD}`, color: sortByMora ? R : T4, borderRadius: 6, padding: "4px 10px", fontSize: 10, fontWeight: sortByMora ? 700 : 400, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
          {sortByMora ? "↓ Por Mora" : "Ordenar por Mora"}
        </button>
        {canEdit && <Btn label="+ Nuevo" onClick={() => setModal("new")} />}
      </div>
      <Tbl cols={["Contrato", "Cliente", "Tel.", "Saldo", "Mora", "Vence", "Gestor", "Cto.", ""]}
        rows={filtered.map(c => (<tr key={c.id} style={{ borderBottom: `1px solid ${BG3}`, cursor: "pointer", background: sel === c.id ? BG3 : "transparent" }} onClick={() => setSel(c.id === sel ? null : c.id)}>
          <td style={td({ color: B, fontWeight: 700, fontSize: 10 })}>{c.contractNo}</td>
          <td style={tW()}>{c.name}</td>
          <td style={td({ color: T3, fontFamily: "monospace", fontSize: 11 })}>{c.ph}</td>
          <td style={td({ color: c.balance > 0 ? R : G, fontWeight: 700 })}>{f$(c.balance)}</td>
          <td style={td()}><Bdg l={c.cls.l} /></td>
          <td style={tS()}>{c.dueDate}</td>
          <td style={tPs()}>{users.find(u => String(u.id) === String(c.assignedGestor))?.name || "—"}</td>
          <td style={td()}><Bdg l={c.contractStatus} /></td>
          <td style={tFl()}>
            {canEdit && <Btn label="Editar" variant="ghost" small onClick={e => { e.stopPropagation(); setModal(c); }} />}
            {!canEdit && <Btn label="+ Info" variant="warning" small onClick={e => { e.stopPropagation(); setModal(c); }} />}
          </td>
        </tr>))} />
    </div>
    {selC && <div style={{ background: BG2, border: `1px solid ${BD}`, borderRadius: 12, padding: 16, overflowY: "auto", maxHeight: "85vh" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 11 }}>
        <span style={{ color: T1, fontWeight: 700, fontSize: 13 }}>{selC.name}</span>
        <Btn label="✕" variant="ghost" small onClick={() => setSel(null)} />
      </div>
      {(onGoToCashier || onGoToRes) && <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
        {onGoToCashier && <Btn label="💳 Pagar" onClick={() => onGoToCashier(selC.id)} />}
        {onGoToRes && <Btn label="🏨 Reservar" variant="purple" onClick={() => onGoToRes(selC.id)} />}
        {onSavePromise && <Btn label="★ Promesa" variant="success" onClick={() => setPromiseModal(selC)} />}
      </div>}
      <div style={{ display: "flex", gap: 4, marginBottom: 12, flexWrap: "wrap" }}>
        {[["info", "Info"], ["contacts", "Contacto"], ["contract", "Contrato"], ["comments", "Comentarios"], ["txhistory", "Cobros"], ["reshistory", "Reservas"]].map(([id, lbl]) => (
          <button key={id} onClick={() => setDtab(id)} style={{ background: dtab === id ? IND : BG3, color: dtab === id ? "#fff" : T3, border: `1px solid ${dtab === id ? IND : BD}`, borderRadius: 6, padding: "3px 10px", fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{lbl}</button>
        ))}
      </div>
      {dtab === "info" && <div>
        <div style={{ display: "flex", gap: 7, marginBottom: 11, flexWrap: "wrap" }}>
          <Bdg l={selC.contractStatus} /><Bdg l={selC.cls.l} />
          <Btn label="📋 Cobros" small variant="ghost" onClick={() => setDtab("txhistory")} />
          <Btn label="🏨 Reservas" small variant="ghost" onClick={() => setDtab("reshistory")} />
        </div>
        {[["Contrato", selC.contractNo], ["Vencimiento", selC.dueDate], ["Gestor", users.find(u => String(u.id) === String(selC.assignedGestor))?.name || "—"], ["Plazo", `${selC.contractYears || "—"}a (${selC.yearsElapsed || 0} transcurridos)`]].map(([l, v]) => (
          <div key={l} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: `1px solid ${BG3}` }}>
            <span style={{ color: T4, fontSize: 11 }}>{l}</span><span style={{ color: T2, fontWeight: 600, fontSize: 11 }}>{v}</span>
          </div>
        ))}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7, marginTop: 10 }}>
          {[["Pts/Año", fP(selC.annualPoints), P], ["Pts Pagados", fP(selC.paidPoints), G], ["Saldo", f$(selC.balance), selC.balance > 0 ? R : G], ["Interés Mora", f$(selC.interest), Y], ["Total Adeudado", f$(selC.totalOwed), selC.totalOwed > 0 ? R : G], ["Pts Totales", fP(selC.totalPoints), B]].map(([l, v, c]) => (
            <div key={l} style={{ background: BG3, borderRadius: 6, padding: "6px 9px" }}><div style={{ fontSize: 8, color: T4, textTransform: "uppercase", marginBottom: 2 }}>{l}</div><div style={{ color: c, fontWeight: 700, fontSize: 12 }}>{v}</div></div>
          ))}
        </div>
        <div style={{ marginTop: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
            <div style={{ fontSize: 9, color: T4, textTransform: "uppercase" }}>Puntos Guardados ({(selC.savedPoints || []).filter(sp => new Date(sp.expiryDate) > new Date()).length}/1 año)</div>
            {selC.paidPoints > 0 && (selC.savedPoints || []).filter(sp => new Date(sp.expiryDate) > new Date()).length < 1 && TODAY < new Date(CY, 6, 1) && <Btn label="+ Guardar Pts" variant="ghost" small onClick={() => setSaveModal(selC)} />}
          </div>
          {(selC.savedPoints || []).map((sp, i) => (<div key={i} style={{ background: BG3, borderRadius: 5, padding: "6px 9px", marginBottom: 3, display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: P, fontWeight: 700 }}>{fP(sp.points)}</span>
            <span style={{ color: T4, fontSize: 10 }}>Vence: {sp.expiryDate}·{sp.savedBy}</span>
          </div>))}
          {(selC.savedPoints || []).length === 0 && <div style={{ color: T4, fontSize: 10, textAlign: "center", padding: "8px 0" }}>Sin puntos guardados</div>}
        </div>
      </div>}
      {dtab === "contacts" && <ContactsPanel selC={selC} cu={cu} onAddPhone={onAddPhone} onSetPhoneActive={onSetPhoneActive} onAddEmail={onAddEmail} onSetEmailActive={onSetEmailActive} onAddAddress={onAddAddress} onSetAddressActive={onSetAddressActive} />}
      {dtab === "contract" && <div>
        {[["Plazo total", `${selC.contractYears || "—"} años`], ["Años transcurridos", selC.yearsElapsed || 0], ["Años restantes", Math.max(0, (selC.contractYears || 0) - (selC.yearsElapsed || 0))], ["Pts totales", fP(selC.totalPoints)], ["Pts usados (hist.)", fP(selC.pointsUsedToDate || 0)], ["Pts restantes", fP(Math.max(0, (selC.totalPoints || 0) - (selC.pointsUsedToDate || 0)))], ["Pts anuales", fP(selC.annualPoints)], ["Pts pagados", fP(selC.paidPoints)]].map(([l, v]) => (
          <div key={l} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: `1px solid ${BG3}` }}>
            <span style={{ color: T4, fontSize: 11 }}>{l}</span><span style={{ color: T2, fontWeight: 600, fontSize: 11 }}>{v}</span>
          </div>
        ))}
      </div>}
      {dtab === "comments" && <CommentsPanel selC={selC} cu={cu} onAddComment={onAddComment} />}
      {dtab === "txhistory" && (() => {
        const cP = [...payments].filter(p => p.clientId === selC.id).sort((a, b) => b.id - a.id);
        const exp = () => exportCSV([["Fecha", "Monto", "Pts", "Concepto", "Método", "Gestor"], ...cP.map(p => [p.date, p.amount, p.points, p.type, p.method, p.processedBy])], [], "cobros_" + selC.contractNo + ".csv");
        return (<div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 9 }}><span style={{ fontSize: 10, color: T3 }}>{cP.length} transacciones</span><Btn label="⬇ CSV" small variant="ghost" onClick={exp} /></div>
          {cP.length === 0 ? <div style={{ color: T4, fontSize: 11, textAlign: "center", padding: "18px 0" }}>Sin transacciones</div> : cP.map(p => (<div key={p.id} style={{ background: BG3, borderRadius: 6, padding: "8px 10px", marginBottom: 5 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}><span style={{ color: T1, fontWeight: 600, fontSize: 12 }}>{f$(p.amount)}</span>{p.points > 0 && <span style={{ color: G, fontSize: 11 }}>{fP(p.points)}</span>}</div>
            <div style={{ fontSize: 9, color: T4 }}>{p.date}·{p.type}·{p.method}·{p.processedBy}</div>
            {p.note && <div style={{ fontSize: 9, color: T3, marginTop: 2 }}>{p.note}</div>}
          </div>))}
        </div>);
      })()}
      {dtab === "reshistory" && (() => {
        const cR = [...reservations].filter(r => r.clientId === selC.id).sort((a, b) => b.id - a.id);
        const usedP = cR.filter(r => r.status === "Confirmed").reduce((a, r) => a + r.pointsUsed, 0);
        const avail = selC.paidPoints - usedP + ((selC.savedPoints || []).filter(sp => new Date(sp.expiryDate) > new Date()).reduce((a, sp) => a + sp.points, 0));
        const exp = () => exportCSV([["Folio", "Unidad", "Ubicación", "Entrada", "Salida", "Pts", "Estado"], ...cR.map(r => ["RES-" + r.id, r.unitName, r.locationName, r.checkIn, r.checkOut, r.pointsUsed, r.status])], [], "reservas_" + selC.contractNo + ".csv");
        return (<div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 9 }}>
            <span style={{ color: G, fontSize: 10, fontWeight: 700 }}>{avail.toLocaleString()} pts disponibles</span>
            <Btn label="⬇ CSV" small variant="ghost" onClick={exp} />
          </div>
          {cR.length === 0 ? <div style={{ color: T4, fontSize: 11, textAlign: "center", padding: "18px 0" }}>Sin reservaciones</div> : cR.map(r => (<div key={r.id} style={{ background: BG3, borderRadius: 6, padding: "8px 10px", marginBottom: 5 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}><span style={{ color: T1, fontWeight: 600, fontSize: 12 }}>{r.unitName}·{r.locationName}</span><Bdg l={r.status} /></div>
            <div style={{ fontSize: 10, color: B, marginBottom: 2 }}>{r.checkIn}→{r.checkOut}·{r.nights}n·{r.pointsUsed.toLocaleString()} pts</div>
            <div style={{ fontSize: 9, color: T4 }}>RES-{r.id}·{r.seasonName}·{r.processedBy}</div>
          </div>))}
        </div>);
      })()}
    </div>}
  </div>);
}
// ── CASHIER ──────────────────────────────────────────────────────────────────
// Modal para guardar puntos pagados al año siguiente (vence 31 ene del año+1, máx 2 años acum)
function SavePointsModal({ client, onSave, onClose, cu }) {
  // Reglas: (1) mantenimiento pagado, (2) antes del 1 julio, (3) máximo 1 año guardado
  const maxToSave = client.paidPoints; // Solo se pueden guardar los pagados
  const [pts, setPts] = useState(maxToSave);
  const [note, setNote] = useState("");
  // Los puntos guardados vencen el 31 de diciembre del año SIGUIENTE
  const expiry = new Date(CY + 1, 11, 31).toISOString().split("T")[0];
  // ¿Ya pasó el 1 de julio? Entonces ya no se puede guardar
  const july1 = new Date(CY, 6, 1); // 1 julio año actual
  const beforeJuly = TODAY < july1;
  // Regla: máximo 1 año de puntos guardados a la vez
  const yearsGuard = (client.savedPoints || []).filter(sp => new Date(sp.expiryDate) > new Date()).length;
  const canSave = beforeJuly && yearsGuard < 1 && pts > 0 && pts <= maxToSave;
  return (<Modal title={`Guardar Puntos — ${client.name}`} onClose={onClose}>
    <div style={{ background: BG3, borderRadius: 7, padding: "10px 12px", marginBottom: 12, fontSize: 11, color: T3 }}>
      <div>Puntos pagados disponibles: <b style={{ color: G }}>{fP(maxToSave)}</b></div>
      <div>Años ya guardados: <b style={{ color: yearsGuard >= 1 ? R : P }}>{yearsGuard}/1</b></div>
      <div>Los puntos guardados vencen el <b style={{ color: Y }}>{expiry}</b> (31 dic del año siguiente).</div>
      <div>Fecha límite para guardar: <b style={{ color: Y }}>30 Jun {CY}</b></div>
    </div>
    {!beforeJuly && <div style={{ color: R, fontSize: 11, marginBottom: 10 }}>⚠ Ya pasó el 1 de julio. No se pueden guardar puntos este año.</div>}
    {yearsGuard >= 1 && <div style={{ color: R, fontSize: 11, marginBottom: 10 }}>⚠ El cliente ya tiene puntos guardados de otro año. No puede guardar más (límite de 1 año).</div>}
    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      <Inp label="Puntos a guardar" value={pts} onChange={v => setPts(Math.min(maxToSave, Math.max(0, +v)))} type="number" />
      <Inp label="Notas" value={note} onChange={setNote} />
    </div>
    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 13 }}>
      <Btn label="Cancelar" variant="ghost" onClick={onClose} />
      <Btn label="Guardar Puntos" onClick={() => onSave({ points: pts, expiryDate: expiry, note, savedBy: cu.username, savedDate: TOD })} disabled={!canSave} />
    </div>
  </Modal>);
}

const PT = [
  { v: "maintenance", l: "Mantenimiento anual", pts: true },
  { v: "prepago_maintenance", l: "Mantenimiento adelantado (Prepago)", pts: true },
  { v: "point_purchase", l: "Compra puntos (uso inmediato)", pts: true },
  { v: "cancellation_payment", l: "Liquidación / cancelación contrato", pts: false },
  { v: "moratorios", l: "Moratorios (intereses por mora)", pts: false },
];
// Auto-elimina pagos pendientes de validación al final del día y promesas del mes sin cumplir
function autoCleanup(pending, promises, setPending, setPromises) {
  const now = new Date(); const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  // Pagos pendientes que ya pasaron el día de creación: eliminar
  const expired = pending.filter(p => { const d = new Date(p.submittedAt); return d < new Date(now.getFullYear(), now.getMonth(), now.getDate()); });
  if (expired.length > 0) setTimeout(() => setPending(ps => ps.filter(p => !expired.find(e => e.id === p.id))), 0);
  // Promesas de meses pasados sin cumplir: eliminar
  const expiredProm = promises.filter(p => p.status === "Pendiente" && p.promiseDate && p.promiseDate.slice(0, 7) < TOM);
  if (expiredProm.length > 0) setTimeout(() => setPromises(ps => ps.filter(p => !expiredProm.find(e => e.id === p.id))), 0);
}
// Gestor de cobranza envía propuesta; cajero valida o elimina
function FxRateEditor({ fxRate, setFxRate, onSaveFxRate }) {
  const [draft, setDraft] = useState(fxRate.rate);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setDraft(fxRate.rate); }, [fxRate.rate]);
  const dirty = +draft !== +fxRate.rate;
  const apply = async () => {
    if (!dirty || +draft <= 0) return;
    setSaving(true);
    try {
      if (onSaveFxRate) await onSaveFxRate(+draft);
      setFxRate({ ...fxRate, rate: +draft, date: TOD });
    } finally { setSaving(false); }
  };
  return (<div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
    <div style={{ flex: 1 }}><Inp label="MXN por USD" type="number" value={draft} onChange={v => setDraft(+v)} /></div>
    <div style={{ color: B, fontWeight: 800, fontSize: 22 }}>${fxRate.rate}</div>
    {dirty && <Btn label={saving ? "Guardando..." : "Aplicar nuevo TC"} variant="success" onClick={apply} disabled={saving || +draft <= 0} />}
  </div>);
}

function CashierView({ clients, payments, setPayments, setClients, pp, pms, cu, users, cr, condonations, pendingPayments, setPendingPayments, promises, setPromises, fxRate, setFxRate, preselClientId, onClearPresel, onSavePayment, onSavePending, onRejectPending, onSaveFxRate, promiseToValidate, onClearPromiseToValidate, onPromiseFulfilled }) {
  const isCajero = cu.role === "cajero";
  const isGestor = cu.role === "gestor";
  // Obtener tasa de comisión desde cr (commission_rates de BD)
  const getCrRate = (concept) => {
    if (!cr) return 0;
    const match = cr.find(r => r.id === concept || r.id === concept.replace('point_purchase','point_sale'));
    return (match?.pct || 0) / 100;
  };
  const [sid, setSid] = useState(preselClientId || null), [ptype, setPtype] = useState("maintenance"), [montoTotal, setMontoTotal] = useState(""), [note, setNote] = useState(""), [ok, setOk] = useState(null);
  const [validateMid, setValidateMid] = useState("1"); // Medio de pago al validar (cajero)
  const [proposalMid, setProposalMid] = useState(""); // Medio de pago al proponer (gestor)
  // Auto-seleccionar primer método si no hay uno
  useEffect(() => { if (!proposalMid && pms.length > 0) setProposalMid(String(pms[0].id)); }, [pms]); // eslint-disable-line
  const selectedPm = pms.find(m => String(m.id) === String(proposalMid)) || pms[0];
  const costPct = selectedPm?.costPct || 0;
  const client = clients.find(c => c.id === sid);
  const d = client ? dOvr(client.dueDate) : 0;
  const cls = client ? getClientStatus(client, payments, condonations) : { l: "Al corriente", c: "#22c55e", r: 0 };
  const interest = client ? cInt(client.balance, d, cls.r * 12) : 0;
  const montoN = +montoTotal || 0;
  // Año de mantenimiento a pagar para el cliente seleccionado (considera condonados como cubiertos)
  const maintYear = client ? getMaintYear(client, payments, condonations) : CY;
  const isPrepago = client ? maintYear === CY + 1 : false;
  const yaPrepagado = client ? maintYear > CY + 1 : false;
  const maintPointExpiry = getMaintPointExpiry(maintYear);
  const preloadedMantAmt = client ? Math.round(client.annualPoints * pp) : 0;

  // ── REPARTO AUTOMÁTICO DEL MONTO ────────────────────────────────────
  // Lógica: aplicar primero a mantenimiento (al máximo posible), sobrante a moratorios
  // Si el monto no alcanza para cubrir mant. completo, mostrar 100% descuento en moratorios
  // y descuento variable en mantenimiento (siempre respetando reglas de descuento máximo)
  const allocation = useMemo(() => {
    if (!client || montoN <= 0) return { mantAmt: 0, moraAmt: 0, mantDisc: 0, moraDisc: 0, valid: false, reason: "Sin monto" };

    const isPrepagoPay = ptype === "prepago_maintenance";
    const maxDiscPctMant = (isPrepagoPay ? 0.30 : 0.20) - (costPct / 100);

    if (isPrepagoPay) {
      // Prepago: monto cubre mant del año siguiente con descuento opcional
      const montoCompleto = preloadedMantAmt;
      const descMant = Math.max(0, montoCompleto - montoN);
      const descMaxPermitido = montoCompleto * maxDiscPctMant;
      if (montoN > montoCompleto) return { mantAmt: 0, moraAmt: 0, mantDisc: 0, moraDisc: 0, valid: false, reason: `El monto excede el mantenimiento prepago ($${fMXN(montoCompleto)})` };
      if (descMant > descMaxPermitido) return { mantAmt: montoN, moraAmt: 0, mantDisc: descMant, moraDisc: 0, valid: false, reason: `Descuento ${((descMant/montoCompleto)*100).toFixed(1)}% excede máximo ${(maxDiscPctMant*100).toFixed(1)}%` };
      return { mantAmt: montoN, moraAmt: 0, mantDisc: descMant, moraDisc: 0, valid: true, reason: "" };
    }

    // Caso normal: mantenimiento + posible mora
    const saldoMant = client.balance;
    const saldoMora = interest;

    if (saldoMant === 0 && saldoMora === 0) {
      return { mantAmt: 0, moraAmt: 0, mantDisc: 0, moraDisc: 0, valid: false, reason: "Cliente al corriente — no hay deuda que cobrar" };
    }

    let mantAmt, moraAmt, mantDisc, moraDisc;

    if (montoN >= saldoMant) {
      // El monto cubre TODO el mantenimiento. El sobrante va a moratorios.
      mantAmt = saldoMant; mantDisc = 0;
      const sobrante = montoN - saldoMant;
      moraAmt = Math.min(sobrante, saldoMora);
      moraDisc = Math.max(0, saldoMora - moraAmt); // descuento de mora si no alcanza para cubrirla toda
    } else {
      // El monto NO alcanza para cubrir mant completo
      // → 100% descuento en moratorios y aplicar descuento variable en mant
      moraAmt = 0; moraDisc = saldoMora; // toda la mora se condona
      mantAmt = montoN; mantDisc = saldoMant - montoN;
    }

    // Validar reglas de descuento
    const descMantPct = saldoMant > 0 ? mantDisc / saldoMant : 0;
    if (descMantPct > maxDiscPctMant) {
      return { mantAmt, moraAmt, mantDisc, moraDisc, valid: false, reason: `Descuento mantenimiento ${(descMantPct*100).toFixed(1)}% excede máximo ${(maxDiscPctMant*100).toFixed(1)}% (con ${costPct}% de costo financiero)` };
    }

    return { mantAmt, moraAmt, mantDisc, moraDisc, valid: true, reason: "" };
  }, [client, montoN, ptype, costPct, preloadedMantAmt, interest]);

  // Auto-precargar monto y tipo cuando se selecciona un cliente
  useEffect(() => {
    if (!client) { setMontoTotal(""); setPtype("maintenance"); return; }
    // Si viene una promesa a validar, los datos los pone el otro useEffect
    if (promiseToValidate && promiseToValidate.clientId === client.id) return;
    if (yaPrepagado) {
      setPtype("maintenance"); setMontoTotal("");
      return;
    }
    if (isPrepago) {
      setPtype("prepago_maintenance");
      setMontoTotal(String(preloadedMantAmt));
    } else {
      setPtype("maintenance");
      // Sugerir saldo + mora como total a cobrar
      const sugerido = (client.balance || 0) + (interest || 0);
      setMontoTotal(sugerido > 0 ? String(Math.round(sugerido)) : "");
    }
  }, [sid]); // eslint-disable-line

  // Pre-llenar formulario al venir de una promesa (Validar)
  useEffect(() => {
    if (promiseToValidate && clients.length > 0) {
      const fx = fxRate?.rate || 17.5;
      setSid(promiseToValidate.clientId);
      const amountMxn = Math.round(promiseToValidate.amount * fx);
      setMontoTotal(String(amountMxn));
      // Mapear concept de promesa a ptype del formulario
      if (promiseToValidate.concept === 'prepago') setPtype('prepago_maintenance');
      else setPtype('maintenance');
      setNote(`[Promesa #${promiseToValidate.id}] ${promiseToValidate.note || ''}`);
    }
  }, [promiseToValidate?.id]); // eslint-disable-line

  const submit = () => {
    if (!client || montoN <= 0) return;
    if (yaPrepagado) return;
    if (!proposalMid) return;
    if (!allocation.valid) { alert(allocation.reason || "Datos incompletos"); return; }

    const isPrepagoPay = ptype === "prepago_maintenance";
    const totalCobrar = allocation.mantAmt + allocation.moraAmt;
    const prop = {
      id: Date.now(), clientId: client.id, clientName: client.name, contractNo: client.contractNo,
      ptype: isPrepagoPay ? "maintenance" : "maintenance",
      mantAmt: allocation.mantAmt, moraAmt: allocation.moraAmt,
      mantDisc: allocation.mantDisc, moraDisc: allocation.moraDisc,
      totalACobrar: totalCobrar, submittedBy: cu.username, submittedAt: new Date().toISOString(),
      note: isPrepagoPay ? `[PREPAGO] Mantenimiento adelantado año ${maintYear}${note ? " — " + note : ""}` : note,
      status: "Por Validar",
      maintYear, maintPointExpiry, isPrepago: isPrepagoPay,
      methodId: +proposalMid, methodName: selectedPm?.name, costPct,
    };
    setPendingPayments(ps => [...ps, prop]);
    setOk({ name: client.name, total: totalCobrar, id: prop.id });
    setSid(null); setMontoTotal(""); setNote("");
    // Guardar en Supabase
    if (onSavePending) onSavePending(prop).catch(console.error);
    // Si vino de una promesa, marcarla como cumplida y limpiar el state
    if (promiseToValidate && onPromiseFulfilled) {
      onPromiseFulfilled(promiseToValidate.id).catch(console.error);
      if (onClearPromiseToValidate) onClearPromiseToValidate();
    }
  };
  const validatePayment = (id, mid) => {
    const pp2 = pendingPayments.find(p => p.id === id); if (!pp2) return;
    const pm = pms.find(m => m.id === +mid) || pms[0];
    const cli = clients.find(c => c.id === pp2.clientId);
    // Puntos acreditados: para mantenimiento, son los pts que corresponden al monto pagado
    const mantPaid = pp2.mantAmt - pp2.mantDisc;
    const ptsFinal = pp2.ptype === "maintenance" ? Math.round(mantPaid / pp) : (pp2.ptype === "point_purchase" ? Math.round(pp2.totalACobrar / pp) : 0);
    // Determinar a qué año se asigna el pago (el más antiguo pendiente, salvo que sea prepago)
    const targetYear = pp2.isPrepago ? (pp2.maintYear || CY + 1) : (cli ? getMaintYear(cli, payments, condonations) : CY);
    const targetExpiry = getMaintPointExpiry(targetYear);
    const payment = {
      id: Date.now(), clientId: pp2.clientId, clientName: pp2.clientName, contractNo: pp2.contractNo,
      date: new Date().toISOString().split("T")[0], amount: pp2.totalACobrar, amountMant: pp2.mantAmt - pp2.mantDisc, amountMora: pp2.moraAmt - pp2.moraDisc,
      points: ptsFinal || 0, method: pm.name, methodId: pm.id, costPct: pm.costPct || 0,
      discountMant: pp2.mantDisc, discountMora: pp2.moraDisc,
      note: `[${pp2.ptype}] ${pp2.note}`, status: "Liquidado",
      processedBy: pp2.submittedBy, processedByCajero: cu.username,
      type: pp2.ptype, fxRate: fxRate.rate,
      maintYear: targetYear,
      maintPointExpiry: targetExpiry,
      isPrepago: pp2.isPrepago || targetYear > CY,
      pendingPaymentId: typeof pp2.id === 'number' && pp2.id > 1000000000 ? null : pp2.id,
      agentCommission: (pp2.isPrepago ? (pp2.mantAmt - pp2.mantDisc) * getCrRate('prepago') : (pp2.mantAmt - pp2.mantDisc) * getCrRate('maintenance')) + (pp2.moraAmt - pp2.moraDisc) * getCrRate('moratorios'),
    };
    setPayments(ps => [...ps, payment]);
    // Guardar en Supabase
    if (onSavePayment) {
      const clientAfter = clients.find(c => c.id === pp2.clientId);
      // Calcular balance USD nuevo: el cliente tiene balance en MXN en la app, convertir a USD para DB
      // mantPaid es lo que cobró menos descuento (MXN), restar al balance MXN y convertir a USD
      const newBalanceMxn = Math.max(0, (clientAfter?.balance || 0) - (pp2.mantAmt - pp2.mantDisc));
      const newBalanceUsd = newBalanceMxn / (fxRate?.rate || 17.5);
      const newPaidPoints = (clientAfter?.paidPoints || 0) + (ptsFinal || 0);
      // El nuevo status se recalcula en el siguiente loadAll(), pero damos uno tentativo
      const newStatus = newBalanceUsd === 0 ? 'Active' : (newBalanceUsd > 0 && (clientAfter?.paidPoints || 0) > 0 ? 'Partial' : 'Delinquent');
      onSavePayment(payment, clientAfter ? {
        paidPoints: newPaidPoints,
        balance: newBalanceUsd,
        status: newStatus,
      } : null).catch(console.error);
    }
    // Actualizar cliente según tipo
    setClients(cs => cs.map(c => {
      if (c.id !== pp2.clientId) return c;
      if (pp2.ptype === "maintenance") {
        const isPrepagoPay = pp2.isPrepago || targetYear > CY;
        const np = c.paidPoints + (ptsFinal || 0);
        const nb = Math.max(0, c.balance - (pp2.mantAmt - pp2.mantDisc));
        // Si es prepago: los puntos van a savedPoints con fecha de vencimiento correcta
        // (estarán disponibles inmediatamente para reservar)
        if (isPrepagoPay) {
          const newSavedPt = { points: ptsFinal || 0, expiryDate: targetExpiry, savedBy: cu.username, savedDate: payment.date, maintYear: targetYear, note: `Prepago mantenimiento ${targetYear}` };
          return { ...c, savedPoints: [...(c.savedPoints || []), newSavedPt], balance: nb, status: nb === 0 ? "Active" : c.status };
        }
        // Pago normal: incrementa paidPoints y reduce saldo
        return { ...c, paidPoints: np, balance: nb, status: nb === 0 ? "Active" : np > 0 ? "Partial" : c.status };
      }
      if (pp2.ptype === "point_purchase") { const np = c.paidPoints + (ptsFinal || 0), na = c.annualPoints + (ptsFinal || 0); return { ...c, totalPoints: c.totalPoints + (ptsFinal || 0), annualPoints: na, paidPoints: np }; }
      if (pp2.ptype === "cancellation_payment") {
        // Al cancelar el contrato el cliente PIERDE todos los puntos (incluyendo prepagos en savedPoints)
        return { ...c, balance: 0, paidPoints: 0, savedPoints: [], contractStatus: "Cancelado c/pago", cancelDate: payment.date, cancelReason: `Liquidación: ${pp2.note}` };
      }
      if (pp2.ptype === "moratorios") return c;
      return c;
    }));
    setPromises(prs => prs.map(pr => pr.clientId === pp2.clientId && pr.status === "Pendiente" && pr.promiseDate && pr.promiseDate.slice(0, 7) >= TOM ? { ...pr, status: "Cumplida", fulfilledDate: payment.date } : pr));
    setPendingPayments(ps => ps.filter(p => p.id !== id));
  };
  const rejectPending = id => {
    setPendingPayments(ps => ps.filter(p => p.id !== id));
    if (onRejectPending) onRejectPending(id).catch(console.error);
  };
  const deletePayment = async pid => {
    const p = payments.find(x => x.id === pid); if (!p) return;
    const yesterday = new Date(TODAY.getTime() - 86400000).toISOString().split("T")[0];
    if (p.date !== yesterday) { alert("Solo se pueden eliminar pagos procesados el día anterior."); return; }
    if (!window.confirm(`¿Eliminar pago de ${p.clientName} por ${f$(p.amount)}? Esta acción no se puede deshacer.`)) return;
    try {
      if (typeof p.id === 'number' && p.id < 1000000000) {
        await softDeletePayment(p.id);
      }
      setPayments(ps => ps.filter(x => x.id !== pid));
      if (onSavePayment) await loadAll();
    } catch (e) {
      console.error('Error eliminando pago:', e);
      alert('Error eliminando pago: ' + (e.message || JSON.stringify(e)));
    }
  };
  const emitReceipt = pid => {
    const p = payments.find(x => x.id === pid); if (!p) return;
    const w = window.open("", "_blank");
    w.document.write(`<!DOCTYPE html><html><head><title>Recibo</title><style>body{font-family:Arial,sans-serif;max-width:500px;margin:40px auto;padding:20px}.h{text-align:center;border-bottom:2px solid #1d4ed8;padding-bottom:12px;margin-bottom:16px}.logo{font-size:20px;font-weight:800;color:#1d4ed8}.row{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #eee}.lbl{color:#666;font-size:12px}.val{font-weight:700;font-size:12px}.total{background:#1d4ed810;padding:10px 12px;border-radius:6px;margin-top:10px;display:flex;justify-content:space-between;font-size:14px;font-weight:700;color:#1d4ed8}.ft{margin-top:20px;text-align:center;font-size:10px;color:#888}.prepago{background:#10b98110;border:1px solid #10b98133;border-radius:6px;padding:8px 10px;margin:8px 0;font-size:11px;color:#10b981;text-align:center}</style></head><body><div class="h"><div class="logo">◈ POINTSUITE</div><h2 style="margin:6px 0 3px">Recibo de Pago</h2><div style="color:#666;font-size:11px">Folio: PAG-${p.id}</div></div>${p.isPrepago ? `<div class="prepago">⭐ PREPAGO — Mantenimiento ${p.maintYear} · Puntos vigentes hasta ${p.maintPointExpiry}</div>` : p.type === "maintenance" ? `<div style="background:#1d4ed810;border-radius:6px;padding:6px 10px;margin:6px 0;font-size:11px;color:#1d4ed8;text-align:center">Mantenimiento Año ${p.maintYear || CY} · Puntos vencen ${p.maintPointExpiry || ""}</div>` : ""}${[["Fecha", p.date], ["Cliente", p.clientName], ["Contrato", p.contractNo], ["Concepto", PT.find(t => t.v === p.type)?.l || p.type], p.type === "maintenance" ? ["Año de mantenimiento", String(p.maintYear || CY)] : null, ["Mantenimiento", f$(p.amountMant || 0)], p.amountMora ? ["Moratorios", f$(p.amountMora)] : null, p.discountMant ? ["Descuento mant.", `-${f$(p.discountMant)}`] : null, p.discountMora ? ["Descuento mora", `-${f$(p.discountMora)}`] : null, ["Pts acreditados", (p.points || 0).toLocaleString()], p.type === "maintenance" ? ["Pts vigentes hasta", p.maintPointExpiry || ""] : null, ["Medio", p.method], ["Gestor", p.processedBy], ["Cajero", p.processedByCajero || "—"], p.fxRate ? ["Tipo de cambio", `$${p.fxRate} MXN/USD`] : null].filter(Boolean).map(([l, v]) => `<div class="row"><span class="lbl">${l}</span><span class="val">${v}</span></div>`).join("")}<div class="total"><span>TOTAL</span><span>${f$(p.amount)}</span></div><div class="ft">PointSuite OMS · Recibo oficial</div></body></html>`);
    w.document.close(); w.print();
  };
  // Recargar cleanup en mount
  autoCleanup(pendingPayments, promises, setPendingPayments, setPromises);
  // Filtro: pendientes y pagos del día
  const todayPayments = payments.filter(p => p.date === TOD);
  // Pagos de ayer que aún pueden eliminarse hoy
  const yesterday = new Date(TODAY.getTime() - 86400000).toISOString().split("T")[0];
  const yesterdayPayments = payments.filter(p => p.date === yesterday);
  const monthPayments = payments.filter(p => p.date && p.date.slice(0, 7) === TOM);
  // Vista dividida: gestor registra; cajero valida
  return (<div style={{ display: "grid", gridTemplateColumns: isCajero ? "1fr 1fr" : "1fr 1.2fr", gap: 14, alignItems: "start" }}>
    {!isCajero && (<div style={{ background: BG2, border: `1px solid ${BD}`, borderRadius: 12, padding: 18 }}>
      <Sec t="Registrar Propuesta de Cobro" />
      {promiseToValidate && <div style={{ background: B + "15", border: `2px solid ${B}66`, borderRadius: 8, padding: "10px 13px", marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ color: B, fontWeight: 800, fontSize: 12 }}>★ Validando Promesa de Pago</div>
            <div style={{ color: T3, fontSize: 11, marginTop: 2 }}>
              {promiseToValidate.clientName} · {promiseToValidate.contractNo} · Promesa del {promiseToValidate.promiseDate}
            </div>
            <div style={{ color: T4, fontSize: 10, marginTop: 2 }}>
              Si envías este pago a caja, la promesa se marcará como cumplida. Si cancelas, la promesa permanece pendiente.
            </div>
          </div>
          <Btn label="✕ Cancelar validación" variant="ghost" small onClick={() => { if (onClearPromiseToValidate) onClearPromiseToValidate(); setSid(null); setMontoTotal(""); setNote(""); }} />
        </div>
      </div>}
      {ok && <div style={{ background: G + "12", border: `1px solid ${G}28`, borderRadius: 7, padding: "8px 10px", marginBottom: 11, fontSize: 11 }}><div style={{ color: G, fontWeight: 700 }}>✓ Propuesta enviada a caja (ID:{ok.id})</div><div style={{ color: T3 }}>{ok.name} · {f$(ok.total)} · Caja debe validar antes del fin del día</div></div>}
      <div style={{ fontSize: 10, color: T4, marginBottom: 10 }}>Puedes proponer un cobro para <b style={{ color: T1 }}>cualquier cliente</b>, aunque no esté asignado a ti. El cajero lo valida cuando lo cobre efectivamente.</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        <SearchBox clients={clients.filter(c => c.contractStatus === "Active")} onSelect={setSid} selectedId={sid} />
        {client && (() => {
          const fx2 = fxRate?.rate || 17.5;
          const saldoUSD = client.balance / fx2;
          const intUSD2 = interest / fx2;
          const montoMXN = Math.round(client.annualPoints * pp);
          const montoUSD = (montoMXN / fx2).toFixed(2);
          return <div style={{ padding: "10px 12px", background: BG3, borderRadius: 7, border: `1px solid ${isPrepago ? "#10b981" : cls.c}44` }}>
            {/* Badge de año de mantenimiento - siempre visible */}
            <div style={{ marginBottom: 8, padding: "7px 10px", background: isPrepago ? "#10b98118" : B + "15", borderRadius: 6, border: `1px solid ${isPrepago ? "#10b98144" : B + "33"}` }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: isPrepago ? "#10b981" : B, marginBottom: 3 }}>
                {isPrepago ? "⭐ PREPAGO — Mantenimiento Año " + maintYear : "📅 Mantenimiento Año " + maintYear}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                <div><div style={{ fontSize: 8, color: T4, textTransform: "uppercase" }}>Pts/año</div><div style={{ color: P, fontWeight: 700 }}>{fP(client.annualPoints)}</div></div>
                <div><div style={{ fontSize: 8, color: T4, textTransform: "uppercase" }}>Monto MXN</div><div style={{ color: G, fontWeight: 700 }}>{fMXN(montoMXN)}</div></div>
                <div><div style={{ fontSize: 8, color: T4, textTransform: "uppercase" }}>Monto USD</div><div style={{ color: B, fontWeight: 700 }}>USD ${montoUSD}</div></div>
              </div>
              {isPrepago && <div style={{ fontSize: 9, color: "#10b981", marginTop: 5 }}>
                Puntos disponibles inmediatamente · Vencen el <b>{maintPointExpiry}</b>
              </div>}
              {!isPrepago && client.balance > 0 && <div style={{ fontSize: 9, color: Y, marginTop: 5 }}>
                Saldo pendiente: <b>{fMXN(client.balance)}</b> ({fUSD(saldoUSD)})
              </div>}
            </div>
            {/* Info adicional del cliente */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 6 }}>
              {[["Pts pagados", fP(client.paidPoints), G], ["Saldo USD", fUSD(saldoUSD), client.balance > 0 ? R : G], ["Mora USD", fUSD(intUSD2), interest > 0 ? Y : T4]].map(([l, v, c]) => (
                <div key={l}><div style={{ fontSize: 8, color: T4, textTransform: "uppercase" }}>{l}</div><div style={{ color: c, fontWeight: 700, fontSize: 11 }}>{v}</div></div>
              ))}
            </div>
            <div style={{ fontSize: 9, color: T4, marginTop: 5 }}>TC: ${fx2} MXN/USD · <Bdg l={cls.l} /></div>
          </div>;
        })()}
        {/* Mensaje cuando el cliente ya tiene prepagado todo lo que puede */}
        {client && yaPrepagado && <div style={{ background: G + "15", border: `1px solid ${G}44`, borderRadius: 8, padding: "12px 14px", marginBottom: 8 }}>
          <div style={{ fontSize: 11, color: G, fontWeight: 800, marginBottom: 4 }}>✓ Cliente al corriente con prepago aplicado</div>
          <div style={{ fontSize: 9, color: T3 }}>Este cliente ya tiene pagado el mantenimiento del año en curso ({CY}) y el siguiente ({CY + 1}). No se permite procesar más pagos de mantenimiento adelantado.</div>
        </div>}

        {/* Selector de concepto — prepago_maintenance solo visible para clientes en Promoción Prepago */}
        <Inp
          label="Concepto"
          value={ptype}
          onChange={v => { setPtype(v); if (v === "prepago_maintenance") setMontoTotal(String(preloadedMantAmt)); else if (v !== "prepago_maintenance") setMontoTotal(""); }}
          opts={PT.filter(t => t.v !== "prepago_maintenance" || isPrepago).map(t => ({ v: t.v, l: t.l }))}
        />

        {/* Selector de medio de pago — el gestor lo determina */}
        <div>
          <Inp
            label="Medio de pago"
            value={proposalMid}
            onChange={setProposalMid}
            opts={pms.filter(m => m.active !== false).map(m => ({ v: String(m.id), l: `${m.name}${m.costPct > 0 ? ` (costo ${m.costPct}%)` : " (sin costo)"}` }))}
          />
          {selectedPm && costPct > 0 && <div style={{ fontSize: 9, color: T4, marginTop: 3 }}>
            Costo financiero: {costPct}% · Descuento máximo permitido: <b style={{ color: Y }}>{((ptype === "prepago_maintenance" ? 30 : 20) - costPct).toFixed(1)}%</b>
          </div>}
        </div>

        {/* Formulario especial para Mantenimiento Adelantado */}
        {ptype === "prepago_maintenance" && client && (() => {
          const fx2 = fxRate?.rate || 17.5;
          const nextMaintYear = maintYear; // ya es CY+1 para prepago
          const montoCompleto = Math.round(client.annualPoints * pp);
          const montoUSD = (montoCompleto / fx2).toFixed(2);
          return <div style={{ background: "#10b98112", border: "1px solid #10b98144", borderRadius: 8, padding: "12px 14px" }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: "#10b981", marginBottom: 10 }}>⭐ Mantenimiento Adelantado — Año {nextMaintYear}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 10 }}>
              <div style={{ background: BG3, borderRadius: 6, padding: "7px 9px" }}>
                <div style={{ fontSize: 8, color: T4, textTransform: "uppercase", marginBottom: 2 }}>Año a pagar</div>
                <div style={{ color: "#10b981", fontWeight: 800, fontSize: 14 }}>{nextMaintYear}</div>
              </div>
              <div style={{ background: BG3, borderRadius: 6, padding: "7px 9px" }}>
                <div style={{ fontSize: 8, color: T4, textTransform: "uppercase", marginBottom: 2 }}>Puntos/año</div>
                <div style={{ color: P, fontWeight: 700 }}>{fP(client.annualPoints)}</div>
              </div>
              <div style={{ background: BG3, borderRadius: 6, padding: "7px 9px" }}>
                <div style={{ fontSize: 8, color: T4, textTransform: "uppercase", marginBottom: 2 }}>Pts vencen</div>
                <div style={{ color: Y, fontWeight: 700, fontSize: 10 }}>{maintPointExpiry}</div>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
              <div style={{ background: BG3, borderRadius: 6, padding: "7px 9px" }}>
                <div style={{ fontSize: 8, color: T4, textTransform: "uppercase", marginBottom: 2 }}>Monto MXN</div>
                <div style={{ color: G, fontWeight: 800, fontSize: 13 }}>{fMXN(montoCompleto)}</div>
              </div>
              <div style={{ background: BG3, borderRadius: 6, padding: "7px 9px" }}>
                <div style={{ fontSize: 8, color: T4, textTransform: "uppercase", marginBottom: 2 }}>Equivalente USD</div>
                <div style={{ color: B, fontWeight: 700 }}>USD ${montoUSD}</div>
                <div style={{ fontSize: 8, color: T4 }}>TC: ${fx2}</div>
              </div>
            </div>
            <div style={{ fontSize: 9, color: "#10b981", marginBottom: 8 }}>
              ✓ Los {fP(client.annualPoints)} estarán disponibles <b>inmediatamente</b> para hacer reservaciones y vencerán el <b>{maintPointExpiry}</b>.
            </div>
            <Inp label={`Monto a cobrar (MXN $) — Mantenimiento Año ${nextMaintYear}`} value={montoTotal} onChange={setMontoTotal} type="number" />
            {montoN > 0 && montoN < montoCompleto && (() => {
              const descuento = montoCompleto - montoN;
              const maxPct = 0.30 - (costPct / 100);
              const maxDesc = montoCompleto * maxPct;
              const exceso = descuento > maxDesc;
              return <div style={{ fontSize: 9, color: exceso ? R : Y, marginTop: 3, fontWeight: exceso ? 700 : 500 }}>
                {exceso
                  ? `⛔ El descuento (${fMXN(descuento)}) excede el máximo permitido (${(maxPct * 100).toFixed(1)}% = ${fMXN(maxDesc)}). Tope: 30% - ${costPct}% costo medio.`
                  : `⚠ Monto completo: ${fMXN(montoCompleto)}. Descuento aplicado: ${fMXN(descuento)} (${((descuento / montoCompleto) * 100).toFixed(1)}% de ${(maxPct * 100).toFixed(1)}% permitido).`}
              </div>;
            })()}
            {montoN > montoCompleto && <div style={{ fontSize: 9, color: R, marginTop: 3, fontWeight: 700 }}>
              ⛔ El monto excede el costo del mantenimiento ({fMXN(montoCompleto)}).
            </div>}
          </div>;
        })()}

        {/* Formulario normal para otros conceptos */}
        {ptype !== "prepago_maintenance" && (() => {
          const desglose = getMaintDesglose(client, payments, pp, condonations);
          const pendientes = desglose.filter(d => !d.paid && !d.condonated);
          const fx2 = fxRate?.rate || 17.5;
          return <>
            {client && (pendientes.length > 0 || desglose.some(d => d.condonated)) && <div style={{ background: BG3, border: `1px solid ${pendientes.length > 1 ? R : Y}33`, borderRadius: 8, padding: "10px 12px" }}>
              <div style={{ fontSize: 9, color: pendientes.length > 1 ? R : Y, textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8, fontWeight: 700 }}>
                {pendientes.length > 1 ? `⚠ ${pendientes.length} años de mantenimiento pendientes` : pendientes.length === 1 ? "📅 Mantenimiento pendiente" : "✓ Desglose de mantenimientos"}
              </div>
              {desglose.map(d => (
                <div key={d.year} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: `1px solid ${BD}`, opacity: (d.paid || d.condonated) ? 0.5 : 1 }}>
                  <div style={{ width: 42, flexShrink: 0 }}>
                    <span style={{ background: d.paid ? G + "20" : d.condonated ? P + "20" : d.partial ? Y + "20" : R + "20", color: d.paid ? G : d.condonated ? P : d.partial ? Y : R, border: `1px solid ${d.paid ? G : d.condonated ? P : d.partial ? Y : R}44`, borderRadius: 4, padding: "1px 5px", fontSize: 9, fontWeight: 700 }}>
                      {d.year}
                    </span>
                  </div>
                  <div style={{ flex: 1, fontSize: 10 }}>
                    <span style={{ color: T3 }}>{fP(d.pts)}</span>
                    {d.partial && <span style={{ color: Y, fontSize: 9, marginLeft: 6 }}>Parcial: {fP(d.ptsPagados)} pagados</span>}
                    {d.condonated && <span style={{ color: P, fontSize: 9, marginLeft: 6 }}>⚖ Condonado</span>}
                  </div>
                  <div style={{ textAlign: "right" }}>
                    {d.paid
                      ? <span style={{ color: G, fontSize: 10, fontWeight: 700 }}>✓ Pagado</span>
                      : d.condonated
                        ? <span style={{ color: P, fontSize: 10, fontWeight: 700 }}>⚖ Condonado</span>
                        : <div>
                            <div style={{ color: d.partial ? Y : R, fontWeight: 700, fontSize: 10 }}>{fMXN(d.pendienteMXN)}</div>
                            <div style={{ color: T4, fontSize: 8 }}>{fUSD(d.pendienteMXN / fx2)}</div>
                          </div>
                    }
                  </div>
                </div>
              ))}
              {pendientes.length > 1 && <div style={{ marginTop: 7, padding: "5px 8px", background: R + "12", borderRadius: 5 }}>
                <div style={{ fontSize: 9, color: R, fontWeight: 700 }}>Total pendiente: {fMXN(pendientes.reduce((a, d) => a + d.pendienteMXN, 0))} · {fUSD(pendientes.reduce((a, d) => a + d.pendienteMXN, 0) / fx2)}</div>
                <div style={{ fontSize: 8, color: T4, marginTop: 2 }}>El pago se aplicará al año más antiguo primero.</div>
              </div>}
            </div>}
            <div>
              <Inp label="Monto total a cobrar (MXN $)" value={montoTotal} onChange={setMontoTotal} type="number" />
              {montoN > 0 && <div style={{ fontSize: 9, color: T4, marginTop: 2 }}>≈ {fUSD(montoN / fx2)} USD</div>}
              {client && (client.balance + interest) > 0 && <div style={{ fontSize: 9, color: T4, marginTop: 3 }}>
                Saldo total adeudado: <b style={{ color: R }}>{fMXN(client.balance + interest)}</b>
                {" — "}Mant: {fMXN(client.balance)} · Mora: {fMXN(interest)}
              </div>}
            </div>
          </>;
        })()}
        {/* Reparto automático del monto */}
        {montoN > 0 && client && ptype !== "prepago_maintenance" && (() => {
          const a = allocation;
          const totalACobrar = a.mantAmt + a.moraAmt;
          const totalDesc = a.mantDisc + a.moraDisc;
          const saldoMant = client.balance;
          const moraMXN = interest;
          const maxDiscPctMant = 0.20 - (costPct / 100);
          return <div style={{ background: BG3, borderRadius: 7, padding: "10px 12px", border: `1px solid ${a.valid ? G : R}33` }}>
            <div style={{ fontSize: 9, color: a.valid ? G : R, textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8, fontWeight: 700 }}>
              {a.valid ? "✓ Reparto automático del monto" : "⛔ Reparto bloqueado"}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
              <div style={{ background: BG2, borderRadius: 5, padding: "6px 8px" }}>
                <div style={{ fontSize: 8, color: T4, textTransform: "uppercase" }}>Mantenimiento</div>
                <div style={{ color: G, fontWeight: 700 }}>{fMXN(a.mantAmt)}</div>
                <div style={{ fontSize: 8, color: T4 }}>de {fMXN(saldoMant)}</div>
                {a.mantDisc > 0 && <div style={{ fontSize: 9, color: Y, marginTop: 2 }}>Desc: {fMXN(a.mantDisc)} ({((a.mantDisc/saldoMant)*100).toFixed(1)}%) · máx {(maxDiscPctMant*100).toFixed(1)}%</div>}
              </div>
              <div style={{ background: BG2, borderRadius: 5, padding: "6px 8px" }}>
                <div style={{ fontSize: 8, color: T4, textTransform: "uppercase" }}>Moratorios</div>
                <div style={{ color: G, fontWeight: 700 }}>{fMXN(a.moraAmt)}</div>
                <div style={{ fontSize: 8, color: T4 }}>de {fMXN(moraMXN)}</div>
                {a.moraDisc > 0 && <div style={{ fontSize: 9, color: Y, marginTop: 2 }}>Desc: {fMXN(a.moraDisc)} ({moraMXN > 0 ? ((a.moraDisc/moraMXN)*100).toFixed(1) : 0}%)</div>}
              </div>
            </div>
            {!a.valid && <div style={{ color: R, fontSize: 10, fontWeight: 700, marginTop: 4 }}>⛔ {a.reason}</div>}
          </div>;
        })()}
        <Inp label="Notas" value={note} onChange={setNote} />
      </div>
      {montoN > 0 && client && ptype !== "prepago_maintenance" && (() => {
        const a = allocation;
        const totalDesc = a.mantDisc + a.moraDisc;
        const saldoRes = Math.max(0, (client.balance || 0) - a.mantAmt);
        return <div style={{ margin: "10px 0", padding: "10px", background: BG3, borderRadius: 7 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 6, marginBottom: 6 }}>
            {[["Total a cobrar", fMXN(a.mantAmt + a.moraAmt), T1], ["Desc. Total", fMXN(totalDesc), Y], ["Mant. cobrado", fMXN(a.mantAmt), G], ["Saldo result.", fMXN(saldoRes), saldoRes > 0 ? R : G]].map(([l, v, c]) => (<div key={l}><div style={{ fontSize: 8, color: T4, textTransform: "uppercase" }}>{l}</div><div style={{ color: c, fontWeight: 700, fontSize: 11 }}>{v}</div></div>))}
          </div>
          {!a.valid && <div style={{ color: R, fontSize: 10, fontWeight: 700 }}>⛔ {a.reason}</div>}
        </div>;
      })()}
      {montoN > 0 && client && ptype === "prepago_maintenance" && <div style={{ margin: "10px 0", padding: "10px", background: "#10b98112", borderRadius: 7, border: "1px solid #10b98133" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 6 }}>
          {[["A cobrar MXN", fMXN(montoN), G], ["Año pagado", String(maintYear), "#10b981"], ["Pts disponibles hasta", maintPointExpiry, Y]].map(([l, v, c]) => (<div key={l}><div style={{ fontSize: 8, color: T4, textTransform: "uppercase" }}>{l}</div><div style={{ color: c, fontWeight: 700, fontSize: 11 }}>{v}</div></div>))}
        </div>
      </div>}
      {(() => {
        const isPrepagoPay = ptype === "prepago_maintenance";
        if (isPrepagoPay) {
          return <Btn label={`⭐ Enviar Prepago Año ${maintYear} a Caja${selectedPm ? ` (${selectedPm.name})` : ""}`} variant="success" onClick={submit} disabled={!client || montoN <= 0 || !allocation.valid || !proposalMid} />;
        }
        return <Btn label={`Enviar a Caja para Validación${selectedPm ? ` (${selectedPm.name})` : ""}`} onClick={submit} disabled={!client || montoN <= 0 || !allocation.valid || !proposalMid} />;
      })()}
      <div style={{ fontSize: 9, color: T4, marginTop: 5 }}>Si el cajero no valida el pago antes del fin del día, la propuesta se cancela automáticamente.</div>
    </div>)}
    {isCajero && (<div style={{ background: BG2, border: `1px solid ${BD}`, borderRadius: 12, padding: 18 }}>
      <Sec t="Tipo de Cambio del Día" a={<span style={{ fontSize: 10, color: T4 }}>Fecha: {fxRate.date}</span>} />
      {(() => {
        const [newRate, setNewRate] = [(typeof fxRate.draftRate !== 'undefined' ? fxRate.draftRate : fxRate.rate), null];
        return null;
      })()}
      <FxRateEditor fxRate={fxRate} setFxRate={setFxRate} onSaveFxRate={onSaveFxRate} />
      <div style={{ marginTop: 10, padding: "8px 9px", background: BG3, borderRadius: 6, fontSize: 10, color: T4 }}>Los contratos son en USD y los cobros en pesos. Al aplicar un nuevo TC se crea un registro histórico que afecta solo a las operaciones validadas a partir de ese momento.</div>
    </div>)}

    <div>
      <div style={{ background: BG2, border: `1px solid ${BD}`, borderRadius: 12, padding: 18, marginBottom: 14 }}>
        <Sec t="Propuestas de Cobro Pendientes de Validar" a={<span style={{ fontSize: 10, color: T4 }}>{pendingPayments.length} pendientes</span>} />
        {pendingPayments.length === 0 ? <div style={{ color: T4, fontSize: 11, textAlign: "center", padding: "15px 0" }}>Sin propuestas pendientes</div> :
          pendingPayments.map(p => (<div key={p.id} style={{ background: BG3, borderRadius: 7, padding: "11px 13px", marginBottom: 8, border: `1px solid ${Y}33` }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <div>
                <b style={{ color: T1 }}>{p.clientName}</b>
                <span style={{ color: T4, fontSize: 10, marginLeft: 7 }}>{p.contractNo}</span>
                {p.ptype === "maintenance" && <span style={{ background: B + "20", color: B, border: `1px solid ${B}33`, borderRadius: 4, padding: "1px 6px", fontSize: 9, fontWeight: 700, marginLeft: 7 }}>Mant. {p.maintYear || CY}{p.isPrepago ? " ⭐ PREPAGO" : ""}</span>}
              </div>
              <span style={{ color: Y, fontSize: 10 }}>{new Date(p.submittedAt).toLocaleTimeString()}</span>
            </div>
            {p.ptype === "maintenance" && p.maintPointExpiry && <div style={{ fontSize: 9, color: p.isPrepago ? "#10b981" : T4, marginBottom: 5 }}>
              Puntos vigentes hasta: <b>{p.maintPointExpiry}</b>{p.isPrepago ? " (prepago — disponibles inmediatamente)" : ""}
            </div>}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 4, marginBottom: 7, fontSize: 10 }}>
              {[["Mant.", f$(p.mantAmt), T2], ["Mora", f$(p.moraAmt), T2], ["Dscto.", f$(p.mantDisc + p.moraDisc), Y], ["A Cobrar", f$(p.totalACobrar), G]].map(([l, v, c]) => (<div key={l}><div style={{ fontSize: 8, color: T4, textTransform: "uppercase" }}>{l}</div><div style={{ color: c, fontWeight: 700 }}>{v}</div></div>))}
            </div>
            <div style={{ fontSize: 9, color: T4, marginBottom: 4 }}>Propuso: <b style={{ color: T2 }}>{p.submittedBy}</b> · Medio: <b style={{ color: B }}>{p.methodName || pms.find(m => m.id === p.methodId)?.name || "Efectivo"}</b>{p.note ? ` · ${p.note}` : ""}</div>
            {isCajero && <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6 }}>
              <Btn label={`✓ Validar (cobrado en ${p.methodName || pms.find(m => m.id === p.methodId)?.name || "Efectivo"})`} variant="success" small onClick={() => validatePayment(p.id, p.methodId || 1)} />
              <Btn label="✗ Rechazar" variant="danger" small onClick={() => rejectPending(p.id)} />
            </div>}
          </div>))}
      </div>

      {isCajero && (<div style={{ background: BG2, border: `1px solid ${BD}`, borderRadius: 12, padding: 18 }}>
        <Sec t={`Pagos Validados Hoy — ${todayPayments.length}`} a={<span style={{ color: G, fontSize: 12, fontWeight: 700 }}>{f$(todayPayments.reduce((a, p) => a + p.amount, 0))}</span>} />
        <div style={{ fontSize: 10, color: T4, marginBottom: 8 }}>Pagos del día actual. No pueden eliminarse hasta mañana.</div>
        {todayPayments.length === 0 ? <div style={{ color: T4, fontSize: 11, textAlign: "center", padding: "15px 0" }}>Sin pagos hoy</div> :
          <Tbl cols={["Cliente", "Concepto", "Monto", "Pts", "Medio", "Gestor", ""]} rows={todayPayments.slice().reverse().map(p => (<tr key={p.id} style={{ borderBottom: `1px solid ${BG3}` }}>
            <td style={tW11()}>{p.clientName}</td>
            <td style={tG3s()}>{PT.find(t => t.v === p.type)?.l || p.type}</td>
            <td style={tGb()}>{f$(p.amount)}</td>
            <td style={tBs()}>{p.points > 0 ? fP(p.points) : "—"}</td>
            <td style={tG3s()}>{p.method}</td>
            <td style={tPs()}>{p.processedBy}</td>
            <td style={tFl()}>
              <Btn label="📄 Recibo" variant="ghost" small onClick={() => emitReceipt(p.id)} />
            </td>
          </tr>))} />}
        {yesterdayPayments.length > 0 && <div style={{ marginTop: 14, padding: "11px 13px", background: R + "10", border: `1px solid ${R}22`, borderRadius: 7 }}>
          <div style={{ fontSize: 10, color: R, textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8, fontWeight: 700 }}>Pagos de Ayer — Eliminables Hoy ({yesterdayPayments.length})</div>
          <div style={{ fontSize: 9, color: T4, marginBottom: 6 }}>Última ventana para corregir errores. Al eliminar, se revierten los cambios al cliente.</div>
          <Tbl cols={["Cliente", "Concepto", "Monto", "Pts", "Medio", "Gestor", ""]} rows={yesterdayPayments.slice().reverse().map(p => (<tr key={p.id} style={{ borderBottom: `1px solid ${BG3}` }}>
            <td style={tW11()}>{p.clientName}</td>
            <td style={tG3s()}>{PT.find(t => t.v === p.type)?.l || p.type}</td>
            <td style={tGb()}>{f$(p.amount)}</td>
            <td style={tBs()}>{p.points > 0 ? fP(p.points) : "—"}</td>
            <td style={tG3s()}>{p.method}</td>
            <td style={tPs()}>{p.processedBy}</td>
            <td style={tFl()}>
              <Btn label="📄 Recibo" variant="ghost" small onClick={() => emitReceipt(p.id)} />
              <Btn label="🗑 Eliminar" variant="danger" small onClick={() => deletePayment(p.id)} />
            </td>
          </tr>))} />
        </div>}
        <div style={{ marginTop: 14, padding: "9px 11px", background: BG3, borderRadius: 7 }}>
          <div style={{ fontSize: 9, color: T4, textTransform: "uppercase", marginBottom: 7 }}>Recibos del Mes</div>
          <div style={{ fontSize: 11, color: T2 }}>{monthPayments.length} pagos · {f$(monthPayments.reduce((a, p) => a + p.amount, 0))}</div>
          <Btn label="📄 Imprimir todos los recibos del mes" variant="ghost" small onClick={() => { monthPayments.forEach(p => setTimeout(() => emitReceipt(p.id), 100)); }} />
        </div>
      </div>)}
    </div>
  </div>);
}

// ── RESERVATIONS ─────────────────────────────────────────────────────────────
function ConfDoc({ r, onClose }) {
  const pr = () => { const w = window.open("", "_blank"); w.document.write(`<!DOCTYPE html><html><head><style>body{font-family:Arial,sans-serif;max-width:560px;margin:40px auto}.h{text-align:center;border-bottom:2px solid #1d4ed8;padding-bottom:14px;margin-bottom:20px}.logo{font-size:20px;font-weight:800;color:#1d4ed8}.row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #eee}.lbl{color:#666;font-size:12px}.val{font-weight:700;font-size:12px}.ft{margin-top:28px;text-align:center;font-size:10px;color:#888}</style></head><body><div class="h"><div class="logo">◈ POINTSUITE</div><h2 style="margin:8px 0 4px">Confirmación de Reservación</h2><div style="color:#666;font-size:11px">Folio: RES-${r.id}</div></div>${[["Cliente", r.clientName], ["Contrato", r.contractNo], ["Unidad", r.unitName], ["Ubicación", r.locationName], ["Temporada", r.seasonName], ["Check-In", r.checkIn], ["Check-Out", r.checkOut], ["Noches", r.nights], ["Puntos", r.pointsUsed.toLocaleString() + " pts"], ["Gestor", r.processedBy]].map(([l, v]) => `<div class="row"><span class="lbl">${l}</span><span class="val">${v}</span></div>`).join("")}<div class="ft">Comprobante válido de reservación · PointSuite OMS</div></body></html>`); w.document.close(); w.print(); };
  return (<Modal title={`Confirmación — ${r.unitName}`} onClose={onClose}>
    <div style={{ background: BG3, borderRadius: 8, padding: "13px", fontSize: 12, lineHeight: 1.8, marginBottom: 14 }}>
      {[["Folio", "RES-" + r.id], ["Cliente", r.clientName], ["Contrato", r.contractNo], ["Unidad", r.unitName + " · " + r.locationName], ["Temporada", r.seasonName], ["Entrada", r.checkIn], ["Salida", r.checkOut], ["Noches", r.nights], ["Puntos", r.pointsUsed.toLocaleString() + " pts"], ["Gestor", r.processedBy]].map(([l, v]) => (<div key={l} style={{ display: "flex", justifyContent: "space-between", borderBottom: `1px solid ${BD}`, padding: "3px 0" }}><span style={{ color: T4 }}>{l}</span><span style={{ color: T1, fontWeight: 600 }}>{v}</span></div>))}
    </div>
    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
      <Btn label="Cerrar" variant="ghost" onClick={onClose} />
      <Btn label="🖨 Imprimir / PDF" onClick={pr} />
    </div>
  </Modal>);
}
function ResModal({ clients, units, uts, reservations, onSave, onClose, cu, rc, presel, payments, condonations }) {
  const [sid, setSid] = useState(presel || null);
  const [uid, setUid] = useState("");
  const [ci, setCi] = useState(""), [co, setCo] = useState("");
  const [availCheck, setAvailCheck] = useState(null); // null | number (rooms available)
  const [checking, setChecking] = useState(false);

  const unit = units.find(u => u.id === +uid);
  const ut = uts.find(t => t.id === unit?.typeId);
  const client = clients.find(c => c.id === sid);
  const DAYS_ES = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

  // Para unidades semanales: ajustar check-in al día correcto
  const handleCiChange = (val) => {
    setCi(val); setCo(""); setAvailCheck(null);
    if (unit?.isWeekly && val) {
      const d = new Date(val + "T12:00:00");
      const diff = (unit.weeklyStartDay - d.getDay() + 7) % 7;
      if (diff !== 0) {
        const adj = new Date(d); adj.setDate(adj.getDate() + diff);
        setCi(adj.toISOString().split("T")[0]);
      }
      // Auto-set checkout 7 nights later
      const co2 = new Date(d); co2.setDate(co2.getDate() + diff + 7);
      setCo(co2.toISOString().split("T")[0]);
    }
  };

  const nights = ci && co ? Math.max(0, Math.round((new Date(co + "T12:00:00") - new Date(ci + "T12:00:00")) / 86400000)) : 0;

  // Validar mínimo de noches
  const minNights = unit?.isWeekly ? 7 : 3;
  const nightsOk = nights >= minNights;

  // Calcular puntos totales
  const ptTotal = (() => {
    if (!nights || !unit || !ci || !nightsOk) return 0;
    let t = 0;
    for (let i = 0; i < nights; i++) {
      const d = new Date(ci + "T12:00:00"); d.setDate(d.getDate() + i);
      const dw = d.getDay();
      const s = detS(d.toISOString().split("T")[0], unit);
      t += calcPts(unit, s.id, dw === 5 || dw === 6);
    }
    return t;
  })();

  const usedP = reservations.filter(r => r.clientId === sid && r.status === "Confirmed").reduce((a, r) => a + r.pointsUsed, 0);
  const savedA = client ? (client.savedPoints || []).filter(sp => new Date(sp.expiryDate) > new Date()).reduce((a, sp) => a + sp.points, 0) : 0;
  const avail = client ? client.paidPoints - usedP + savedA : 0;

  const cls = client ? getClientStatus(client, payments, condonations) : null;
  const delinq = cls ? !["Al corriente", "Promoción Prepago"].includes(cls.l) : false;

  // Verificar disponibilidad en BD
  const checkAvailability = async () => {
    if (!unit || !ci || !co || !nightsOk) return;
    setChecking(true);
    try {
      const rooms = await getAvailableRooms(unit.id, ci, co);
      setAvailCheck(rooms);
    } catch (e) { setAvailCheck(0); }
    setChecking(false);
  };

  useEffect(() => { setAvailCheck(null); }, [uid, ci, co]);

  // Disponibilidad en calendario: contar cuartos ocupados por fecha
  const getOccupied = (dateStr) => {
    if (!unit) return 0;
    return reservations.filter(r => r.unitId === unit.id && r.status === "Confirmed" && r.checkIn <= dateStr && r.checkOut > dateStr).length;
  };
  const getTotalRooms = (dateStr) => {
    if (!unit) return 0;
    const avail = (unit.availability || []).find(a => a.startDate <= dateStr && a.endDate >= dateStr);
    return avail ? avail.totalRooms : 0;
  };

  // Generar calendario del mes actual y siguiente
  const calDates = (() => {
    const dates = [];
    const start = new Date(); start.setDate(1);
    for (let m = 0; m < 2; m++) {
      const mm = new Date(start.getFullYear(), start.getMonth() + m, 1);
      const daysInMonth = new Date(mm.getFullYear(), mm.getMonth() + 1, 0).getDate();
      for (let d = 1; d <= daysInMonth; d++) {
        const ds = new Date(mm.getFullYear(), mm.getMonth(), d).toISOString().split("T")[0];
        const total = getTotalRooms(ds);
        const occ = getOccupied(ds);
        const free = Math.max(0, total - occ);
        const s = detS(ds, unit);
        dates.push({ ds, total, occ, free, season: s?.id || "oro", isSelected: ds >= ci && ds < co });
      }
    }
    return dates;
  })();

  const canBook = nightsOk && client && ptTotal <= avail && unit && client.contractStatus === "Active" && !delinq && (availCheck === null || availCheck > 0);
  const season = ci ? detS(ci, unit) : null;

  return (<Modal title="Nueva Reservación" onClose={onClose} wide>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
      <div style={{ gridColumn: "1/-1" }}>
        <SearchBox clients={clients} onSelect={id => { setSid(id); setAvailCheck(null); }} selectedId={sid} />
        {client && <div style={{ marginTop: 5, padding: "7px 9px", background: BG3, borderRadius: 6, display: "flex", gap: 12, fontSize: 10 }}>
          <span style={{ color: G }}>Disponibles: {avail.toLocaleString()} pts</span>
          {savedA > 0 && <span style={{ color: P }}>{savedA.toLocaleString()} pts guardados</span>}
          {delinq && <span style={{ color: R, fontWeight: 700 }}>⚠ Con morosidad — sin reservas</span>}
        </div>}
      </div>
      <Inp label="Unidad" value={uid} onChange={v => { setUid(+v); setCi(""); setCo(""); setAvailCheck(null); }}
        opts={[{ v: "", l: "Selecciona una unidad..." }, ...units.filter(u => u.active).map(u => ({ v: u.id, l: `${u.name} — ${uts.find(t => t.id === u.typeId)?.name || ""} · ${u.location || ""}${u.isWeekly ? " 📅 Semanal" : ""}` }))]} />
      {unit?.isWeekly && <div style={{ background: Y + "15", border: `1px solid ${Y}44`, borderRadius: 6, padding: "7px 9px", fontSize: 10, color: Y }}>
        📅 Unidad semanal — llegada los {DAYS_ES[unit.weeklyStartDay]} · Mínimo 7 noches
      </div>}
      <Inp label={unit?.isWeekly ? `Check-In (${DAYS_ES[unit.weeklyStartDay]})` : "Check-In (mín. 3 noches)"} type="date" value={ci} onChange={handleCiChange} />
      <Inp label="Check-Out" type="date" value={co} onChange={v => { if (!unit?.isWeekly) { setCo(v); setAvailCheck(null); } }} />
    </div>

    {/* Validación de mínimo de noches */}
    {nights > 0 && !nightsOk && <div style={{ color: R, fontSize: 10, marginTop: 6, padding: "6px 9px", background: R + "12", borderRadius: 6 }}>
      ⛔ Mínimo {minNights} noches requeridas. Actualmente: {nights} noche{nights !== 1 ? "s" : ""}.
    </div>}

    {/* Calendario de disponibilidad */}
    {unit && <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 9, color: T4, textTransform: "uppercase", marginBottom: 6 }}>Disponibilidad del inventario</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
        {calDates.slice(0, 62).map(({ ds, free, total, season: sId, isSelected }) => {
          const color = total === 0 ? T4 : free === 0 ? R : free < total ? Y : G;
          return (<div key={ds} title={`${ds}: ${free}/${total} disponibles`} style={{ width: 18, height: 18, borderRadius: 3, background: isSelected ? B : color + "33", border: `1px solid ${isSelected ? B : color}55`, fontSize: 7, display: "flex", alignItems: "center", justifyContent: "center", color: isSelected ? "#fff" : color, fontWeight: isSelected ? 700 : 400, cursor: "pointer" }} onClick={() => { if (!unit.isWeekly) { handleCiChange(ds); } }}>
            {new Date(ds + "T12:00:00").getDate()}
          </div>);
        })}
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 5, fontSize: 9 }}>
        <span style={{ color: G }}>■ Disponible</span>
        <span style={{ color: Y }}>■ Parcial</span>
        <span style={{ color: R }}>■ Agotado</span>
        <span style={{ color: B }}>■ Seleccionado</span>
        <span style={{ color: T4 }}>■ Sin inventario</span>
      </div>
    </div>}

    {/* Resumen de la reservación */}
    {nightsOk && unit && season && <div style={{ marginTop: 9, padding: "9px", background: BG3, borderRadius: 7, display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 7 }}>
      {[["Noches", nights, T1], ["Dom–Jue/n", calcPts(unit, season.id, false), B], ["Vie–Sáb/n", calcPts(unit, season.id, true), P], ["Total", fP(ptTotal), ptTotal <= avail ? G : R], ["Comisión", f$(rc), Y]].map(([l, v, c]) => (<div key={l}><div style={{ fontSize: 8, color: T4, textTransform: "uppercase", marginBottom: 2 }}>{l}</div><div style={{ color: c, fontWeight: 700 }}>{v}</div></div>))}
    </div>}

    {/* Verificar disponibilidad en BD */}
    {nightsOk && unit && ci && co && <div style={{ marginTop: 8 }}>
      {availCheck === null ? (
        <Btn label={checking ? "Verificando..." : "🔍 Verificar disponibilidad"} variant="ghost" onClick={checkAvailability} disabled={checking} />
      ) : availCheck > 0 ? (
        <div style={{ color: G, fontSize: 11, padding: "6px 9px", background: G + "12", borderRadius: 6 }}>✓ Disponible — {availCheck} cuarto{availCheck !== 1 ? "s" : ""} libre{availCheck !== 1 ? "s" : ""} en esas fechas</div>
      ) : (
        <div style={{ color: R, fontSize: 11, padding: "6px 9px", background: R + "12", borderRadius: 6 }}>⛔ Sin disponibilidad en esas fechas para esta unidad.</div>
      )}
    </div>}

    {!canBook && nightsOk && <div style={{ color: R, fontSize: 10, marginTop: 5 }}>
      ⚠ {delinq ? "Cliente con morosidad." : ptTotal > avail ? `Puntos insuficientes (necesitas ${fP(ptTotal)}, tienes ${fP(avail)}).` : availCheck === 0 ? "Sin disponibilidad." : "Verifica disponibilidad antes de confirmar."}
    </div>}

    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 13 }}>
      <Btn label="Cancelar" variant="ghost" onClick={onClose} />
      <Btn label="Confirmar y Emitir Comprobante" disabled={!canBook || availCheck === null || availCheck === 0}
        onClick={() => onSave({ clientId: sid, clientName: client.name, contractNo: client.contractNo, unitId: unit.id, unitName: unit.name, location: unit.location || "", seasonId: season.id, seasonName: season.name, checkIn: ci, checkOut: co, nights, pointsUsed: ptTotal, status: "Confirmed" })} />
    </div>
  </Modal>);
}
function ReservationsView({ clients, reservations, setReservations, units, setUnits, uts, cu, rc, payments, condonations, users, preselClientId, onClearPresel, onSaveReservation, onCancelReservation }) {
  const [vtab, setVtab] = useState("avail"), [modal, setModal] = useState(preselClientId ? true : false), [confDoc, setConfDoc] = useState(null), [presel, setPresel] = useState(preselClientId || null), [filt, setFilt] = useState("All");
  const availC = useMemo(() => {
    // Clientes con mantenimiento pagado ESTE AÑO y con puntos disponibles sin usar en reservaciones
    const maintPaidThisYear = new Set(payments.filter(p => p.type === "maintenance" && p.date && new Date(p.date).getFullYear() === CY).map(p => p.clientId));
    return clients.filter(c => {
      if (c.contractStatus !== "Active") return false;
      if (!maintPaidThisYear.has(c.id)) return false; // Mantenimiento no pagado este año
      const usedR = reservations.filter(r => r.clientId === c.id && r.status === "Confirmed" && r.checkIn && new Date(r.checkIn).getFullYear() === CY).reduce((a, r) => a + r.pointsUsed, 0);
      const sv = (c.savedPoints || []).filter(sp => new Date(sp.expiryDate) > new Date()).reduce((a, sp) => a + sp.points, 0);
      const avail = c.paidPoints - usedR + sv;
      return avail > 0;
    }).map(c => {
      const usedR = reservations.filter(r => r.clientId === c.id && r.status === "Confirmed" && r.checkIn && new Date(r.checkIn).getFullYear() === CY).reduce((a, r) => a + r.pointsUsed, 0);
      const sv = (c.savedPoints || []).filter(sp => new Date(sp.expiryDate) > new Date()).reduce((a, sp) => a + sp.points, 0);
      return { ...c, avail: c.paidPoints - usedR + sv, sv };
    });
  }, [clients, reservations, payments]);
  const save = res => {
    const nr = { ...res, id: Date.now(), processedBy: cu.username };
    setReservations(rs => [...rs, nr]);
    setUnits(us => us.map(u => u.id === res.unitId ? { ...u, occ: [...(u.occ || []), { ci: res.checkIn, co: res.checkOut }] } : u));
    if (onClearPresel) onClearPresel();
    setModal(false); setConfDoc(nr);
    // Guardar en Supabase
    if (onSaveReservation) onSaveReservation(nr).catch(console.error);
  };
  const filtered = reservations.filter(r => filt === "All" || r.status === filt || r.clientName === filt);
  return (<div>
    {modal && <ResModal clients={availC.length ? availC : clients} units={units} uts={uts} reservations={reservations} onSave={save} onClose={() => setModal(false)} cu={cu} rc={rc} presel={presel} payments={payments} condonations={condonations} />}
    {confDoc && <ConfDoc r={confDoc} onClose={() => setConfDoc(null)} />}
    <div style={{ display: "flex", gap: 5, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
      {[["avail", "Puntos Disponibles"], ["list", "Todas las Reservaciones"]].map(([id, l]) => (
        <button key={id} onClick={() => setVtab(id)} style={{ background: vtab === id ? IND : BG2, color: vtab === id ? "#fff" : T4, border: `1px solid ${vtab === id ? IND : BD}`, borderRadius: 7, padding: "5px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{l}</button>
      ))}
      <div style={{ marginLeft: "auto" }}><Btn label="+ Nueva Reservación" onClick={() => { setPresel(null); setModal(true); }} /></div>
    </div>
    {vtab === "avail" && <div>
      <div style={{ fontSize: 11, color: T4, marginBottom: 11 }}>Clientes <b style={{ color: G }}>al corriente</b>, con mantenimiento pagado y puntos disponibles.</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(270px,1fr))", gap: 11 }}>
        {availC.map(c => (<div key={c.id} style={{ background: BG2, border: `1px solid ${G}33`, borderRadius: 10, padding: "13px 15px", borderTop: `2px solid ${G}` }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 7 }}>
            <div><div style={{ color: T1, fontWeight: 700, fontSize: 13 }}>{c.name}</div><div style={{ color: T4, fontSize: 10 }}>{c.contractNo}·{users?.find(u => String(u.id) === String(c.assignedGestor))?.name || "—"}</div></div>
            <div style={{ textAlign: "right" }}><div style={{ color: G, fontWeight: 800, fontSize: 16 }}>{c.avail.toLocaleString()}</div><div style={{ color: T4, fontSize: 9 }}>pts disponibles</div></div>
          </div>
          {c.sv > 0 && <div style={{ fontSize: 10, color: P, marginBottom: 6 }}>◈ {c.sv.toLocaleString()} pts guardados incluidos</div>}
          <div style={{ display: "flex", gap: 7, marginTop: 8 }}>
            <div style={{ flex: 1, background: BG3, borderRadius: 5, padding: "5px 7px", fontSize: 10 }}><div style={{ color: T4, fontSize: 8, textTransform: "uppercase" }}>Pagados</div><div style={{ color: G, fontWeight: 700 }}>{c.paidPoints.toLocaleString()}</div></div>
            <div style={{ flex: 1, background: BG3, borderRadius: 5, padding: "5px 7px", fontSize: 10 }}><div style={{ color: T4, fontSize: 8, textTransform: "uppercase" }}>Usados</div><div style={{ color: B, fontWeight: 700 }}>{(c.paidPoints - c.avail + c.sv).toLocaleString()}</div></div>
            <Btn label="Reservar →" onClick={() => { setPresel(c.id); setModal(true); }} />
          </div>
        </div>))}
        {availC.length === 0 && <div style={{ color: T4, fontSize: 12, padding: "28px", textAlign: "center", gridColumn: "1/-1" }}>No hay clientes con puntos disponibles ahora.</div>}
      </div>
    </div>}
    {vtab === "list" && <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 11, flexWrap: "wrap" }}>
        <select value={filt} onChange={e => setFilt(e.target.value)} style={{ ...IS, flex: 1, minWidth: 170 }}>
          <option value="All">Todas</option><option value="Confirmed">Confirmadas</option><option value="Cancelled">Canceladas</option>
          {clients.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
        </select>
      </div>
      <Tbl cols={["Folio", "Contrato", "Cliente", "Unidad", "Temp.", "Entrada", "Salida", "Noches", "Pts", "Gestor", "Estado", ""]}
        rows={[...filtered].reverse().map(r => (<tr key={r.id} style={{ borderBottom: `1px solid ${BG3}` }}>
          <td style={tG3s()}>RES-{r.id}</td>
          <td style={tBs()}>{r.contractNo}</td>
          <td style={tW()}>{r.clientName}</td>
          <td style={tG3()}>{r.unitName}</td>
          <td style={tG3()}>{r.seasonName}</td>
          <td style={tS()}>{r.checkIn}</td>
          <td style={tS()}>{r.checkOut}</td>
          <td style={td({ color: T1 })}>{r.nights}</td>
          <td style={tBb()}>{r.pointsUsed.toLocaleString()}</td>
          <td style={tPs()}>{r.processedBy}</td>
          <td style={td()}><Bdg l={r.status} /></td>
          <td style={tFl()}>
            {r.status === "Confirmed" && <Btn label="📄" variant="ghost" small onClick={() => setConfDoc(r)} />}
            {r.status !== "Cancelled" && <Btn label="Cancelar" variant="danger" small onClick={() => {
              setReservations(rs => rs.map(x => x.id === r.id ? { ...x, status: "Cancelled" } : x));
              if (onCancelReservation) onCancelReservation(r.id);
            }} />}
          </td>
        </tr>))} />
    </div>}
  </div>);
}
// ── COLLECTIONS ──────────────────────────────────────────────────────────────
function CollectionsView({ clients, payments, pp, promises, setPromises, cu, fxRate, onSavePromise, onUpdatePromise, condonations }) {
  const [filt, setFilt] = useState("All"), [vtab, setVtab] = useState("accounts"), [pMod, setPMod] = useState(null), [pDate, setPDate] = useState(new Date().toISOString().split("T")[0]), [pAmt, setPAmt] = useState(""), [pNote, setPNote] = useState("");
  const isAdmin = ["superadmin", "admin"].includes(cu.role);
  const myC = isAdmin ? clients : clients.filter(c => String(c.assignedGestor) === String(cu.id));
  const fx = fxRate?.rate || 17.5; // Tipo de cambio MXN/USD
  const collM = payments.filter(p => p.date && p.date.slice(0, 7) === TOM).reduce((a, p) => a + p.amount, 0);
  const collT = payments.filter(p => p.date === TOD).reduce((a, p) => a + p.amount, 0);
  const myProm = isAdmin ? promises : promises.filter(p => p.gestorUsername === cu.username);
  const promT = myProm.filter(p => p.promiseDate === TOD && p.status === "Pendiente");
  const promM = myProm.filter(p => p.promiseDate && p.promiseDate.slice(0, 7) === TOM && p.status === "Pendiente");
  const relP = isAdmin ? payments.filter(p => p.date && p.date.slice(0, 7) === TOM) : payments.filter(p => p.date && p.date.slice(0, 7) === TOM && p.processedBy === cu.username);
  const costM = relP.reduce((a, p) => a + p.amount * (p.costPct || 0) / 100 + (p.agentCommission || 0), 0);
  const revM = relP.reduce((a, p) => a + p.amount, 0);
  const costPct2 = revM > 0 ? ((costM / revM) * 100).toFixed(1) : "0.0";
  const en = myC.map(c => { const d = dOvr(c.dueDate); const cl = getClientStatus(c, payments, condonations); return { ...c, dOvr: d, cls: cl, interest: cInt(c.balance, d, cl.r * 12) }; });
  const fc = en.filter(c => filt === "All" || c.status === filt || (filt === "Morosos" && c.balance > 0));
  // Saldo en USD
  const balUSD = c => c.balance / fx;
  const intUSD = c => (c.interest || 0) / fx;
  // Promesa: gestor propone monto en MXN → sistema calcula descuento vs saldo en USD
  const pAmtN = +pAmt || 0;
  const pSaldoMXN = pMod ? pMod.balance : 0; // Saldo en MXN (campo balance ya está en MXN por pp)
  const pDescuento = pMod ? Math.max(0, pSaldoMXN - pAmtN) : 0; // Descuento en MXN
  const pMaxDisc = pSaldoMXN * 0.20; // Máximo 20% descuento en saldo
  const pDescuentoExcede = pDescuento > pMaxDisc;
  const addProm = () => {
    if (!pMod || !pAmt || !pDate) return;
    if (pDescuentoExcede) return;
    const newProm = { id: Date.now(), clientId: pMod.id, clientName: pMod.name, contractNo: pMod.contractNo, promiseDate: pDate, amount: pAmtN, note: pNote, status: "Pendiente", gestorUsername: cu.username, gestorName: cu.name, createdAt: TOD };
    setPromises(ps => [...ps, newProm]);
    // Guardar en Supabase
    if (onSavePromise) onSavePromise(newProm).catch(console.error);
    setPMod(null); setPAmt(""); setPNote("");
  };
  return (<div>
    {pMod && <Modal title={`Propuesta de Pago — ${pMod.name}`} onClose={() => setPMod(null)}>
      <div style={{ background: BG3, borderRadius: 7, padding: "8px 10px", marginBottom: 10, fontSize: 11, color: T3 }}>
        <div>Saldo: <b style={{ color: R }}>{fUSD(balUSD(pMod))}</b> USD · <span style={{ color: T4 }}>({fMXN(pMod.balance)} al tipo de cambio ${fx} MXN/USD)</span></div>
        <div style={{ marginTop: 3 }}><Bdg l={cDel(dOvr(pMod.dueDate)).l} /></div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        <Inp label="Fecha prometida" type="date" value={pDate} onChange={setPDate} />
        <Inp label="Monto a pagar (MXN $)" type="number" value={pAmt} onChange={setPAmt} />
        {pAmtN > 0 && <div style={{ background: BG3, borderRadius: 6, padding: "9px 11px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 6 }}>
            {[["Saldo USD", fUSD(balUSD(pMod)), R], ["Monto MXN", fMXN(pAmtN), G], ["Descuento", fMXN(pDescuento), pDescuentoExcede ? R : Y]].map(([l, v, c]) => (
              <div key={l}><div style={{ fontSize: 8, color: T4, textTransform: "uppercase" }}>{l}</div><div style={{ color: c, fontWeight: 700 }}>{v}</div></div>
            ))}
          </div>
          {pDescuento > 0 && <div style={{ fontSize: 9, color: T4 }}>Descuento: {((pDescuento / pSaldoMXN) * 100).toFixed(1)}% del saldo (máx permitido: 20%)</div>}
          {pDescuentoExcede && <div style={{ color: R, fontSize: 10, marginTop: 4, fontWeight: 700 }}>⚠ El descuento excede el máximo permitido (20% = {fMXN(pMaxDisc)}). Sube el monto a cobrar.</div>}
        </div>}
        <Inp label="Notas" value={pNote} onChange={setPNote} />
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
        <Btn label="Cancelar" variant="ghost" onClick={() => setPMod(null)} />
        <Btn label="Registrar Promesa" onClick={addProm} disabled={!pAmt || !pDate || pDescuentoExcede} />
      </div>
    </Modal>}
    <div style={{ display: "flex", gap: 9, flexWrap: "wrap", marginBottom: 13 }}>
      <Kpi label="Cobrado Hoy (MXN)" value={fMXN(collT)} accent={G} />
      <Kpi label="Cobrado Mes (MXN)" value={fMXN(collM)} accent={B} />
      <Kpi label="Saldo Pendiente (USD)" value={fUSD(myC.reduce((a, c) => a + c.balance, 0) / fx)} accent={R} />
      <Kpi label="Promesas Hoy (MXN)" value={promT.length} sub={fMXN(promT.reduce((a, p) => a + p.amount, 0))} accent={Y} warn={promT.length > 0} />
      <Kpi label="Promesas Mes (MXN)" value={promM.length} sub={fMXN(promM.reduce((a, p) => a + p.amount, 0))} accent={P} />
      <Kpi label="Costo Cobranza" value={costPct2 + "%"} sub={isAdmin ? "Global" : cu.name} accent={O} warn={parseFloat(costPct2) > 20} />
    </div>
    <div style={{ display: "flex", gap: 5, marginBottom: 12 }}>
      {[["accounts", "Cuentas"], ["promises", "Promesas"]].map(([id, l]) => (
        <button key={id} onClick={() => setVtab(id)} style={{ background: vtab === id ? IND : BG2, color: vtab === id ? "#fff" : T4, border: `1px solid ${vtab === id ? IND : BD}`, borderRadius: 7, padding: "5px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
          {l}{id === "promises" && promT.length > 0 ? <span style={{ background: Y, color: "#000", borderRadius: 9, padding: "0 5px", fontSize: 9, marginLeft: 5, fontWeight: 700 }}>{promT.length}</span> : null}
        </button>
      ))}
    </div>
    {vtab === "accounts" && <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 11 }}>
        <select value={filt} onChange={e => setFilt(e.target.value)} style={{ ...IS, width: 150 }}>{["All", "Active", "Partial", "Delinquent", "Morosos"].map(s => <option key={s}>{s}</option>)}</select>
      </div>
      <Tbl cols={["Contrato", "Cliente", "Vence", "Días", "Clasificación", "Saldo (USD)", "Interés (USD)", "Total (USD)", "Cob%", "Estado", ""]}
        rows={fc.map(c => {
          const cov = Math.round((c.paidPoints / (c.annualPoints || 1)) * 100); return (<tr key={c.id} style={{ borderBottom: `1px solid ${BG3}` }}>
            <td style={tBs()}>{c.contractNo}</td>
            <td style={tW()}>{c.name}</td>
            <td style={tS()}>{c.dueDate}</td>
            <td style={td({ color: c.dOvr > 0 ? R : G, fontWeight: 700 })}>{c.dOvr > 0 ? c.dOvr : "—"}</td>
            <td style={td()}><Bdg l={c.cls.l} /></td>
            <td style={td({ color: c.balance > 0 ? R : G, fontWeight: 700 })}>{fUSD(balUSD(c))}</td>
            <td style={tY()}>{c.interest > 0 ? fUSD(intUSD(c)) : "—"}</td>
            <td style={td({ color: c.balance > 0 ? R : G, fontWeight: 700 })}>{fUSD((c.balance + c.interest) / fx)}</td>
            <td style={td()}><div style={{ display: "flex", alignItems: "center", gap: 5 }}><div style={{ width: 38, height: 4, background: BD, borderRadius: 3 }}><div style={{ width: `${cov}%`, height: "100%", background: cov === 100 ? G : cov > 50 ? Y : R, borderRadius: 3 }} /></div><span style={{ fontSize: 9, color: T4 }}>{cov}%</span></div></td>
            <td style={td()}><Bdg l={c.status} /></td>
            <td style={td()}>{c.balance > 0 && <Btn label="+ Promesa" variant="warning" small onClick={() => { setPMod(c); setPAmt(Math.round(c.balance)); }} />}</td>
          </tr>);
        })} />
      <div style={{ marginTop: 18 }}><Sec t="Historial de Pagos (MXN)" /></div>
      <Tbl cols={["Fecha", "Contrato", "Cliente", "Monto (MXN)", "Pts", "Método", "Costo Tx", "Gestor", "Estado"]}
        rows={[...payments].filter(p => isAdmin || p.processedBy === cu.username).reverse().map(p => (<tr key={p.id} style={{ borderBottom: `1px solid ${BG3}` }}>
          <td style={tS()}>{p.date}</td>
          <td style={tBs()}>{p.contractNo}</td>
          <td style={tW()}>{p.clientName}</td>
          <td style={tGb()}>{fMXN(p.amount)}</td>
          <td style={tBs()}>{p.points > 0 ? fP(p.points) : "—"}</td>
          <td style={tG3()}>{p.method}</td>
          <td style={tY()}>{fMXN(p.amount * (p.costPct || 0) / 100)}</td>
          <td style={tS()}>{p.processedBy}</td>
          <td style={td()}><Bdg l={p.status} /></td>
        </tr>))} />
    </div>}
    {vtab === "promises" && <div>
      {promT.length > 0 && <div style={{ background: Y + "14", border: `1px solid ${Y}33`, borderRadius: 9, padding: "11px 13px", marginBottom: 12 }}>
        <div style={{ fontSize: 10, color: Y, fontWeight: 700, marginBottom: 7 }}>⏰ Promesas para HOY — {promT.length}</div>
        {promT.map(p => (<div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 0", borderBottom: `1px solid ${Y}22` }}>
          <div><b style={{ color: T1 }}>{p.clientName}</b><span style={{ color: T3, fontSize: 10, marginLeft: 7 }}>{p.contractNo}</span>{p.note && <span style={{ color: T4, fontSize: 9, marginLeft: 7 }}>{p.note}</span>}</div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ color: Y, fontWeight: 700 }}>{f$(p.amount)}</span>
            <Btn label="✓" variant="success" small onClick={() => {
              setPromises(ps => ps.map(x => x.id === p.id ? { ...x, status: "Cumplida" } : x));
              if (onUpdatePromise) onUpdatePromise(p.id, "Cumplida");
            }} />
            <Btn label="✗" variant="danger" small onClick={() => {
              setPromises(ps => ps.map(x => x.id === p.id ? { ...x, status: "Incumplida" } : x));
              if (onUpdatePromise) onUpdatePromise(p.id, "Incumplida");
            }} />
          </div>
        </div>))}
      </div>}
      <Tbl cols={["Fecha Promesa", "Contrato", "Cliente", "Monto", "Gestor", "Nota", "Creada", "Estado", ""]}
        rows={[...myProm].sort((a, b) => b.promiseDate.localeCompare(a.promiseDate)).map(p => (<tr key={p.id} style={{ borderBottom: `1px solid ${BG3}` }}>
          <td style={td({ color: p.promiseDate === TOD ? Y : T4, fontWeight: p.promiseDate === TOD ? 700 : 400 })}>{p.promiseDate}</td>
          <td style={tBs()}>{p.contractNo}</td>
          <td style={tW()}>{p.clientName}</td>
          <td style={td({ color: Y, fontWeight: 700 })}>{f$(p.amount)}</td>
          <td style={tPs()}>{p.gestorName}</td>
          <td style={tS()}>{p.note}</td>
          <td style={tS()}>{p.createdAt}</td>
          <td style={td()}><Bdg l={p.status} /></td>
          <td style={tFl()}>
            {p.status === "Pendiente" && <><Btn label="✓" variant="success" small onClick={() => {
              setPromises(ps => ps.map(x => x.id === p.id ? { ...x, status: "Cumplida" } : x));
              if (onUpdatePromise) onUpdatePromise(p.id, "Cumplida");
            }} /><Btn label="✗" variant="danger" small onClick={() => {
              setPromises(ps => ps.map(x => x.id === p.id ? { ...x, status: "Incumplida" } : x));
              if (onUpdatePromise) onUpdatePromise(p.id, "Incumplida");
            }} /></>}
          </td>
        </tr>))} />
    </div>}
  </div>);
}
// ── POINT SALES ──────────────────────────────────────────────────────────────
function PointSalesView({ clients, setClients, payments, setPayments, pp, pms, cu, pendingSales, setPendingSales, onSavePointSale, pointPrices, fxRate }) {
  const isAdmin = ["superadmin", "admin"].includes(cu.role), isCajero = cu.role === "cajero";
  const [sid, setSid] = useState(null), [stype, setStype] = useState("immediate"), [pts, setPts] = useState(""), [mid, setMid] = useState("1"), [note, setNote] = useState(""), [date, setDate] = useState(new Date().toISOString().split("T")[0]), [ok, setOk] = useState(null), [eYr, setEYr] = useState(0), [eAn, setEAn] = useState(0), [showSim, setShowSim] = useState(false);
  // Precio de VENTA por punto (lo establece el gestor, mín $2 USD, sin máximo)
  const [customPP, setCustomPP] = useState(pp);
  useEffect(() => { setCustomPP(pp); }, [pp]);
  const activePP = Math.max(2, +customPP || pp);
  const ppError = +customPP > 0 && +customPP < 2;

  // Precio de MANTENIMIENTO del año en curso (de point_prices, config por admin)
  const maintPricePerPt = getPriceForYear(pointPrices || [], CY);

  const client = clients.find(c => c.id === sid), pm = pms.find(m => m.id === +mid) || pms[0];
  const fx = fxRate?.rate || 17.5;

  // Para uso inmediato: cobra venta + mantenimiento del año en curso
  // Para otros tipos: solo precio de venta
  const ptsSaleUsd = pts ? +pts * activePP : 0;
  const ptsMaintUsd = (pts && stype === "immediate") ? +pts * maintPricePerPt : 0;
  const totalUsd = ptsSaleUsd + ptsMaintUsd;
  const totalMxn = totalUsd * fx;
  const txC = totalMxn * (pm?.costPct || 0) / 100;

  const yr = client ? Math.max(1, (client.contractYears || 1) - (client.yearsElapsed || 0)) : 1;
  const newYr = yr + (+eYr || 0), newTot = (client?.totalPoints || 0) + (+pts || 0);
  let fA = 0;
  if (stype === "increase_annual" && +eAn > 0) fA = (client?.annualPoints || 0) + (+eAn);
  else if (stype === "hybrid") fA = +eAn > 0 ? (client?.annualPoints || 0) + (+eAn) : calcAP(newTot, client?.pointsUsedToDate || 0, Math.max(1, (client?.contractYears || 1) + (+eYr || 0) - (client?.yearsElapsed || 0)));
  else fA = calcAP(newTot, client?.pointsUsedToDate || 0, newYr);
  const minA = client?.annualPoints || 0;
  const aOk = stype === "immediate" || fA >= minA;
  const canSub = !isCajero && client && pts && +pts > 0 && aOk && !ppError;
  const now = Date.now();

  const submit = () => {
    if (!canSub) return;
    const sale = {
      id: Date.now(), clientId: client.id, clientName: client.name, contractNo: client.contractNo,
      date, pts: +pts, stype, eYr: +eYr || 0, eAn: +eAn || 0,
      totalCost: totalMxn, totalUsd,
      pricePerPt: activePP, maintPricePerPt, ptsMaintUsd, ptsSaleUsd,
      pm: pm?.name || "", costPct: pm?.costPct || 0, note,
      submittedBy: cu.username, submittedAt: new Date().toISOString(),
      expiresAt: new Date(now + 48 * 3600000).toISOString(), status: "Pendiente"
    };
    setPendingSales(ps => [...ps, sale]);
    setOk({ name: client.name, pts: +pts, cost: totalMxn, id: sale.id });
    setPts(""); setNote(""); setSid(null); setEYr(0); setEAn(0); setShowSim(false);
  };
  const validate = id => {
    const sale = pendingSales.find(s => s.id === id); if (!sale) return;
    const p = { id: Date.now(), clientId: sale.clientId, clientName: sale.clientName, contractNo: sale.contractNo, date: sale.date, amount: sale.totalCost, points: sale.pts, method: sale.pm, costPct: sale.costPct, note: `[Venta pts validada] ${sale.note}`, status: "Liquidado", processedBy: sale.submittedBy, processedByCajero: cu.username, type: "point_sale", agentCommission: sale.totalCost * 0.02 };
    setPayments(ps => [...ps, p]);
    setClients(cs => cs.map(c => { if (c.id !== sale.clientId) return c; if (sale.stype === "immediate") { const a2 = c.annualPoints + sale.pts, p2 = c.paidPoints + sale.pts; return { ...c, totalPoints: c.totalPoints + sale.pts, annualPoints: a2, paidPoints: p2, balance: Math.max(0, (a2 - p2) * pp) }; } const nT = c.totalPoints + sale.pts, nCY = (c.contractYears || yr) + sale.eYr, nYR = Math.max(1, nCY - (c.yearsElapsed || 0)); const rA = sale.eAn > 0 ? c.annualPoints + sale.eAn : calcAP(nT, c.pointsUsedToDate || 0, nYR); return { ...c, totalPoints: nT, contractYears: nCY, yearsRemaining: nYR, annualPoints: rA, balance: Math.max(0, (rA - (c.paidPoints || 0)) * pp) }; }));
    setPendingSales(ps => ps.map(s => s.id === id ? { ...s, status: "Validada", validatedBy: cu.username } : s));
    if (onSavePointSale) {
      const cli = clients.find(c => c.id === sale.clientId);
      const nT = cli ? cli.totalPoints + sale.pts : null;
      const nA = sale.stype === 'immediate' ? (cli ? cli.annualPoints + sale.pts : null) : (sale.eAn > 0 && cli ? cli.annualPoints + sale.eAn : null);
      const nCY = cli && sale.eYr ? (cli.contractYears || 10) + sale.eYr : null;
      onSavePointSale({
        clientId: sale.clientId, stype: sale.stype, pts: sale.pts,
        eYr: sale.eYr || 0, eAn: sale.eAn || 0,
        totalMxn: sale.totalCost,
        totalUsd: sale.totalUsd || sale.totalCost / fx,
        pricePerPt: sale.pricePerPt || pp,
        newTotalPoints: nT, newAnnualPoints: nA, newContractYears: nCY,
        note: sale.note,
      });
    }
  };
  const cancel = id => setPendingSales(ps => ps.map(s => s.id === id ? { ...s, status: "Cancelada" } : s));
  const actPend = pendingSales.filter(s => s.status === "Pendiente" && new Date(s.expiresAt).getTime() > now);
  const sim = client && pts && +pts > 0 ? { before: { tot: client.totalPoints, an: client.annualPoints, yr, paid: client.paidPoints }, after: { tot: stype === "immediate" ? client.totalPoints + (+pts) : newTot, an: stype === "immediate" ? client.annualPoints + (+pts) : fA, yr: stype === "immediate" ? yr : newYr, paid: stype === "immediate" ? client.paidPoints + (+pts) : client.paidPoints } } : null;
  const tOpts = [{ v: "immediate", l: "Uso inmediato (+ mantenimiento)" }, ...(isAdmin || cu.role === "gestor" ? [{ v: "extend_term", l: "Ampliar plazo" }, { v: "increase_annual", l: "Aumentar pts/año" }, { v: "hybrid", l: "Híbrido" }] : [])];
  return (<div style={{ display: "grid", gridTemplateColumns: "1fr 1.1fr", gap: 14, alignItems: "start" }}>
    <div style={{ background: BG2, border: `1px solid ${BD}`, borderRadius: 12, padding: 18 }}>
      {isCajero ? (<div>
        <Sec t="Validar Ventas Pendientes" />
        <div style={{ fontSize: 11, color: T3, marginBottom: 12 }}>Valida o cancela ventas de puntos de gestores. Sin validación en 48h se cancelan automáticamente.</div>
        {actPend.length === 0 ? <div style={{ color: T4, fontSize: 11, textAlign: "center", padding: "18px 0" }}>Sin ventas pendientes.</div> : actPend.map(s => {
          const hrs = Math.max(0, Math.round((new Date(s.expiresAt).getTime() - now) / 3600000)); return (<div key={s.id} style={{ background: BG3, borderRadius: 8, padding: "11px", marginBottom: 9, border: `1px solid ${Y}33` }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}><div><b style={{ color: T1 }}>{s.clientName}</b><span style={{ color: T4, fontSize: 10, marginLeft: 7 }}>{s.contractNo}</span></div><span style={{ color: Y, fontSize: 10 }}>Expira en {hrs}h</span></div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 5, marginBottom: 8, fontSize: 10 }}>
              {[["Pts", s.pts.toLocaleString(), P], ["Tipo", s.stype === "immediate" ? "Inmediato" : s.stype, T3], ["Total", fMXN(s.totalCost), G]].map(([l, v, c]) => (<div key={l}><div style={{ fontSize: 8, color: T4, textTransform: "uppercase" }}>{l}</div><div style={{ color: c, fontWeight: 700 }}>{v}</div></div>))}
            </div>
            <div style={{ fontSize: 9, color: T4, marginBottom: 7 }}>Por: {s.submittedBy}·{s.note}</div>
            <div style={{ display: "flex", gap: 7 }}><Btn label="✓ Validar y Aplicar" variant="success" onClick={() => validate(s.id)} /><Btn label="✗ Cancelar" variant="danger" small onClick={() => cancel(s.id)} /></div>
          </div>);
        })}</div>
      ) : (<div>
        <Sec t="Venta de Puntos Adicionales" />
        {ok && <div style={{ background: P + "12", border: `1px solid ${P}28`, borderRadius: 7, padding: "8px 10px", marginBottom: 11, fontSize: 11 }}><div style={{ color: P, fontWeight: 700, marginBottom: 2 }}>✓ Enviado a validación (ID:{ok.id})</div><div style={{ color: T3 }}>{ok.name}·{ok.pts.toLocaleString()} pts·{f$(ok.cost)} — Caja tiene 48h para validar</div></div>}
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          <SearchBox clients={clients.filter(c => c.contractStatus === "Active")} onSelect={v => { setSid(v); setEYr(0); setEAn(0); setShowSim(false); }} selectedId={sid} />
          {client && <div style={{ padding: "7px 9px", background: BG3, borderRadius: 6, display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 4, fontSize: 10 }}>
            {[["Pts tot.", client.totalPoints.toLocaleString(), B], ["Pts/año", client.annualPoints.toLocaleString(), P], ["Pagados", client.paidPoints.toLocaleString(), G], ["Años rest.", yr + " a", Y]].map(([l, v, c]) => (<div key={l}><div style={{ fontSize: 8, color: T4, textTransform: "uppercase" }}>{l}</div><div style={{ color: c, fontWeight: 700 }}>{v}</div></div>))}
          </div>}
          <Inp label="Tipo de venta" value={stype} onChange={v => { setStype(v); setEYr(0); setEAn(0); }} opts={tOpts} />
          <div>
            <Inp label="Precio de VENTA por punto (USD) — mín. $2.00 USD" value={customPP} onChange={v => setCustomPP(+v)} type="number" />
            {ppError && <div style={{ color: R, fontSize: 10, marginTop: 3, fontWeight: 700 }}>⛔ El precio mínimo de venta es $2.00 USD por punto.</div>}
            {!ppError && customPP > 0 && <div style={{ color: T4, fontSize: 9, marginTop: 3 }}>Precio de venta: {fUSD(activePP)}/pt{stype === "immediate" ? ` · Mantenimiento {CY}: ${fUSD(maintPricePerPt)}/pt (se cobra en esta transacción)` : " · Sin cargo de mantenimiento en esta compra"}</div>}
            {stype === "immediate" && pts > 0 && !ppError && <div style={{ background: B + "12", borderRadius: 5, padding: "5px 8px", marginTop: 5, fontSize: 10 }}>
              <div style={{ color: B, fontWeight: 700 }}>Desglose del cobro:</div>
              <div style={{ color: T2 }}>Venta {pts} pts × {fUSD(activePP)} = <b>{fUSD(ptsSaleUsd)}</b></div>
              <div style={{ color: T2 }}>Mantenimiento {CY}: {pts} pts × {fUSD(maintPricePerPt)} = <b>{fUSD(ptsMaintUsd)}</b></div>
              <div style={{ color: T1, fontWeight: 700 }}>Total USD: {fUSD(totalUsd)} · Total MXN: {fMXN(totalMxn)}</div>
            </div>}
          </div>
          <Inp label="Puntos a vender" value={pts} onChange={setPts} type="number" />
          {stype === "hybrid" && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}><Inp label="Años adicionales" value={eYr} onChange={v => setEYr(Math.max(0, +v))} type="number" /><Inp label="Pts/año adicionales" value={eAn} onChange={v => setEAn(Math.max(0, +v))} type="number" /></div>}
          {stype === "increase_annual" && <Inp label="Pts/año adicionales" value={eAn} onChange={v => setEAn(Math.max(0, +v))} type="number" />}
          <Inp label="Medio de Pago" value={mid} onChange={setMid} opts={pms.filter(m => m.active).map(m => ({ v: m.id, l: `${m.name} — ${m.costPct}%` }))} />
          <Inp label="Fecha" value={date} onChange={setDate} type="date" />
          <Inp label="Notas" value={note} onChange={setNote} />
        </div>
        {sim && pts > 0 && <div style={{ marginTop: 9 }}>
          <button onClick={() => setShowSim(!showSim)} style={{ background: B + "20", color: B, border: `1px solid ${B}44`, borderRadius: 7, padding: "5px 13px", fontSize: 11, cursor: "pointer", fontFamily: "inherit", fontWeight: 600, width: "100%" }}>{showSim ? "▲ Ocultar simulación" : "▼ Ver simulación de membresía"}</button>
          {showSim && <div style={{ background: BG3, borderRadius: 8, padding: "11px", marginTop: 7, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 }}>
            {[["Estado Actual", sim.before, T2], ["Después de la Venta", sim.after, G]].map(([ttl, d, tc]) => (<div key={ttl}>
              <div style={{ fontSize: 9, color: tc, textTransform: "uppercase", marginBottom: 6 }}>{ttl}</div>
              {[["Pts totales", d.tot.toLocaleString()], ["Pts anuales", d.an.toLocaleString()], ["Años restantes", d.yr], ["Pts pagados", d.paid.toLocaleString()]].map(([l, v]) => (<div key={l} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, padding: "2px 0", borderBottom: `1px solid ${BD}` }}><span style={{ color: T4 }}>{l}</span><span style={{ color: tc, fontWeight: 600 }}>{v}</span></div>))}
            </div>))}
          </div>}
        </div>}
        {pts > 0 && client && <div style={{ margin: "9px 0", padding: "8px", background: BG3, borderRadius: 7, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
          {[["Total MXN", fMXN(totalMxn), P], stype === "immediate" ? ["Venta+Mant.", `${fUSD(ptsSaleUsd)}+${fUSD(ptsMaintUsd)}`, T2] : ["Solo venta", fUSD(ptsSaleUsd), T2], ["Costo tx", f$(txC), Y]].map(([l, v, c]) => (<div key={l}><div style={{ fontSize: 8, color: T4, textTransform: "uppercase" }}>{l}</div><div style={{ color: c, fontWeight: 700, fontSize: 11 }}>{v}</div></div>))}
        </div>}
        {!aOk && pts > 0 && <div style={{ color: R, fontSize: 10, marginBottom: 7 }}>⚠ No puede quedar con menos de {minA.toLocaleString()} pts/año.</div>}
        <Btn label="Enviar a Validación por Caja" onClick={submit} disabled={!canSub} />
        <div style={{ fontSize: 9, color: T4, marginTop: 4 }}>Caja tiene 48h para validar o se cancela automáticamente.</div>
      </div>)}
    </div>
    <div style={{ background: BG2, border: `1px solid ${BD}`, borderRadius: 12, padding: 18 }}>
      <Sec t="Historial de Ventas" />
      {pendingSales.length === 0 ? <div style={{ color: T4, fontSize: 11, textAlign: "center", padding: "18px 0" }}>Sin ventas registradas</div>
        : <Tbl cols={["Fecha", "Contrato", "Cliente", "Pts", "Total", "Tipo", "Por", "Estado"]} rows={[...pendingSales].reverse().slice(0, 15).map(s => {
          const exp = s.status === "Pendiente" && new Date(s.expiresAt).getTime() <= now; return (<tr key={s.id} style={{ borderBottom: `1px solid ${BG3}` }}>
            <td style={tS()}>{s.date}</td>
            <td style={tBs()}>{s.contractNo}</td>
            <td style={tW11()}>{s.clientName}</td>
            <td style={td({ color: P, fontWeight: 700 })}>{s.pts.toLocaleString()}</td>
            <td style={tGb()}>{f$(s.totalCost)}</td>
            <td style={td({ color: T3, fontSize: 9 })}>{s.stype}</td>
            <td style={td({ color: P, fontSize: 9 })}>{s.submittedBy}</td>
            <td style={td()}><Bdg l={exp ? "Expirada" : s.status} /></td>
          </tr>);
        })} />}
    </div>
  </div>);
}
// ── REPORTS (compact) ────────────────────────────────────────────────────────
function ReportsView({ clients, reservations, payments, pp, users, role, courtesies, rc, condonations }) {
  const [rep, setRep] = useState("col");
  const [period, setPeriod] = useState("mtd"); // mtd | ytd | lm | ly
  const tabs = [["col", "Cobranza"], ["mora", "Morosidad"], ["prom", "Promesas Pago"], ["res", "Reservaciones"], ["cgestor", "Costo Gestor"], ["cglobal", "Costo Global"], ["pts", "Puntos"], ["ptsAvail", "Pts Disponibles"], ["cort", "Cortesías"], ...(role === "superadmin" ? [["cto", "Contratos"]] : [])];
  // Filtrar pagos según periodo
  const filterP = () => {
    const now = TODAY; const y = now.getFullYear(), m = now.getMonth();
    if (period === "mtd") return payments.filter(p => p.date && new Date(p.date).getFullYear() === y && new Date(p.date).getMonth() === m);
    if (period === "ytd") return payments.filter(p => p.date && new Date(p.date).getFullYear() === y);
    if (period === "lm") { const lmY = m === 0 ? y - 1 : y, lmM = m === 0 ? 11 : m - 1; return payments.filter(p => p.date && new Date(p.date).getFullYear() === lmY && new Date(p.date).getMonth() === lmM); }
    if (period === "ly") return payments.filter(p => p.date && new Date(p.date).getFullYear() === y - 1);
    return payments;
  };
  const filterR = () => {
    const now = TODAY; const y = now.getFullYear(), m = now.getMonth();
    if (period === "mtd") return reservations.filter(r => r.checkIn && new Date(r.checkIn).getFullYear() === y && new Date(r.checkIn).getMonth() === m);
    if (period === "ytd") return reservations.filter(r => r.checkIn && new Date(r.checkIn).getFullYear() === y);
    if (period === "lm") { const lmY = m === 0 ? y - 1 : y, lmM = m === 0 ? 11 : m - 1; return reservations.filter(r => r.checkIn && new Date(r.checkIn).getFullYear() === lmY && new Date(r.checkIn).getMonth() === lmM); }
    if (period === "ly") return reservations.filter(r => r.checkIn && new Date(r.checkIn).getFullYear() === y - 1);
    return reservations;
  };
  const filteredPayments = filterP(), filteredReservations = filterR();
  const staff = users.filter(u => ["gestor", "cajero", "admin"].includes(u.role));
  const colTotal = filteredPayments.reduce((a, p) => a + p.amount, 0);
  const txCost = filteredPayments.reduce((a, p) => a + p.amount * (p.costPct || 0) / 100, 0);
  const commAll = filteredPayments.reduce((a, p) => a + (p.agentCommission || 0), 0) + filteredReservations.filter(r => r.status === "Confirmed").length * rc;
  const salaryAll = staff.reduce((a, u) => a + (u.salary || 0), 0);
  const socialCostAll = staff.reduce((a, u) => a + (u.socialCost || 0), 0);
  const totalPayrollAll = salaryAll + socialCostAll;
  const en = clients.map(c => { const d = dOvr(c.dueDate); const cl = getClientStatus(c, payments, condonations); return { ...c, dOvr: d, cls: cl, interest: cInt(c.balance, d, cl.r * 12) }; });
  const Row = ({ items }) => (<>{items.map(([l, v, c]) => (<div key={l} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: `1px solid ${BG3}` }}><span style={{ color: T4, fontSize: 11 }}>{l}</span><span style={{ color: c || T2, fontWeight: 600, fontSize: 11 }}>{v}</span></div>))}</>);
  return (<div>
    <div style={{ display: "flex", gap: 4, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
      <span style={{ fontSize: 9, color: T4, textTransform: "uppercase", marginRight: 5 }}>Periodo:</span>
      {[["mtd", "Mes a la fecha"], ["ytd", "Año a la fecha"], ["lm", "Mes anterior"], ["ly", "Año anterior"]].map(([id, l]) => (
        <button key={id} onClick={() => setPeriod(id)} style={{ background: period === id ? B : BG2, color: period === id ? "#fff" : T4, border: `1px solid ${period === id ? B : BD}`, borderRadius: 7, padding: "3px 10px", fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{l}</button>))}
    </div>
    <div style={{ display: "flex", gap: 4, marginBottom: 14, flexWrap: "wrap" }}>
      {tabs.map(([id, l]) => (<button key={id} onClick={() => setRep(id)} style={{ background: rep === id ? IND : BG2, color: rep === id ? "#fff" : T4, border: `1px solid ${rep === id ? IND : BD}`, borderRadius: 7, padding: "4px 11px", fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>{l}</button>))}
    </div>
    {rep === "col" && <div>
      <div style={{ display: "flex", gap: 9, flexWrap: "wrap", marginBottom: 14 }}>
        <Kpi label={`Recaudado (${period})`} value={f$(colTotal)} accent={G} />
        <Kpi label="Saldo Total" value={f$(clients.reduce((a, c) => a + c.balance, 0))} accent={R} />
        <Kpi label="Intereses Mora" value={f$(en.reduce((a, c) => a + c.interest, 0))} accent={Y} warn />
      </div>
      <Tbl cols={["Contrato", "Cliente", "Pagado", "Saldo", "Interés", "# Pagos", "Cobertura"]}
        rows={clients.map(c => {
          const inv = c.annualPoints * pp, paid = c.paidPoints * pp, n = payments.filter(p => p.clientId === c.id).length; return (<tr key={c.id} style={{ borderBottom: `1px solid ${BG3}` }}>
            <td style={tBs()}>{c.contractNo}</td>
            <td style={tW()}>{c.name}</td>
            <td style={tG()}>{f$(paid)}</td>
            <td style={td({ color: c.balance > 0 ? R : G, fontWeight: 700 })}>{f$(c.balance)}</td>
            <td style={tY()}>{en.find(x => x.id === c.id)?.interest > 0 ? f$(en.find(x => x.id === c.id).interest) : "—"}</td>
            <td style={tG3()}>{n}</td>
            <td style={td()}><div style={{ display: "flex", alignItems: "center", gap: 5 }}><div style={{ width: 38, height: 4, background: BD, borderRadius: 3 }}><div style={{ width: `${Math.min(100, Math.round((paid / inv) * 100))}%`, height: "100%", background: paid >= inv ? G : Y, borderRadius: 3 }} /></div><span style={{ fontSize: 9, color: T4 }}>{Math.round((paid / inv) * 100)}%</span></div></td>
          </tr>);
        })} />
    </div>}
    {rep === "mora" && <div>
      <div style={{ display: "flex", gap: 9, flexWrap: "wrap", marginBottom: 14 }}>
        {[{ l: "Al corriente", c: G }, { l: "1–30 días", c: "#a3e635" }, { l: "31–60 días", c: Y }, { l: "61–90 días", c: O }, { l: "91–180 días", c: R }, { l: "+180 días", c: "#dc2626" }].map(bk => { const cnt = en.filter(c => c.cls.l === bk.l).length, bal = en.filter(c => c.cls.l === bk.l).reduce((a, c) => a + c.balance, 0); return (<div key={bk.l} style={{ background: BG2, border: `1px solid ${bk.c}22`, borderRadius: 9, padding: "11px 14px", flex: "1 1 100px", borderLeft: `2px solid ${bk.c}` }}><div style={{ fontSize: 8, color: T4, textTransform: "uppercase", marginBottom: 3 }}>{bk.l}</div><div style={{ fontSize: 18, fontWeight: 800, color: bk.c }}>{cnt}</div><div style={{ fontSize: 9, color: T4 }}>{f$(bal)}</div></div>); })}
      </div>
      <Tbl cols={["Contrato", "Cliente", "Vence", "Días", "Clasificación", "Saldo", "Interés", "Total", "Tasa %"]}
        rows={en.filter(c => c.balance > 0).sort((a, b) => b.dOvr - a.dOvr).map(c => (<tr key={c.id} style={{ borderBottom: `1px solid ${BG3}` }}>
          <td style={tBs()}>{c.contractNo}</td>
          <td style={tW()}>{c.name}</td>
          <td style={tS()}>{c.dueDate}</td>
          <td style={td({ color: c.dOvr > 90 ? R : Y, fontWeight: 700 })}>{c.dOvr > 0 ? c.dOvr : 0}</td>
          <td style={td()}><Bdg l={c.cls.l} /></td>
          <td style={tRb()}>{f$(c.balance)}</td>
          <td style={tY()}>{f$(c.interest)}</td>
          <td style={tRb()}>{f$(c.balance + c.interest)}</td>
          <td style={tY()}>{c.cls.r * 12}% anual</td>
        </tr>))} />
    </div>}
    {rep === "prom" && <Tbl cols={["Contrato", "Cliente", "Tel", "Días Mora", "Saldo", "Interés", "Total", "Gestor", "Acción"]}
      rows={en.filter(c => c.balance > 0).sort((a, b) => b.dOvr - a.dOvr).map(c => (<tr key={c.id} style={{ borderBottom: `1px solid ${BG3}` }}>
        <td style={tBs()}>{c.contractNo}</td>
        <td style={tW()}>{c.name}</td>
        <td style={tG3s()}>{(c.phones || []).find(p => p.active !== false)?.number || "—"}</td>
        <td style={td({ color: c.dOvr > 90 ? R : Y, fontWeight: 700 })}>{c.dOvr}</td>
        <td style={tRb()}>{f$(c.balance)}</td>
        <td style={tY()}>{f$(c.interest)}</td>
        <td style={tRb()}>{f$(c.balance + c.interest)}</td>
        <td style={tPs()}>{users.find(u => String(u.id) === String(c.assignedGestor))?.name || "—"}</td>
        <td style={td({ color: T4, fontSize: 9 })}>{c.dOvr > 90 ? "⛔ Escalar" : c.dOvr > 30 ? "📞 Urgente" : "📞 Contactar"}</td>
      </tr>))} />}
    {rep === "res" && <div>
      <div style={{ display: "flex", gap: 9, flexWrap: "wrap", marginBottom: 14 }}>
        <Kpi label={`Total Reservas (${period})`} value={filteredReservations.length} accent={P} />
        <Kpi label="Confirmadas" value={filteredReservations.filter(r => r.status === "Confirmed").length} accent={G} />
        <Kpi label="Pts Totales" value={fP(filteredReservations.reduce((a, r) => a + r.pointsUsed, 0))} accent={B} />
        <Kpi label="Noches" value={filteredReservations.reduce((a, r) => a + r.nights, 0)} accent={Y} />
      </div>
      <Tbl cols={["Folio", "Contrato", "Cliente", "Unidad", "Temp.", "Entrada", "Salida", "Noches", "Pts", "Gestor", "Estado"]}
        rows={[...filteredReservations].reverse().map(r => (<tr key={r.id} style={{ borderBottom: `1px solid ${BG3}` }}>
          <td style={td({ color: T3, fontSize: 9 })}>RES-{r.id}</td>
          <td style={tBs()}>{r.contractNo}</td>
          <td style={tW()}>{r.clientName}</td>
          <td style={tG3()}>{r.unitName}</td>
          <td style={tG3()}>{r.seasonName}</td>
          <td style={tS()}>{r.checkIn}</td>
          <td style={tS()}>{r.checkOut}</td>
          <td style={tT2()}>{r.nights}</td>
          <td style={tBb()}>{r.pointsUsed.toLocaleString()}</td>
          <td style={tPs()}>{r.processedBy}</td>
          <td style={td()}><Bdg l={r.status} /></td>
        </tr>))} />
    </div>}
    {rep === "cgestor" && <div>
      <div style={{ display: "flex", gap: 9, flexWrap: "wrap", marginBottom: 14 }}>
        <Kpi label="Sueldos Base" value={f$(salaryAll)} accent={B} />
        <Kpi label="Costo Social" value={f$(socialCostAll)} accent={O} />
        <Kpi label="Nómina Total" value={f$(totalPayrollAll)} accent={P} />
        <Kpi label="Comisiones YTD" value={f$(commAll)} accent={G} />
        <Kpi label="Costo Financiero" value={f$(txCost)} accent={Y} />
      </div>
      <Tbl cols={["Empleado", "Rol", "Sueldo", "Costo Tx", "Comm Cobros", "Comm Res", "Total", "Ingresos", "Ratio"]}
        rows={staff.map(u => {
          const uP = filteredPayments.filter(p => p.processedBy === u.username); const uR = filteredReservations.filter(r => r.processedBy === u.username); const txC2 = uP.reduce((a, p) => a + p.amount * (p.costPct || 0) / 100, 0); const cC = uP.reduce((a, p) => a + p.amount * (0), 0); const cR = uR.length * rc; const tot = (u.salary || 0) + txC2 + cC + cR; const rev = uP.reduce((a, p) => a + p.amount, 0); const ratio = rev > 0 ? tot / rev : 0; return (<tr key={u.id} style={{ borderBottom: `1px solid ${BG3}` }}>
            <td style={td()}><div style={{ display: "flex", alignItems: "center", gap: 6 }}><div style={{ width: 18, height: 18, borderRadius: 5, background: (u.color||P) + "20", border: `1px solid ${(u.color||P)}33`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: u.color||P, fontWeight: 700 }}>{(u.name||u.username||"?")[0]}</div><span style={{ color: T1, fontWeight: 600, fontSize: 11 }}>{u.name}</span></div></td>
            <td style={td()}><RBdg r={u.role} /></td>
            <td style={td({ color: B })}>{f$(u.salary || 0)}</td>
            <td style={tY()}>{f$(txC2)}</td>
            <td style={tG()}>{f$(cC)}</td>
            <td style={tP()}>{f$(cR)}</td>
            <td style={tRb()}>{f$(tot)}</td>
            <td style={tT2()}>{f$(rev)}</td>
            <td style={td()}><div style={{ display: "flex", alignItems: "center", gap: 5 }}><div style={{ width: 38, height: 4, background: BD, borderRadius: 3 }}><div style={{ width: `${Math.min(100, ratio * 100)}%`, height: "100%", background: ratio > .3 ? R : ratio > .15 ? Y : G, borderRadius: 3 }} /></div><span style={{ fontSize: 9, color: ratio > .3 ? R : ratio > .15 ? Y : G, fontWeight: 700 }}>{(ratio * 100).toFixed(1)}%</span></div></td>
          </tr>);
        })} />
    </div>}
    {rep === "cglobal" && <div>
      <div style={{ display: "flex", gap: 9, flexWrap: "wrap", marginBottom: 14 }}>
        <Kpi label={`Ingresos (${period})`} value={f$(colTotal)} accent={G} />
        <Kpi label="Costo Financiero" value={f$(txCost)} sub={colTotal > 0 ? ((txCost / colTotal) * 100).toFixed(1) + "%" : ""} accent={Y} />
        <Kpi label="Comisiones" value={f$(commAll)} sub={colTotal > 0 ? ((commAll / colTotal) * 100).toFixed(1) + "%" : ""} accent={P} />
        <Kpi label="Nómina Mensual" value={f$(totalPayrollAll)} sub={colTotal > 0 ? ((totalPayrollAll / colTotal) * 100).toFixed(1) + "%" : ""} accent={B} />
        <Kpi label="Costo Total" value={f$(txCost + commAll + totalPayrollAll)} sub={colTotal > 0 ? (((txCost + commAll + totalPayrollAll) / colTotal) * 100).toFixed(1) + "% de ingresos" : ""} accent={R} warn />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 13 }}>
        <div style={{ background: BG2, border: `1px solid ${BD}`, borderRadius: 10, padding: 15 }}>
          <Sec t="Composición del Costo (% sobre ingresos)" />
          {(() => {
            const total = txCost + commAll + totalPayrollAll; return [["Costo financiero (medios)", txCost, Y], ["Comisiones cobros+reservas", commAll, G], ["Sueldos base", salaryAll, B], ["Costo social", socialCostAll, O]].map(([l, v, c]) => {
              const pctIngr = colTotal > 0 ? (v / colTotal) * 100 : 0; const pctTot = total > 0 ? (v / total) * 100 : 0; return (<div key={l} style={{ padding: "6px 0", borderBottom: `1px solid ${BG3}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}><div style={{ width: 6, height: 6, borderRadius: "50%", background: c }} /><span style={{ color: T3, fontSize: 11 }}>{l}</span></div>
                  <span style={{ color: c, fontWeight: 700 }}>{f$(v)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: T4 }}>
                  <span>{pctIngr.toFixed(1)}% de ingresos</span>
                  <span>{pctTot.toFixed(1)}% del costo total</span>
                </div>
                <div style={{ width: "100%", height: 3, background: BD, borderRadius: 2, marginTop: 3 }}><div style={{ width: `${pctTot}%`, height: "100%", background: c, borderRadius: 2 }} /></div>
              </div>);
            });
          })()}
          <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", marginTop: 4 }}><span style={{ color: T1, fontWeight: 700 }}>TOTAL</span><div style={{ textAlign: "right" }}><div style={{ color: R, fontWeight: 800, fontSize: 14 }}>{f$(txCost + commAll + totalPayrollAll)}</div>{colTotal > 0 && <div style={{ color: R, fontSize: 10 }}>{(((txCost + commAll + totalPayrollAll) / colTotal) * 100).toFixed(1)}% de ingresos</div>}</div></div>
        </div>
        <div style={{ background: BG2, border: `1px solid ${BD}`, borderRadius: 10, padding: 15 }}>
          <Sec t="Costo por Medio de Pago" />
          {[...new Set(filteredPayments.map(p => p.method))].map(m => {
            const mP = filteredPayments.filter(p => p.method === m), mC = mP.reduce((a, p) => a + p.amount * (p.costPct || 0) / 100, 0), mA = mP.reduce((a, p) => a + p.amount, 0); const pctIngr = colTotal > 0 ? (mC / colTotal) * 100 : 0; return (<div key={m} style={{ padding: "6px 0", borderBottom: `1px solid ${BG3}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div><div style={{ color: T1, fontSize: 11 }}>{m}</div><div style={{ color: T4, fontSize: 9 }}>{mP.length}tx · {f$(mA)}</div></div>
                <div style={{ textAlign: "right" }}><div style={{ color: Y, fontWeight: 700 }}>{f$(mC)}</div><div style={{ color: T4, fontSize: 9 }}>{pctIngr.toFixed(2)}% ingresos</div></div>
              </div>
            </div>);
          })}
        </div>
      </div>
    </div>}
    {rep === "pts" && <div>
      <div style={{ display: "flex", gap: 9, flexWrap: "wrap", marginBottom: 14 }}>
        <Kpi label="Pts Totales Contratos" value={fP(clients.reduce((a, c) => a + c.totalPoints, 0))} accent={B} />
        <Kpi label="Pts Anuales" value={fP(clients.reduce((a, c) => a + c.annualPoints, 0))} accent={P} />
        <Kpi label="Pts Pagados" value={fP(clients.reduce((a, c) => a + c.paidPoints, 0))} accent={G} />
        <Kpi label={`Pts vencen Dic 31, ${CY}`} value={fP(clients.filter(c => c.contractStatus === "Active").reduce((a, c) => a + Math.max(0, c.annualPoints - c.paidPoints), 0))} sub="si no se pagan" accent={R} warn />
      </div>
      <Tbl cols={["Contrato", "Cliente", "Pts/Año", "Pagados", "Sin Pagar", "Vencimiento", "Pts Guard.", "Estado"]}
        rows={clients.map(c => {
          const unpaid = Math.max(0, c.annualPoints - c.paidPoints), saved = (c.savedPoints || []).reduce((a, sp) => a + sp.points, 0); return (<tr key={c.id} style={{ borderBottom: `1px solid ${BG3}` }}>
            <td style={tBs()}>{c.contractNo}</td>
            <td style={tW()}>{c.name}</td>
            <td style={tP()}>{fP(c.annualPoints)}</td>
            <td style={tG()}>{fP(c.paidPoints)}</td>
            <td style={td({ color: unpaid > 0 ? R : G, fontWeight: 700 })}>{fP(unpaid)}</td>
            <td style={tYs()}>Dic 31 {CY}</td>
            <td style={tP()}>{saved > 0 ? fP(saved) : "—"}</td>
            <td style={td()}><Bdg l={unpaid > 0 ? "Pendiente" : "Liquidado"} /></td>
          </tr>);
        })} />
    </div>}
    {rep === "ptsAvail" && <div>
      <div style={{ fontSize: 11, color: T4, marginBottom: 12 }}>Clientes con <b style={{ color: G }}>mantenimiento pagado este año</b> ({CY}) que tienen puntos disponibles sin usar en reservaciones del año.</div>
      {(() => {
        const maintPaidThisYear = new Set(payments.filter(p => p.type === "maintenance" && p.date && new Date(p.date).getFullYear() === CY).map(p => p.clientId));
        const list = clients.filter(c => c.contractStatus === "Active" && maintPaidThisYear.has(c.id)).map(c => {
          const usedP = reservations.filter(r => r.clientId === c.id && r.status === "Confirmed" && r.checkIn && new Date(r.checkIn).getFullYear() === CY).reduce((a, r) => a + r.pointsUsed, 0);
          const savedA = (c.savedPoints || []).filter(sp => new Date(sp.expiryDate) > new Date()).reduce((a, sp) => a + sp.points, 0);
          const avail = c.paidPoints - usedP + savedA;
          return { ...c, usedP, savedA, avail };
        }).filter(c => c.avail > 0).sort((a, b) => b.avail - a.avail);
        const totalAvail = list.reduce((a, c) => a + c.avail, 0); const totalSaved = list.reduce((a, c) => a + c.savedA, 0); return (<>
          <div style={{ display: "flex", gap: 9, flexWrap: "wrap", marginBottom: 14 }}>
            <Kpi label="Clientes con pts disponibles" value={list.length} accent={G} />
            <Kpi label="Total pts disponibles" value={fP(totalAvail)} accent={P} />
            <Kpi label="Pts guardados (de años previos)" value={fP(totalSaved)} accent={C} />
          </div>
          <Tbl cols={["Contrato", "Cliente", "Pagados", "Usados este año", "Guardados", "Disponibles", "Gestor", "Estado Cuota"]}
            rows={list.map(c => {
              const d = dOvr(c.dueDate); const cl = getClientStatus(c, payments, condonations); return (<tr key={c.id} style={{ borderBottom: `1px solid ${BG3}` }}>
                <td style={tBs()}>{c.contractNo}</td>
                <td style={tW()}>{c.name}</td>
                <td style={tG()}>{fP(c.paidPoints)}</td>
                <td style={tBs()}>{fP(c.usedP)}</td>
                <td style={tP()}>{c.savedA > 0 ? fP(c.savedA) : "—"}</td>
                <td style={{ ...td(), color: G, fontWeight: 700, fontSize: 13 }}>{fP(c.avail)}</td>
                <td style={tPs()}>{users.find(u => String(u.id) === String(c.assignedGestor))?.name || "—"}</td>
                <td style={td()}><Bdg l={cl.l} /></td>
              </tr>);
            })} />
        </>);
      })()}
    </div>}
    {rep === "cort" && <div>
      <div style={{ display: "flex", gap: 9, flexWrap: "wrap", marginBottom: 14 }}>
        <Kpi label="Total Cortesías" value={courtesies.length} accent={P} />
        <Kpi label="Valor Estimado" value={f$(courtesies.reduce((a, c) => c.type === "balance_reduction" ? a + c.amount : c.type === "points" ? a + c.amount * pp : a + 500, 0))} accent={O} warn />
      </div>
      <Tbl cols={["Fecha", "Contrato", "Cliente", "Tipo", "Cantidad", "Categoría", "Motivo", "Por"]}
        rows={[...courtesies].reverse().map(c => (<tr key={c.id} style={{ borderBottom: `1px solid ${BG3}` }}>
          <td style={tS()}>{c.date}</td>
          <td style={tBs()}>{c.contractNo}</td>
          <td style={tW()}>{c.clientName}</td>
          <td style={tPs()}>{c.type}</td>
          <td style={td({ color: P, fontWeight: 700 })}>{c.type === "points" ? fP(c.amount) : f$(c.amount)}</td>
          <td style={tYs()}>{c.category}</td>
          <td style={tG3s()}>{c.reason}</td>
          <td style={tPs()}>{c.grantedBy}</td>
        </tr>))} />
    </div>}
    {rep === "cto" && role === "superadmin" && <Tbl cols={["Contrato", "Cliente", "Pts Tot.", "Saldo", "Estado", "Cto.", "Cancelación", "Motivo"]}
      rows={clients.map(c => (<tr key={c.id} style={{ borderBottom: `1px solid ${BG3}` }}>
        <td style={tBb()}>{c.contractNo}</td>
        <td style={tW()}>{c.name}</td>
        <td style={tG3()}>{fP(c.totalPoints)}</td>
        <td style={td({ color: c.balance > 0 ? R : G, fontWeight: 700 })}>{f$(c.balance)}</td>
        <td style={td()}><Bdg l={c.status} /></td>
        <td style={td()}><Bdg l={c.contractStatus} /></td>
        <td style={tS()}>{c.cancelDate || "—"}</td>
        <td style={tS()}>{c.cancelReason || "—"}</td>
      </tr>))} />}
  </div>);
}
// ── CONFIG ───────────────────────────────────────────────────────────────────
function PpEditor({ pp, setPp, onSavePricePerPoint }) {
  const [draft, setDraft] = useState(pp);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setDraft(pp); }, [pp]);
  const dirty = +draft !== +pp;
  const apply = async () => {
    if (!dirty || +draft <= 0) return;
    setSaving(true);
    try { if (onSavePricePerPoint) await onSavePricePerPoint(+draft); else setPp(+draft); }
    finally { setSaving(false); }
  };
  return (<div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
    <div style={{ flex: 1 }}><Inp label="Precio ($/pt/año)" value={draft} onChange={v => setDraft(+v)} type="number" /></div>
    <div style={{ color: B, fontWeight: 800, fontSize: 22 }}>{f$(pp)}</div>
    {dirty && <Btn label={saving ? "Guardando..." : "Aplicar"} variant="success" onClick={apply} disabled={saving || +draft <= 0} />}
  </div>);
}

// ── SEASON ROW — múltiples rangos de fechas por temporada ──────────────────
const MONTHS_CONF = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
function SeasonRow({ meta, editU, setEditU, saveSeasonRange, removeSeasonRange }) {
  // Todos los rangos de esta temporada para esta unidad
  const ranges = (editU.seasons || []).filter(x => (x.season || x.id) === meta.id);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const emptyForm = { sm: 1, sd: 1, em: 12, ed: 31, wd: ranges[0]?.pts_weekday || 0, we: ranges[0]?.pts_weekend || 0 };
  const [addForm, setAddForm] = useState(emptyForm);
  const [editForm, setEditForm] = useState({});

  const totalRanges = ranges.length;

  return (<div style={{ background: BG3, border: `1px solid ${meta.color}33`, borderRadius: 8, padding: "10px 12px", marginBottom: 8, borderLeft: `3px solid ${meta.color}` }}>
    {/* Header */}
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: totalRanges > 0 ? 8 : 0 }}>
      <div>
        <span style={{ color: meta.color, fontWeight: 700, fontSize: 12 }}>{meta.name}</span>
        <span style={{ color: T4, fontSize: 10, marginLeft: 8 }}>
          {totalRanges === 0 ? "(sin rangos — usará Oro como default)" : `${totalRanges} rango${totalRanges > 1 ? "s" : ""}`}
        </span>
      </div>
      <Btn label="+ Agregar rango" variant="ghost" small onClick={() => { setAdding(true); setAddForm(emptyForm); }} />
    </div>

    {/* Rangos existentes */}
    {ranges.map(r => {
      const isEditing = editingId === r.id;
      return (<div key={r.id} style={{ background: BG2, borderRadius: 6, padding: "7px 9px", marginBottom: 5, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        {!isEditing ? <>
          <span style={{ color: T2, fontSize: 11, flex: 1 }}>
            {MONTHS_CONF[(r.start_month||1)-1]} {r.start_day} — {MONTHS_CONF[(r.end_month||12)-1]} {r.end_day}
            <span style={{ color: T4, marginLeft: 8 }}>Dom-Jue: {r.pts_weekday}pts · Vie-Sáb: {r.pts_weekend}pts</span>
          </span>
          <Btn label="Editar" variant="ghost" small onClick={() => { setEditingId(r.id); setEditForm({ sm: r.start_month, sd: r.start_day, em: r.end_month, ed: r.end_day, wd: r.pts_weekday || 0, we: r.pts_weekend || 0 }); }} />
          <Btn label="✕" variant="danger" small onClick={() => {
            if (r.id && r.id < 1e9 && removeSeasonRange) removeSeasonRange(r.id);
            setEditU(u => ({ ...u, seasons: u.seasons.filter(x => x.id !== r.id) }));
          }} />
        </> : <>
          <RangeFormInline form={editForm} setForm={setEditForm} />
          <Btn label="Guardar" variant="success" small onClick={() => {
            const updated = { ...r, start_month: editForm.sm, start_day: editForm.sd, end_month: editForm.em, end_day: editForm.ed, pts_weekday: editForm.wd, pts_weekend: editForm.we };
            setEditU(u => ({ ...u, seasons: u.seasons.map(x => x.id === r.id ? updated : x) }));
            if (saveSeasonRange) saveSeasonRange(editU.id, meta.id, editForm.sm, editForm.sd, editForm.em, editForm.ed, editForm.wd, editForm.we, r.id < 1e9 ? r.id : null);
            setEditingId(null);
          }} />
          <Btn label="Cancelar" variant="ghost" small onClick={() => setEditingId(null)} />
        </>}
      </div>);
    })}

    {/* Formulario de agregar nuevo rango */}
    {adding && <div style={{ background: BG2, borderRadius: 6, padding: "9px 10px", marginTop: 5 }}>
      <div style={{ fontSize: 9, color: meta.color, textTransform: "uppercase", marginBottom: 6, fontWeight: 700 }}>Nuevo rango — {meta.name}</div>
      <RangeFormInline form={addForm} setForm={setAddForm} />
      <div style={{ display: "flex", gap: 6, marginTop: 8, justifyContent: "flex-end" }}>
        <Btn label="Cancelar" variant="ghost" small onClick={() => setAdding(false)} />
        <Btn label="Agregar rango" variant="success" small onClick={() => {
          const newR = { id: Date.now(), season: meta.id, unit_id: editU.id, start_month: addForm.sm, start_day: addForm.sd, end_month: addForm.em, end_day: addForm.ed, pts_weekday: addForm.wd, pts_weekend: addForm.we };
          setEditU(u => ({ ...u, seasons: [...(u.seasons || []), newR] }));
          if (saveSeasonRange) saveSeasonRange(editU.id, meta.id, addForm.sm, addForm.sd, addForm.em, addForm.ed, addForm.wd, addForm.we, null);
          setAdding(false);
        }} />
      </div>
    </div>}
  </div>);
}

// Formulario inline de rango de fechas
function RangeFormInline({ form, setForm }) {
  return (<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr 1fr", gap: 6, flex: 1 }}>
    <Inp label="Inicio Mes" value={form.sm} onChange={v => setForm(f => ({ ...f, sm: +v }))} opts={MONTHS_CONF.map((m, i) => ({ v: i+1, l: m }))} />
    <Inp label="Día" value={form.sd} onChange={v => setForm(f => ({ ...f, sd: +v }))} type="number" />
    <Inp label="Fin Mes" value={form.em} onChange={v => setForm(f => ({ ...f, em: +v }))} opts={MONTHS_CONF.map((m, i) => ({ v: i+1, l: m }))} />
    <Inp label="Día" value={form.ed} onChange={v => setForm(f => ({ ...f, ed: +v }))} type="number" />
    <Inp label="Dom-Jue pts" value={form.wd} onChange={v => setForm(f => ({ ...f, wd: +v }))} type="number" />
    <Inp label="Vie-Sáb pts" value={form.we} onChange={v => setForm(f => ({ ...f, we: +v }))} type="number" />
  </div>);
}

// ── PRICE YEAR ROW — componente separado para evitar useState dentro de .map() ─
function PriceYearRow({ yr, pointPrices, savePointPrice, canEdit, pp }) {
  const cur = (pointPrices || []).find(p => p.year === yr);
  const currentPrice = cur?.priceUsd || 4.75;
  const [draft, setDraft] = useState(currentPrice);
  useEffect(() => { setDraft(cur?.priceUsd || 4.75); }, [cur?.priceUsd]);
  const dirty = +draft !== +currentPrice;
  return (<div style={{ display: "flex", gap: 10, alignItems: "flex-end", marginBottom: 10, padding: "10px 12px", background: BG3, borderRadius: 8 }}>
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 9, color: T4, marginBottom: 3 }}>{yr === CY ? "Año en curso" : "Año siguiente"} — {yr}</div>
      <input type="number" value={draft} min={2} step={0.01} onChange={e => setDraft(+e.target.value)} style={{ ...IS, fontSize: 13, fontWeight: 700, width: 100 }} />
      <span style={{ fontSize: 10, color: T4, marginLeft: 6 }}>USD/pt · {f$(draft * (yr <= CY ? 1 : 1))}/pt</span>
    </div>
    <div style={{ color: B, fontWeight: 800, fontSize: 18 }}>{f$(currentPrice)}</div>
    {dirty && +draft >= 2 && canEdit && <Btn label="Aplicar" variant="success" onClick={() => savePointPrice && savePointPrice(yr, +draft)} />}
    {dirty && +draft < 2 && <div style={{ color: R, fontSize: 10 }}>Mín. $2.00 USD</div>}
  </div>);
}

function ConfigView({ seasonOrder, setSeasonOrder, uts, setUts, units, setUnits, pp, setPp, onSaveUnit, onSaveUnitType, onRemoveUnitType, onSavePricePerPoint, pointPrices, savePointPrice, saveUnitAvailability, removeUnitAvailability, saveSeasonRange, removeSeasonRange, cu }) {
  const canEdit = cu && ["admin", "superadmin"].includes(cu.role);
  const [sec, setSec] = useState("tarifa"), [editUT, setEditUT] = useState(null), [editU, setEditU] = useState(null);
  const mO = MONTHS_ES.map((m, i) => ({ v: i + 1, l: m })), dO = Array.from({ length: 31 }, (_, i) => i + 1).map(d => ({ v: d, l: d }));
  // Orden temporadas: helpers para mover arriba/abajo
  const moveSeason = (id, dir) => { const i = seasonOrder.indexOf(id); const j = i + dir; if (j < 0 || j >= seasonOrder.length) return; const n = [...seasonOrder];[n[i], n[j]] = [n[j], n[i]]; setSeasonOrder(n); };
  // Unidad vacía con 3 temporadas default
  const emptyUnit = () => ({
    id: "new", typeId: uts[0]?.id, location: "", name: "", active: true, occ: [], seasons: [
      { id: "platino", ranges: [{ startMonth: 12, startDay: 15, endMonth: 1, endDay: 5 }], ptsWd: 0, ptsWe: 0 },
      { id: "oro", ranges: [{ startMonth: 7, startDay: 1, endMonth: 8, endDay: 31 }], ptsWd: 0, ptsWe: 0 },
      { id: "plata", ranges: [{ startMonth: 1, startDay: 6, endMonth: 6, endDay: 30 }], ptsWd: 0, ptsWe: 0 },
    ]
  });
  const addRange = (sId) => setEditU(u => ({ ...u, seasons: u.seasons.map(s => s.id === sId ? { ...s, ranges: [...(s.ranges || []), { startMonth: 1, startDay: 1, endMonth: 1, endDay: 15 }] } : s) }));
  const delRange = (sId, i) => setEditU(u => ({ ...u, seasons: u.seasons.map(s => s.id === sId ? { ...s, ranges: s.ranges.filter((_, x) => x !== i) } : s) }));
  const updRange = (sId, i, field, val) => setEditU(u => ({ ...u, seasons: u.seasons.map(s => s.id === sId ? { ...s, ranges: s.ranges.map((r, x) => x === i ? { ...r, [field]: val } : r) } : s) }));
  const updSeasonPts = (sId, field, val) => setEditU(u => ({ ...u, seasons: u.seasons.map(s => s.id === sId ? { ...s, [field]: val } : s) }));
  return (<div>
    <div style={{ display: "flex", gap: 5, marginBottom: 16, flexWrap: "wrap" }}>
      {[["tarifa", "Tarifa / Precios"], ["orden", "Orden Temporadas"], ["tipos", "Tipos Unidad"], ["unidades", "Inventario / Temporadas"]].map(([id, l]) => (
        <button key={id} onClick={() => setSec(id)} style={{ background: sec === id ? IND : BG2, color: sec === id ? "#fff" : T4, border: `1px solid ${sec === id ? IND : BD}`, borderRadius: 7, padding: "5px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{l}</button>
      ))}
    </div>
    {sec === "tarifa" && <div style={{ maxWidth: 600 }}>
      <div style={{ background: BG2, border: `1px solid ${BD}`, borderRadius: 11, padding: 18, marginBottom: 14 }}>
        <Sec t="Precio por punto — Años modificables" />
        <div style={{ fontSize: 10, color: T4, marginBottom: 12 }}>Solo se puede modificar el precio del año en curso ({CY}) y el siguiente ({CY + 1}). Los años anteriores están fijos en $4.75 USD.</div>
        {[CY, CY + 1].map(yr => (
          <PriceYearRow key={yr} yr={yr} pointPrices={pointPrices} savePointPrice={savePointPrice} canEdit={canEdit} pp={pp} />
        ))}
        <div style={{ background: BG3, borderRadius: 6, padding: "7px 9px", fontSize: 10, color: T4, marginTop: 8 }}>
          Años anteriores a {CY}: precio fijo $4.75 USD/pt · Ejemplo 5,000 pts → <b style={{ color: T1 }}>{f$(5000 * pp)}</b>
        </div>
      </div>
    </div>}
    {sec === "orden" && <div style={{ maxWidth: 480 }}>
      <div style={{ background: BG2, border: `1px solid ${BD}`, borderRadius: 11, padding: 18 }}>
        <Sec t="Orden de Temporadas (de más alta a más baja)" />
        <div style={{ fontSize: 10, color: T4, marginBottom: 12 }}>Las temporadas son fijas (Platino, Oro, Plata). Puedes reordenarlas para ajustar prioridades en reportes y presentación visual.</div>
        {seasonOrder.map((sId, i) => {
          const meta = SEASON_META.find(m => m.id === sId); return (<div key={sId} style={{ background: BG3, borderRadius: 7, padding: "9px 12px", marginBottom: 6, display: "flex", alignItems: "center", gap: 10, borderLeft: `3px solid ${meta.color}` }}>
            <span style={{ color: T4, fontSize: 11, width: 20 }}>{i + 1}.</span>
            <span style={{ color: meta.color, fontWeight: 700, flex: 1 }}>{meta.name}</span>
            <Btn label="↑" variant="ghost" small onClick={() => moveSeason(sId, -1)} disabled={i === 0} />
            <Btn label="↓" variant="ghost" small onClick={() => moveSeason(sId, 1)} disabled={i === seasonOrder.length - 1} />
          </div>);
        })}
      </div>
    </div>}
    {sec === "tipos" && <div>
      {editUT && <Modal title={editUT.id === "new" ? "Nuevo Tipo de Unidad" : "Editar Tipo"} onClose={() => setEditUT(null)}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div style={{ gridColumn: "1/-1" }}><Inp label="Nombre (ej. Studio, Suite 2 Rec)" value={editUT.name || ""} onChange={v => setEditUT(u => ({ ...u, name: v }))} /></div>
          <Inp label="Cap. con privacidad (1er número)" value={editUT.privacyCapacity || 2} onChange={v => setEditUT(u => ({ ...u, privacyCapacity: +v }))} type="number" />
          <Inp label="Cap. máxima (2do número)" value={editUT.maxCapacity || 4} onChange={v => setEditUT(u => ({ ...u, maxCapacity: +v }))} type="number" />
        </div>
        {editUT.privacyCapacity && editUT.maxCapacity && <div style={{ background: BG3, borderRadius: 6, padding: "7px 9px", marginTop: 8, fontSize: 10, color: T2 }}>
          Tipo: <b style={{ color: B }}>{editUT.privacyCapacity}/{editUT.maxCapacity}</b> — {editUT.privacyCapacity} personas con privacidad · {editUT.maxCapacity} personas máximo
        </div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
          <Btn label="Cancelar" variant="ghost" onClick={() => setEditUT(null)} />
          <Btn label="Guardar" onClick={() => {
            const obj = { ...editUT, name: `${editUT.name || editUT.privacyCapacity + "/" + editUT.maxCapacity}` };
            if (editUT.id === "new") setUts(us => [...us, { ...obj, id: Date.now() }]);
            else setUts(us => us.map(x => x.id === editUT.id ? obj : x));
            if (onSaveUnitType) onSaveUnitType(obj);
            setEditUT(null);
          }} />
        </div>
      </Modal>}
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
        {canEdit && <Btn label="+ Nuevo Tipo" onClick={() => setEditUT({ id: "new", name: "", privacyCapacity: 2, maxCapacity: 4 })} />}
      </div>
      <Tbl cols={["Tipo", "Capacidad Privacidad", "Capacidad Máxima", ""]} rows={uts.map(ut => (<tr key={ut.id} style={{ borderBottom: `1px solid ${BG3}` }}>
        <td style={tW()}>{ut.name}</td>
        <td style={tBb()}>{ut.privacyCapacity || 2} personas</td>
        <td style={tBb()}>{ut.maxCapacity || 4} personas</td>
        <td style={td()}>{canEdit && <Btn label="Editar" variant="ghost" small onClick={() => setEditUT({ ...ut })} />}</td>
      </tr>))} />
    </div>}
    {sec === "unidades" && <div>
      {editU && <Modal title={editU.id === "new" ? "Nueva Unidad" : `Editar: ${editU.name}`} onClose={() => setEditU(null)} wide>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 14 }}>
          <Inp label="Nombre de unidad" value={editU.name || ""} onChange={v => setEditU(u => ({ ...u, name: v }))} />
          <Inp label="Tipo" value={editU.typeId || ""} onChange={v => setEditU(u => ({ ...u, typeId: +v }))} opts={uts.map(t => ({ v: t.id, l: t.name }))} />
          <Inp label="Ubicación / Destino" value={editU.location || ""} onChange={v => setEditU(u => ({ ...u, location: v }))} />
          <div style={{ gridColumn: "1/-1" }}>
            <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "8px 10px", background: BG3, borderRadius: 6 }}>
              <label style={{ fontSize: 11, color: T2, display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                <input type="checkbox" checked={editU.isWeekly || false} onChange={e => setEditU(u => ({ ...u, isWeekly: e.target.checked }))} />
                Reservación semanal (solo se puede reservar por semana completa)
              </label>
            </div>
          </div>
          {editU.isWeekly && <div style={{ gridColumn: "1/-1" }}>
            <Inp label="Día de llegada (check-in)" value={editU.weeklyStartDay ?? 5} onChange={v => setEditU(u => ({ ...u, weeklyStartDay: +v }))}
              opts={[0,1,2,3,4,5,6].map(d => ({ v: d, l: ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"][d] }))} />
          </div>}
        </div>

        {/* Inventario / Disponibilidad */}
        <div style={{ fontSize: 9, color: T4, textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 8 }}>Inventario disponible</div>
        {(editU.availability || []).map((a, i) => (
          <div key={a.id || i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto auto", gap: 8, marginBottom: 6, alignItems: "end" }}>
            <Inp label="Desde" type="date" value={a.startDate || ""} onChange={v => setEditU(u => ({ ...u, availability: u.availability.map((x, j) => j === i ? { ...x, startDate: v } : x) }))} />
            <Inp label="Hasta" type="date" value={a.endDate || ""} onChange={v => setEditU(u => ({ ...u, availability: u.availability.map((x, j) => j === i ? { ...x, endDate: v } : x) }))} />
            <Inp label="Cuartos" type="number" value={a.totalRooms || 1} onChange={v => setEditU(u => ({ ...u, availability: u.availability.map((x, j) => j === i ? { ...x, totalRooms: +v } : x) }))} />
            <Btn label="Guardar" small variant="success" onClick={() => {
              if (saveUnitAvailability) saveUnitAvailability(editU.id, a.startDate, a.endDate, a.totalRooms, a.id && a.id < 1e9 ? a.id : null);
            }} />
          </div>
        ))}
        <Btn label="+ Agregar rango de disponibilidad" variant="ghost" small onClick={() => setEditU(u => ({ ...u, availability: [...(u.availability || []), { id: Date.now(), startDate: "", endDate: "", totalRooms: 1 }] }))} />

        {/* Temporadas */}
        <div style={{ fontSize: 9, color: T4, textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 8, marginTop: 14 }}>Temporadas · Rangos de fechas y puntos por noche</div>
        <div style={{ fontSize: 9, color: T4, marginBottom: 8 }}>Si una fecha no está en ningún rango, se usará <b style={{ color: "#fbbf24" }}>Oro</b> como temporada default. Si hay solapamiento, se aplica la temporada más alta (Platino {'>'} Oro {'>'} Plata).</div>
        {SEASON_META.map(meta => (
          <SeasonRow key={meta.id} meta={meta} editU={editU} setEditU={setEditU} saveSeasonRange={saveSeasonRange} removeSeasonRange={removeSeasonRange} />
        ))}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <Btn label="Cancelar" variant="ghost" onClick={() => setEditU(null)} />
          <Btn label="Guardar Unidad" onClick={() => {
            const isNew = editU.id === "new";
            if (isNew) setUnits(us => [...us, { ...editU, id: Date.now() }]);
            else setUnits(us => us.map(x => x.id === editU.id ? editU : x));
            if (onSaveUnit) onSaveUnit(editU);
            setEditU(null);
          }} />
        </div>
      </Modal>}
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
        {canEdit && <Btn label="+ Nueva Unidad" onClick={() => setEditU({ id: "new", name: "", typeId: uts[0]?.id || 1, location: "", isWeekly: false, weeklyStartDay: 5, active: true, seasons: [], availability: [] })} />}
      </div>
      <Tbl cols={["Unidad", "Tipo", "Ubicación", "Semanal", "Inventario", "Estado", ""]} rows={units.map(u => {
        const ut = uts.find(t => t.id === u.typeId);
        const totalRooms = (u.availability || []).reduce((a, av) => Math.max(a, av.totalRooms), 0);
        return (<tr key={u.id} style={{ borderBottom: `1px solid ${BG3}`, opacity: u.active ? 1 : .4 }}>
          <td style={tW()}>{u.name}</td>
          <td style={tG3()}>{ut?.name}</td>
          <td style={tG3()}>{u.location || "—"}</td>
          <td style={td({ color: u.isWeekly ? Y : T4 })}>{u.isWeekly ? `📅 Semanal (${["Dom","Lun","Mar","Mié","Jue","Vie","Sáb"][u.weeklyStartDay]})` : "Libre"}</td>
          <td style={tBs()}>{totalRooms > 0 ? `${totalRooms} cuartos` : <span style={{ color: R }}>Sin inventario</span>}</td>
          <td style={td()}><Bdg l={u.active ? "Active" : "Cancelado"} /></td>
          <td style={tFl()}>
            {canEdit && <Btn label="Editar" variant="ghost" small onClick={() => setEditU({ ...u, seasons: [...(u.seasons || [])], availability: [...(u.availability || [])] })} />}
            {canEdit && <Btn label={u.active ? "Baja" : "Activar"} variant={u.active ? "danger" : "success"} small onClick={() => {
              setUnits(us => us.map(x => x.id === u.id ? { ...x, active: !x.active } : x));
              if (onSaveUnit) onSaveUnit({ ...u, active: !u.active });
            }} />}
          </td>
        </tr>);
      })} />
    </div>}
  </div>);
}
// ── PAYMENT METHODS ──────────────────────────────────────────────────────────
function PayMethodsView({ pms, setPms, onSavePm }) {
  const [modal, setModal] = useState(null), [form, setForm] = useState({});
  const setF = k => v => setForm(f => ({ ...f, [k]: v }));
  const save = () => {
    const obj = { ...form, costPct: +(form.costPct || 0), active: form.active !== false };
    if (modal === "new") {
      setPms(ms => [...ms, { ...obj, id: Date.now() }]);
      if (onSavePm) onSavePm(obj);
    } else {
      setPms(ms => ms.map(m => m.id === modal.id ? { ...m, ...obj } : m));
      if (onSavePm) onSavePm({ ...obj, id: modal.id });
    }
    setModal(null);
  };
  return (<div>
    {modal && <Modal title="Medio de Pago" onClose={() => setModal(null)}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}><div style={{ gridColumn: "1/-1" }}><Inp label="Nombre" value={form.name || ""} onChange={setF("name")} /></div><Inp label="Costo por tx (%)" value={form.costPct || 0} onChange={v => setF("costPct")(+v)} type="number" /><Inp label="Estado" value={form.active ? "si" : "no"} onChange={v => setF("active")(v === "si")} opts={[{ v: "si", l: "Activo" }, { v: "no", l: "Inactivo" }]} /></div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}><Btn label="Cancelar" variant="ghost" onClick={() => setModal(null)} /><Btn label="Guardar" onClick={save} /></div>
    </Modal>}
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
      <Kpi label="Medios Activos" value={pms.filter(m => m.active).length} accent={B} />
      <Kpi label="Costo Promedio" value={(pms.reduce((a, m) => a + m.costPct, 0) / pms.length).toFixed(2) + "%"} accent={Y} />
    </div>
    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}><Btn label="+ Nuevo Medio" onClick={() => { setForm({ name: "", costPct: 0, active: true }); setModal("new"); }} /></div>
    <Tbl cols={["Medio", "Costo Tx (%)", "Estado", ""]} rows={pms.map(m => (<tr key={m.id} style={{ borderBottom: `1px solid ${BG3}` }}>
      <td style={tW()}>{m.name}</td>
      <td style={td()}><div style={{ display: "flex", alignItems: "center", gap: 7 }}><div style={{ width: Math.round(m.costPct / 4 * 50), height: 4, background: Y, borderRadius: 3, minWidth: 4 }} /><span style={{ color: Y, fontWeight: 700 }}>{m.costPct}%</span></div></td>
      <td style={td()}><Bdg l={m.active ? "Active" : "Cancelado"} /></td>
      <td style={tFl()}><Btn label="Editar" variant="ghost" small onClick={() => { setForm({ ...m }); setModal(m); }} /><Btn label={m.active ? "Desact." : "Activar"} variant={m.active ? "danger" : "success"} small onClick={() => {
        setPms(ms => ms.map(x => x.id === m.id ? { ...x, active: !x.active } : x));
        if (onSavePm) onSavePm({ ...m, active: !m.active });
      }} /></td>
    </tr>))} />
  </div>);
}
// ── COMPENSATION ─────────────────────────────────────────────────────────────
function CompView({ users, setUsers, payments, reservations, pp, rc, setRc, cr, setCr, onSaveUser, onSaveCommissionRate, onSaveReservationFee }) {
  const [editId, setEditId] = useState(null), [form, setForm] = useState({}), [ctab, setCtab] = useState("personal");
  const [draftRc, setDraftRc] = useState(rc);
  useEffect(() => { setDraftRc(rc); }, [rc]);
  const setF = k => v => setForm(f => ({ ...f, [k]: v }));
  const staff = users.filter(u => u.role !== "superadmin");
  const save = () => {
    const newSalary = +(form.salary || 0);
    const newSocialCost = +(form.socialCost || 0);
    setUsers(us => us.map(u => u.id === editId ? { ...u, salary: newSalary, socialCost: newSocialCost } : u));
    if (onSaveUser) {
      const userObj = users.find(u => u.id === editId);
      if (userObj) onSaveUser({ id: editId, salary: newSalary, socialCost: newSocialCost });
    }
    setEditId(null);
  };
  const saveRc = () => {
    if (+draftRc === +rc) return;
    setRc(+draftRc);
    if (onSaveReservationFee) onSaveReservationFee(+draftRc);
  };
  return (<div>
    {editId && <Modal title="Editar Compensación" onClose={() => setEditId(null)}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Inp label="Sueldo mensual ($)" value={form.salary || 0} onChange={v => setF("salary")(+v)} type="number" />
        <Inp label="Costo social mensual ($)" value={form.socialCost || 0} onChange={v => setF("socialCost")(+v)} type="number" />
      </div>
      {((+form.salary || 0) > 0 || (+form.socialCost || 0) > 0) && <div style={{ background: BG3, borderRadius: 6, padding: "7px 9px", marginTop: 8, fontSize: 10, color: T2 }}>
        Costo total: <b style={{ color: B }}>{f$((+form.salary || 0) + (+form.socialCost || 0))}/mes</b>
      </div>}
      <div style={{ background: P + "12", borderRadius: 6, padding: "7px 9px", marginTop: 8, fontSize: 10, color: T3 }}>Las comisiones por cobro se configuran <b style={{ color: P }}>por concepto</b>, no por persona. Ve a la pestaña "Por Concepto".</div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}><Btn label="Cancelar" variant="ghost" onClick={() => setEditId(null)} /><Btn label="Guardar" onClick={save} /></div>
    </Modal>}
    <div style={{ display: "flex", gap: 5, marginBottom: 14 }}>
      {[["personal", "Personal"], ["reservacion", "Comisión Reserva"], ["concepto", "Por Concepto"]].map(([id, l]) => (
        <button key={id} onClick={() => setCtab(id)} style={{ background: ctab === id ? IND : BG2, color: ctab === id ? "#fff" : T4, border: `1px solid ${ctab === id ? IND : BD}`, borderRadius: 7, padding: "5px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{l}</button>
      ))}
    </div>
    {ctab === "personal" && <div>
      <div style={{ display: "flex", gap: 9, flexWrap: "wrap", marginBottom: 13 }}>
        <Kpi label="Nómina Base" value={f$(staff.reduce((a, u) => a + (u.salary || 0), 0))} accent={B} />
        <Kpi label="Costo Social Total" value={f$(staff.reduce((a, u) => a + (u.socialCost || 0), 0))} accent={O} />
        <Kpi label="Costo Total Nómina" value={f$(staff.reduce((a, u) => a + (u.salary || 0) + (u.socialCost || 0), 0))} accent={P} />
      </div>
      <Tbl cols={["Empleado", "Rol", "Sueldo", "Costo Social", "Costo Total", ""]}
        rows={staff.map(u => {
          const totalCosto = (u.salary || 0) + (u.socialCost || 0);
          const pctSocial = u.salary > 0 ? ((u.socialCost || 0) / u.salary * 100).toFixed(1) : "0.0";
          return (<tr key={u.id} style={{ borderBottom: `1px solid ${BG3}` }}>
            <td style={td()}><div style={{ display: "flex", alignItems: "center", gap: 6 }}><div style={{ width: 18, height: 18, borderRadius: 5, background: (u.color||P) + "20", border: `1px solid ${(u.color||P)}33`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: u.color||P, fontWeight: 700 }}>{(u.name||u.username||"?")[0]}</div><span style={{ color: T1, fontWeight: 600, fontSize: 11 }}>{u.name}</span></div></td>
            <td style={td()}><RBdg r={u.role} /></td>
            <td style={td({ color: B })}>{f$(u.salary || 0)}</td>
            <td style={td({ color: O })}>{f$(u.socialCost || 0)}<span style={{ color: T4, fontSize: 9, marginLeft: 4 }}>({pctSocial}%)</span></td>
            <td style={td({ color: T1, fontWeight: 700, fontSize: 13 })}>{f$(totalCosto)}</td>
            <td style={td()}><Btn label="Editar" variant="ghost" small onClick={() => { setForm({ salary: u.salary || 0, socialCost: u.socialCost || 0 }); setEditId(u.id); }} /></td>
          </tr>);
        })} />
    </div>}
    {ctab === "reservacion" && <div style={{ maxWidth: 480 }}><div style={{ background: BG2, border: `1px solid ${BD}`, borderRadius: 11, padding: 18 }}>
      <Sec t="Comisión Fija por Reservación" />
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
        <div style={{ flex: 1 }}><Inp label="Comisión por reservación ($)" value={draftRc} onChange={v => setDraftRc(+v)} type="number" /></div>
        <div style={{ color: P, fontWeight: 800, fontSize: 22 }}>{f$(rc)}</div>
        {+draftRc !== +rc && <Btn label="Aplicar" variant="success" onClick={saveRc} />}
      </div>
    </div></div>}
    {ctab === "concepto" && <div>
      <div style={{ fontSize: 11, color: T3, marginBottom: 13 }}>Comisión por tipo de cobro, independiente del gestor. Se aplica a todos los gestores por igual.</div>
      <Tbl cols={["Concepto", "Comisión (%)", "Activo", ""]}
        rows={cr.map(r => (<tr key={r.id} style={{ borderBottom: `1px solid ${BG3}` }}>
          <td style={tW()}>{r.l}</td>
          <td style={td()}><CrEditor row={r} cr={cr} setCr={setCr} onSaveCommissionRate={onSaveCommissionRate} /></td>
          <td style={td()}><Bdg l={r.active ? "Active" : "Cancelado"} /></td>
          <td style={td()}><Btn label={r.active ? "Desact." : "Activar"} variant={r.active ? "danger" : "success"} small onClick={() => setCr(rs => rs.map(x => x.id === r.id ? { ...x, active: !x.active } : x))} /></td>
        </tr>))} />
    </div>}
  </div>);
}

function CrEditor({ row, cr, setCr, onSaveCommissionRate }) {
  const [draft, setDraft] = useState(row.pct);
  useEffect(() => { setDraft(row.pct); }, [row.pct]);
  const dirty = +draft !== +row.pct;
  const apply = () => {
    setCr(rs => rs.map(x => x.id === row.id ? { ...x, pct: +draft } : x));
    if (onSaveCommissionRate) onSaveCommissionRate(row.id, +draft);
  };
  return (<div style={{ display: "flex", alignItems: "center", gap: 7 }}>
    <input type="number" value={draft} step="0.1" onChange={e => setDraft(+e.target.value)} style={{ ...IS, width: 75, padding: "4px 7px", fontSize: 11 }} />
    <span style={{ color: Y, fontWeight: 700 }}>{row.pct}%</span>
    {dirty && <Btn label="Aplicar" variant="success" small onClick={apply} />}
  </div>);
}
// ── USERS / TEAM / CONTRACTS / COURTESIES ────────────────────────────────────
function UsersView({ cu, users, setUsers, rc, onSaveUser }) {
  const [modal, setModal] = useState(null), [form, setForm] = useState({});
  const setF = k => v => setForm(f => ({ ...f, [k]: v }));
  const pD = { superadmin: "Todo", admin: "Config+Reportes+Equipo+Contratos", cajero: "Caja", gestor: "Cobranzas+Reservaciones+Venta Pts" };
  const save = () => {
    const isNew = modal === "new";
    const userObj = { ...form, salary: +(form.salary || 0), active: form.active !== false };
    if (isNew) {
      setUsers(us => [...us, { ...userObj, id: Date.now(), commissions: { collection: 0 } }]);
      if (onSaveUser) onSaveUser(userObj);
    } else {
      setUsers(us => us.map(u => u.id === modal.id ? { ...u, ...userObj } : u));
      if (onSaveUser) onSaveUser({ ...userObj, id: modal.id });
    }
    setModal(null);
  };
  return (<div>
    {modal && <Modal title={modal === "new" ? "Nuevo Usuario" : "Editar Usuario"} onClose={() => setModal(null)}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div style={{ gridColumn: "1/-1" }}><Inp label="Nombre completo" value={form.name || ""} onChange={setF("name")} /></div>
        <Inp label="Usuario" value={form.username || ""} onChange={setF("username")} />
        <Inp label="Contraseña" value={form.password || ""} onChange={setF("password")} />
        <Inp label="Rol" value={form.role || "gestor"} onChange={setF("role")} opts={Object.keys(RM).map(r => ({ v: r, l: RM[r].l }))} />
        <Inp label="Color (hex)" value={form.color || P} onChange={setF("color")} />
        <Inp label="Sueldo mensual ($)" value={form.salary || 0} onChange={v => setF("salary")(+v)} type="number" />
        <Inp label="Costo social mensual ($)" value={form.socialCost || 0} onChange={v => setF("socialCost")(+v)} type="number" />
      </div>
      {(form.salary > 0 || form.socialCost > 0) && <div style={{ background: BG3, borderRadius: 6, padding: "8px 10px", marginTop: 8, fontSize: 10, color: T2 }}>
        Costo total para la empresa: <b style={{ color: B }}>{f$((+form.salary || 0) + (+form.socialCost || 0))}/mes</b>
        {form.salary > 0 && <span style={{ color: T4, marginLeft: 6 }}>({(((+form.socialCost || 0) / (+form.salary || 1)) * 100).toFixed(1)}% costo social)</span>}
      </div>}
      <div style={{ background: BG3, borderRadius: 6, padding: "7px 9px", marginTop: 6, fontSize: 10, color: T4 }}><b style={{ color: T1 }}>Permisos: </b>{pD[form.role || "gestor"]}</div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}><Btn label="Cancelar" variant="ghost" onClick={() => setModal(null)} /><Btn label="Guardar" onClick={save} /></div>
    </Modal>}
    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}><Btn label="+ Nuevo Usuario" onClick={() => { setForm({ username: "", password: "", name: "", role: "gestor", color: P, salary: 0, socialCost: 0 }); setModal("new"); }} /></div>
    <Tbl cols={["Usuario", "Nombre", "Rol", "Sueldo", "Costo Social", "Costo Total", "Activo", ""]} rows={users.map(u => (<tr key={u.id} style={{ borderBottom: `1px solid ${BG3}`, opacity: u.active === false ? .4 : 1 }}>
      <td style={td()}><div style={{ display: "flex", alignItems: "center", gap: 6 }}><div style={{ width: 20, height: 20, borderRadius: 5, background: (u.color || P) + "20", border: `1px solid ${(u.color || P)}33`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: u.color || P, fontWeight: 700 }}>{(u.username || u.name || "?")[0].toUpperCase()}</div><span style={{ color: T1, fontWeight: 600 }}>{u.username}</span>{u.id === cu.id && <span style={{ fontSize: 8, color: T4, border: `1px solid ${BD}`, borderRadius: 4, padding: "1px 4px" }}>tú</span>}</div></td>
      <td style={tG3()}>{u.name}</td>
      <td style={td()}><RBdg r={u.role} /></td>
      <td style={tT2()}>{f$(u.salary || 0)}</td>
      <td style={td({ color: O })}>{f$(u.socialCost || 0)}</td>
      <td style={td({ color: B, fontWeight: 700 })}>{f$((u.salary || 0) + (u.socialCost || 0))}</td>
      <td style={td()}><Bdg l={u.active === false ? "Cancelado" : "Active"} /></td>
      <td style={tFl()}><Btn label="Editar" variant="ghost" small onClick={() => { setForm({ ...u }); setModal(u); }} />{u.id !== cu.id && <Btn label={u.active === false ? "Activar" : "Baja"} variant={u.active === false ? "success" : "danger"} small onClick={() => {
        setUsers(us => us.map(x => x.id === u.id ? { ...x, active: !x.active } : x));
        if (onSaveUser) onSaveUser({ id: u.id, active: !u.active });
      }} />}</td>
    </tr>))} />
  </div>);
}
function TeamView({ users, setUsers, clients, setClients, payments, reservations, condonations, onAssignGestor, onCancelContract, onSaveUser, cu }) {
  const [ttab, setTtab] = useState("list"), [modal, setModal] = useState(null), [form, setForm] = useState({}), [agt, setAgt] = useState(""), [selC, setSelC] = useState([]);
  const setF = k => v => setForm(f => ({ ...f, [k]: v }));
  const isSuperAdmin = cu?.role === "superadmin";
  // Enriquecer clientes con cls, dOvr, interest para la segmentación
  const enrichedClients = useMemo(() => clients.map(c => {
    const d = dOvr(c.dueDate);
    const cl = getClientStatus(c, payments, condonations);
    const interest = cInt(c.balance, d, cl.r * 12);
    return { ...c, dOvr: d, cls: cl, interest };
  }), [clients, payments, condonations]);
  const gestors = users.filter(u => u.role === "gestor");
  const save = () => {
    const isNew = modal === "new";
    const obj = { ...form, role: form.role || "gestor", active: true, salary: +(form.salary || 0), commissions: { collection: 0 } };
    if (isNew) setUsers(us => [...us, { ...obj, id: Date.now() }]);
    else setUsers(us => us.map(u => u.id === modal.id ? { ...u, ...obj } : u));
    if (onSaveUser) onSaveUser(isNew ? obj : { ...obj, id: modal.id });
    setModal(null);
  };
  const doAssign = async () => {
    if (!agt || !selC.length) return;
    // Optimistic update with string ID
    setClients(cs => cs.map(c => selC.includes(c.id) ? { ...c, assignedGestor: String(agt) } : c));
    // Save batch to DB (agt is now a numeric ID as string)
    if (onAssignGestor) await onAssignGestor(selC, +agt);
    setSelC([]); setAgt("");
  };
  return (<div>
    {modal && <Modal title={modal === "new" ? "Nuevo Usuario" : "Editar Gestor"} onClose={() => setModal(null)}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div style={{ gridColumn: "1/-1" }}><Inp label="Nombre completo" value={form.name || ""} onChange={setF("name")} /></div>
        <Inp label="Usuario" value={form.username || ""} onChange={setF("username")} />
        <Inp label="Contraseña" value={form.password || ""} onChange={setF("password")} />
        {modal === "new" && isSuperAdmin && <div style={{ gridColumn: "1/-1" }}>
          <Inp label="Rol" value={form.role || "gestor"} onChange={setF("role")} opts={[{ v: "gestor", l: "Gestor" }, { v: "cajero", l: "Cajero" }, { v: "admin", l: "Admin" }]} />
        </div>}
        <Inp label="Sueldo mensual ($)" value={form.salary || 0} onChange={v => setF("salary")(+v)} type="number" />
        <Inp label="Costo social mensual ($)" value={form.socialCost || 0} onChange={v => setF("socialCost")(+v)} type="number" />
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
        <Btn label="Cancelar" variant="ghost" onClick={() => setModal(null)} />
        <Btn label="Guardar" onClick={save} />
      </div>
    </Modal>}
    <div style={{ display: "flex", gap: 5, marginBottom: 14 }}>
      {[["list", "Gestores"], ["assign", "Asignación Cuentas"]].map(([id, l]) => (
        <button key={id} onClick={() => setTtab(id)} style={{ background: ttab === id ? IND : BG2, color: ttab === id ? "#fff" : T4, border: `1px solid ${ttab === id ? IND : BD}`, borderRadius: 7, padding: "5px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{l}</button>
      ))}
    </div>
    {ttab === "list" && <div>
      {isSuperAdmin && <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
        <Btn label="+ Nuevo Usuario" onClick={() => { setForm({ username: "", password: "", name: "", role: "gestor", color: P, salary: 0 }); setModal("new"); }} />
      </div>}
      <Tbl cols={["Gestor", "Usuario", "Sueldo", "Com.", "Cobros YTD", "Reservas", "Estado", ""]}
        rows={gestors.map(g => {
          const gP = payments.filter(p => p.processedBy === g.username), gR = reservations.filter(r => r.processedBy === g.username); return (<tr key={g.id} style={{ borderBottom: `1px solid ${BG3}`, opacity: g.active === false ? .4 : 1 }}>
            <td style={td()}><div style={{ display: "flex", alignItems: "center", gap: 6 }}><div style={{ width: 20, height: 20, borderRadius: 5, background: g.color + "20", border: `1px solid ${g.color}33`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: g.color, fontWeight: 700 }}>{g.name[0]}</div><span style={{ color: T1, fontWeight: 600 }}>{g.name}</span></div></td>
            <td style={tG3()}>{g.username}</td>
            <td style={td({ color: T2, fontWeight: 600 })}>{f$(g.salary || 0)}</td>
            <td style={tG()}><span style={{ fontSize: 9, color: T4 }}>por concepto</span></td>
            <td style={td({ color: B })}>{gP.length}tx·{f$(gP.reduce((a, p) => a + p.amount, 0))}</td>
            <td style={tP()}>{gR.length} res</td>
            <td style={td()}><Bdg l={g.active === false ? "Cancelado" : "Active"} /></td>
            <td style={tFl()}><Btn label="Editar" variant="ghost" small onClick={() => { setForm({ ...g }); setModal(g); }} />{g.active !== false ? <Btn label="Baja" variant="danger" small onClick={() => setUsers(us => us.map(x => x.id === g.id ? { ...x, active: false } : x))} /> : <Btn label="Activar" variant="success" small onClick={() => setUsers(us => us.map(x => x.id === g.id ? { ...x, active: true } : x))} />}</td>
          </tr>);
        })} />
    </div>}
    {ttab === "assign" && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
      <div style={{ background: BG2, border: `1px solid ${BD}`, borderRadius: 11, padding: 16 }}>
        <Sec t="Asignar Cuentas" />
        <div style={{ marginBottom: 9 }}><Inp label="Gestor destino" value={agt} onChange={setAgt} opts={[{ v: "", l: "— Seleccionar —" }, ...gestors.filter(g => g.active !== false).map(g => ({ v: String(g.id), l: g.name }))]} /></div>
        <div style={{ fontSize: 9, color: T4, textTransform: "uppercase", marginBottom: 5 }}>Seleccionar clientes</div>
        <div style={{ maxHeight: 280, overflowY: "auto" }}>
          {clients.map(c => (<div key={c.id} onClick={() => setSelC(s => s.includes(c.id) ? s.filter(x => x !== c.id) : [...s, c.id])} style={{ padding: "6px 9px", borderBottom: `1px solid ${BG3}`, cursor: "pointer", background: selC.includes(c.id) ? B + "20" : "transparent", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div><span style={{ color: T1, fontSize: 12, fontWeight: selC.includes(c.id) ? 700 : 400 }}>{c.name}</span><span style={{ color: T4, fontSize: 9, marginLeft: 7 }}>{c.contractNo}</span></div>
            <span style={{ color: P, fontSize: 9 }}>{gestors.find(g => String(g.id) === String(c.assignedGestor))?.name || "sin asignar"}</span>
          </div>))}
        </div>
        <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 10, color: T3 }}>{selC.length} seleccionados</span>
          <Btn label="Asignar" onClick={doAssign} disabled={!agt || !selC.length} />
        </div>
      </div>
      <div style={{ background: BG2, border: `1px solid ${BD}`, borderRadius: 11, padding: 16 }}>
        <Sec t="Cuentas por Gestor — Resumen por Concepto" />
        {gestors.map(g => {
          const gC = enrichedClients.filter(c => String(c.assignedGestor) === String(g.id));
          // 1. Mantenimientos vencidos: saldo > 0 y status != "Promoción Prepago" y status != "Al corriente"
          // 2. Moratorios: interés acumulado por días vencidos
          // 3. Promoción: clientes con status "Promoción Prepago" o "Al corriente"
          const cMaintVencidos = gC.filter(c => c.balance > 0).reduce((a, c) => a + (c.balance || 0), 0);
          const cMoratorios = gC.filter(c => c.balance > 0 && c.dOvr > 0).reduce((a, c) => a + (c.interest || 0), 0);
          const cPromocion = gC.filter(c => c.cls?.l === "Promoción Prepago" || c.cls?.l === "Al corriente").length;
          const cConMora = gC.filter(c => c.balance > 0).length;
          return (<div key={g.id} style={{ marginBottom: 16, padding: "12px 14px", background: BG3, borderRadius: 8, borderLeft: `3px solid ${g.color}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10, alignItems: "center" }}>
              <span style={{ color: g.color, fontWeight: 700, fontSize: 13 }}>{g.name}</span>
              <span style={{ color: T4, fontSize: 11 }}>{gC.length} cuenta{gC.length !== 1 ? "s" : ""} asignada{gC.length !== 1 ? "s" : ""}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 10 }}>
              <div style={{ background: R + "12", border: `1px solid ${R}33`, borderRadius: 6, padding: "8px 10px" }}>
                <div style={{ fontSize: 8, color: T4, textTransform: "uppercase", marginBottom: 2 }}>Mantenimientos vencidos</div>
                <div style={{ color: R, fontWeight: 800, fontSize: 14 }}>{f$(cMaintVencidos)}</div>
                <div style={{ fontSize: 9, color: T4 }}>{cConMora} cuenta{cConMora !== 1 ? "s" : ""}</div>
              </div>
              <div style={{ background: Y + "12", border: `1px solid ${Y}33`, borderRadius: 6, padding: "8px 10px" }}>
                <div style={{ fontSize: 8, color: T4, textTransform: "uppercase", marginBottom: 2 }}>Moratorios</div>
                <div style={{ color: Y, fontWeight: 800, fontSize: 14 }}>{f$(cMoratorios)}</div>
                <div style={{ fontSize: 9, color: T4 }}>intereses acumulados</div>
              </div>
              <div style={{ background: G + "12", border: `1px solid ${G}33`, borderRadius: 6, padding: "8px 10px" }}>
                <div style={{ fontSize: 8, color: T4, textTransform: "uppercase", marginBottom: 2 }}>Promoción / Al corriente</div>
                <div style={{ color: G, fontWeight: 800, fontSize: 14 }}>{cPromocion}</div>
                <div style={{ fontSize: 9, color: T4 }}>cuenta{cPromocion !== 1 ? "s" : ""}</div>
              </div>
            </div>
            {gC.map(c => (<div key={c.id} style={{ padding: "4px 7px", background: BG2, borderRadius: 4, marginBottom: 2, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <span style={{ color: T2, fontSize: 11 }}>{c.name}</span>
                <span style={{ color: c.cls?.c || T4, fontSize: 9, marginLeft: 6 }}>· {c.cls?.l || "—"}</span>
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}><span style={{ color: c.balance > 0 ? R : G, fontSize: 10 }}>{f$(c.balance)}</span><Btn label="Quitar" variant="danger" small onClick={async () => {
                setClients(cs => cs.map(x => x.id === c.id ? { ...x, assignedGestor: "" } : x));
                if (onAssignGestor) await onAssignGestor([c.id], null);
              }} /></div>
            </div>))}
            {gC.length === 0 && <div style={{ fontSize: 10, color: T4, padding: "4px 0", textAlign: "center" }}>Sin cuentas asignadas</div>}
          </div>);
        })}
      </div>
    </div>}
  </div>);
}
function ContractsView({ clients, setClients }) {
  const [modal, setModal] = useState(null), [reason, setReason] = useState(""), [type, setType] = useState("Cancelado s/pago"), [srch, setSrch] = useState("");
  const filtered = clients.filter(c => c.name.toLowerCase().includes(srch.toLowerCase()) || c.contractNo.toLowerCase().includes(srch.toLowerCase()));
  return (<div>
    {modal && (() => {
      const savedTotal = (modal.savedPoints || []).filter(sp => new Date(sp.expiryDate) > new Date()).reduce((a, sp) => a + sp.points, 0);
      const totalPtsToLose = (modal.paidPoints || 0) + savedTotal;
      return <Modal title={`Cancelar — ${modal.name}`} onClose={() => setModal(null)}>
        <div style={{ background: R + "12", border: `1px solid ${R}28`, borderRadius: 7, padding: "10px 12px", marginBottom: 12, fontSize: 11, color: R }}>
          ⚠ El cliente perderá acceso a reservaciones.
          {totalPtsToLose > 0 && <div style={{ marginTop: 4, color: O }}>Pierde <b>{fP(totalPtsToLose)}</b> ({fP(modal.paidPoints || 0)} pagados{savedTotal > 0 ? ` + ${fP(savedTotal)} prepagos/guardados` : ""}).</div>}
          {modal.balance > 0 && <div style={{ marginTop: 4, color: Y }}>Saldo pendiente: <b>{f$(modal.balance)}</b></div>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          <Inp label="Tipo de cancelación" value={type} onChange={setType} opts={[{ v: "Cancelado s/pago", l: "Sin pago — deuda activa" }, { v: "Cancelado c/pago", l: "Con pago — deuda liquidada" }]} />
          <Inp label="Motivo / Notas" value={reason} onChange={setReason} />
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
          <Btn label="No cancelar" variant="ghost" onClick={() => setModal(null)} />
          <Btn label="Confirmar Cancelación" variant="danger" onClick={() => {
            // Al cancelar el cliente PIERDE TODOS los puntos (paidPoints + savedPoints)
            setClients(cs => cs.map(c => c.id === modal.id ? { ...c, contractStatus: type, cancelReason: reason, cancelDate: new Date().toISOString().split("T")[0], paidPoints: 0, savedPoints: [] } : c));
            if (onCancelContract) onCancelContract(modal.id, type, reason);
            setModal(null); setReason("");
          }} />
        </div>
      </Modal>;
    })()}
    <div style={{ display: "flex", gap: 9, flexWrap: "wrap", marginBottom: 13 }}>
      <Kpi label="Contratos Activos" value={clients.filter(c => c.contractStatus === "Active").length} accent={G} />
      <Kpi label="Cancelados s/Pago" value={clients.filter(c => c.contractStatus === "Cancelado s/pago").length} accent={R} />
      <Kpi label="Cancelados c/Pago" value={clients.filter(c => c.contractStatus === "Cancelado c/pago").length} accent={P} />
      <Kpi label="Deuda en Cancelados" value={f$(clients.filter(c => c.contractStatus !== "Active").reduce((a, c) => a + c.balance, 0))} accent={O} warn />
    </div>
    <div style={{ marginBottom: 11 }}><input placeholder="Buscar…" value={srch} onChange={e => setSrch(e.target.value)} style={{ ...IS, maxWidth: 320 }} /></div>
    <Tbl cols={["Contrato", "Cliente", "Pts", "Saldo", "Est. Cuenta", "Estado Cto.", "Cancelación", "Motivo", ""]}
      rows={filtered.map(c => (<tr key={c.id} style={{ borderBottom: `1px solid ${BG3}` }}>
        <td style={tBb()}>{c.contractNo}</td>
        <td style={tW()}>{c.name}</td>
        <td style={tG3()}>{fP(c.totalPoints)}</td>
        <td style={td({ color: c.balance > 0 ? R : G, fontWeight: 700 })}>{f$(c.balance)}</td>
        <td style={td()}><Bdg l={c.status} /></td>
        <td style={td()}><Bdg l={c.contractStatus} /></td>
        <td style={tS()}>{c.cancelDate || "—"}</td>
        <td style={td({ color: T4, fontSize: 10, maxWidth: 140 })}>{c.cancelReason || "—"}</td>
        <td style={td()}>{c.contractStatus === "Active" ? <Btn label="Cancelar" variant="danger" small onClick={() => setModal(c)} /> : <Btn label="Reactivar" variant="success" small onClick={() => {
          setClients(cs => cs.map(x => x.id === c.id ? { ...x, contractStatus: "Active", cancelReason: "", cancelDate: "" } : x));
          if (onCancelContract) onCancelContract(c.id, "Active", "Reactivado");
        }} />}</td>
      </tr>))} />
  </div>);
}
function CourtesiesView({ clients, setClients, courtesies, setCourtesies, pp, cu, users, onSaveCourtesy }) {
  const [modal, setModal] = useState(false), [sid, setSid] = useState(null), [ctype, setCtype] = useState("points"), [amt, setAmt] = useState(""), [reason, setReason] = useState(""), [cat, setCat] = useState("points");
  const ctypeOpts = [{ v: "points", l: "Puntos gratuitos" }, { v: "balance_reduction", l: "Reducción de saldo" }, { v: "free_reservation", l: "Reservación gratuita" }];
  const client = clients.find(c => c.id === sid);
  const doAdd = () => {
    if (!client || !reason || !amt) return;
    const c = { clientId: client.id, clientName: client.name, contractNo: client.contractNo, ctype, category: cat, amount: +amt, reason, grantedByUsername: cu.username };
    setCourtesies(cs => [...cs, { ...c, id: Date.now(), date: new Date().toISOString().split("T")[0] }]);
    if (onSaveCourtesy) onSaveCourtesy(c).catch(console.error);
    setModal(false); setSid(null); setAmt(""); setReason("");
  };
  const getAuthorName = (c) => {
    if (c.grantedByName) return c.grantedByName;
    if (c.grantedByUsername) return c.grantedByUsername;
    const u = users?.find(u => u.id === c.grantedBy || u.username === c.grantedBy);
    return u?.name || u?.username || c.grantedBy || "—";
  };
  return (<div>
    {modal && <Modal title="Nueva Cortesía" onClose={() => setModal(false)}>
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        <SearchBox clients={clients.filter(c => c.contractStatus === "Active")} onSelect={setSid} selectedId={sid} />
        <Inp label="Tipo" value={ctype} onChange={setCtype} opts={ctypeOpts} />
        <Inp label="Cantidad (pts o $)" value={amt} onChange={setAmt} type="number" />
        <Inp label="Categoría" value={cat} onChange={setCat} opts={[{ v: "points", l: "Puntos" }, { v: "balance_reduction", l: "Balance" }, { v: "free_reservation", l: "Reservación" }]} />
        <Inp label="Motivo detallado (obligatorio)" value={reason} onChange={setReason} />
      </div>
      {!reason && <div style={{ color: Y, fontSize: 10, marginTop: 4 }}>⚠ El motivo es obligatorio.</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}><Btn label="Cancelar" variant="ghost" onClick={() => setModal(false)} /><Btn label="Registrar Cortesía" variant="purple" disabled={!client || !reason || !amt} onClick={doAdd} /></div>
    </Modal>}
    <div style={{ display: "flex", gap: 9, flexWrap: "wrap", marginBottom: 13 }}>
      <Kpi label="Cortesías Registradas" value={courtesies.length} accent={P} />
      <Kpi label="Valor Total" value={f$(courtesies.reduce((a, c) => c.ctype === "balance_reduction" || c.type === "balance_reduction" ? a + c.amount : c.ctype === "points" || c.type === "points" ? a + c.amount * pp : a + 500, 0))} accent={O} warn={courtesies.length > 0} />
    </div>
    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}><Btn label="+ Nueva Cortesía" variant="purple" onClick={() => setModal(true)} /></div>
    <Tbl cols={["Fecha", "Contrato", "Cliente", "Tipo", "Cantidad", "Motivo", "Otorgado por"]}
      rows={[...courtesies].reverse().map(c => (<tr key={c.id} style={{ borderBottom: `1px solid ${BG3}` }}>
        <td style={tS()}>{c.date || c.createdAt?.slice(0, 10)}</td>
        <td style={tBs()}>{c.contractNo}</td>
        <td style={tW()}>{c.clientName}</td>
        <td style={tPs()}>{ctypeOpts.find(o => o.v === (c.ctype || c.type))?.l || c.ctype || c.type}</td>
        <td style={td({ color: P, fontWeight: 700 })}>{(c.ctype || c.type) === "points" ? fP(c.amount) : f$(c.amount)}</td>
        <td style={tG3s()}>{c.reason}</td>
        <td style={tPs()}>{getAuthorName(c)}</td>
      </tr>))} />
  </div>);
}
// ── DASHBOARD ────────────────────────────────────────────────────────────────
function Dashboard({ clients, reservations, payments, pp, promises, users, condonations, fxRate }) {
  const [showAllPromises, setShowAllPromises] = useState(false);
  const fx = fxRate?.rate || 17.5;
  const collT = payments.filter(p => p.date === TOD).reduce((a, p) => a + p.amount, 0);
  const collM = payments.filter(p => p.date && p.date.slice(0, 7) === TOM).reduce((a, p) => a + p.amount, 0);
  const activeProm = promises.filter(p => p.status === "pending" || p.status === "Pendiente");
  const promT = activeProm.filter(p => p.promiseDate === TOD);
  const promM = activeProm.filter(p => p.promiseDate && p.promiseDate.slice(0, 7) === TOM);
  const promOvr = activeProm.filter(p => p.promiseDate < TOD);
  const mPmts = payments.filter(p => p.date && p.date.slice(0, 7) === TOM);
  const txM = mPmts.reduce((a, p) => a + p.amount * (p.costPct || 0) / 100, 0);
  const commM = mPmts.reduce((a, p) => a + (p.agentCommission || 0), 0);
  const salM = users.filter(u => ["gestor", "cajero", "admin"].includes(u.role)).reduce((a, u) => a + (u.salary || 0), 0);
  const costPct = collM > 0 ? (((txM + commM + salM) / collM) * 100).toFixed(1) : "0.0";
  const en = clients.map(c => { const d = dOvr(c.dueDate); const cl = getClientStatus(c, payments, condonations); return { ...c, d, cls: cl, int: cInt(c.balance, d, cl.r * 12) }; });

  const gestorName = (p) => p.gestorName || users.find(u => String(u.id) === String(p.gestorId))?.name || p.gestorUsername || "—";

  // Panel de todas las promesas activas agrupadas por gestor
  const AllPromisesPanel = () => {
    const gestors = users.filter(u => u.role === "gestor");
    return (<div style={{ background: BG2, border: `1px solid ${B}44`, borderRadius: 10, padding: 15, marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <Sec t="Todas las Promesas Activas" />
        <Btn label="✕ Cerrar" variant="ghost" small onClick={() => setShowAllPromises(false)} />
      </div>
      {/* KPIs */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginBottom: 14 }}>
        {[[`Vencidas`, promOvr.length, R], [`Hoy`, promT.length, Y], [`Este Mes`, promM.length, G]].map(([l, v, c]) => (
          <div key={l} style={{ background: c + "10", border: `1px solid ${c}33`, borderRadius: 7, padding: "8px 10px", textAlign: "center" }}>
            <div style={{ fontSize: 8, color: T4, textTransform: "uppercase" }}>{l}</div>
            <div style={{ color: c, fontWeight: 800, fontSize: 20 }}>{v}</div>
          </div>
        ))}
      </div>
      {/* Vencidas */}
      {promOvr.length > 0 && <>
        <div style={{ fontSize: 9, color: R, fontWeight: 800, textTransform: "uppercase", marginBottom: 6, marginTop: 8 }}>⚠ Vencidas ({promOvr.length})</div>
        {promOvr.sort((a,b) => a.promiseDate.localeCompare(b.promiseDate)).map(p => (
          <PromiseRow key={p.id} p={p} color={R} gestorName={gestorName(p)} fx={fx} />
        ))}
      </>}
      {/* Hoy */}
      {promT.length > 0 && <>
        <div style={{ fontSize: 9, color: Y, fontWeight: 800, textTransform: "uppercase", marginBottom: 6, marginTop: 8 }}>Hoy ({promT.length})</div>
        {promT.sort((a,b) => (b.amount||0)-(a.amount||0)).map(p => (
          <PromiseRow key={p.id} p={p} color={Y} gestorName={gestorName(p)} fx={fx} />
        ))}
      </>}
      {/* Futuras del mes */}
      {promM.filter(p => p.promiseDate > TOD).length > 0 && <>
        <div style={{ fontSize: 9, color: G, fontWeight: 800, textTransform: "uppercase", marginBottom: 6, marginTop: 8 }}>Futuras este mes ({promM.filter(p => p.promiseDate > TOD).length})</div>
        {promM.filter(p => p.promiseDate > TOD).sort((a,b) => a.promiseDate.localeCompare(b.promiseDate)).map(p => (
          <PromiseRow key={p.id} p={p} color={G} gestorName={gestorName(p)} fx={fx} />
        ))}
      </>}
      {activeProm.length === 0 && <div style={{ color: T4, fontSize: 11, textAlign: "center", padding: "20px 0" }}>No hay promesas activas</div>}
    </div>);
  };

  return (<div>
    {/* Botón ver todas las promesas (lado izquierdo del header) */}
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
      <div>
        <Btn label={`★ Ver Promesas de Todos los Gestores (${activeProm.length})`} variant={showAllPromises ? "success" : "ghost"} onClick={() => setShowAllPromises(v => !v)} />
      </div>
      <div style={{ fontSize: 9, color: T4 }}>{TOD}</div>
    </div>

    {/* Panel de todas las promesas */}
    {showAllPromises && <AllPromisesPanel />}

    {/* KPIs */}
    <div style={{ display: "flex", gap: 9, flexWrap: "wrap", marginBottom: 18 }}>
      <Kpi label="Cobrado Hoy" value={f$(collT)} accent={G} />
      <Kpi label="Cobrado este Mes" value={f$(collM)} accent={B} />
      <Kpi label="Promesas Hoy" value={promT.length} sub={fMXN(promT.reduce((a, p) => a + p.amount * fx, 0))} accent={Y} warn={promT.length > 0} />
      <Kpi label="Promesas Vencidas" value={promOvr.length} sub={fMXN(promOvr.reduce((a, p) => a + p.amount * fx, 0))} accent={R} warn={promOvr.length > 0} />
      <Kpi label="Costo Cobranza Mes" value={costPct + "%"} sub={`${f$(txM + commM + salM)} / ${f$(collM)}`} accent={O} warn={parseFloat(costPct) > 25} />
      <Kpi label="Saldo Pendiente" value={f$(clients.reduce((a, c) => a + c.balance, 0))} accent={R} />
    </div>

    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 13 }}>
      {/* Clasificación morosidad */}
      <div style={{ background: BG2, border: `1px solid ${BD}`, borderRadius: 10, padding: 15 }}>
        <Sec t="Clasificación de Morosidad" />
        {[{ l: "Al corriente", c: G }, { l: "1–30 días", c: "#a3e635" }, { l: "31–60 días", c: Y }, { l: "61–90 días", c: O }, { l: "91–180 días", c: R }, { l: "+180 días", c: "#dc2626" }].map(bk => {
          const cnt = en.filter(c => c.cls.l === bk.l).length; return cnt > 0 ? (<div key={bk.l} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: bk.c }} />
            <span style={{ color: T3, fontSize: 11, flex: 1 }}>{bk.l}</span>
            <span style={{ color: bk.c, fontWeight: 700 }}>{cnt}</span>
            <div style={{ width: 50, height: 4, background: BD, borderRadius: 3 }}><div style={{ width: `${(cnt / clients.length) * 100}%`, height: "100%", background: bk.c, borderRadius: 3 }} /></div>
          </div>) : null;
        })}
      </div>

      {/* Promesas de hoy (reemplaza "Próximas Reservaciones") */}
      <div style={{ background: BG2, border: `1px solid ${BD}`, borderRadius: 10, padding: 15 }}>
        <Sec t={`Promesas de Hoy (${promT.length})`} />
        {promT.length === 0 && promOvr.length > 0 && <>
          <div style={{ fontSize: 9, color: R, fontWeight: 700, marginBottom: 6 }}>⚠ {promOvr.length} promesa{promOvr.length > 1 ? "s" : ""} vencida{promOvr.length > 1 ? "s" : ""}</div>
          {promOvr.slice(0, 4).map(p => <PromiseRow key={p.id} p={p} color={R} gestorName={gestorName(p)} fx={fx} />)}
        </>}
        {promT.map(p => <PromiseRow key={p.id} p={p} color={Y} gestorName={gestorName(p)} fx={fx} />)}
        {promT.length === 0 && promOvr.length === 0 && <div style={{ color: T4, fontSize: 11, textAlign: "center", padding: "14px 0" }}>Sin promesas para hoy</div>}
      </div>

      {/* Pagos recientes */}
      <div style={{ background: BG2, border: `1px solid ${BD}`, borderRadius: 10, padding: 15 }}>
        <Sec t="Pagos Recientes" />
        {[...payments].reverse().slice(0, 5).map(p => (<div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 0", borderBottom: `1px solid ${BG3}` }}>
          <div><div style={{ color: T1, fontSize: 11, fontWeight: 600 }}>{p.clientName}</div><div style={{ color: T4, fontSize: 9 }}>{p.date}·{p.method}·{p.processedBy}</div></div>
          <span style={{ color: G, fontWeight: 700, fontSize: 11 }}>{f$(p.amount)}</span>
        </div>))}
        {payments.length === 0 && <div style={{ color: T4, fontSize: 11, textAlign: "center", padding: "14px 0" }}>Sin pagos</div>}
      </div>

      {/* Pts por vencer */}
      <div style={{ background: BG2, border: `1px solid ${BD}`, borderRadius: 10, padding: 15 }}>
        <Sec t={`Pts vencen Dic 31, ${CY}`} />
        <div style={{ fontSize: 10, color: T4, marginBottom: 7 }}>Puntos sin pagar que vencerán si no se cobra a tiempo</div>
        {clients.filter(c => c.annualPoints > c.paidPoints && c.contractStatus === "Active").slice(0, 4).map(c => (<div key={c.id} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: `1px solid ${BG3}` }}>
          <span style={{ color: T2, fontSize: 11 }}>{c.name}</span>
          <span style={{ color: R, fontSize: 11, fontWeight: 700 }}>{fP(c.annualPoints - c.paidPoints)}</span>
        </div>))}
        {clients.filter(c => c.annualPoints > c.paidPoints && c.contractStatus === "Active").length === 0 && <div style={{ color: G, fontSize: 11, textAlign: "center", padding: "14px 0" }}>¡Todos los clientes pagados!</div>}
      </div>
    </div>
  </div>);
}

// Fila compacta de promesa para usar en Dashboard
function PromiseRow({ p, color, gestorName, fx }) {
  const rate = fx || 17.5;
  const amountMxn = p.amount * rate;
  return (
    <div style={{ padding: "5px 7px", background: BG3, borderLeft: `2px solid ${color}`, borderRadius: 4, marginBottom: 4, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <div>
        <span style={{ color: T1, fontSize: 11, fontWeight: 600 }}>{p.clientName}</span>
        <span style={{ color: T4, fontSize: 9, marginLeft: 6 }}>{p.contractNo}</span>
        <div style={{ color: T4, fontSize: 9 }}>
          {p.promiseDate} · {gestorName}
          {p.concept && p.concept !== 'maintenance' && <span style={{ marginLeft: 6, color: color }}>· {p.concept}</span>}
        </div>
      </div>
      <span style={{ color: color, fontWeight: 700, fontSize: 11, whiteSpace: "nowrap" }}>{fMXN(amountMxn)}</span>
    </div>
  );
}

// ── MY ACCOUNT (GESTOR) ──────────────────────────────────────────────────────
function MyAccountView({ cu, users, payments, pms, fxRate, cr }) {
  const userRecord = users.find(u => u.username === cu.username) || cu;
  const sueldo = userRecord.salary || 0;
  const costoSocial = userRecord.socialCost || 0;
  // Filtrar pagos del mes actual del gestor
  const TOD2 = new Date();
  const monthStart = new Date(TOD2.getFullYear(), TOD2.getMonth(), 1);
  const myPayments = payments.filter(p => {
    const procBy = p.originatedBy || p.processedBy;
    if (procBy !== cu.username) return false;
    if (!p.date) return false;
    return new Date(p.date) >= monthStart;
  });
  const fx = fxRate?.rate || 17.5;
  const cobradoMxn = myPayments.reduce((a, p) => a + (p.amount || 0), 0);
  // Comisiones por concepto desde tabla cr (parejo para todos los gestores)
  const getCrPct = (conceptId) => {
    const r = (cr || []).find(x => x.id === conceptId && x.active !== false);
    return r ? (r.pct / 100) : 0;
  };
  const comisiones = myPayments.reduce((a, p) => {
    const mantNeto = (p.amountMant || 0) * fx;
    const moraNeto = (p.amountMora || 0) * fx;
    const isP = p.isPrepago;
    // prepago usa "maintenance" pero con tasa propia si existe; si no, usa maintenance
    const cMantPct = isP ? (getCrPct('prepago') || getCrPct('maintenance') || 0.01) : (getCrPct('maintenance') || 0.02);
    const cMoraPct = getCrPct('moratorios') || 0.03;
    return a + mantNeto * cMantPct + moraNeto * cMoraPct;
  }, 0);
  // Costos financieros
  const costosFin = myPayments.reduce((a, p) => {
    const pm = pms.find(m => m.id === p.methodId);
    const pct = (pm?.costPct || 0) / 100;
    return a + (p.amount || 0) * pct;
  }, 0);
  // Costo total para la empresa
  const costoTotal = sueldo + costoSocial + comisiones + costosFin;
  const pctCosto = cobradoMxn > 0 ? (costoTotal / cobradoMxn) * 100 : 0;
  return (<div style={{ padding: 20, color: T1 }}>
    <h2 style={{ color: B, fontWeight: 700, marginBottom: 20 }}>Mi Estado de Cuenta — {userRecord.name || cu.username}</h2>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 12, marginBottom: 20 }}>
      <div style={{ background: BG2, border: `1px solid ${BD}`, borderRadius: 8, padding: 14 }}>
        <div style={{ fontSize: 9, color: T4, textTransform: "uppercase", marginBottom: 4 }}>Sueldo Mensual</div>
        <div style={{ color: T1, fontWeight: 700, fontSize: 18 }}>{fMXN(sueldo)}</div>
      </div>
      <div style={{ background: BG2, border: `1px solid ${BD}`, borderRadius: 8, padding: 14 }}>
        <div style={{ fontSize: 9, color: T4, textTransform: "uppercase", marginBottom: 4 }}>Costo Social</div>
        <div style={{ color: O, fontWeight: 700, fontSize: 18 }}>{fMXN(costoSocial)}</div>
        {sueldo > 0 && <div style={{ fontSize: 9, color: T4, marginTop: 3 }}>{((costoSocial / sueldo) * 100).toFixed(1)}% del sueldo</div>}
      </div>
      <div style={{ background: BG2, border: `1px solid ${BD}`, borderRadius: 8, padding: 14 }}>
        <div style={{ fontSize: 9, color: T4, textTransform: "uppercase", marginBottom: 4 }}>Comisiones del Mes</div>
        <div style={{ color: G, fontWeight: 700, fontSize: 18 }}>{fMXN(comisiones)}</div>
        <div style={{ fontSize: 9, color: T4, marginTop: 3 }}>por concepto cobrado</div>
      </div>
      <div style={{ background: BG2, border: `1px solid ${BD}`, borderRadius: 8, padding: 14 }}>
        <div style={{ fontSize: 9, color: T4, textTransform: "uppercase", marginBottom: 4 }}>Costos Financieros</div>
        <div style={{ color: Y, fontWeight: 700, fontSize: 18 }}>{fMXN(costosFin)}</div>
        <div style={{ fontSize: 9, color: T4, marginTop: 3 }}>medios usados en el mes</div>
      </div>
      <div style={{ background: BG2, border: `1px solid ${B}33`, borderRadius: 8, padding: 14 }}>
        <div style={{ fontSize: 9, color: T4, textTransform: "uppercase", marginBottom: 4 }}>Cobrado en el Mes</div>
        <div style={{ color: B, fontWeight: 700, fontSize: 18 }}>{fMXN(cobradoMxn)}</div>
        <div style={{ fontSize: 9, color: T4, marginTop: 3 }}>{myPayments.length} pagos validados</div>
      </div>
    </div>
    <div style={{ background: BG2, border: `1px solid ${BD}`, borderRadius: 8, padding: 18, marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: T3, textTransform: "uppercase", fontWeight: 700 }}>Costo Total para la Empresa</div>
        <div style={{ color: pctCosto > 50 ? R : pctCosto > 30 ? Y : G, fontWeight: 800, fontSize: 28 }}>{fMXN(costoTotal)}</div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 12 }}>
        <div>
          <div style={{ fontSize: 9, color: T4, marginBottom: 3 }}>Detalle del costo:</div>
          <div style={{ fontSize: 11, color: T2 }}>Sueldo: <b>{fMXN(sueldo)}</b></div>
          <div style={{ fontSize: 11, color: T2 }}>+ Costo social: <b style={{ color: O }}>{fMXN(costoSocial)}</b></div>
          <div style={{ fontSize: 11, color: T2 }}>+ Comisiones: <b>{fMXN(comisiones)}</b></div>
          <div style={{ fontSize: 11, color: T2 }}>+ Costos financieros: <b>{fMXN(costosFin)}</b></div>
          <div style={{ fontSize: 11, color: B, fontWeight: 700, marginTop: 5 }}>= Total: {fMXN(costoTotal)}</div>
        </div>
        <div>
          <div style={{ fontSize: 9, color: T4, marginBottom: 3 }}>% del cobrado que cuesta:</div>
          <div style={{ color: pctCosto > 50 ? R : pctCosto > 30 ? Y : G, fontWeight: 800, fontSize: 32 }}>{pctCosto.toFixed(1)}%</div>
          <div style={{ fontSize: 10, color: T4, marginTop: 3 }}>{costoTotal.toFixed(0)} / {cobradoMxn.toFixed(0)} × 100</div>
        </div>
      </div>
    </div>
    <div style={{ background: BG2, border: `1px solid ${BD}`, borderRadius: 8, padding: 18 }}>
      <div style={{ fontSize: 11, color: T3, textTransform: "uppercase", fontWeight: 700, marginBottom: 10 }}>Pagos Procesados Este Mes</div>
      {myPayments.length === 0 ? <div style={{ color: T4, fontSize: 11, textAlign: "center", padding: 20 }}>Sin pagos en el mes actual.</div> : (
        <Tbl cols={["Fecha", "Cliente", "Concepto", "Monto", "Medio", "Comisión"]} rows={myPayments.map(p => {
          const mantNeto = (p.amountMant || 0) * fx;
          const moraNeto = (p.amountMora || 0) * fx;
          const mantPct = p.isPrepago ? (getCrPct('prepago') || 0.01) : (getCrPct('maintenance') || 0.02);
          const moraPct = getCrPct('moratorios') || 0.03;
          const com = mantNeto * mantPct + moraNeto * moraPct;
          const pmName = pms.find(m => m.id === p.methodId)?.name || p.method || "—";
          return (<tr key={p.id} style={{ borderBottom: `1px solid ${BG3}` }}>
            <td style={tG3()}>{p.date}</td>
            <td style={tW()}>{p.clientName}</td>
            <td style={tG3()}>{p.isPrepago ? "Prepago" : (p.type === "maintenance" ? "Mantenimiento" : p.type)}</td>
            <td style={tGb()}>{fMXN(p.amount)}</td>
            <td style={tG3()}>{pmName}</td>
            <td style={tBb()}>{fMXN(com)}</td>
          </tr>);
        })} />
      )}
    </div>
  </div>);
}

// ── GESTIÓN ESPECIAL — Condonaciones y Recuperación de Puntos ─────────────────
function SpecialMgmtView({ clients, payments, condonations, setCondonations, cu, users, pp, onSaveCondonation, onSaveRecoveredPoints }) {
  const [stab, setStab] = useState("cond");
  const [selC, setSelC] = useState(null);
  const [selYear, setSelYear] = useState(null);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [recSelC, setRecSelC] = useState(null);
  const [recSelYear, setRecSelYear] = useState(null);
  const [recReason, setRecReason] = useState("");
  const [recConfirming, setRecConfirming] = useState(false);

  const client = clients.find(c => c.id === selC);
  const recClient = clients.find(c => c.id === recSelC);

  // Años condonados para el cliente seleccionado
  const condYears = condonations
    .filter(c => c.clientId === selC)
    .map(c => c.maintYear);

  // Años disponibles para condonar: vencidos (< CY), con mantenimiento impago, no condonados antes
  const getCondonableYears = (cli) => {
    if (!cli || !cli.contractDate) return [];
    const startYear = new Date(cli.contractDate).getFullYear();
    const paidByYear = getPaidPtsByYear(cli, payments);
    const alreadyCond = condonations.filter(c => c.clientId === cli.id).map(c => c.maintYear);
    const years = [];
    for (let yr = startYear; yr < CY; yr++) {
      const paid = (paidByYear[yr] || 0) >= (cli.annualPoints || 0);
      const condonated = alreadyCond.includes(yr);
      if (!paid && !condonated) years.push(yr);
    }
    return years;
  };

  // Años disponibles para recuperar puntos:
  // - Solo CY-1 y CY-2 (últimos 2 años)
  // - Solo si el mantenimiento fue PAGADO (puntos se distribuyeron)
  // - Solo si los puntos ya vencieron (siempre, porque son años < CY)
  // - Solo si esos puntos NO están ya en client_saved_points vigentes
  const getRecoverableYears = (cli) => {
    if (!cli || !cli.contractDate) return [];
    const startYear = new Date(cli.contractDate).getFullYear();
    const paidByYear = getPaidPtsByYear(cli, payments);
    const annualPts = cli.annualPoints || 0;
    const now = new Date();
    const validSaved = (cli.savedPoints || []).filter(sp => new Date(sp.expiryDate) > now);
    const years = [];
    for (let yr = CY - 2; yr < CY; yr++) {
      if (yr < startYear) continue;
      const paid = (paidByYear[yr] || 0) >= annualPts;
      // Verificar si ya existen puntos recuperados de ese año en savedPoints vigentes
      const alreadyRecovered = validSaved.some(sp => sp.maintYear === yr);
      if (paid && !alreadyRecovered) years.push(yr);
    }
    return years;
  };

  const condonableYears = client ? getCondonableYears(client) : [];
  const recoverableYears = recClient ? getRecoverableYears(recClient) : [];
  const recYear = recoverableYears.find(y => y === recSelYear);
  const paidByYearRec = recClient ? getPaidPtsByYear(recClient, payments) : {};
  const recPts = recYear ? Math.min(paidByYearRec[recYear] || 0, recClient?.annualPoints || 0) : 0;
  const expiryRec = new Date(CY + 1, 11, 31).toISOString().split("T")[0];

  const doCondonar = async () => {
    if (!client || !selYear || !reason.trim()) return;
    await onSaveCondonation(client.id, selYear, reason);
    setCondonations(prev => [...prev, { id: Date.now(), clientId: client.id, clientName: client.name, maintYear: selYear, reason, authorizedByName: cu.name || cu.username, date: new Date().toISOString().split("T")[0] }]);
    setConfirming(false); setSelYear(null); setReason("");
  };

  const doRecuperar = async () => {
    if (!recClient || !recSelYear || !recReason.trim() || recPts <= 0) return;
    await onSaveRecoveredPoints(recClient.id, recPts, recSelYear, `[RECUPERACIÓN] Año ${recSelYear} — ${recReason}`);
    setRecConfirming(false); setRecSelYear(null); setRecReason("");
  };

  const btnStyle = (active) => ({ background: active ? IND : BG2, color: active ? "#fff" : T4, border: `1px solid ${active ? IND : BD}`, borderRadius: 7, padding: "5px 14px", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" });

  return (<div style={{ padding: 20, color: T1 }}>
    <div style={{ display: "flex", gap: 6, marginBottom: 20, borderBottom: `1px solid ${BD}`, paddingBottom: 12 }}>
      <button style={btnStyle(stab === "cond")} onClick={() => setStab("cond")}>⚖ Condonar Mantenimiento</button>
      <button style={btnStyle(stab === "rec")} onClick={() => setStab("rec")}>🔄 Recuperar Puntos</button>
      <button style={btnStyle(stab === "hist")} onClick={() => setStab("hist")}>📋 Historial</button>
    </div>

    {/* ── CONDONAR ── */}
    {stab === "cond" && <div style={{ maxWidth: 600 }}>
      <div style={{ background: R + "15", border: `1px solid ${R}44`, borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 10, color: R }}>
        ⚠ La condonación cancela la deuda de mantenimiento de un año sin otorgar puntos al cliente. Solo aplica a años con mantenimiento vencido e impago. Esta acción queda registrada en auditoría.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div>
          <div style={{ fontSize: 9, color: T4, textTransform: "uppercase", marginBottom: 5 }}>Cliente</div>
          <SearchBox clients={clients} onSelect={id => { setSelC(id); setSelYear(null); setConfirming(false); }} selectedId={selC} />
        </div>
        {client && condonableYears.length === 0 && <div style={{ background: G + "15", border: `1px solid ${G}44`, borderRadius: 6, padding: "10px 14px", fontSize: 11, color: G }}>
          ✓ Este cliente no tiene años vencidos disponibles para condonar.
        </div>}
        {client && condonableYears.length > 0 && <>
          <div>
            <div style={{ fontSize: 9, color: T4, textTransform: "uppercase", marginBottom: 5 }}>Año a condonar</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {condonableYears.map(yr => (
                <button key={yr} onClick={() => { setSelYear(yr); setConfirming(false); }} style={{ background: selYear === yr ? R + "33" : BG3, border: `1px solid ${selYear === yr ? R : BD}`, color: selYear === yr ? R : T2, borderRadius: 6, padding: "5px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                  {yr}
                </button>
              ))}
            </div>
          </div>
          {selYear && <div>
            <div style={{ fontSize: 9, color: T4, textTransform: "uppercase", marginBottom: 5 }}>Motivo (obligatorio)</div>
            <textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="Describe el motivo de la condonación..." rows={3} style={{ ...IS, resize: "vertical", fontSize: 11 }} />
          </div>}
          {selYear && reason.trim() && !confirming && (
            <div style={{ background: R + "15", border: `1px solid ${R}55`, borderRadius: 8, padding: "12px 14px" }}>
              <div style={{ fontSize: 11, color: T1, marginBottom: 8 }}>
                ¿Confirmas condonar el mantenimiento de <b style={{ color: R }}>{selYear}</b> para <b style={{ color: T1 }}>{client.name}</b>?
              </div>
              <div style={{ fontSize: 10, color: T3, marginBottom: 10 }}>
                • El cliente NO recibirá los {fP(client.annualPoints)} de ese año<br />
                • El año quedará marcado como "Condonado" en su historial<br />
                • Esta acción no se puede deshacer
              </div>
              <Btn label="Confirmar Condonación" variant="danger" onClick={() => setConfirming(true)} />
            </div>
          )}
          {confirming && (
            <div style={{ background: R + "25", border: `2px solid ${R}`, borderRadius: 8, padding: "14px 16px" }}>
              <div style={{ fontSize: 12, color: R, fontWeight: 700, marginBottom: 10 }}>⚠ ÚLTIMA CONFIRMACIÓN</div>
              <div style={{ fontSize: 11, color: T2, marginBottom: 12 }}>
                Condonar mantenimiento <b>{selYear}</b> de <b>{client.name}</b>.<br />Motivo: {reason}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <Btn label="Cancelar" variant="ghost" onClick={() => setConfirming(false)} />
                <Btn label="✓ Sí, condonar definitivamente" variant="danger" onClick={doCondonar} />
              </div>
            </div>
          )}
        </>}
        {/* Condonaciones ya aplicadas al cliente */}
        {client && condYears.length > 0 && <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 9, color: T4, textTransform: "uppercase", marginBottom: 5 }}>Años ya condonados</div>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
            {condYears.map(yr => <span key={yr} style={{ background: R + "20", border: `1px solid ${R}44`, color: R, borderRadius: 5, padding: "3px 9px", fontSize: 11, fontWeight: 700 }}>⚖ {yr}</span>)}
          </div>
        </div>}
      </div>
    </div>}

    {/* ── RECUPERAR PUNTOS ── */}
    {stab === "rec" && <div style={{ maxWidth: 600 }}>
      <div style={{ background: B + "15", border: `1px solid ${B}44`, borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 10, color: B }}>
        ℹ Solo se pueden recuperar puntos de años cuyo mantenimiento fue pagado, que hayan vencido, y que no estén ya recuperados. El período máximo es de 2 años anteriores al actual ({CY - 2} y {CY - 1}). Los puntos recuperados vencen el <b>{expiryRec}</b>.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div>
          <div style={{ fontSize: 9, color: T4, textTransform: "uppercase", marginBottom: 5 }}>Cliente</div>
          <SearchBox clients={clients} onSelect={id => { setRecSelC(id); setRecSelYear(null); setRecConfirming(false); }} selectedId={recSelC} />
        </div>
        {recClient && recoverableYears.length === 0 && <div style={{ background: Y + "15", border: `1px solid ${Y}44`, borderRadius: 6, padding: "10px 14px", fontSize: 11, color: Y }}>
          ⚠ Este cliente no tiene puntos recuperables en los últimos 2 años ({CY - 2}–{CY - 1}). Puede ser porque no pagó esos años, o porque los puntos ya fueron recuperados previamente.
        </div>}
        {recClient && recoverableYears.length > 0 && <>
          <div>
            <div style={{ fontSize: 9, color: T4, textTransform: "uppercase", marginBottom: 5 }}>Año a recuperar</div>
            <div style={{ display: "flex", gap: 6 }}>
              {recoverableYears.map(yr => (
                <button key={yr} onClick={() => { setRecSelYear(yr); setRecConfirming(false); }} style={{ background: recSelYear === yr ? B + "33" : BG3, border: `1px solid ${recSelYear === yr ? B : BD}`, color: recSelYear === yr ? B : T2, borderRadius: 6, padding: "8px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                  {yr}
                  <div style={{ fontSize: 9, color: recSelYear === yr ? B : T4, marginTop: 2 }}>{fP(Math.min(paidByYearRec[yr] || 0, recClient.annualPoints))} disponibles</div>
                </button>
              ))}
            </div>
          </div>
          {recSelYear && <div>
            <div style={{ fontSize: 9, color: T4, textTransform: "uppercase", marginBottom: 5 }}>Motivo (obligatorio)</div>
            <textarea value={recReason} onChange={e => setRecReason(e.target.value)} placeholder="Describe el motivo de la recuperación..." rows={3} style={{ ...IS, resize: "vertical", fontSize: 11 }} />
          </div>}
          {recSelYear && recReason.trim() && !recConfirming && (
            <div style={{ background: B + "15", border: `1px solid ${B}55`, borderRadius: 8, padding: "12px 14px" }}>
              <div style={{ fontSize: 11, color: T1, marginBottom: 8 }}>
                ¿Confirmas recuperar <b style={{ color: B }}>{fP(recPts)}</b> de <b>{recSelYear}</b> para <b>{recClient.name}</b>?
              </div>
              <div style={{ fontSize: 10, color: T3, marginBottom: 10 }}>
                • Los puntos quedarán disponibles inmediatamente<br />
                • Vencen el <b style={{ color: Y }}>{expiryRec}</b><br />
                • Esta acción queda registrada en el historial del cliente
              </div>
              <Btn label="Recuperar Puntos" variant="success" onClick={() => setRecConfirming(true)} />
            </div>
          )}
          {recConfirming && (
            <div style={{ background: G + "20", border: `2px solid ${G}`, borderRadius: 8, padding: "14px 16px" }}>
              <div style={{ fontSize: 12, color: G, fontWeight: 700, marginBottom: 10 }}>✓ CONFIRMACIÓN FINAL</div>
              <div style={{ fontSize: 11, color: T2, marginBottom: 12 }}>
                Recuperar <b>{fP(recPts)}</b> del año <b>{recSelYear}</b> para <b>{recClient.name}</b>.<br />Vencen el {expiryRec}. Motivo: {recReason}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <Btn label="Cancelar" variant="ghost" onClick={() => setRecConfirming(false)} />
                <Btn label="✓ Confirmar recuperación" variant="success" onClick={doRecuperar} />
              </div>
            </div>
          )}
        </>}
      </div>
    </div>}

    {/* ── HISTORIAL ── */}
    {stab === "hist" && <div>
      <h3 style={{ color: T2, fontWeight: 700, marginBottom: 14, fontSize: 13 }}>Historial de Condonaciones</h3>
      {condonations.length === 0 ? <div style={{ color: T4, textAlign: "center", padding: 24 }}>Sin condonaciones registradas.</div> : (
        <Tbl cols={["Fecha", "Cliente", "Año", "Motivo", "Autorizado por"]}
          rows={condonations.map(c => (<tr key={c.id} style={{ borderBottom: `1px solid ${BG3}` }}>
            <td style={tS()}>{c.date}</td>
            <td style={tW()}>{c.clientName} <span style={{ color: T4, fontSize: 9 }}>{c.contractNo}</span></td>
            <td style={td({ color: R, fontWeight: 700 })}>{c.maintYear}</td>
            <td style={tG3()}>{c.reason}</td>
            <td style={tPs()}>{c.authorizedByName || c.authorizedByUsername || "—"}</td>
          </tr>))}
        />
      )}
    </div>}
  </div>);
}

// ── ALTA DE CONTRATOS PREEXISTENTES (MIGRACIÓN) ────────────────────────────
function LegacyContractView({ cu, users, onSave }) {
  const CY_NOW = new Date().getFullYear();
  const emptyForm = () => ({
    // Sección 1: Contrato
    contractNo: '', name: '', coHolder: '',
    contractDate: '', contractYears: 30, firstUseYear: CY_NOW,
    contractStatus: 'Active', cancelDate: '', cancelReason: '',
    assignedGestor: '',
    // Sección 2: Puntos
    totalPoints: 0, pointsUsedToDate: 0,
    // Sección 3: Último mantenimiento pagado
    lastPaidMaintYear: CY_NOW - 1,
    // Sección 4: Puntos vigentes disponibles en este momento
    hasAvailablePoints: false,
    availPts: 0, availExpiry: `${CY_NOW}-12-31`, availMaintYear: CY_NOW,
  });

  const [form, setForm] = useState(emptyForm());
  const [phones, setPhones] = useState([{ label: 'Casa', number: '' }, { label: 'Cel', number: '' }]);
  const [emails, setEmails] = useState([{ label: 'Personal', email: '' }]);
  const [addresses, setAddresses] = useState([{ label: 'Casa', address: '' }]);
  const [comments, setComments] = useState([{ text: '' }]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(null);
  const [errors, setErrors] = useState({});

  const setF = k => v => setForm(f => ({ ...f, [k]: v }));
  const gestors = users.filter(u => u.role === "gestor" && u.active !== false);

  // Cálculo automático de puntos anuales
  const yearsInContract = Math.max(1, (form.firstUseYear ? CY_NOW - form.firstUseYear + 1 : form.contractYears) || 1);
  const calcAnnualPts = form.totalPoints && form.contractYears
    ? Math.ceil(form.totalPoints / form.contractYears)
    : 0;

  // Años de mantenimiento pendientes desde lastPaidMaintYear+1 hasta CY_NOW
  const firstUnpaidYear = form.lastPaidMaintYear ? +form.lastPaidMaintYear + 1 : null;
  const pendingYears = firstUnpaidYear ? Math.max(0, CY_NOW - firstUnpaidYear + 1) : 0;
  const pendingAmountUSD = pendingYears * calcAnnualPts * 4.75;

  const validate = () => {
    const e = {};
    if (!form.contractNo.trim()) e.contractNo = "Requerido";
    if (!form.name.trim()) e.name = "Requerido";
    if (!form.firstUseYear) e.firstUseYear = "Requerido";
    if (!form.totalPoints || +form.totalPoints <= 0) e.totalPoints = "Debe ser > 0";
    if (!form.contractYears || +form.contractYears <= 0) e.contractYears = "Debe ser > 0";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      const contract = {
        ...form,
        totalPoints: +form.totalPoints,
        contractYears: +form.contractYears,
        firstUseYear: +form.firstUseYear,
        lastPaidMaintYear: form.lastPaidMaintYear ? +form.lastPaidMaintYear : null,
        pointsUsedToDate: +form.pointsUsedToDate || 0,
        annualPoints: calcAnnualPts,
        yearsElapsed: form.firstUseYear ? CY_NOW - +form.firstUseYear : 0,
        assignedGestor: form.assignedGestor || null,
      };
      const cleanPhones = phones.filter(p => p.number?.trim());
      const cleanEmails = emails.filter(e => e.email?.trim());
      const cleanAddresses = addresses.filter(a => a.address?.trim());
      const cleanComments = comments.filter(c => c.text?.trim());
      const availPts = form.hasAvailablePoints && +form.availPts > 0
        ? { points: +form.availPts, expiryDate: form.availExpiry, maintYear: +form.availMaintYear }
        : null;

      const result = await onSave(contract, cleanPhones, cleanEmails, cleanAddresses, cleanComments, availPts);
      setSaved({ contractNo: form.contractNo, name: form.name, id: result?.id });
      setForm(emptyForm());
      setPhones([{ label: 'Casa', number: '' }, { label: 'Cel', number: '' }]);
      setEmails([{ label: 'Personal', email: '' }]);
      setAddresses([{ label: 'Casa', address: '' }]);
      setComments([{ text: '' }]);
    } catch (e) {
      alert('Error: ' + (e.message || JSON.stringify(e)));
    }
    setSaving(false);
  };

  const addRow = (setter) => setter(r => [...r, { label: '', number: '', email: '', address: '', text: '' }]);
  const removeRow = (setter, i) => setter(r => r.filter((_, j) => j !== i));
  const updateRow = (setter, i, field, val) => setter(r => r.map((x, j) => j === i ? { ...x, [field]: val } : x));

  const Err = ({ k }) => errors[k] ? <div style={{ color: R, fontSize: 9, marginTop: 2 }}>{errors[k]}</div> : null;
  const SectionTitle = ({ n, t, sub }) => (<div style={{ borderBottom: `2px solid ${B}33`, paddingBottom: 6, marginBottom: 14, marginTop: 22 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ width: 22, height: 22, borderRadius: "50%", background: B, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, flexShrink: 0 }}>{n}</div>
      <div><div style={{ color: T1, fontWeight: 700, fontSize: 13 }}>{t}</div>{sub && <div style={{ color: T4, fontSize: 10 }}>{sub}</div>}</div>
    </div>
  </div>);

  return (<div style={{ padding: 20, maxWidth: 900 }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
      <div>
        <h2 style={{ color: B, fontWeight: 800, margin: 0, fontSize: 20 }}>⊕ Alta de Contrato Preexistente</h2>
        <div style={{ color: T4, fontSize: 11, marginTop: 4 }}>Para migración de contratos del sistema anterior. Solo admin/superadmin.</div>
      </div>
      {saved && <div style={{ background: G + "15", border: `1px solid ${G}44`, borderRadius: 8, padding: "10px 14px", fontSize: 11 }}>
        <div style={{ color: G, fontWeight: 700 }}>✓ Contrato {saved.contractNo} dado de alta</div>
        <div style={{ color: T3 }}>{saved.name}</div>
      </div>}
    </div>

    {/* ─── SECCIÓN 1: CONTRATO ─── */}
    <SectionTitle n="1" t="Datos del Contrato" />
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
      <div><Inp label="Número de contrato *" value={form.contractNo} onChange={setF("contractNo")} /><Err k="contractNo" /></div>
      <Inp label="Fecha de firma del contrato" value={form.contractDate} onChange={setF("contractDate")} type="date" />
      <Inp label="Plazo total del contrato (años) *" value={form.contractYears} onChange={setF("contractYears")} type="number" />
      <Inp label="Estado del contrato" value={form.contractStatus} onChange={setF("contractStatus")} opts={[{ v: "Active", l: "Activo" }, { v: "Cancelado s/pago", l: "Cancelado sin pago" }, { v: "Cancelado c/pago", l: "Cancelado con pago" }]} />
      {form.contractStatus !== "Active" && <>
        <Inp label="Fecha de cancelación" value={form.cancelDate} onChange={setF("cancelDate")} type="date" />
        <Inp label="Motivo de cancelación" value={form.cancelReason} onChange={setF("cancelReason")} />
      </>}
      <Inp label="Gestor asignado" value={form.assignedGestor} onChange={setF("assignedGestor")} opts={[{ v: "", l: "Sin asignar" }, ...gestors.map(g => ({ v: String(g.id), l: g.name }))]} />
    </div>

    {/* ─── SECCIÓN 2: TITULAR ─── */}
    <SectionTitle n="2" t="Titular y Co-titular" />
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
      <div><Inp label="Nombre completo del titular *" value={form.name} onChange={setF("name")} /><Err k="name" /></div>
      <Inp label="Co-titular (opcional)" value={form.coHolder} onChange={setF("coHolder")} />
    </div>

    {/* ─── SECCIÓN 3: PUNTOS ─── */}
    <SectionTitle n="3" t="Puntos del Contrato" sub="Los puntos anuales se calculan automáticamente: Puntos totales ÷ Plazo" />
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10 }}>
      <div><Inp label="Puntos totales del contrato *" value={form.totalPoints} onChange={setF("totalPoints")} type="number" /><Err k="totalPoints" /></div>
      <div><Inp label="Primer año de uso *" value={form.firstUseYear} onChange={setF("firstUseYear")} type="number" /><Err k="firstUseYear" /></div>
      <div style={{ background: BG3, borderRadius: 8, padding: "10px 12px" }}>
        <div style={{ fontSize: 9, color: T4, textTransform: "uppercase", marginBottom: 3 }}>Pts / año (calculado)</div>
        <div style={{ color: B, fontWeight: 800, fontSize: 20 }}>{calcAnnualPts.toLocaleString()}</div>
        <div style={{ fontSize: 9, color: T4 }}>{form.totalPoints} ÷ {form.contractYears} años</div>
      </div>
      <Inp label="Puntos usados a la fecha" value={form.pointsUsedToDate} onChange={setF("pointsUsedToDate")} type="number" />
    </div>

    {/* ─── SECCIÓN 4: MANTENIMIENTO ─── */}
    <SectionTitle n="4" t="Estado de Mantenimiento" sub="El sistema calculará automáticamente los años sin pagar desde el último pagado" />
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
      <div>
        <Inp label="Último año de mantenimiento pagado" value={form.lastPaidMaintYear} onChange={setF("lastPaidMaintYear")} type="number" />
        <div style={{ fontSize: 9, color: T4, marginTop: 3 }}>
          Ej. si pagó hasta 2023, el sistema marcará 2024, 2025, 2026 como pendientes.
        </div>
      </div>
      {form.lastPaidMaintYear && pendingYears > 0 && <div style={{ background: pendingYears > 3 ? R + "12" : Y + "12", border: `1px solid ${pendingYears > 3 ? R : Y}33`, borderRadius: 8, padding: "10px 12px" }}>
        <div style={{ fontSize: 9, color: pendingYears > 3 ? R : Y, textTransform: "uppercase", marginBottom: 3 }}>Años pendientes de pago</div>
        <div style={{ color: pendingYears > 3 ? R : Y, fontWeight: 800, fontSize: 22 }}>{pendingYears} año{pendingYears !== 1 ? "s" : ""}</div>
        <div style={{ fontSize: 10, color: T3 }}>{firstUnpaidYear} – {CY_NOW} · ~{fUSD(pendingAmountUSD)} a precio actual</div>
        <div style={{ fontSize: 9, color: T4, marginTop: 3 }}>Desde {firstUnpaidYear} hasta {CY_NOW} inclusive</div>
      </div>}
      {form.lastPaidMaintYear && pendingYears === 0 && <div style={{ background: G + "12", border: `1px solid ${G}33`, borderRadius: 8, padding: "10px 12px" }}>
        <div style={{ color: G, fontWeight: 700, fontSize: 12 }}>✓ Al corriente</div>
        <div style={{ fontSize: 10, color: T3 }}>Mantenimiento pagado hasta {form.lastPaidMaintYear}</div>
      </div>}
    </div>

    {/* ─── SECCIÓN 5: PUNTOS DISPONIBLES VIGENTES ─── */}
    <SectionTitle n="5" t="Puntos Disponibles Vigentes" sub="Si el socio tiene puntos actualmente disponibles para usar (ya pagados, no vencidos)" />
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
      <label style={{ fontSize: 11, color: T2, display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
        <input type="checkbox" checked={form.hasAvailablePoints} onChange={e => setF("hasAvailablePoints")(e.target.checked)} />
        Este socio tiene puntos vigentes disponibles para reservaciones
      </label>
    </div>
    {form.hasAvailablePoints && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, background: BG3, borderRadius: 8, padding: 12 }}>
      <Inp label="Puntos disponibles actualmente" value={form.availPts} onChange={setF("availPts")} type="number" />
      <Inp label="Vencen el" value={form.availExpiry} onChange={setF("availExpiry")} type="date" />
      <Inp label="Año de mantenimiento al que corresponden" value={form.availMaintYear} onChange={setF("availMaintYear")} type="number" />
    </div>}

    {/* ─── SECCIÓN 6: CONTACTO ─── */}
    <SectionTitle n="6" t="Teléfonos" />
    {phones.map((p, i) => (<div key={i} style={{ display: "grid", gridTemplateColumns: "150px 1fr auto", gap: 8, marginBottom: 6 }}>
      <Inp label="Etiqueta" value={p.label} onChange={v => updateRow(setPhones, i, 'label', v)} />
      <Inp label="Número" value={p.number} onChange={v => updateRow(setPhones, i, 'number', v)} />
      {i > 0 && <div style={{ paddingTop: 18 }}><Btn label="✕" variant="danger" small onClick={() => removeRow(setPhones, i)} /></div>}
    </div>))}
    <Btn label="+ Agregar teléfono" variant="ghost" small onClick={() => addRow(setPhones)} />

    <SectionTitle n="7" t="Correos Electrónicos" />
    {emails.map((e, i) => (<div key={i} style={{ display: "grid", gridTemplateColumns: "150px 1fr auto", gap: 8, marginBottom: 6 }}>
      <Inp label="Etiqueta" value={e.label} onChange={v => updateRow(setEmails, i, 'label', v)} />
      <Inp label="Correo" value={e.email} onChange={v => updateRow(setEmails, i, 'email', v)} />
      {i > 0 && <div style={{ paddingTop: 18 }}><Btn label="✕" variant="danger" small onClick={() => removeRow(setEmails, i)} /></div>}
    </div>))}
    <Btn label="+ Agregar correo" variant="ghost" small onClick={() => addRow(setEmails)} />

    <SectionTitle n="8" t="Direcciones" />
    {addresses.map((a, i) => (<div key={i} style={{ display: "grid", gridTemplateColumns: "150px 1fr auto", gap: 8, marginBottom: 6 }}>
      <Inp label="Etiqueta" value={a.label} onChange={v => updateRow(setAddresses, i, 'label', v)} />
      <Inp label="Dirección" value={a.address} onChange={v => updateRow(setAddresses, i, 'address', v)} />
      {i > 0 && <div style={{ paddingTop: 18 }}><Btn label="✕" variant="danger" small onClick={() => removeRow(setAddresses, i)} /></div>}
    </div>))}
    <Btn label="+ Agregar dirección" variant="ghost" small onClick={() => addRow(setAddresses)} />

    <SectionTitle n="9" t="Comentarios Importantes" sub="Notas relevantes del historial del socio" />
    {comments.map((c, i) => (<div key={i} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, marginBottom: 6 }}>
      <textarea value={c.text} onChange={e => updateRow(setComments, i, 'text', e.target.value)}
        placeholder="Escribe un comentario o nota importante sobre este socio..."
        rows={2} style={{ ...IS, resize: "vertical", fontSize: 11 }} />
      {i > 0 && <div><Btn label="✕" variant="danger" small onClick={() => removeRow(setComments, i)} /></div>}
    </div>))}
    <Btn label="+ Agregar comentario" variant="ghost" small onClick={() => addRow(setComments)} />

    {/* ─── RESUMEN ANTES DE GUARDAR ─── */}
    {form.contractNo && form.name && form.totalPoints > 0 && <div style={{ background: BG2, border: `1px solid ${B}33`, borderRadius: 10, padding: 16, marginTop: 20 }}>
      <div style={{ fontSize: 11, color: T3, textTransform: "uppercase", fontWeight: 700, marginBottom: 10 }}>Resumen del contrato a dar de alta</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
        {[
          ["Contrato", form.contractNo, B],
          ["Titular", form.name, T1],
          ["Pts totales", (+form.totalPoints).toLocaleString(), P],
          ["Pts/año", calcAnnualPts.toLocaleString(), G],
          ["1er año uso", form.firstUseYear, T2],
          ["Último mant.", form.lastPaidMaintYear || "—", pendingYears > 0 ? R : G],
          ["Años pend.", pendingYears || "Ninguno", pendingYears > 0 ? R : G],
          ["Estado", form.contractStatus, form.contractStatus === "Active" ? G : R],
        ].map(([l, v, c]) => (<div key={l} style={{ background: BG3, borderRadius: 6, padding: "8px 10px" }}>
          <div style={{ fontSize: 9, color: T4, textTransform: "uppercase", marginBottom: 2 }}>{l}</div>
          <div style={{ color: c, fontWeight: 700, fontSize: 13 }}>{v}</div>
        </div>))}
      </div>
    </div>}

    {/* Errores de validación */}
    {Object.keys(errors).length > 0 && <div style={{ background: R + "12", border: `1px solid ${R}44`, borderRadius: 8, padding: "10px 14px", marginTop: 14 }}>
      <div style={{ color: R, fontWeight: 700, marginBottom: 5 }}>Por favor corrige los siguientes campos:</div>
      {Object.entries(errors).map(([k, v]) => <div key={k} style={{ color: R, fontSize: 11 }}>• {k}: {v}</div>)}
    </div>}

    <div style={{ display: "flex", gap: 10, marginTop: 20, paddingTop: 16, borderTop: `1px solid ${BD}` }}>
      <Btn label="Limpiar formulario" variant="ghost" onClick={() => { setForm(emptyForm()); setErrors({}); setSaved(null); }} />
      <Btn label={saving ? "Guardando..." : "⊕ Dar de Alta Contrato"} variant="success" disabled={saving} onClick={handleSave} />
    </div>
  </div>);
}
// ── REPORTE DE COBRANZA ────────────────────────────────────────────────────
function CobranzaReportView({ payments, pointSales, pms, users, cr, cu }) {
  const [period, setPeriod] = useState("today");

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const monthStart = `${CY}-${String(new Date().getMonth() + 1).padStart(2, "0")}-01`;
  const yearStart = `${CY}-01-01`;
  const lastYearStart = `${CY - 1}-01-01`;
  const lastYearEnd = `${CY - 1}-12-31`;

  const PERIODS = [
    { id: "today", l: "Hoy", from: today, to: today },
    { id: "yesterday", l: "Ayer", from: yesterday, to: yesterday },
    { id: "month", l: "Este Mes", from: monthStart, to: today },
    { id: "year", l: "Este Año", from: yearStart, to: today },
    { id: "lastyear", l: "Año Anterior", from: lastYearStart, to: lastYearEnd },
  ];

  const cur = PERIODS.find(p => p.id === period);

  // Obtener tasa de comisión por concepto
  const getCrRate = (concept) => {
    if (!cr) return 0;
    const match = cr.find(r => r.id === concept || r.id === concept?.replace('point_purchase', 'point_sale'));
    return (match?.pct || 0) / 100;
  };

  // Combinar payments + point_sales en un solo array normalizado
  const allRows = [
    // Pagos de mantenimiento/mora/cancelación
    ...payments
      .filter(p => p.date >= cur.from && p.date <= cur.to)
      .map(p => {
        const pm = pms.find(m => m.id === p.methodId);
        const pmName = pm?.name || p.method || "—";
        const costoPct = pm?.costPct || 0;
        const costoFin = p.amount * costoPct / 100;
        // Descuento = monto completo - monto cobrado (sin moratorios en el cálculo)
        // monto completo = amountMant × fx (si tuviéramos el fx original, usamos amount + discountMant × fx)
        // Como tenemos el descuento en USD de BD, lo convertimos a MXN aproximado
        const fx = 17.5; // aproximación; en producción vendría del pago
        const descMantMxn = (p.discountMant || 0) * fx;
        const moraMxn = (p.amountMora || 0) * fx;
        // Descuento neto = descuento - mora cobrada (mora resta el descuento)
        const descuentoNeto = descMantMxn - moraMxn;
        // Comisión del gestor
        const gestorRate = p.isPrepago ? getCrRate('prepago') : getCrRate('maintenance');
        const comisionMxn = p.amount * gestorRate;
        const costoCobranza = p.amount > 0
          ? ((costoFin + descuentoNeto + comisionMxn) / p.amount) * 100
          : 0;
        return {
          id: p.id, date: p.date,
          contractNo: p.contractNo, clientName: p.clientName,
          concept: p.isPrepago ? "Mant. Adelantado (Prepago)" : p.type === "maintenance" ? "Mantenimiento" : p.type === "moratorios" ? "Moratorios" : p.type || "Otro",
          amount: p.amount, discuento: descuentoNeto,
          metodoPago: pmName, costoFin, comision: comisionMxn,
          costoCobranza, gestorName: users.find(u => u.username === p.originatedBy)?.name || p.originatedBy || "—",
        };
      }),
    // Ventas de puntos
    ...pointSales
      .filter(s => s.date >= cur.from && s.date <= cur.to)
      .map(s => {
        const pm = pms.find(m => m.id === s.methodId);
        const pmName = pm?.name || "—";
        const costoPct = pm?.costPct || 0;
        const costoFin = s.amount * costoPct / 100;
        const comisionMxn = s.amount * getCrRate('point_sale');
        const costoCobranza = s.amount > 0
          ? ((costoFin + comisionMxn) / s.amount) * 100
          : 0;
        return {
          id: "ps_" + s.id, date: s.date,
          contractNo: s.contractNo, clientName: s.clientName,
          concept: `Venta Puntos (${s.saleType || "—"})`,
          amount: s.amount, discuento: 0,
          metodoPago: pmName, costoFin, comision: comisionMxn,
          costoCobranza, gestorName: users.find(u => u.username === s.submittedBy)?.name || s.submittedBy || "—",
        };
      }),
  ].sort((a, b) => b.date.localeCompare(a.date));

  // Totales
  const totAmount = allRows.reduce((a, r) => a + r.amount, 0);
  const totDesc = allRows.reduce((a, r) => a + r.discuento, 0);
  const totCostoFin = allRows.reduce((a, r) => a + r.costoFin, 0);
  const totComision = allRows.reduce((a, r) => a + r.comision, 0);
  const totCostoCobranza = totAmount > 0
    ? ((totCostoFin + totDesc + totComision) / totAmount) * 100
    : 0;

  const colW = { date: 90, contract: 90, client: 180, concept: 150, amount: 110, desc: 100, method: 110, costoFin: 90, costoC: 90, gestor: 110 };

  return (<div style={{ padding: 20 }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
      <h2 style={{ color: B, fontWeight: 800, margin: 0, fontSize: 18 }}>◑ Reporte de Cobranza</h2>
      <div style={{ display: "flex", gap: 6 }}>
        {PERIODS.map(p => (
          <button key={p.id} onClick={() => setPeriod(p.id)} style={{ background: period === p.id ? B : BG2, color: period === p.id ? "#fff" : T4, border: `1px solid ${period === p.id ? B : BD}`, borderRadius: 7, padding: "5px 12px", fontSize: 11, fontWeight: period === p.id ? 700 : 400, cursor: "pointer", fontFamily: "inherit" }}>{p.l}</button>
        ))}
      </div>
    </div>

    {/* KPIs */}
    <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 10, marginBottom: 16 }}>
      {[
        ["Total Cobrado", fMXN(totAmount), B],
        ["Descuentos Netos", fMXN(totDesc), totDesc > 0 ? Y : G],
        ["Costos Financieros", fMXN(totCostoFin), O],
        ["Comisiones Gestores", fMXN(totComision), P],
        ["Costo de Cobranza", totCostoCobranza.toFixed(2) + "%", totCostoCobranza > 30 ? R : totCostoCobranza > 15 ? Y : G],
      ].map(([l, v, c]) => (<div key={l} style={{ background: BG2, border: `1px solid ${BD}`, borderRadius: 8, padding: "12px 14px" }}>
        <div style={{ fontSize: 9, color: T4, textTransform: "uppercase", marginBottom: 3 }}>{l}</div>
        <div style={{ color: c, fontWeight: 800, fontSize: 16 }}>{v}</div>
        <div style={{ fontSize: 9, color: T4, marginTop: 2 }}>{allRows.length} transacciones</div>
      </div>))}
    </div>

    {allRows.length === 0
      ? <div style={{ color: T4, textAlign: "center", padding: 40 }}>Sin transacciones en el período seleccionado.</div>
      : (<div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
          <thead>
            <tr style={{ background: BG3 }}>
              {[["Fecha", colW.date], ["Contrato", colW.contract], ["Cliente", colW.client], ["Concepto", colW.concept], ["Monto", colW.amount], ["Descuento", colW.desc], ["Medio", colW.method], ["Costo Fin.", colW.costoFin], ["Costo Cobr.%", colW.costoC], ["Gestor", colW.gestor]].map(([h, w]) => (
                <th key={h} style={{ padding: "7px 10px", textAlign: "left", fontSize: 9, color: T4, textTransform: "uppercase", letterSpacing: ".05em", width: w, borderBottom: `2px solid ${BD}` }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {allRows.map(r => (
              <tr key={r.id} style={{ borderBottom: `1px solid ${BG3}` }}>
                <td style={{ padding: "6px 10px", color: T4, fontSize: 10 }}>{r.date}</td>
                <td style={{ padding: "6px 10px", color: B, fontWeight: 600 }}>{r.contractNo}</td>
                <td style={{ padding: "6px 10px", color: T1 }}>{r.clientName}</td>
                <td style={{ padding: "6px 10px", color: T3 }}>{r.concept}</td>
                <td style={{ padding: "6px 10px", color: G, fontWeight: 700, textAlign: "right" }}>{fMXN(r.amount)}</td>
                <td style={{ padding: "6px 10px", color: r.discuento > 0 ? R : r.discuento < 0 ? G : T4, textAlign: "right" }}>{fMXN(r.discuento)}</td>
                <td style={{ padding: "6px 10px", color: T3 }}>{r.metodoPago}</td>
                <td style={{ padding: "6px 10px", color: O, textAlign: "right" }}>{fMXN(r.costoFin)}</td>
                <td style={{ padding: "6px 10px", color: r.costoCobranza > 30 ? R : r.costoCobranza > 15 ? Y : G, fontWeight: 600, textAlign: "right" }}>{r.costoCobranza.toFixed(2)}%</td>
                <td style={{ padding: "6px 10px", color: T3, fontSize: 10 }}>{r.gestorName}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ background: BG3, borderTop: `2px solid ${BD}` }}>
              <td colSpan={4} style={{ padding: "8px 10px", color: T1, fontWeight: 700, fontSize: 12 }}>TOTALES ({allRows.length} transacciones)</td>
              <td style={{ padding: "8px 10px", color: G, fontWeight: 800, fontSize: 13, textAlign: "right" }}>{fMXN(totAmount)}</td>
              <td style={{ padding: "8px 10px", color: totDesc > 0 ? R : G, fontWeight: 700, textAlign: "right" }}>{fMXN(totDesc)}</td>
              <td style={{ padding: "8px 10px" }}></td>
              <td style={{ padding: "8px 10px", color: O, fontWeight: 700, textAlign: "right" }}>{fMXN(totCostoFin)}</td>
              <td style={{ padding: "8px 10px", color: totCostoCobranza > 30 ? R : totCostoCobranza > 15 ? Y : G, fontWeight: 800, fontSize: 13, textAlign: "right" }}>{totCostoCobranza.toFixed(2)}%</td>
              <td style={{ padding: "8px 10px" }}></td>
            </tr>
          </tfoot>
        </table>
      </div>)}
  </div>);
}
// ── PROMESAS DEL GESTOR — Dashboard principal ────────────────────────────
const CONCEPT_OPTS = [
  { v: "maintenance", l: "Mantenimiento" },
  { v: "moratorios", l: "Moratorios" },
  { v: "prepago", l: "Mantenimiento Prepago" },
  { v: "point_sale", l: "Venta de Puntos" },
  { v: "cancellation_payment", l: "Pago de Cancelación" },
];

function PromisesView({ promises, clients, cu, users, fxRate, onValidate, onReschedule, onCancel, onGoToClient }) {
  const isGestor = cu.role === "gestor";
  const dbUser = users.find(u => u.username === cu.username);
  const myId = dbUser?.id;

  // Filtrar promesas del gestor (o todas si admin/superadmin)
  const myPromises = isGestor
    ? promises.filter(p => String(p.gestorId) === String(myId) && p.status === 'pending')
    : promises.filter(p => p.status === 'pending');

  const today = new Date().toISOString().slice(0, 10);

  const overdue = myPromises.filter(p => p.promiseDate < today).sort((a,b) => a.promiseDate.localeCompare(b.promiseDate));
  const todayP = myPromises.filter(p => p.promiseDate === today).sort((a,b) => (b.amount||0)-(a.amount||0));
  const future = myPromises.filter(p => p.promiseDate > today).sort((a,b) => a.promiseDate.localeCompare(b.promiseDate));

  const [selPr, setSelPr] = useState(null);
  const [actionType, setActionType] = useState(null); // 'reschedule' | 'cancel'
  const [newDate, setNewDate] = useState("");

  const fx = fxRate?.rate || 17.5;
  const conceptName = (c) => CONCEPT_OPTS.find(o => o.v === c)?.l || c;

  const PromiseCard = ({ p, color, label }) => {
    const isSel = selPr?.id === p.id;
    return (<div style={{ background: BG2, border: `1px solid ${isSel ? color : BD}`, borderLeft: `3px solid ${color}`, borderRadius: 8, padding: "10px 12px", marginBottom: 7, cursor: "pointer" }} onClick={() => { setSelPr(isSel ? null : p); setActionType(null); }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", gap: 7, alignItems: "center", marginBottom: 3 }}>
            <span style={{ color, fontSize: 9, fontWeight: 700, textTransform: "uppercase" }}>{label}</span>
            <span style={{ color: T1, fontWeight: 700, fontSize: 12 }}>{p.clientName}</span>
            <span style={{ color: T4, fontSize: 9 }}>{p.contractNo}</span>
          </div>
          <div style={{ display: "flex", gap: 10, fontSize: 10, color: T3 }}>
            <span>📅 {p.promiseDate}</span>
            <span>💰 {fMXN(p.amount * fx)} <span style={{ color: T4 }}>({fUSD(p.amount)})</span></span>
            <span>🏷 {conceptName(p.concept)}</span>
          </div>
          {p.note && <div style={{ fontSize: 10, color: T4, marginTop: 4, fontStyle: "italic" }}>"{p.note}"</div>}
        </div>
      </div>
      {isSel && <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${BD}` }}>
        {!actionType && <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Btn label="✓ Validar (ir a caja)" variant="success" small onClick={(e) => { e.stopPropagation(); onValidate(p); }} />
          <Btn label="📅 Recorrer fecha" variant="ghost" small onClick={(e) => { e.stopPropagation(); setActionType('reschedule'); setNewDate(today); }} />
          <Btn label="✕ Borrar promesa" variant="danger" small onClick={(e) => { e.stopPropagation(); if (window.confirm("¿Borrar esta promesa de pago? Esta acción no se puede deshacer.")) onCancel(p.id); }} />
          {onGoToClient && <Btn label="Ver cliente" variant="ghost" small onClick={(e) => { e.stopPropagation(); onGoToClient(p.clientId); }} />}
        </div>}
        {actionType === 'reschedule' && <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }} onClick={e => e.stopPropagation()}>
          <Inp label="Nueva fecha (máx 30 días)" type="date" value={newDate} onChange={setNewDate} />
          <Btn label="Cancelar" variant="ghost" small onClick={() => setActionType(null)} />
          <Btn label="Recorrer" variant="success" small onClick={async () => { await onReschedule(p.id, newDate); setActionType(null); setSelPr(null); }} />
        </div>}
      </div>}
    </div>);
  };

  return (<div style={{ padding: 20 }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
      <div>
        <h2 style={{ color: B, fontWeight: 800, margin: 0, fontSize: 20 }}>★ Mis Promesas de Pago</h2>
        <div style={{ color: T4, fontSize: 11, marginTop: 4 }}>
          Da clic en una promesa para ver acciones · Las promesas son solo seguimiento; al validarse se mandan a caja como propuesta.
        </div>
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ background: R + "12", border: `1px solid ${R}33`, borderRadius: 8, padding: "8px 12px", textAlign: "center" }}>
          <div style={{ fontSize: 8, color: T4, textTransform: "uppercase" }}>Vencidas</div>
          <div style={{ color: R, fontWeight: 800, fontSize: 18 }}>{overdue.length}</div>
        </div>
        <div style={{ background: Y + "12", border: `1px solid ${Y}33`, borderRadius: 8, padding: "8px 12px", textAlign: "center" }}>
          <div style={{ fontSize: 8, color: T4, textTransform: "uppercase" }}>Hoy</div>
          <div style={{ color: Y, fontWeight: 800, fontSize: 18 }}>{todayP.length}</div>
        </div>
        <div style={{ background: G + "12", border: `1px solid ${G}33`, borderRadius: 8, padding: "8px 12px", textAlign: "center" }}>
          <div style={{ fontSize: 8, color: T4, textTransform: "uppercase" }}>Futuras</div>
          <div style={{ color: G, fontWeight: 800, fontSize: 18 }}>{future.length}</div>
        </div>
      </div>
    </div>

    {/* VENCIDAS */}
    {overdue.length > 0 && <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 11, color: R, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8, padding: "5px 10px", background: R + "10", borderRadius: 6 }}>
        ⚠ Promesas Vencidas ({overdue.length})
      </div>
      {overdue.map(p => <PromiseCard key={p.id} p={p} color={R} label={`Vencida ${Math.floor((new Date(today) - new Date(p.promiseDate))/86400000)}d`} />)}
    </div>}

    {/* HOY */}
    {todayP.length > 0 && <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 11, color: Y, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8, padding: "5px 10px", background: Y + "10", borderRadius: 6 }}>
        📅 Promesas para Hoy ({todayP.length})
      </div>
      {todayP.map(p => <PromiseCard key={p.id} p={p} color={Y} label="Hoy" />)}
    </div>}

    {/* FUTURAS */}
    {future.length > 0 && <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 11, color: G, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8, padding: "5px 10px", background: G + "10", borderRadius: 6 }}>
        📆 Promesas Futuras ({future.length})
      </div>
      {future.map(p => <PromiseCard key={p.id} p={p} color={G} label={p.promiseDate} />)}
    </div>}

    {myPromises.length === 0 && <div style={{ background: BG2, border: `1px solid ${BD}`, borderRadius: 10, padding: "30px 20px", textAlign: "center" }}>
      <div style={{ fontSize: 36, marginBottom: 10 }}>★</div>
      <div style={{ color: T2, fontWeight: 700, marginBottom: 5 }}>No tienes promesas pendientes</div>
      <div style={{ color: T4, fontSize: 11 }}>Crea promesas desde la ficha del cliente para hacer seguimiento de tus cobros.</div>
    </div>}
  </div>);
}

// ── MODAL PARA CREAR PROMESA — Reutilizable desde ClientView ─────────────
function PromiseModal({ client, fxRate, cu, onSave, onClose }) {
  const today = new Date().toISOString().slice(0, 10);
  const max30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState("");
  const [concept, setConcept] = useState("maintenance");
  const [note, setNote] = useState("");
  const fx = fxRate?.rate || 17.5;
  const amtN = +amount || 0;
  const valid = amtN > 0 && date >= today && date <= max30;

  return (<Modal title={`Nueva Promesa de Pago — ${client?.name || ""}`} onClose={onClose}>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
      <Inp label="Fecha de promesa (máx 30 días)" type="date" value={date} onChange={setDate} />
      <Inp label="Concepto" value={concept} onChange={setConcept} opts={CONCEPT_OPTS} />
      <Inp label="Monto en MXN" type="number" value={amount} onChange={setAmount} />
      <div style={{ background: BG3, borderRadius: 6, padding: "8px 10px" }}>
        <div style={{ fontSize: 8, color: T4 }}>Equivalente USD</div>
        <div style={{ color: B, fontWeight: 700 }}>{fUSD(amtN / fx)}</div>
        <div style={{ fontSize: 8, color: T4 }}>TC: ${fx}</div>
      </div>
    </div>
    <div style={{ marginTop: 8 }}>
      <Inp label="Nota (opcional)" value={note} onChange={setNote} />
    </div>
    {date < today && <div style={{ color: R, fontSize: 10, marginTop: 6 }}>⛔ La fecha no puede ser en el pasado</div>}
    {date > max30 && <div style={{ color: R, fontSize: 10, marginTop: 6 }}>⛔ La fecha no puede ser más de 30 días</div>}
    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
      <Btn label="Cancelar" variant="ghost" onClick={onClose} />
      <Btn label="Crear Promesa" variant="success" disabled={!valid} onClick={() => {
        onSave({ clientId: client.id, promiseDate: date, amount: amtN, concept, note });
        onClose();
      }} />
    </div>
  </Modal>);
}
// ── APP ROOT ─────────────────────────────────────────────────────────────────
const MONTHS_ES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
export default function App() {
  const [users, setUsers] = useState(INIT_U);
  const [cu, setCu] = useState(null);
  const [tab, setTab] = useState(null);
  const [clients, setClients] = useState([]);
  const [reservations, setReservations] = useState([]);
  const [payments, setPayments] = useState([]);
  const [seasonOrder, setSeasonOrder] = useState(INIT_SEASON_ORDER);
  const [fxRate, setFxRate] = useState({ rate: 17.5, date: TOD });
  const [uts, setUts] = useState(INIT_UT);
  const [units, setUnits] = useState([]);
  const [pp, setPp] = useState(4.75);
  const [pms, setPms] = useState([]);
  const [rc, setRc] = useState(150);
  const [courtesies, setCourtesies] = useState([]);
  const [condonations, setCondonations] = useState([]);
  const [pointPrices, setPointPrices] = useState([]);
  const [pointSales, setPointSales] = useState([]);
  const [cr, setCr] = useState(INIT_CR);
  const [promises, setPromises] = useState([]);
  const [pendingSales, setPendingSales] = useState([]);
  const [pendingPayments, setPendingPayments] = useState([]);
  const [preselClient, setPreselClient] = useState(null);
  const [preselResClient, setPreselResClient] = useState(null);
  const [promiseToValidate, setPromiseToValidate] = useState(null);
  const [loading, setLoading] = useState(false);
  const [dbError, setDbError] = useState(null);

  // ── Cargar datos de Supabase ──────────────────────────
  const loadAll = useCallback(async () => {
    setLoading(true);
    setDbError(null);
    try {
      const [
        dbClients, dbPayments, dbReservations, dbUnits,
        dbFxRate, dbPms, dbPromises, dbPending, dbUsers
      ] = await Promise.all([
        fetchClients(),
        fetchPayments(),
        fetchReservations(),
        fetchUnits(),
        fetchFxRate(),
        fetchPaymentMethods(),
        fetchPromises(),
        fetchPendingPayments(),
        fetchUsers(),
      ]);

      const dbUts = await fetchUnitTypes();
      if (dbUts.length > 0) setUts(dbUts);

      // Cargar comisiones por concepto y config de sistema
      try {
        const dbCr = await fetchCommissionRates();
        if (dbCr.length > 0) {
          const merged = INIT_CR.map(init => {
            const dbMatch = dbCr.find(d =>
              d.concept === init.id ||
              (init.id === 'point_purchase' && d.concept === 'point_sale')
            );
            return dbMatch ? { ...init, pct: dbMatch.ratePct, l: dbMatch.label || init.l } : init;
          });
          // Agregar conceptos de BD que no estén en INIT_CR
          dbCr.forEach(d => {
            if (!merged.find(m => m.id === d.concept)) {
              merged.push({ id: d.concept, l: d.label || d.concept, pct: d.ratePct, active: true });
            }
          });
          setCr(merged);
        }
      } catch (e) { console.warn('No se pudo cargar commission_rates:', e.message); }
      try {
        const dbCfg = await fetchSystemConfig();
        if (dbCfg.pricePerPoint) setPp(dbCfg.pricePerPoint);
        if (dbCfg.reservationFee) setRc(dbCfg.reservationFee);
      } catch (e) { console.warn('No se pudo cargar system_config:', e.message); }

      // Cargar cortesías
      try {
        const dbCourtesies = await fetchCourtesies();
        if (dbCourtesies.length > 0) setCourtesies(dbCourtesies);
      } catch (e) { console.warn('No se pudo cargar cortesías:', e.message); }

      // Cargar precios por punto por año
      try {
        const dbPrices = await fetchPointPrices();
        if (dbPrices.length > 0) setPointPrices(dbPrices);
      } catch (e) { console.warn('No se pudo cargar point_prices:', e.message); }

      // Cargar ventas de puntos validadas (para reportes)
      try {
        const dbPointSales = await fetchPointSales();
        setPointSales(dbPointSales);
      } catch (e) { console.warn('No se pudo cargar point_sales:', e.message); }

      // Cargar condonaciones (necesario antes de calcular saldo dinámico)
      let dbCondonations = [];
      try {
        dbCondonations = await fetchCondonations();
        setCondonations(dbCondonations);
      } catch (e) { console.warn('No se pudo cargar condonaciones:', e.message); }

      // Calcular occ en units desde reservaciones
      const unitsWithOcc = dbUnits.map(u => ({
        ...u,
        occ: dbReservations
          .filter(r => r.unitId === u.id && r.status === 'Confirmed')
          .map(r => ({ ci: r.checkIn, co: r.checkOut }))
      }));

      if (dbPayments.length > 0) setPayments(dbPayments);
      if (dbReservations.length > 0) setReservations(dbReservations);
      if (unitsWithOcc.length > 0) setUnits(unitsWithOcc);
      else setUnits(INIT_UNITS);

      // Calcular saldo dinámico de cada cliente desde años pendientes (en MXN, usando pp y fx)
      const fxForBalance = dbFxRate?.rate || 17.5;
      const dynClients = (dbClients.length > 0 ? dbClients : INIT_C).map(c => {
        const desg = getMaintDesglose(c, dbPayments, pp, dbCondonations);
        const dyn = desg.reduce((a, d) => a + d.pendienteMXN, 0);
        // Calcular paid_points dinámicos: SOLO puntos del año en curso + año siguiente (prepago)
        // Los puntos de años anteriores están vencidos y NO se cuentan como disponibles.
        const paidByYear = getPaidPtsByYear(c, dbPayments);
        const availPaidPts = (paidByYear[CY] || 0) + (paidByYear[CY + 1] || 0);
        return { ...c, balance: dyn, paidPoints: availPaidPts };
      });
      setClients(dynClients);

      setFxRate(dbFxRate);
      if (dbPms.length > 0) setPms(dbPms);
      else setPms(INIT_PM);
      setPromises(dbPromises); // siempre actualizar, incluso si es array vacío
      // Convertir montos USD a MXN para pending_payments usando el FX actual
      const fx = dbFxRate?.rate || 17.5;
      const dbPendingMxn = dbPending.map(p => ({
        ...p,
        mantAmt: Math.round((p.mantAmtUsd || 0) * fx * 100) / 100,
        moraAmt: Math.round((p.moraAmtUsd || 0) * fx * 100) / 100,
        mantDisc: Math.round((p.mantDiscUsd || 0) * fx * 100) / 100,
        moraDisc: Math.round((p.moraDiscUsd || 0) * fx * 100) / 100,
        totalACobrar: Math.round((p.totalUsd || 0) * fx * 100) / 100,
      }));
      if (dbPendingMxn.length > 0) setPendingPayments(dbPendingMxn);
      if (dbUsers.length > 0) setUsers(dbUsers);

    } catch (e) {
      console.error('Error cargando datos:', e);
      setDbError(e.message);
      // Fallback a datos demo
      setClients(INIT_C);
      setUnits(INIT_UNITS);
      setPms(INIT_PM);
    }
    setLoading(false);
  }, []);

  // Cargar datos cuando el usuario hace login
  useEffect(() => {
    if (cu) loadAll();
  }, [cu]);

  // ── Wrappers que sincronizan React + Supabase ─────────

  // Guardar pago validado
  const savePayment = async (paymentObj, clientUpdates) => {
    try {
      const fx = fxRate?.rate || 17.5;
      const dbUser = users.find(u => u.username === cu?.username);
      const userId = dbUser?.id || null;
      // El cajero es quien valida (processedBy = cu actual cuando es cajero)
      // El gestor es quien propuso (paymentObj.processedBy contiene el username del gestor)
      const cajeroUser = users.find(u => u.username === (paymentObj.processedByCajero || cu?.username));
      const cajeroId = cajeroUser?.id || userId;
      const gestorUser = users.find(u => u.username === paymentObj.processedBy) || users.find(u => u.username === paymentObj.submittedBy);
      const gestorId = gestorUser?.id || userId;
      const fxId = fxRate?.id || null;
      const dbPayment = {
        client_id: paymentObj.clientId,
        concept: (paymentObj.type === 'prepago_maintenance' ? 'maintenance' : paymentObj.type) || 'maintenance',
        payment_date: paymentObj.date,
        maint_amount_usd: (paymentObj.amountMant || 0) / fx,
        mora_amount_usd: (paymentObj.amountMora || 0) / fx,
        maint_discount_usd: (paymentObj.discountMant || 0) / fx,
        mora_discount_usd: (paymentObj.discountMora || 0) / fx,
        total_usd: paymentObj.amount / fx,
        total_mxn: paymentObj.amount,
        points_credited: paymentObj.points || 0,
        note: paymentObj.note || '',
        maint_year: paymentObj.maintYear || null,
        maint_point_expiry: paymentObj.maintPointExpiry || null,
        is_prepago: paymentObj.isPrepago || false,
        processed_by: cajeroId,
        originated_by: gestorId,
        payment_method_id: paymentObj.methodId || null,
        pending_payment_id: paymentObj.pendingPaymentId || null,
        fx_rate_id: fxId,
        is_deleted: false,
      };
      await insertPayment(dbPayment);
      // Marcar pending_payment como 'validated' en DB
      if (paymentObj.pendingPaymentId && typeof paymentObj.pendingPaymentId === 'number' && paymentObj.pendingPaymentId < 100000000) {
        try {
          await updatePendingPayment(paymentObj.pendingPaymentId, { status: 'validated' });
          console.log('Pending payment marked as validated:', paymentObj.pendingPaymentId);
        } catch (e) { console.error('Error updating pending status:', e); }
      }
      // NO actualizamos paid_points ni balance_usd en clients — ahora son DERIVED:
      // se calculan dinámicamente desde la suma de pagos en cada loadAll().
      // Solo actualizamos account_status si cambió.
      // Recargar datos
      await loadAll();
    } catch (e) {
      console.error('Error guardando pago:', e);
      alert('Error guardando pago: ' + e.message);
    }
  };

  // Guardar reservación
  const saveReservation = async (resObj) => {
    try {
      const dbUser = users.find(u => u.username === cu?.username);
      const userId = dbUser?.id || null;
      const fxForComm = fxRate?.rate || 17.5;
      await insertReservation({
        client_id: resObj.clientId,
        unit_id: resObj.unitId,
        season: resObj.seasonId || resObj.season || null,
        check_in: resObj.checkIn,
        check_out: resObj.checkOut,
        nights: resObj.nights || 0,
        points_used: resObj.pointsUsed || 0,
        status: resObj.status || 'Confirmed',
        processed_by: userId,
        reservation_commission_usd: (rc || 0) / fxForComm,
      });
      await loadAll();
    } catch (e) {
      console.error('Error guardando reservación:', e);
      alert('Error guardando reservación: ' + e.message);
    }
  };

  // Guardar propuesta de cobro
  const savePendingPayment = async (pp2) => {
    try {
      const fx = fxRate?.rate || 17.5;
      const dbUser = users.find(u => u.username === cu?.username);
      const userId = dbUser?.id || null;
      const dbPP = {
        client_id: pp2.clientId,
        concept: pp2.ptype === 'prepago_maintenance' ? 'maintenance' : (pp2.ptype || 'maintenance'),
        submitted_by: userId,
        expires_at: new Date(new Date().setHours(23, 59, 59)).toISOString(),
        maint_amount_usd: (pp2.mantAmt || 0) / fx,
        mora_amount_usd: (pp2.moraAmt || 0) / fx,
        maint_discount_usd: (pp2.mantDisc || 0) / fx,
        mora_discount_usd: (pp2.moraDisc || 0) / fx,
        total_usd: (pp2.totalACobrar || 0) / fx,
        note: pp2.note || '',
        status: 'pending',
        maint_year: pp2.maintYear || null,
        maint_point_expiry: pp2.maintPointExpiry || null,
        is_prepago: pp2.isPrepago || false,
        payment_method_id: pp2.methodId || null,
      };
      console.log('savePendingPayment payload:', JSON.stringify(dbPP, null, 2));
      await insertPendingPayment(dbPP);
      await loadAll();
    } catch (e) {
      console.error('Error guardando propuesta:', e);
      alert('Error guardando propuesta: ' + e.message);
    }
  };

  // Guardar promesa de pago
  const savePromise = async (pr) => {
    try {
      const fx = fxRate?.rate || 17.5;
      const dbUser = users.find(u => u.username === cu?.username);
      await insertPromise({
        client_id: pr.clientId,
        gestor_id: dbUser?.id || null,
        promise_date: pr.promiseDate,
        amount_usd: (pr.amount || 0) / fx,
        note: pr.note || null,
        concept: pr.concept || 'maintenance',
        status: 'pending',
      });
      await loadAll();
    } catch (e) {
      console.error('Error guardando promesa:', e);
      alert('Error guardando promesa: ' + (e.message || JSON.stringify(e)));
    }
  };

  // Recorrer promesa: cambiar fecha (máximo 30 días desde hoy)
  const reschedulePromise = async (id, newDate) => {
    try {
      const today = new Date(); today.setHours(0,0,0,0);
      const max = new Date(today.getTime() + 30 * 86400000);
      const target = new Date(newDate + "T12:00:00");
      if (target > max) { alert("La fecha no puede ser más de 30 días en el futuro."); return; }
      if (target < today) { alert("La fecha no puede ser en el pasado."); return; }
      await updatePromise(id, { promise_date: newDate });
      await loadAll();
    } catch (e) {
      console.error(e); alert('Error: ' + (e.message || JSON.stringify(e)));
    }
  };

  // Cancelar promesa (status = cancelled)
  const cancelPromise = async (id) => {
    try {
      // Borrar la promesa por completo
      await deletePromise(id);
      await loadAll();
    } catch (e) {
      console.error(e); alert('Error: ' + (e.message || JSON.stringify(e)));
    }
  };

  // Validar promesa: NO crea pending_payment directamente.
  // Lleva al gestor al formulario de caja con cliente + monto + concepto pre-llenados.
  // La promesa queda en pending hasta que se envíe a caja, momento en que se marca como fulfilled.
  const validatePromiseToCashier = (promise) => {
    // Set state que CashierView leerá para pre-llenar
    setPromiseToValidate(promise);
    setPreselClient(promise.clientId);
    setTab("cashier");
  };

  // Marca promesa como fulfilled tras enviar pago a caja exitosamente
  const markPromiseFulfilled = async (promiseId) => {
    try {
      await updatePromise(promiseId, { status: 'fulfilled', fulfilled_at: new Date().toISOString() });
      await loadAll();
    } catch (e) {
      console.error('Error marcando promesa como cumplida:', e);
    }
  };

  // Rechazar propuesta pendiente (marca como rejected en BD)
  const rejectPendingPayment = async (pendingId) => {
    try {
      const realId = pendingId && pendingId < 100000000 ? pendingId : null;
      if (realId) await updatePendingPayment(realId, { status: 'rejected' });
      await loadAll();
    } catch (e) {
      console.error('Error rechazando propuesta:', e);
      alert('Error rechazando propuesta: ' + (e.message || JSON.stringify(e)));
    }
  };

  // Guardar/actualizar unidad
  const saveUnit = async (u) => {
    try {
      if (u.id === "new" || !u.id || u.id > 1000000000) {
        await insertUnit(u);
      } else {
        await updateUnit(u.id, u);
      }
      await loadAll();
    } catch (e) {
      console.error('Error guardando unidad:', e);
      alert('Error guardando unidad: ' + (e.message || JSON.stringify(e)));
    }
  };

  // Guardar tipo de unidad
  const saveUnitType = async (ut) => {
    try {
      if (ut.id === "new" || !ut.id || ut.id > 1000000000) {
        await insertUnitType(ut.name);
      } else {
        await updateUnitType(ut.id, ut.name);
      }
      await loadAll();
    } catch (e) {
      console.error('Error guardando tipo:', e);
      alert('Error guardando tipo: ' + (e.message || JSON.stringify(e)));
    }
  };

  const removeUnitType = async (id) => {
    try {
      await deleteUnitType(id);
      await loadAll();
    } catch (e) {
      console.error('Error eliminando tipo:', e);
      alert('Error eliminando tipo: ' + (e.message || JSON.stringify(e)));
    }
  };

  // Guardar medio de pago
  const savePaymentMethod = async (pm) => {
    try {
      if (!pm.id || pm.id > 1000000000) {
        await insertPaymentMethod(pm);
      } else {
        await updatePaymentMethod(pm.id, pm);
      }
      await loadAll();
    } catch (e) {
      console.error('Error guardando medio de pago:', e);
      alert('Error guardando medio de pago: ' + (e.message || JSON.stringify(e)));
    }
  };

  // Guardar usuario (sueldo, datos personales, password, etc.)
  const saveUser = async (u) => {
    try {
      if (!u.id || u.id > 1000000000) {
        await insertUser(u);
      } else {
        await updateUser(u.id, u);
      }
      await loadAll();
    } catch (e) {
      console.error('Error guardando usuario:', e);
      alert('Error guardando usuario: ' + (e.message || JSON.stringify(e)));
    }
  };

  // ─── CLIENTES (todas las operaciones a BD) ────────────────
  const saveClient = async (c) => {
    try {
      if (!c.id || c.id > 1000000000) {
        await insertClient(c);
      } else {
        const dbFields = {
          contract_no: c.contractNo,
          full_name: c.name,
          contract_date: c.contractDate || null,
          contract_years: c.contractYears || 10,
          years_elapsed: c.yearsElapsed || 0,
          total_points: c.totalPoints || 0,
          points_used_to_date: c.pointsUsedToDate || 0,
          annual_points: c.annualPoints || 0,
          due_date: c.dueDate || null,
          assigned_gestor_id: c.assignedGestor ? +c.assignedGestor : null,
        };
        await updateClient(c.id, dbFields);
      }
      await loadAll();
    } catch (e) {
      console.error('Error guardando cliente:', e);
      alert('Error guardando cliente: ' + (e.message || JSON.stringify(e)));
    }
  };

  // Phones / Emails / Addresses — agregar nueva info (no editar/borrar existentes)
  const addClientPhone = async (clientId, label, number) => {
    try { await insertClientPhone(clientId, label, number, true); await loadAll(); }
    catch (e) { console.error(e); alert('Error: ' + (e.message || JSON.stringify(e))); }
  };
  const setClientPhoneActive = async (id, isActive) => {
    try { await updateClientPhone(id, isActive); await loadAll(); }
    catch (e) { console.error(e); alert('Error: ' + (e.message || JSON.stringify(e))); }
  };
  const addClientEmail = async (clientId, label, email) => {
    try { await insertClientEmail(clientId, label, email, true); await loadAll(); }
    catch (e) { console.error(e); alert('Error: ' + (e.message || JSON.stringify(e))); }
  };
  const setClientEmailActive = async (id, isActive) => {
    try { await updateClientEmail(id, isActive); await loadAll(); }
    catch (e) { console.error(e); alert('Error: ' + (e.message || JSON.stringify(e))); }
  };
  const addClientAddress = async (clientId, label, address) => {
    try { await insertClientAddress(clientId, label, address, true); await loadAll(); }
    catch (e) { console.error(e); alert('Error: ' + (e.message || JSON.stringify(e))); }
  };
  const setClientAddressActive = async (id, isActive) => {
    try { await updateClientAddress(id, isActive); await loadAll(); }
    catch (e) { console.error(e); alert('Error: ' + (e.message || JSON.stringify(e))); }
  };
  const addClientComment = async (clientId, body) => {
    try {
      const dbUser = users.find(u => u.username === cu?.username);
      await insertClientComment(clientId, body, dbUser?.id || null);
      await loadAll();
    } catch (e) { console.error(e); alert('Error: ' + (e.message || JSON.stringify(e))); }
  };

  // Guardar puntos (SavePointsModal)
  const saveSavedPoints = async (clientId, points, maintYear, note) => {
    try {
      const dbUser = users.find(u => u.username === cu?.username);
      await insertSavedPoints(clientId, points, maintYear, dbUser?.id || null, note);
      await loadAll();
    } catch (e) {
      console.error('Error guardando puntos:', e);
      alert('Error guardando puntos: ' + (e.message || JSON.stringify(e)));
    }
  };

  // Cancelar reservación
  const cancelReservation = async (id) => {
    try {
      await updateReservation(id, { status: 'Cancelled' });
      await loadAll();
    } catch (e) {
      console.error('Error cancelando reservación:', e);
      alert('Error cancelando reservación: ' + (e.message || JSON.stringify(e)));
    }
  };

  // Marcar promesa como cumplida/incumplida
  const updatePromiseStatus = async (id, newStatus) => {
    try {
      const dbStatus = newStatus === 'Cumplida' ? 'fulfilled' : 'expired';
      const fields = { status: dbStatus };
      if (dbStatus === 'fulfilled') fields.fulfilled_at = new Date().toISOString();
      await updatePromise(id, fields);
      await loadAll();
    } catch (e) {
      console.error('Error actualizando promesa:', e);
      alert('Error actualizando promesa: ' + (e.message || JSON.stringify(e)));
    }
  };

  // Guardar venta de puntos
  const savePointSale = async (sale) => {
    try {
      const dbUser = users.find(u => u.username === cu?.username);
      await insertPointSale(sale, dbUser?.id || null);
      // Actualizar cliente en BD: total_points, annual_points, contract_years son campos reales
      const cli = clients.find(c => c.id === sale.clientId);
      if (cli) {
        const clientUpdates = {};
        if (sale.stype === 'immediate') {
          clientUpdates.total_points = cli.totalPoints + sale.pts;
          clientUpdates.annual_points = cli.annualPoints + sale.pts;
        } else {
          const nT = cli.totalPoints + sale.pts;
          const nCY = (cli.contractYears || 10) + (sale.eYr || 0);
          const nYR = Math.max(1, nCY - (cli.yearsElapsed || 0));
          const rA = sale.eAn > 0 ? cli.annualPoints + sale.eAn : calcAP(nT, cli.pointsUsedToDate || 0, nYR);
          clientUpdates.total_points = nT;
          clientUpdates.contract_years = nCY;
          clientUpdates.annual_points = rA;
        }
        await updateClient(sale.clientId, clientUpdates);
      }
      await loadAll();
    } catch (e) {
      console.error('Error guardando venta:', e);
      alert('Error guardando venta: ' + (e.message || JSON.stringify(e)));
    }
  };

  // Asignar/Quitar gestor (solo admin/superadmin desde TeamView)
  const assignGestor = async (clientIds, gestorUserId) => {
    try {
      const ids = Array.isArray(clientIds) ? clientIds : [clientIds];
      // Update all in BD sequentially
      for (const cid of ids) {
        await updateClient(cid, { assigned_gestor_id: gestorUserId });
      }
      // Silent refresh of only clients (no full loadAll to avoid resetting tab state)
      const freshClients = await fetchClients();
      if (freshClients.length > 0) {
        const dbCondonations2 = condonations; // use cached
        const dynC = freshClients.map(c => {
          const desg = getMaintDesglose(c, payments, pp, dbCondonations2);
          const dyn = desg.reduce((a, d) => a + d.pendienteMXN, 0);
          const paidByYear = getPaidPtsByYear(c, payments);
          const availPaidPts = (paidByYear[CY] || 0) + (paidByYear[CY + 1] || 0);
          return { ...c, balance: dyn, paidPoints: availPaidPts };
        });
        setClients(dynC);
      }
    } catch (e) {
      console.error(e); alert('Error: ' + (e.message || JSON.stringify(e)));
    }
  };

  // Cancelar contrato
  const cancelContract = async (clientId, type, reason) => {
    try {
      await cancelClientContract(clientId, reason, type);
      await loadAll();
    } catch (e) {
      console.error(e); alert('Error: ' + (e.message || JSON.stringify(e)));
    }
  };

  // Guardar tipo de cambio (NUEVO registro histórico)
  const saveFxRate = async (newRate) => {
    try {
      const dbUser = users.find(u => u.username === cu?.username);
      const inserted = await insertFxRate(newRate, dbUser?.id || null);
      await loadAll();
      return inserted;
    } catch (e) {
      console.error('Error guardando TC:', e);
      alert('Error guardando TC: ' + (e.message || JSON.stringify(e)));
    }
  };

  // Guardar precio por punto (system_config)
  const savePricePerPoint = async (newPrice) => {
    try {
      await upsertSystemConfig('price_per_point', newPrice);
      setPp(newPrice);
      await loadAll();
    } catch (e) {
      console.error(e); alert('Error: ' + (e.message || JSON.stringify(e)));
    }
  };

  // Guardar comisión por reserva
  const saveReservationFee = async (newFee) => {
    try {
      await upsertSystemConfig('reservation_fee', newFee);
      setRc(newFee);
      await loadAll();
    } catch (e) {
      console.error(e); alert('Error: ' + (e.message || JSON.stringify(e)));
    }
  };

  // Guardar comisión por concepto
  const saveCommissionRate = async (concept, ratePct) => {
    try {
      // Mapear IDs locales a concept_id de BD
      const conceptIdMap = { point_purchase: 'point_sale' };
      const dbConcept = conceptIdMap[concept] || concept;
      await upsertCommissionRate(dbConcept, ratePct);
      await loadAll();
    } catch (e) {
      console.error(e); alert('Error: ' + (e.message || JSON.stringify(e)));
    }
  };

  const saveCourtesy = async (c) => {
    try {
      const dbUser = users.find(u => u.username === cu?.username);
      await insertCourtesy({ ...c, grantedBy: dbUser?.id || null });
      await loadAll();
    } catch (e) {
      console.error('Error guardando cortesía:', e);
      alert('Error guardando cortesía: ' + (e.message || JSON.stringify(e)));
    }
  };

  const saveCondonation = async (clientId, maintYear, reason) => {
    try {
      const dbUser = users.find(u => u.username === cu?.username);
      await insertCondonation(clientId, maintYear, reason, dbUser?.id || null);
      await loadAll();
    } catch (e) {
      console.error('Error guardando condonación:', e);
      alert('Error guardando condonación: ' + (e.message || JSON.stringify(e)));
    }
  };

  // Función helper: obtener precio por punto para un año específico
  const getPointPriceForYear = (year) => getPriceForYear(pointPrices, year);

  // Guardar precio por punto por año
  const savePointPrice = async (year, priceUsd) => {
    try {
      if (priceUsd < 2) { alert('El precio mínimo por punto es $2.00 USD'); return; }
      const dbUser = users.find(u => u.username === cu?.username);
      await upsertPointPrice(year, priceUsd, dbUser?.id || null);
      await loadAll();
    } catch (e) {
      console.error('Error guardando precio:', e);
      alert('Error guardando precio: ' + (e.message || JSON.stringify(e)));
    }
  };

  // CRUD de disponibilidad de unidades
  const saveUnitAvailability = async (unitId, startDate, endDate, totalRooms, existingId) => {
    try {
      if (existingId) {
        await updateUnitAvailability(existingId, { startDate, endDate, totalRooms });
      } else {
        await insertUnitAvailability(unitId, startDate, endDate, totalRooms);
      }
      await loadAll();
    } catch (e) {
      console.error('Error guardando disponibilidad:', e);
      alert('Error guardando disponibilidad: ' + (e.message || JSON.stringify(e)));
    }
  };

  const removeUnitAvailability = async (id) => {
    try {
      await deleteUnitAvailability(id);
      await loadAll();
    } catch (e) {
      console.error('Error eliminando disponibilidad:', e);
      alert('Error: ' + (e.message || JSON.stringify(e)));
    }
  };

  // Guardar rango de temporada de unidad
  const saveSeasonRange = async (unitId, season, startMonth, startDay, endMonth, endDay, ptsWeekday, ptsWeekend, existingId) => {
    try {
      if (existingId && existingId < 1e9) {
        await updateUnitSeasonRange(existingId, startMonth, startDay, endMonth, endDay, ptsWeekday, ptsWeekend);
      } else {
        await insertUnitSeasonRange(unitId, season, startMonth, startDay, endMonth, endDay, ptsWeekday, ptsWeekend);
      }
      await loadAll();
    } catch (e) {
      console.error('Error guardando temporada:', e);
      alert('Error: ' + (e.message || JSON.stringify(e)));
    }
  };

  const removeSeasonRange = async (id) => {
    try {
      await deleteUnitSeasonRange(id);
      await loadAll();
    } catch (e) {
      console.error('Error eliminando temporada:', e);
      alert('Error: ' + (e.message || JSON.stringify(e)));
    }
  };

  const saveRecoveredPoints = async (clientId, points, maintYear, note) => {
    try {
      const dbUser = users.find(u => u.username === cu?.username);
      await insertSavedPoints(clientId, points, maintYear, dbUser?.id || null, note);
      await loadAll();
    } catch (e) {
      console.error('Error recuperando puntos:', e);
      alert('Error recuperando puntos: ' + (e.message || JSON.stringify(e)));
    }
  };

  // Alta de contrato preexistente (migración)
  const saveLegacyClient = async (contract, phones, emails, addresses, comments, availablePoints) => {
    try {
      const dbUser = users.find(u => u.username === cu?.username);
      const result = await insertLegacyClient(contract, phones, emails, addresses, comments, availablePoints, dbUser?.id || null);
      await loadAll();
      return result;
    } catch (e) {
      console.error('Error dando de alta contrato:', e);
      throw e;
    }
  };

  const login = u => { setCu(u); setTab(RT[u.role][0]); };
  const logout = () => { setCu(null); setTab(null); setClients([]); setPayments([]); };

  if (!cu) return <Login onLogin={login} users={users} />;

  if (loading) return (
    <div style={{ minHeight: "100vh", background: BG, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 16 }}>
      <div style={{ width: 32, height: 32, border: `3px solid ${B}`, borderTop: "3px solid transparent", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
      <div style={{ color: T3, fontSize: 12 }}>Cargando datos...</div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );

  if (dbError && clients.length === 0) return (
    <div style={{ minHeight: "100vh", background: BG, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 12 }}>
      <div style={{ color: R, fontSize: 13, fontWeight: 700 }}>⚠ Error de conexión</div>
      <div style={{ color: T4, fontSize: 11 }}>{dbError}</div>
      <button onClick={loadAll} style={{ background: B, color: "#fff", border: "none", borderRadius: 6, padding: "8px 18px", cursor: "pointer" }}>Reintentar</button>
    </div>
  );
  if (!cu) return <Login onLogin={login} users={users} />;
  const allowed = ATABS.filter(t => RT[cu.role].includes(t.id));
  const active = ATABS.find(t => t.id === tab);
  const sc2 = RM[cu.role]?.c || B;
  const morosos = clients.filter(c => c.balance > 0).length;
  return (<div style={{ minHeight: "100vh", background: BG, fontFamily: "'DM Mono','Fira Code','Courier New',monospace", color: T3 }}>
    <div style={{ background: "#050d1a", borderBottom: `1px solid #0e1e32`, padding: "0 16px", display: "flex", alignItems: "center", gap: 13, height: 48 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <div style={{ width: 22, height: 22, background: "linear-gradient(135deg,#1d4ed8,#7c3aed)", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11 }}>◈</div>
        <span style={{ color: T1, fontWeight: 800, fontSize: 12, letterSpacing: ".06em" }}>POINTSUITE</span>
        <span style={{ color: T5, fontSize: 9 }}>/OMS</span>
      </div>
      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 8, color: T5 }}>{f$(pp)}/pt · Reserva: {f$(rc)}</span>
        {morosos > 0 && <span style={{ background: R + "20", color: R, border: `1px solid ${R}33`, borderRadius: 12, padding: "2px 7px", fontSize: 9, fontWeight: 700 }}>{morosos} morosos</span>}
        <div style={{ display: "flex", alignItems: "center", gap: 5, background: "#07111e", border: `1px solid ${BD}`, borderRadius: 14, padding: "2px 9px 2px 5px" }}>
          <div style={{ width: 16, height: 16, borderRadius: "50%", background: cu.color + "22", border: `1px solid ${cu.color}44`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, color: cu.color, fontWeight: 700 }}>{cu.username[0].toUpperCase()}</div>
          <span style={{ fontSize: 9, color: T3 }}>{cu.name}</span>
          <RBdg r={cu.role} />
        </div>
        <button onClick={() => loadAll()} title="Recargar datos desde la base de datos" style={{ background: "transparent", border: `1px solid ${BD}`, color: B, borderRadius: 6, padding: "2px 8px", fontSize: 8, cursor: "pointer", fontFamily: "inherit", marginRight: 5 }}>🔄 Recargar</button>
        <button onClick={logout} style={{ background: "transparent", border: `1px solid ${BD}`, color: T4, borderRadius: 6, padding: "2px 8px", fontSize: 8, cursor: "pointer", fontFamily: "inherit" }}>Salir ⇥</button>
      </div>
    </div>
    <div style={{ display: "flex", height: "calc(100vh - 48px)" }}>
      <div style={{ width: 172, background: "#050d1a", borderRight: "1px solid #0e1e32", padding: "12px 7px", flexShrink: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ flex: 1 }}>
          {allowed.map(t => (<button key={t.id} onClick={() => setTab(t.id)} style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", background: tab === t.id ? sc2 + "14" : "transparent", color: tab === t.id ? sc2 : "#1a3050", border: `1px solid ${tab === t.id ? sc2 + "33" : "transparent"}`, borderRadius: 6, padding: "6px 8px", marginBottom: 2, fontSize: 10, fontWeight: tab === t.id ? 700 : 500, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
            <span style={{ fontSize: 11 }}>{t.i}</span>{t.l}
          </button>))}
        </div>
        <div style={{ padding: "9px", background: BG, borderRadius: 7, border: `1px solid ${T5}`, marginTop: 7 }}>
          <div style={{ fontSize: 7, color: sc2, letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 4 }}>{RM[cu.role]?.l}</div>
          {cu.role === "superadmin" && <><div style={{ fontSize: 8, color: "#1a3050", marginBottom: 1 }}>Clientes: <b style={{ color: T4 }}>{clients.length}</b></div><div style={{ fontSize: 8, color: "#1a3050", marginBottom: 1 }}>Morosos: <b style={{ color: R }}>{morosos}</b></div><div style={{ fontSize: 8, color: "#1a3050" }}>YTD: <b style={{ color: G }}>{f$(payments.reduce((a, p) => a + p.amount, 0))}</b></div></>}
          {cu.role === "admin" && <><div style={{ fontSize: 8, color: "#1a3050", marginBottom: 1 }}>Gestores: <b style={{ color: P }}>{users.filter(u => u.role === "gestor" && u.active !== false).length}</b></div><div style={{ fontSize: 8, color: "#1a3050" }}>Morosos: <b style={{ color: R }}>{morosos}</b></div></>}
          {cu.role === "gestor" && <><div style={{ fontSize: 8, color: "#1a3050", marginBottom: 1 }}>Mis cuentas: <b style={{ color: P }}>{clients.filter(c => String(c.assignedGestor) === String(cu.id)).length}</b></div><div style={{ fontSize: 8, color: "#1a3050" }}>Mis reservas: <b style={{ color: P }}>{reservations.filter(r => r.processedBy === cu.username).length}</b></div></>}
          {cu.role === "cajero" && <div style={{ fontSize: 8, color: "#1a3050" }}>Tarifa: <b style={{ color: G }}>{f$(pp)}/pt</b></div>}
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: T2, marginBottom: 15, letterSpacing: ".03em" }}>{active?.l}</div>
        {tab === "dash" && <Dashboard clients={clients} reservations={reservations} payments={payments} pp={pp} promises={promises} users={users} condonations={condonations} fxRate={fxRate} />}
        {tab === "promesas" && <PromisesView promises={promises} clients={clients} cu={cu} users={users} fxRate={fxRate} onValidate={validatePromiseToCashier} onReschedule={reschedulePromise} onCancel={cancelPromise} onGoToClient={(cid) => { setPreselClient(cid); setTab("clients"); }} />}
        {tab === "clients" && <ClientsView clients={clients} setClients={setClients} pp={pp} cu={cu} payments={payments} reservations={reservations} users={users} condonations={condonations} fxRate={fxRate} onGoToCashier={cid => { setPreselClient(cid); setTab("cashier"); }} onGoToRes={cid => { setPreselResClient(cid); setTab("res"); }} onSaveClient={saveClient} onAddPhone={addClientPhone} onSetPhoneActive={setClientPhoneActive} onAddEmail={addClientEmail} onSetEmailActive={setClientEmailActive} onAddAddress={addClientAddress} onSetAddressActive={setClientAddressActive} onAddComment={addClientComment} onSaveSavedPoints={saveSavedPoints} onSavePromise={savePromise} />}
        {tab === "cashier" && <CashierView clients={clients} payments={payments} setPayments={setPayments} setClients={setClients} pp={pp} pms={pms} cu={cu} users={users} cr={cr} condonations={condonations} pendingPayments={pendingPayments} setPendingPayments={setPendingPayments} promises={promises} setPromises={setPromises} fxRate={fxRate} setFxRate={setFxRate} preselClientId={preselClient} onClearPresel={() => setPreselClient(null)} onSavePayment={savePayment} onSavePending={savePendingPayment} onRejectPending={rejectPendingPayment} onSaveFxRate={saveFxRate} promiseToValidate={promiseToValidate} onClearPromiseToValidate={() => setPromiseToValidate(null)} onPromiseFulfilled={markPromiseFulfilled} />}
        {tab === "res" && <ReservationsView clients={clients} reservations={reservations} setReservations={setReservations} units={units} setUnits={setUnits} uts={uts} cu={cu} rc={rc} payments={payments} condonations={condonations} users={users} preselClientId={preselResClient} onClearPresel={() => setPreselResClient(null)} onSaveReservation={saveReservation} onCancelReservation={cancelReservation} />}
        {tab === "col" && <CollectionsView clients={clients} payments={payments} pp={pp} promises={promises} setPromises={setPromises} cu={cu} fxRate={fxRate} onSavePromise={savePromise} onUpdatePromise={updatePromiseStatus} condonations={condonations} />}
        {tab === "reports" && <ReportsView clients={clients} reservations={reservations} payments={payments} pp={pp} users={users} role={cu.role} courtesies={courtesies} rc={rc} condonations={condonations} />}
        {tab === "cobranza" && <CobranzaReportView payments={payments} pointSales={pointSales} pms={pms} users={users} cr={cr} cu={cu} />}
        {tab === "config" && <ConfigView seasonOrder={seasonOrder} setSeasonOrder={setSeasonOrder} uts={uts} setUts={setUts} units={units} setUnits={setUnits} pp={pp} setPp={setPp} onSaveUnit={saveUnit} onSaveUnitType={saveUnitType} onRemoveUnitType={removeUnitType} onSavePricePerPoint={savePricePerPoint} pointPrices={pointPrices} savePointPrice={savePointPrice} saveUnitAvailability={saveUnitAvailability} removeUnitAvailability={removeUnitAvailability} saveSeasonRange={saveSeasonRange} removeSeasonRange={removeSeasonRange} cu={cu} />}
        {tab === "pmethods" && <PayMethodsView pms={pms} setPms={setPms} onSavePm={savePaymentMethod} />}
        {tab === "comp" && <CompView users={users} setUsers={setUsers} payments={payments} reservations={reservations} pp={pp} rc={rc} setRc={setRc} cr={cr} setCr={setCr} onSaveUser={saveUser} onSaveCommissionRate={saveCommissionRate} onSaveReservationFee={saveReservationFee} />}
        {tab === "users" && <UsersView cu={cu} users={users} setUsers={setUsers} rc={rc} onSaveUser={saveUser} />}
        {tab === "team" && <TeamView users={users} setUsers={setUsers} clients={clients} setClients={setClients} payments={payments} reservations={reservations} condonations={condonations} onAssignGestor={assignGestor} onCancelContract={cancelContract} onSaveUser={saveUser} cu={cu} />}
        {tab === "contracts" && <ContractsView clients={clients} setClients={setClients} />}
        {tab === "courtesies" && <CourtesiesView clients={clients} setClients={setClients} courtesies={courtesies} setCourtesies={setCourtesies} pp={pp} cu={cu} users={users} onSaveCourtesy={saveCourtesy} />}
        {tab === "special" && <SpecialMgmtView clients={clients} payments={payments} condonations={condonations} setCondonations={setCondonations} cu={cu} users={users} pp={pp} onSaveCondonation={saveCondonation} onSaveRecoveredPoints={saveRecoveredPoints} />}
        {tab === "legacy" && <LegacyContractView cu={cu} users={users} onSave={saveLegacyClient} />}
        {tab === "ec" && <MyAccountView cu={cu} users={users} payments={payments} pms={pms} fxRate={fxRate} cr={cr} />}
        {tab === "ps" && <PointSalesView clients={clients} setClients={setClients} payments={payments} setPayments={setPayments} pp={pp} pms={pms} cu={cu} pendingSales={pendingSales} setPendingSales={setPendingSales} onSavePointSale={savePointSale} pointPrices={pointPrices} fxRate={fxRate} />}
      </div>
    </div>
  </div>);
}
