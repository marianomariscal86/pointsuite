import { useState, useMemo, useEffect, useCallback } from "react";
import { supabase } from './supabase.js';
import {
  fetchClients, updateClient,
  fetchPayments, insertPayment,
  fetchReservations, insertReservation,
  fetchUnits,
  fetchFxRate, insertFxRate,
  fetchPaymentMethods,
  fetchPromises, insertPromise, updatePromise,
  fetchPendingPayments, insertPendingPayment, updatePendingPayment,
  fetchUsers,
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
function getMaintYear(client, payments) {
  if (!client || !client.contractDate) return CY;
  const startYear = new Date(client.contractDate).getFullYear();
  const annualPts = client.annualPoints || 0;
  if (annualPts === 0) return CY;
  // Agrupar puntos pagados por año de mantenimiento
  const paidByYear = {};
  payments.filter(p => (p.type === "maintenance" || p.ptype === "maintenance") && p.clientId === client.id).forEach(p => {
    const yr = p.maintYear || (p.date ? new Date(p.date).getFullYear() : null);
    if (yr) paidByYear[yr] = (paidByYear[yr] || 0) + (p.points || 0);
  });
  // Buscar el año más antiguo no pagado completamente
  for (let yr = startYear; yr <= CY; yr++) {
    if ((paidByYear[yr] || 0) < annualPts) return yr;
  }
  // Todos los años hasta CY están pagados → siguiente año (prepago)
  return CY + 1;
}
function getMaintPointExpiry(maintYear) {
  return new Date(maintYear, 11, 31).toISOString().split("T")[0];
}
// Calcula todos los años de mantenimiento pendientes de pago para un cliente
// Retorna array de {year, pts, montoMXN, paid (bool), partialPts} ordenado de más antiguo a más reciente
function getMaintDesglose(client, payments, pp) {
  if (!client || !client.contractDate) return [];
  const startYear = new Date(client.contractDate).getFullYear();
  const years = [];
  // Obtener pagos de mantenimiento agrupados por año (revisar tanto type como ptype)
  const maintPayments = payments.filter(p => (p.type === "maintenance" || p.ptype === "maintenance") && p.clientId === client.id);
  const paidByYear = {};
  maintPayments.forEach(p => {
    const yr = p.maintYear || (p.date ? new Date(p.date).getFullYear() : null);
    if (yr) paidByYear[yr] = (paidByYear[yr] || 0) + (p.points || 0);
  });
  const annualPts = client.annualPoints || 0;
  const montoAnual = Math.round(annualPts * pp);
  // Iterar desde año de inicio hasta año actual
  for (let yr = startYear; yr <= CY; yr++) {
    const ptsPagados = paidByYear[yr] || 0;
    const paid = ptsPagados >= annualPts;
    const partial = ptsPagados > 0 && !paid;
    years.push({ year: yr, pts: annualPts, montoMXN: montoAnual, ptsPagados, paid, partial, pendientePts: Math.max(0, annualPts - ptsPagados), pendienteMXN: Math.max(0, montoAnual - Math.round(ptsPagados * pp)) });
  }
  return years;
}
// Días hasta el próximo 31 de enero (fecha de asignación de puntos y vencimiento de los anteriores)
// Días hasta el siguiente 1 de enero (fecha de asignación de puntos nuevos)
function daysToNextRenewal() { const next = new Date(CY + 1, 0, 1); return Math.floor((next - TODAY) / 86400000); }
// Días hasta el 31 de diciembre de este año (fecha de vencimiento de puntos no usados)
function daysToPointExpiry() { const exp = new Date(CY, 11, 31); if (TODAY > exp) exp.setFullYear(CY + 1); return Math.floor((exp - TODAY) / 86400000); }
// Días hasta el 31 de enero (fecha límite de pago de mantenimiento)
function daysToMaintDeadline() { const d = new Date(CY, 0, 31); if (TODAY > d) d.setFullYear(CY + 1); return Math.floor((d - TODAY) / 86400000); }
// Clasificación extendida: un cliente con saldo 0 siempre está "Al corriente"
function cDelEx(bal, dOvrDays) { if (bal === 0) { if (daysToNextRenewal() < 365) return { l: "Promoción Prepago", c: "#10b981", r: 0 }; return { l: "Al corriente", c: G, r: 0 }; } return cDel(dOvrDays); }
function calcAP(tot, used, yr) { const r = Math.max(0, tot - (used || 0)); return yr <= 1 ? r : Math.ceil(r / yr); }
// calcPts: recibe la unidad con sus seasons y el id de la temporada detectada
function calcPts(unit, seasonId, isWe) { if (!unit || !seasonId) return 0; const s = (unit.seasons || []).find(x => x.id === seasonId); if (!s) return 0; return isWe ? s.ptsWe : s.ptsWd; }
// Helper: dado una fecha y un rango {startMonth,startDay,endMonth,endDay}, verifica si la fecha cae en el rango
function inRange(date, r) { const m = date.getMonth() + 1, dy = date.getDate(); if (r.startMonth <= r.endMonth) return (m > r.startMonth || (m === r.startMonth && dy >= r.startDay)) && (m < r.endMonth || (m === r.endMonth && dy <= r.endDay)); return (m > r.startMonth || (m === r.startMonth && dy >= r.startDay)) || (m < r.endMonth || (m === r.endMonth && dy <= r.endDay)); }
// detS: dado fecha y unidad, encuentra la temporada de esa unidad que cubre esa fecha
function detS(ds, unit) { if (!ds || !unit) return null; const d = new Date(ds); const s = (unit.seasons || []).find(s => (s.ranges || []).some(r => inRange(d, r))); if (!s) return null; return { ...s, ...SEASON_META.find(m => m.id === s.id) }; }
const mkP = (label, number, active = true) => ({ label, number, active });
const mkE = (label, email, active = true) => ({ label, email, active });
const mkA = (label, text, active = true) => ({ label, text, active });
const mkC = (text, by, date) => ({ id: Math.random(), text, by, date });
const RM = { superadmin: { l: "Super Admin", c: B }, admin: { l: "Admin", c: Y }, cajero: { l: "Cajero", c: G }, gestor: { l: "Gestor", c: P } };
const RT = { superadmin: ["dash", "clients", "cashier", "res", "col", "reports", "config", "pmethods", "comp", "users"], admin: ["dash", "clients", "reports", "config", "team", "contracts", "courtesies", "ps"], cajero: ["cashier", "clients", "ps"], gestor: ["res", "col", "cashier", "clients", "ps"] };
const ATABS = [{ id: "dash", l: "Dashboard", i: "◈" }, { id: "clients", l: "Clientes", i: "◉" }, { id: "cashier", l: "Caja", i: "◐" }, { id: "res", l: "Reservaciones", i: "◫" }, { id: "col", l: "Cobranzas", i: "◎" }, { id: "reports", l: "Reportes", i: "◧" }, { id: "config", l: "Config", i: "◬" }, { id: "pmethods", l: "Medios de Pago", i: "◆" }, { id: "comp", l: "Sueldos", i: "◇" }, { id: "users", l: "Usuarios", i: "◭" }, { id: "team", l: "Mi Equipo", i: "◩" }, { id: "contracts", l: "Contratos", i: "◪" }, { id: "courtesies", l: "Cortesías", i: "◤" }, { id: "ps", l: "Venta Puntos", i: "◥" }];
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
const INIT_CR = [{ id: "maintenance", l: "Pago mantenimiento", pct: 1.5, active: true }, { id: "point_purchase", l: "Compra puntos", pct: 2.0, active: true }, { id: "cancellation_payment", l: "Liquidación cancelación", pct: 0.5, active: true }, { id: "moratorios", l: "Moratorios", pct: 3.0, active: true }];
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
function ClientModal({ client, onSave, onClose, pp, cu }) {
  const isAdmin = ["superadmin", "admin"].includes(cu?.role);
  const blank = { contractNo: "", name: "", contractDate: "", dueDate: "", contractYears: 10, yearsElapsed: 0, totalPoints: 0, pointsUsedToDate: 0, paidPoints: 0, balance: 0, status: "Active", contractStatus: "Active", assignedGestor: "", phones: [], emails: [], addresses: [], comments: [], savedPoints: [] };
  const [f, setF] = useState(client || blank);
  const set = k => v => setF(x => ({ ...x, [k]: v }));
  const yr = Math.max(1, (f.contractYears || 1) - (f.yearsElapsed || 0));
  const cAP = calcAP(f.totalPoints || 0, f.pointsUsedToDate || 0, yr);
  const cBal = Math.max(0, (cAP - (f.paidPoints || 0)) * pp);
  const addPh = (l, n) => set("phones")([...f.phones, { label: l, number: n, active: true }]);
  const addEm = (l, e) => set("emails")([...f.emails, { label: l, email: e, active: true }]);
  const addAd = (l, t) => set("addresses")([...f.addresses, { label: l, text: t, active: true }]);
  const togPh = i => set("phones")(f.phones.map((p, x) => x === i ? { ...p, active: p.active === false ? true : false } : p));
  const togEm = i => set("emails")(f.emails.map((e, x) => x === i ? { ...e, active: e.active === false ? true : false } : e));
  const togAd = i => set("addresses")(f.addresses.map((a, x) => x === i ? { ...a, active: a.active === false ? true : false } : a));
  const addCm = c => set("comments")([...(f.comments || []), c]);
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
// ── CLIENTS VIEW ─────────────────────────────────────────────────────────────
function ClientsView({ clients, setClients, pp, cu, payments, reservations, onGoToCashier, onGoToRes }) {
  const [srch, setSrch] = useState(""), [filt, setFilt] = useState("All"), [sel, setSel] = useState(null), [modal, setModal] = useState(null), [dtab, setDtab] = useState("info");
  const [saveModal, setSaveModal] = useState(null);
  const canEdit = ["superadmin", "admin"].includes(cu.role);
  const en = useMemo(() => clients.map(c => { const d = dOvr(c.dueDate); const cl = cDelEx(c.balance, d); const interest = cInt(c.balance, d, cl.r * 12); return { ...c, dOvr: d, cls: cl, interest, totalOwed: c.balance + interest, ph: (c.phones || []).find(p => p.active !== false)?.number || "—" }; }), [clients]);
  const filtered = useMemo(() => { const ql = srch.toLowerCase(); return en.filter(c => { const ms = !srch || c.name.toLowerCase().includes(ql) || c.contractNo.toLowerCase().includes(ql) || (c.phones || []).some(p => p.number.includes(srch)) || (c.emails || []).some(e => e.email.toLowerCase().includes(ql)); const mf = filt === "All" || c.status === filt || (filt === "Morosos" && c.balance > 0) || (filt === "Cancelados" && c.contractStatus !== "Active"); return ms && mf; }); }, [en, srch, filt]);
  const selC = en.find(c => c.id === sel);
  const save = f => { if (modal === "new") setClients(cs => [...cs, { ...f, id: Date.now() }]); else setClients(cs => cs.map(c => c.id === modal.id ? { ...f, id: c.id } : c)); setModal(null); };
  const exportCSV = (rows, cols, name) => { const csv = [cols, ...rows].map(r => r.join(",")).join("\n"); const a = document.createElement("a"); a.href = "data:text/csv," + encodeURIComponent(csv); a.download = name; a.click(); };
  return (<div style={{ display: "grid", gridTemplateColumns: selC ? "1fr 380px" : "1fr", gap: 14 }}>
    <div>
      {modal && <ClientModal client={modal === "new" ? null : modal} onSave={save} onClose={() => setModal(null)} pp={pp} cu={cu} />}
      {saveModal && <SavePointsModal client={saveModal} cu={cu} onClose={() => setSaveModal(null)} onSave={sp => { setClients(cs => cs.map(c => c.id === saveModal.id ? { ...c, paidPoints: c.paidPoints - sp.points, savedPoints: [...(c.savedPoints || []), sp] } : c)); setSaveModal(null); }} />}
      <div style={{ display: "flex", gap: 8, marginBottom: 11, flexWrap: "wrap" }}>
        <input placeholder="Nombre, Nº contrato, teléfono, email…" value={srch} onChange={e => setSrch(e.target.value)} style={{ ...IS, flex: 1, minWidth: 200 }} />
        <select value={filt} onChange={e => setFilt(e.target.value)} style={{ ...IS, width: 130 }}>{["All", "Active", "Partial", "Delinquent", "Morosos", "Cancelados"].map(s => <option key={s}>{s}</option>)}</select>
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
          <td style={tPs()}>{c.assignedGestor || "—"}</td>
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
      {(onGoToCashier || onGoToRes) && <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {onGoToCashier && <Btn label="💳 Pagar" onClick={() => onGoToCashier(selC.id)} />}
        {onGoToRes && <Btn label="🏨 Reservar" variant="purple" onClick={() => onGoToRes(selC.id)} />}
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
        {[["Contrato", selC.contractNo], ["Vencimiento", selC.dueDate], ["Gestor", selC.assignedGestor || "—"], ["Plazo", `${selC.contractYears || "—"}a (${selC.yearsElapsed || 0} transcurridos)`]].map(([l, v]) => (
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
      {dtab === "contacts" && <div>
        {[["Teléfonos", (selC.phones || []), "number"], ["Correos", (selC.emails || []), "email"], ["Direcciones", (selC.addresses || []), "text"]].map(([title, items, field]) => (
          <div key={title} style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 9, color: T4, textTransform: "uppercase", marginBottom: 5 }}>{title}</div>
            {items.map((it, i) => (<div key={i} style={{ display: "flex", gap: 7, padding: "5px 0", borderBottom: `1px solid ${BG3}`, opacity: it.active === false ? .4 : 1 }}>
              <span style={{ fontSize: 9, color: T3, width: 68, flexShrink: 0, background: BG3, borderRadius: 4, padding: "2px 5px", textAlign: "center" }}>{it.label}</span>
              <span style={{ color: T2, fontSize: 11, flex: 1, fontFamily: field === "text" ? "inherit" : "monospace" }}>{it[field]}</span>
              {it.active === false && <span style={{ fontSize: 9, color: R, background: R + "12", borderRadius: 4, padding: "1px 5px" }}>F/S</span>}
            </div>))}
          </div>
        ))}
      </div>}
      {dtab === "contract" && <div>
        {[["Plazo total", `${selC.contractYears || "—"} años`], ["Años transcurridos", selC.yearsElapsed || 0], ["Años restantes", Math.max(0, (selC.contractYears || 0) - (selC.yearsElapsed || 0))], ["Pts totales", fP(selC.totalPoints)], ["Pts usados (hist.)", fP(selC.pointsUsedToDate || 0)], ["Pts restantes", fP(Math.max(0, (selC.totalPoints || 0) - (selC.pointsUsedToDate || 0)))], ["Pts anuales", fP(selC.annualPoints)], ["Pts pagados", fP(selC.paidPoints)]].map(([l, v]) => (
          <div key={l} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: `1px solid ${BG3}` }}>
            <span style={{ color: T4, fontSize: 11 }}>{l}</span><span style={{ color: T2, fontWeight: 600, fontSize: 11 }}>{v}</span>
          </div>
        ))}
      </div>}
      {dtab === "comments" && <div>
        {[...(selC.comments || [])].sort((a, b) => b.id - a.id).map(c => (<div key={c.id} style={{ background: BG3, borderRadius: 6, padding: "9px 11px", marginBottom: 7, borderLeft: `2px solid ${T4}` }}>
          <div style={{ color: T2, fontSize: 12, marginBottom: 4, lineHeight: 1.5 }}>{c.text}</div>
          <div style={{ color: T4, fontSize: 9 }}>{c.by} · {c.date}</div>
        </div>))}
        {(selC.comments || []).length === 0 && <div style={{ color: T4, fontSize: 11, textAlign: "center", padding: "18px 0" }}>Sin comentarios</div>}
      </div>}
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
function CashierView({ clients, payments, setPayments, setClients, pp, pms, cu, users, pendingPayments, setPendingPayments, promises, setPromises, fxRate, setFxRate, preselClientId, onClearPresel, onSavePayment, onSavePending }) {
  const isCajero = cu.role === "cajero";
  const isGestor = cu.role === "gestor";
  const [sid, setSid] = useState(preselClientId || null), [ptype, setPtype] = useState("maintenance"), [mantAmt, setMantAmt] = useState(""), [moraAmt, setMoraAmt] = useState(""), [note, setNote] = useState(""), [ok, setOk] = useState(null);
  const [validateMid, setValidateMid] = useState("1"); // Medio de pago al validar
  const client = clients.find(c => c.id === sid);
  const d = client ? dOvr(client.dueDate) : 0;
  const cls = cDelEx(client?.balance || 0, d);
  const interest = client ? cInt(client.balance, d, cls.r * 12) : 0;
  const mantAmtN = +mantAmt || 0, moraAmtN = +moraAmt || 0;
  // Año de mantenimiento a pagar para el cliente seleccionado
  const maintYear = client ? getMaintYear(client, payments) : CY;
  // Es prepago SOLO si el mantenimiento del año en curso está completamente pagado
  // y por lo tanto el siguiente pago corresponde al año siguiente
  const isPrepago = client ? maintYear > CY : false;
  const maintPointExpiry = getMaintPointExpiry(maintYear);
  const preloadedMantAmt = client ? Math.round(client.annualPoints * pp) : 0;

  // Auto-precargar monto y tipo cuando se selecciona un cliente
  useEffect(() => {
    if (!client) { setMantAmt(""); setMoraAmt(""); setPtype("maintenance"); return; }
    if (isPrepago) {
      setPtype("prepago_maintenance");
      setMantAmt(String(preloadedMantAmt));
    } else {
      setPtype("maintenance");
      setMantAmt("");
    }
  }, [sid]); // eslint-disable-line

  const submit = () => {
    if (!client || (mantAmtN <= 0 && moraAmtN <= 0)) return;
    const isPrepagoPay = ptype === "prepago_maintenance";
    // Para prepago, no hay descuento sobre saldo (balance=0), se valida diferente
    if (!isPrepagoPay) {
      const saldoMXN = client.balance;
      const moraMXN = interest;
      const autoDiscMant = Math.max(0, saldoMXN - mantAmtN);
      const autoDiscMora = Math.max(0, moraMXN - moraAmtN);
      if (autoDiscMant > saldoMXN * 0.20 || autoDiscMora > moraMXN) return;
    }
    const totalCobrar = mantAmtN + moraAmtN;
    const prop = {
      id: Date.now(), clientId: client.id, clientName: client.name, contractNo: client.contractNo,
      ptype: isPrepagoPay ? "maintenance" : ptype, // se guarda como maintenance para compatibilidad
      mantAmt: mantAmtN, moraAmt: moraAmtN,
      mantDisc: 0, moraDisc: 0,
      totalACobrar: totalCobrar, submittedBy: cu.username, submittedAt: new Date().toISOString(),
      note: isPrepagoPay ? `[PREPAGO] Mantenimiento adelantado año ${maintYear}${note ? " — " + note : ""}` : note,
      status: "Por Validar",
      maintYear, maintPointExpiry, isPrepago: isPrepagoPay
    };
    setPendingPayments(ps => [...ps, prop]);
    setOk({ name: client.name, total: totalCobrar, id: prop.id });
    setSid(null); setMantAmt(""); setMoraAmt(""); setNote("");
    // Guardar en Supabase
    if (onSavePending) onSavePending(prop).catch(console.error);
  };
  const validatePayment = (id, mid) => {
    const pp2 = pendingPayments.find(p => p.id === id); if (!pp2) return;
    const pm = pms.find(m => m.id === +mid) || pms[0];
    const cli = clients.find(c => c.id === pp2.clientId);
    // Puntos acreditados: para mantenimiento, son los pts que corresponden al monto pagado
    const mantPaid = pp2.mantAmt - pp2.mantDisc;
    const ptsFinal = pp2.ptype === "maintenance" ? Math.round(mantPaid / pp) : (pp2.ptype === "point_purchase" ? Math.round(pp2.totalACobrar / pp) : 0);
    // Determinar a qué año se asigna el pago (el más antiguo pendiente, salvo que sea prepago)
    const targetYear = pp2.isPrepago ? (pp2.maintYear || CY + 1) : (cli ? getMaintYear(cli, payments) : CY);
    const targetExpiry = getMaintPointExpiry(targetYear);
    const payment = {
      id: Date.now(), clientId: pp2.clientId, clientName: pp2.clientName, contractNo: pp2.contractNo,
      date: new Date().toISOString().split("T")[0], amount: pp2.totalACobrar, amountMant: pp2.mantAmt - pp2.mantDisc, amountMora: pp2.moraAmt - pp2.moraDisc,
      points: ptsFinal || 0, method: pm.name, costPct: pm.costPct || 0,
      discountMant: pp2.mantDisc, discountMora: pp2.moraDisc,
      note: `[${pp2.ptype}] ${pp2.note}`, status: "Liquidado",
      processedBy: pp2.submittedBy, processedByCajero: cu.username,
      type: pp2.ptype, fxRate: fxRate.rate,
      maintYear: targetYear,
      maintPointExpiry: targetExpiry,
      isPrepago: pp2.isPrepago || targetYear > CY,
      // Comisión diferenciada: prepago (1%) vs mantenimiento normal (2%) vs mora (3%)
      agentCommission: (pp2.isPrepago ? (pp2.mantAmt - pp2.mantDisc) * 0.01 : (pp2.mantAmt - pp2.mantDisc) * 0.02) + (pp2.moraAmt - pp2.moraDisc) * 0.03,
    };
    setPayments(ps => [...ps, payment]);
    // Guardar en Supabase
    if (onSavePayment) {
      const clientAfter = clients.find(c => c.id === pp2.clientId);
      onSavePayment(payment, clientAfter ? {
        paidPoints: clientAfter.paidPoints + (ptsFinal || 0),
        balance: Math.max(0, clientAfter.balance - (pp2.mantAmt - pp2.mantDisc)),
        status: clientAfter.status,
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
  const rejectPending = id => setPendingPayments(ps => ps.filter(p => p.id !== id));
  const deletePayment = pid => {
    const p = payments.find(x => x.id === pid); if (!p) return;
    // Solo se puede eliminar un pago al día SIGUIENTE de haberlo procesado.
    // El pago del día de ayer (TOD-1) es el que puede eliminarse hoy.
    const yesterday = new Date(TODAY.getTime() - 86400000).toISOString().split("T")[0];
    if (p.date !== yesterday) { alert("Solo se pueden eliminar pagos procesados el día anterior. Los pagos del día actual deben esperar hasta mañana; los anteriores ya pasaron la ventana de corrección."); return; }
    if (!window.confirm(`¿Eliminar pago de ${p.clientName} por ${f$(p.amount)}? Esto revertirá los cambios al cliente.`)) return;
    // Revertir efectos según tipo
    setClients(cs => cs.map(c => {
      if (c.id !== p.clientId) return c;
      if (p.type === "maintenance") { const np = Math.max(0, c.paidPoints - (p.points || 0)), nb = c.balance + (p.amountMant || p.amount); return { ...c, paidPoints: np, balance: nb, status: nb > 0 ? "Partial" : "Active" }; }
      if (p.type === "point_purchase") { const np = Math.max(0, c.paidPoints - (p.points || 0)), na = Math.max(0, c.annualPoints - (p.points || 0)); return { ...c, totalPoints: Math.max(0, c.totalPoints - (p.points || 0)), annualPoints: na, paidPoints: np }; }
      if (p.type === "cancellation_payment") return { ...c, balance: p.amount, contractStatus: "Active", cancelDate: "", cancelReason: "" };
      return c;
    }));
    setPayments(ps => ps.filter(x => x.id !== pid));
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
        {/* Selector de concepto — prepago_maintenance solo visible para clientes en Promoción Prepago */}
        <Inp
          label="Concepto"
          value={ptype}
          onChange={v => { setPtype(v); if (v === "prepago_maintenance") setMantAmt(String(preloadedMantAmt)); else if (v !== "prepago_maintenance") setMantAmt(""); }}
          opts={PT.filter(t => t.v !== "prepago_maintenance" || isPrepago).map(t => ({ v: t.v, l: t.l }))}
        />

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
            <Inp label={`Monto a cobrar (MXN $) — Mantenimiento Año ${nextMaintYear}`} value={mantAmt} onChange={setMantAmt} type="number" />
            {mantAmtN > 0 && mantAmtN !== montoCompleto && <div style={{ fontSize: 9, color: Y, marginTop: 3 }}>
              ⚠ El monto completo es {fMXN(montoCompleto)}. Si cobras menos, se aplicará como pago parcial.
            </div>}
          </div>;
        })()}

        {/* Formulario normal para otros conceptos */}
        {ptype !== "prepago_maintenance" && (() => {
          const desglose = getMaintDesglose(client, payments, pp);
          const pendientes = desglose.filter(d => !d.paid);
          const fx2 = fxRate?.rate || 17.5;
          return <>
            {/* Desglose de mantenimientos pendientes — solo si hay más de uno o hay años anteriores sin pagar */}
            {client && pendientes.length > 0 && <div style={{ background: BG3, border: `1px solid ${pendientes.length > 1 ? R : Y}33`, borderRadius: 8, padding: "10px 12px" }}>
              <div style={{ fontSize: 9, color: pendientes.length > 1 ? R : Y, textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8, fontWeight: 700 }}>
                {pendientes.length > 1 ? `⚠ ${pendientes.length} años de mantenimiento pendientes` : "📅 Mantenimiento pendiente"}
              </div>
              {desglose.map(d => (
                <div key={d.year} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: `1px solid ${BD}`, opacity: d.paid ? 0.4 : 1 }}>
                  <div style={{ width: 42, flexShrink: 0 }}>
                    <span style={{ background: d.paid ? G + "20" : d.partial ? Y + "20" : R + "20", color: d.paid ? G : d.partial ? Y : R, border: `1px solid ${d.paid ? G : d.partial ? Y : R}44`, borderRadius: 4, padding: "1px 5px", fontSize: 9, fontWeight: 700 }}>
                      {d.year}
                    </span>
                  </div>
                  <div style={{ flex: 1, fontSize: 10 }}>
                    <span style={{ color: T3 }}>{fP(d.pts)}</span>
                    {d.partial && <span style={{ color: Y, fontSize: 9, marginLeft: 6 }}>Parcial: {fP(d.ptsPagados)} pagados</span>}
                  </div>
                  <div style={{ textAlign: "right" }}>
                    {d.paid
                      ? <span style={{ color: G, fontSize: 10, fontWeight: 700 }}>✓ Pagado</span>
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
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <Inp label="Monto Mantenimiento a pagar (MXN $)" value={mantAmt} onChange={setMantAmt} type="number" />
                {mantAmtN > 0 && <div style={{ fontSize: 9, color: T4, marginTop: 2 }}>≈ {fUSD(mantAmtN / fx2)} USD</div>}
              </div>
              <div>
                <Inp label="Monto Moratorios a pagar (MXN $)" value={moraAmt} onChange={setMoraAmt} type="number" />
                {moraAmtN > 0 && <div style={{ fontSize: 9, color: T4, marginTop: 2 }}>≈ {fUSD(moraAmtN / fx2)} USD</div>}
              </div>
            </div>
          </>;
        })()}
        {(mantAmtN > 0 || moraAmtN > 0) && client && (() => {
          const saldoMXN = client.balance;
          const moraMXN = interest;
          const descMant = Math.max(0, saldoMXN - mantAmtN);
          const descMora = Math.max(0, moraMXN - moraAmtN);
          const maxMant = saldoMXN * 0.20;
          const maxMora = moraMXN * 1.00; // 100% mora permitida
          const exMant = descMant > maxMant;
          const exMora = descMora > maxMora;
          return <div style={{ background: BG3, borderRadius: 7, padding: "9px 11px", border: `1px solid ${exMant || exMora ? R : Y}22` }}>
            <div style={{ fontSize: 9, color: Y, textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 7 }}>Descuentos calculados automáticamente</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 6 }}>
              <div>
                <div style={{ fontSize: 8, color: T4, textTransform: "uppercase" }}>Descuento Mant. (máx 20%)</div>
                <div style={{ color: exMant ? R : Y, fontWeight: 700 }}>{fMXN(descMant)} {descMant > 0 ? `(${((descMant / saldoMXN) * 100).toFixed(1)}%)` : ""}</div>
                {exMant && <div style={{ color: R, fontSize: 9 }}>⚠ Excede máximo ({fMXN(maxMant)})</div>}
              </div>
              <div>
                <div style={{ fontSize: 8, color: T4, textTransform: "uppercase" }}>Descuento Mora (máx 100%)</div>
                <div style={{ color: exMora ? R : Y, fontWeight: 700 }}>{fMXN(descMora)} {descMora > 0 && moraMXN > 0 ? `(${((descMora / moraMXN) * 100).toFixed(1)}%)` : ""}</div>
                {exMora && <div style={{ color: R, fontSize: 9 }}>⚠ Excede máximo</div>}
              </div>
            </div>
            <div style={{ fontSize: 9, color: T4 }}>Los descuentos se calculan automáticamente comparando el monto propuesto vs el saldo. Máx: 20% en mantenimiento, 100% en moratorios.</div>
          </div>;
        })()}
        <Inp label="Notas" value={note} onChange={setNote} />
      </div>
      {mantAmtN + moraAmtN > 0 && client && ptype !== "prepago_maintenance" && (() => {
        const saldoMXN = client.balance;
        const moraMXN = interest;
        const descMant2 = Math.max(0, saldoMXN - mantAmtN);
        const descMora2 = Math.max(0, moraMXN - moraAmtN);
        const maxMant2 = saldoMXN * 0.20;
        const maxMora2 = moraMXN;
        const exMant2 = descMant2 > maxMant2;
        const exMora2 = descMora2 > maxMora2;
        const totalMXN = mantAmtN + moraAmtN;
        const saldoRes = Math.max(0, saldoMXN - mantAmtN);
        return <div style={{ margin: "10px 0", padding: "10px", background: BG3, borderRadius: 7 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 6, marginBottom: 6 }}>
            {[["Total MXN", fMXN(totalMXN), T1], ["Desc. Total", fMXN(descMant2 + descMora2), Y], ["A cobrar MXN", fMXN(totalMXN), G], ["Saldo result. USD", fUSD(saldoRes / (fxRate?.rate || 17.5)), saldoRes > 0 ? R : G]].map(([l, v, c]) => (<div key={l}><div style={{ fontSize: 8, color: T4, textTransform: "uppercase" }}>{l}</div><div style={{ color: c, fontWeight: 700, fontSize: 11 }}>{v}</div></div>))}
          </div>
          {(exMant2 || exMora2) && <div style={{ color: R, fontSize: 10, fontWeight: 700 }}>⛔ No se puede enviar a caja: el descuento excede el máximo permitido. Aumenta el monto a cobrar.</div>}
        </div>;
      })()}
      {mantAmtN > 0 && client && ptype === "prepago_maintenance" && <div style={{ margin: "10px 0", padding: "10px", background: "#10b98112", borderRadius: 7, border: "1px solid #10b98133" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 6 }}>
          {[["A cobrar MXN", fMXN(mantAmtN), G], ["Año pagado", String(maintYear), "#10b981"], ["Pts disponibles hasta", maintPointExpiry, Y]].map(([l, v, c]) => (<div key={l}><div style={{ fontSize: 8, color: T4, textTransform: "uppercase" }}>{l}</div><div style={{ color: c, fontWeight: 700, fontSize: 11 }}>{v}</div></div>))}
        </div>
      </div>}
      {(() => {
        const isPrepagoPay = ptype === "prepago_maintenance";
        if (isPrepagoPay) {
          return <Btn label={`⭐ Enviar Prepago Año ${maintYear} a Caja`} variant="success" onClick={submit} disabled={!client || mantAmtN <= 0} />;
        }
        const saldoMXN = client?.balance || 0;
        const moraMXN = interest;
        const descMant2 = Math.max(0, saldoMXN - mantAmtN);
        const descMora2 = Math.max(0, moraMXN - moraAmtN);
        const exMant2 = descMant2 > saldoMXN * 0.20;
        const exMora2 = descMora2 > moraMXN;
        const blocked = exMant2 || exMora2;
        return <Btn label="Enviar a Caja para Validación" onClick={submit} disabled={!client || (mantAmtN <= 0 && moraAmtN <= 0) || blocked} />;
      })()}
      <div style={{ fontSize: 9, color: T4, marginTop: 5 }}>Si el cajero no valida el pago antes del fin del día, la propuesta se cancela automáticamente.</div>
    </div>)}
    {isCajero && (<div style={{ background: BG2, border: `1px solid ${BD}`, borderRadius: 12, padding: 18 }}>
      <Sec t="Tipo de Cambio del Día" a={<span style={{ fontSize: 10, color: T4 }}>Fecha: {fxRate.date}</span>} />
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
        <div style={{ flex: 1 }}><Inp label="MXN por USD" type="number" value={fxRate.rate} onChange={v => setFxRate({ rate: +v, date: TOD })} /></div>
        <div style={{ color: B, fontWeight: 800, fontSize: 22 }}>${fxRate.rate}</div>
      </div>
      <div style={{ marginTop: 10, padding: "8px 9px", background: BG3, borderRadius: 6, fontSize: 10, color: T4 }}>Los contratos son en USD y los cobros en pesos. Este tipo de cambio se aplica a todos los cobros validados hoy.</div>
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
            <div style={{ fontSize: 9, color: T4, marginBottom: 8 }}>Propuso: {p.submittedBy} · {p.note}</div>
            {isCajero && <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <select value={validateMid} onChange={e => setValidateMid(e.target.value)} style={{ ...IS, flex: 1, fontSize: 11, padding: "5px 8px" }}>{pms.filter(m => m.active).map(m => (<option key={m.id} value={m.id}>{m.name}</option>))}</select>
              <Btn label="✓ Validar (cobrado)" variant="success" small onClick={() => validatePayment(p.id, validateMid)} />
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
function ResModal({ clients, units, uts, reservations, onSave, onClose, cu, rc, presel }) {
  const [sid, setSid] = useState(presel || null), [uid, setUid] = useState(units.filter(u => u.active)[0]?.id || ""), [ci, setCi] = useState(""), [co, setCo] = useState("");
  const unit = units.find(u => u.id === +uid), ut = uts.find(t => t.id === unit?.typeId), client = clients.find(c => c.id === sid), season = detS(ci, unit);
  const nights = ci && co ? Math.max(0, Math.round((new Date(co) - new Date(ci)) / 86400000)) : 0;
  const totalPts = () => { if (!nights || !unit || !ci) return 0; let t = 0; for (let i = 0; i < nights; i++) { const d = new Date(ci); d.setDate(d.getDate() + i); const dw = d.getDay(); const s = detS(d.toISOString().split("T")[0], unit); if (!s) return 0; t += calcPts(unit, s.id, dw === 5 || dw === 6); } return t; };
  const ptTotal = totalPts();
  const usedP = reservations.filter(r => r.clientId === sid && r.status === "Confirmed").reduce((a, r) => a + r.pointsUsed, 0);
  const savedA = client ? (client.savedPoints || []).filter(sp => new Date(sp.expiryDate) > new Date()).reduce((a, sp) => a + sp.points, 0) : 0;
  const avail = client ? client.paidPoints - usedP + savedA : 0;
  const conflict = (unit?.occ || []).some(o => { const oi = new Date(o.ci), oo = new Date(o.co), ni = new Date(ci), no = new Date(co); return !(no <= oi || ni >= oo); });
  const delinq = client ? dOvr(client.dueDate) > 0 : false;
  const canBook = nights > 0 && client && ptTotal <= avail && unit && client.contractStatus === "Active" && !delinq && !conflict;
  return (<Modal title="Nueva Reservación" onClose={onClose} wide>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
      <div style={{ gridColumn: "1/-1" }}>
        <SearchBox clients={clients} onSelect={setSid} selectedId={sid} />
        {client && <div style={{ marginTop: 5, padding: "7px 9px", background: BG3, borderRadius: 6, display: "flex", gap: 12, fontSize: 10 }}>
          <span style={{ color: G }}>Disponibles: {avail.toLocaleString()} pts</span>
          {savedA > 0 && <span style={{ color: P }}>{savedA.toLocaleString()} pts guardados</span>}
          {delinq && <span style={{ color: R, fontWeight: 700 }}>⚠ Con morosidad — sin reservas</span>}
        </div>}
      </div>
      <Inp label="Unidad" value={uid} onChange={v => setUid(+v)} opts={units.filter(u => u.active).map(u => ({ v: u.id, l: `${u.name} — ${uts.find(t => t.id === u.typeId)?.name} · ${u.location || ""}` }))} />
      <div style={{ background: BG3, borderRadius: 6, padding: "7px 9px", fontSize: 11 }}><div style={{ fontSize: 8, color: T4, marginBottom: 2, textTransform: "uppercase" }}>Temporada detectada</div><div style={{ color: season ? season.color : T4, fontWeight: 700 }}>{season ? `Temporada ${season.name}` : "Selecciona fecha"}</div></div>
      <Inp label="Check-In" type="date" value={ci} onChange={setCi} />
      <Inp label="Check-Out" type="date" value={co} onChange={setCo} />
    </div>
    {conflict && <div style={{ color: R, fontSize: 11, marginTop: 7, padding: "7px 9px", background: R + "12", borderRadius: 6 }}>⚠ Unidad ocupada en esas fechas.</div>}
    {nights > 0 && unit && season && !conflict && <div style={{ marginTop: 9, padding: "9px", background: BG3, borderRadius: 7, display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 7 }}>
      {[["Noches", nights, T1], ["Dom–Jue/n", calcPts(unit, season.id, false), B], ["Vie–Sáb/n", calcPts(unit, season.id, true), P], ["Total", fP(ptTotal), ptTotal <= avail ? G : R], ["Comisión", f$(rc), Y]].map(([l, v, c]) => (<div key={l}><div style={{ fontSize: 8, color: T4, textTransform: "uppercase", marginBottom: 2 }}>{l}</div><div style={{ color: c, fontWeight: 700 }}>{v}</div></div>))}
    </div>}
    {!canBook && nights > 0 && !conflict && <div style={{ color: R, fontSize: 10, marginTop: 5 }}>⚠ {delinq ? "Morosidad." : ptTotal > avail ? "Pts insuficientes." : "Datos incompletos."} Disponibles: {avail.toLocaleString()} pts</div>}
    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 13 }}>
      <Btn label="Cancelar" variant="ghost" onClick={onClose} />
      <Btn label="Confirmar y Emitir Comprobante" disabled={!canBook || conflict} onClick={() => onSave({ clientId: sid, clientName: client.name, contractNo: client.contractNo, unitId: unit.id, unitName: unit.name, location: unit.location || "", seasonId: season.id, seasonName: season.name, checkIn: ci, checkOut: co, nights, pointsUsed: ptTotal, status: "Confirmed" })} />
    </div>
  </Modal>);
}
function ReservationsView({ clients, reservations, setReservations, units, setUnits, uts, cu, rc, payments, preselClientId, onClearPresel, onSaveReservation }) {
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
    {modal && <ResModal clients={availC.length ? availC : clients} units={units} uts={uts} reservations={reservations} onSave={save} onClose={() => setModal(false)} cu={cu} rc={rc} presel={presel} />}
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
            <div><div style={{ color: T1, fontWeight: 700, fontSize: 13 }}>{c.name}</div><div style={{ color: T4, fontSize: 10 }}>{c.contractNo}·{c.assignedGestor || "—"}</div></div>
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
            {r.status !== "Cancelled" && <Btn label="Cancelar" variant="danger" small onClick={() => setReservations(rs => rs.map(x => x.id === r.id ? { ...x, status: "Cancelled" } : x))} />}
          </td>
        </tr>))} />
    </div>}
  </div>);
}
// ── COLLECTIONS ──────────────────────────────────────────────────────────────
function CollectionsView({ clients, payments, pp, promises, setPromises, cu, fxRate, onSavePromise }) {
  const [filt, setFilt] = useState("All"), [vtab, setVtab] = useState("accounts"), [pMod, setPMod] = useState(null), [pDate, setPDate] = useState(new Date().toISOString().split("T")[0]), [pAmt, setPAmt] = useState(""), [pNote, setPNote] = useState("");
  const isAdmin = ["superadmin", "admin"].includes(cu.role);
  const myC = isAdmin ? clients : clients.filter(c => c.assignedGestor === cu.username);
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
  const en = myC.map(c => { const d = dOvr(c.dueDate); const cl = cDelEx(c.balance, d); return { ...c, dOvr: d, cls: cl, interest: cInt(c.balance, d, cl.r * 12) }; });
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
            <Btn label="✓" variant="success" small onClick={() => setPromises(ps => ps.map(x => x.id === p.id ? { ...x, status: "Cumplida" } : x))} />
            <Btn label="✗" variant="danger" small onClick={() => setPromises(ps => ps.map(x => x.id === p.id ? { ...x, status: "Incumplida" } : x))} />
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
            {p.status === "Pendiente" && <><Btn label="✓" variant="success" small onClick={() => setPromises(ps => ps.map(x => x.id === p.id ? { ...x, status: "Cumplida" } : x))} /><Btn label="✗" variant="danger" small onClick={() => setPromises(ps => ps.map(x => x.id === p.id ? { ...x, status: "Incumplida" } : x))} /></>}
          </td>
        </tr>))} />
    </div>}
  </div>);
}
// ── POINT SALES ──────────────────────────────────────────────────────────────
function PointSalesView({ clients, setClients, payments, setPayments, pp, pms, cu, pendingSales, setPendingSales }) {
  const isAdmin = ["superadmin", "admin"].includes(cu.role), isCajero = cu.role === "cajero";
  const [sid, setSid] = useState(null), [stype, setStype] = useState("immediate"), [pts, setPts] = useState(""), [mid, setMid] = useState("1"), [note, setNote] = useState(""), [date, setDate] = useState(new Date().toISOString().split("T")[0]), [ok, setOk] = useState(null), [eYr, setEYr] = useState(0), [eAn, setEAn] = useState(0), [showSim, setShowSim] = useState(false);
  const client = clients.find(c => c.id === sid), pm = pms.find(m => m.id === +mid) || pms[0];
  const maint = (pts && stype === "immediate") ? +pts * pp : 0, ptsCost = pts ? +pts * pp : 0, totalCost = stype === "immediate" ? ptsCost + maint : ptsCost, txC = totalCost * (pm?.costPct || 0) / 100;
  const yr = client ? Math.max(1, (client.contractYears || 1) - (client.yearsElapsed || 0)) : 1, newYr = yr + (+eYr || 0), newTot = (client?.totalPoints || 0) + (+pts || 0);
  let fA = 0;
  if (stype === "increase_annual" && +eAn > 0) fA = (client?.annualPoints || 0) + (+eAn);
  else if (stype === "hybrid") fA = +eAn > 0 ? (client?.annualPoints || 0) + (+eAn) : calcAP(newTot, client?.pointsUsedToDate || 0, Math.max(1, (client?.contractYears || 1) + (+eYr || 0) - (client?.yearsElapsed || 0)));
  else fA = calcAP(newTot, client?.pointsUsedToDate || 0, newYr);
  const minA = client?.annualPoints || 0; // Regla: no puede quedar con menos pts/año que los que ya tenía
  const aOk = stype === "immediate" || fA >= minA, canSub = !isCajero && client && pts && +pts > 0 && aOk;
  const now = Date.now();
  const submit = () => {
    if (!canSub) return;
    const sale = { id: Date.now(), clientId: client.id, clientName: client.name, contractNo: client.contractNo, date, pts: +pts, stype, eYr: +eYr || 0, eAn: +eAn || 0, totalCost, pm: pm?.name || "", costPct: pm?.costPct || 0, note, submittedBy: cu.username, submittedAt: new Date().toISOString(), expiresAt: new Date(now + 48 * 3600000).toISOString(), status: "Pendiente" };
    setPendingSales(ps => [...ps, sale]); setOk({ name: client.name, pts: +pts, cost: totalCost, id: sale.id }); setPts(""); setNote(""); setSid(null); setEYr(0); setEAn(0); setShowSim(false);
  };
  const validate = id => {
    const sale = pendingSales.find(s => s.id === id); if (!sale) return;
    const p = { id: Date.now(), clientId: sale.clientId, clientName: sale.clientName, contractNo: sale.contractNo, date: sale.date, amount: sale.totalCost, points: sale.pts, method: sale.pm, costPct: sale.costPct, note: `[Venta pts validada] ${sale.note}`, status: "Liquidado", processedBy: sale.submittedBy, processedByCajero: cu.username, type: "point_sale", agentCommission: sale.totalCost * 0.02 };
    setPayments(ps => [...ps, p]);
    setClients(cs => cs.map(c => { if (c.id !== sale.clientId) return c; if (sale.stype === "immediate") { const a2 = c.annualPoints + sale.pts, p2 = c.paidPoints + sale.pts; return { ...c, totalPoints: c.totalPoints + sale.pts, annualPoints: a2, paidPoints: p2, balance: Math.max(0, (a2 - p2) * pp) }; } const nT = c.totalPoints + sale.pts, nCY = (c.contractYears || yr) + sale.eYr, nYR = Math.max(1, nCY - (c.yearsElapsed || 0)); const rA = sale.eAn > 0 ? c.annualPoints + sale.eAn : calcAP(nT, c.pointsUsedToDate || 0, nYR); return { ...c, totalPoints: nT, contractYears: nCY, yearsRemaining: nYR, annualPoints: rA, balance: Math.max(0, (rA - (c.paidPoints || 0)) * pp) }; }));
    setPendingSales(ps => ps.map(s => s.id === id ? { ...s, status: "Validada", validatedBy: cu.username } : s));
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
              {[["Pts", s.pts.toLocaleString(), P], ["Tipo", s.stype, T3], ["Total", f$(s.totalCost), G]].map(([l, v, c]) => (<div key={l}><div style={{ fontSize: 8, color: T4, textTransform: "uppercase" }}>{l}</div><div style={{ color: c, fontWeight: 700 }}>{v}</div></div>))}
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
          {[stype === "immediate" ? ["Pts+Mant.", f$(totalCost), P] : ["Costo pts", f$(ptsCost), P], stype === "immediate" ? ["(mant.)", f$(maint), Y] : ["Pts/año resul.", fA.toLocaleString(), aOk ? G : R], ["Costo tx", f$(txC), Y]].map(([l, v, c]) => (<div key={l}><div style={{ fontSize: 8, color: T4, textTransform: "uppercase" }}>{l}</div><div style={{ color: c, fontWeight: 700, fontSize: 11 }}>{v}</div></div>))}
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
function ReportsView({ clients, reservations, payments, pp, users, role, courtesies, rc }) {
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
  const en = clients.map(c => { const d = dOvr(c.dueDate); const cl = cDelEx(c.balance, d); return { ...c, dOvr: d, cls: cl, interest: cInt(c.balance, d, cl.r * 12) }; });
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
        <td style={tPs()}>{c.assignedGestor || "—"}</td>
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
        <Kpi label="Comisiones YTD" value={f$(commAll)} accent={G} />
        <Kpi label="Costo Financiero" value={f$(txCost)} accent={Y} />
      </div>
      <Tbl cols={["Empleado", "Rol", "Sueldo", "Costo Tx", "Comm Cobros", "Comm Res", "Total", "Ingresos", "Ratio"]}
        rows={staff.map(u => {
          const uP = filteredPayments.filter(p => p.processedBy === u.username); const uR = filteredReservations.filter(r => r.processedBy === u.username); const txC2 = uP.reduce((a, p) => a + p.amount * (p.costPct || 0) / 100, 0); const cC = uP.reduce((a, p) => a + p.amount * (0), 0); const cR = uR.length * rc; const tot = (u.salary || 0) + txC2 + cC + cR; const rev = uP.reduce((a, p) => a + p.amount, 0); const ratio = rev > 0 ? tot / rev : 0; return (<tr key={u.id} style={{ borderBottom: `1px solid ${BG3}` }}>
            <td style={td()}><div style={{ display: "flex", alignItems: "center", gap: 6 }}><div style={{ width: 18, height: 18, borderRadius: 5, background: u.color + "20", border: `1px solid ${u.color}33`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: u.color, fontWeight: 700 }}>{u.name[0]}</div><span style={{ color: T1, fontWeight: 600, fontSize: 11 }}>{u.name}</span></div></td>
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
        <Kpi label="Nómina Mensual" value={f$(salaryAll)} sub={colTotal > 0 ? ((salaryAll / colTotal) * 100).toFixed(1) + "%" : ""} accent={B} />
        <Kpi label="Costo Total" value={f$(txCost + commAll + salaryAll)} sub={colTotal > 0 ? (((txCost + commAll + salaryAll) / colTotal) * 100).toFixed(1) + "% de ingresos" : ""} accent={R} warn />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 13 }}>
        <div style={{ background: BG2, border: `1px solid ${BD}`, borderRadius: 10, padding: 15 }}>
          <Sec t="Composición del Costo (% sobre ingresos)" />
          {(() => {
            const total = txCost + commAll + salaryAll; return [["Costo financiero (medios)", txCost, Y], ["Comisiones cobros+reservas", commAll, G], ["Nómina base", salaryAll, B]].map(([l, v, c]) => {
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
          <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", marginTop: 4 }}><span style={{ color: T1, fontWeight: 700 }}>TOTAL</span><div style={{ textAlign: "right" }}><div style={{ color: R, fontWeight: 800, fontSize: 14 }}>{f$(txCost + commAll + salaryAll)}</div>{colTotal > 0 && <div style={{ color: R, fontSize: 10 }}>{(((txCost + commAll + salaryAll) / colTotal) * 100).toFixed(1)}% de ingresos</div>}</div></div>
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
              const d = dOvr(c.dueDate); const cl = cDelEx(c.balance, d); return (<tr key={c.id} style={{ borderBottom: `1px solid ${BG3}` }}>
                <td style={tBs()}>{c.contractNo}</td>
                <td style={tW()}>{c.name}</td>
                <td style={tG()}>{fP(c.paidPoints)}</td>
                <td style={tBs()}>{fP(c.usedP)}</td>
                <td style={tP()}>{c.savedA > 0 ? fP(c.savedA) : "—"}</td>
                <td style={{ ...td(), color: G, fontWeight: 700, fontSize: 13 }}>{fP(c.avail)}</td>
                <td style={tPs()}>{c.assignedGestor || "—"}</td>
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
function ConfigView({ seasonOrder, setSeasonOrder, uts, setUts, units, setUnits, pp, setPp }) {
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
      {[["tarifa", "Tarifa"], ["orden", "Orden Temporadas"], ["tipos", "Tipos Unidad"], ["unidades", "Inventario / Temporadas"]].map(([id, l]) => (
        <button key={id} onClick={() => setSec(id)} style={{ background: sec === id ? IND : BG2, color: sec === id ? "#fff" : T4, border: `1px solid ${sec === id ? IND : BD}`, borderRadius: 7, padding: "5px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{l}</button>
      ))}
    </div>
    {sec === "tarifa" && <div style={{ maxWidth: 400 }}><div style={{ background: BG2, border: `1px solid ${BD}`, borderRadius: 11, padding: 18 }}>
      <Sec t="Precio Mantenimiento por Punto" />
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
        <div style={{ flex: 1 }}><Inp label="Precio ($/pt/año)" value={pp} onChange={v => setPp(+v)} type="number" /></div>
        <div style={{ color: B, fontWeight: 800, fontSize: 22 }}>{f$(pp)}</div>
      </div>
      <div style={{ marginTop: 10, padding: "8px 9px", background: BG3, borderRadius: 6, fontSize: 10, color: T4 }}>Ejemplo 5,000 pts → <b style={{ color: T1 }}>{f$(5000 * pp)}</b></div>
    </div></div>}
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
      {editUT && <Modal title="Editar Tipo" onClose={() => setEditUT(null)}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div style={{ gridColumn: "1/-1" }}><Inp label="Nombre" value={editUT.name} onChange={v => setEditUT(u => ({ ...u, name: v }))} /></div>
          <Inp label="Pts base/noche" value={editUT.basePts} onChange={v => setEditUT(u => ({ ...u, basePts: +v }))} type="number" />
          <Inp label="Estado" value={editUT.active ? "si" : "no"} onChange={v => setEditUT(u => ({ ...u, active: v === "si" }))} opts={[{ v: "si", l: "Activo" }, { v: "no", l: "Inactivo" }]} />
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}><Btn label="Cancelar" variant="ghost" onClick={() => setEditUT(null)} /><Btn label="Guardar" onClick={() => { setUts(us => us.map(x => x.id === editUT.id ? editUT : x)); setEditUT(null); }} /></div>
      </Modal>}
      <Tbl cols={["Tipo", "Pts Base/noche", "Estado", ""]} rows={uts.map(ut => (<tr key={ut.id} style={{ borderBottom: `1px solid ${BG3}` }}>
        <td style={tW()}>{ut.name}</td>
        <td style={tBb()}>{ut.basePts} pts</td>
        <td style={td()}><Bdg l={ut.active ? "Active" : "Cancelado"} /></td>
        <td style={td()}><Btn label="Editar" variant="ghost" small onClick={() => setEditUT({ ...ut })} /></td>
      </tr>))} />
    </div>}
    {sec === "unidades" && <div>
      {editU && <Modal title={editU.id === "new" ? "Nueva Unidad" : `Editar: ${editU.name}`} onClose={() => setEditU(null)} wide>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 14 }}>
          <Inp label="Nombre de unidad" value={editU.name} onChange={v => setEditU(u => ({ ...u, name: v }))} />
          <Inp label="Tipo" value={editU.typeId} onChange={v => setEditU(u => ({ ...u, typeId: +v }))} opts={uts.map(t => ({ v: t.id, l: t.name }))} />
          <Inp label="Ubicación (texto libre)" value={editU.location || ""} onChange={v => setEditU(u => ({ ...u, location: v }))} />
        </div>
        <div style={{ fontSize: 9, color: T4, textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 10 }}>Temporadas · Rangos de fechas y costos por noche</div>
        {editU.seasons.map(s => {
          const meta = SEASON_META.find(m => m.id === s.id); return (<div key={s.id} style={{ background: BG3, border: `1px solid ${meta.color}33`, borderRadius: 8, padding: "12px 14px", marginBottom: 10, borderLeft: `3px solid ${meta.color}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 9 }}>
              <span style={{ color: meta.color, fontWeight: 700, fontSize: 13 }}>{meta.name}</span>
              <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
                <div><label style={{ fontSize: 8, color: T4, textTransform: "uppercase" }}>Dom–Jue pts/noche</label><input type="number" value={s.ptsWd} onChange={e => updSeasonPts(s.id, "ptsWd", +e.target.value)} style={{ ...IS, width: 80, marginTop: 2 }} /></div>
                <div><label style={{ fontSize: 8, color: T4, textTransform: "uppercase" }}>Vie–Sáb pts/noche</label><input type="number" value={s.ptsWe} onChange={e => updSeasonPts(s.id, "ptsWe", +e.target.value)} style={{ ...IS, width: 80, marginTop: 2 }} /></div>
              </div>
            </div>
            <div style={{ fontSize: 9, color: T4, marginBottom: 5, textTransform: "uppercase" }}>Rangos de fechas</div>
            {(s.ranges || []).map((r, i) => (<div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr auto", gap: 5, marginBottom: 4, alignItems: "center" }}>
              <select value={r.startMonth} onChange={e => updRange(s.id, i, "startMonth", +e.target.value)} style={{ ...IS, fontSize: 11, padding: "4px 7px" }}>{mO.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
              <select value={r.startDay} onChange={e => updRange(s.id, i, "startDay", +e.target.value)} style={{ ...IS, fontSize: 11, padding: "4px 7px" }}>{dO.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
              <select value={r.endMonth} onChange={e => updRange(s.id, i, "endMonth", +e.target.value)} style={{ ...IS, fontSize: 11, padding: "4px 7px" }}>{mO.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
              <select value={r.endDay} onChange={e => updRange(s.id, i, "endDay", +e.target.value)} style={{ ...IS, fontSize: 11, padding: "4px 7px" }}>{dO.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
              <Btn label="✕" variant="danger" small onClick={() => delRange(s.id, i)} />
            </div>))}
            <Btn label="+ Agregar rango" variant="ghost" small onClick={() => addRange(s.id)} />
          </div>);
        })}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
          <Btn label="Cancelar" variant="ghost" onClick={() => setEditU(null)} />
          <Btn label="Guardar" onClick={() => { if (editU.id === "new") setUnits(us => [...us, { ...editU, id: Date.now() }]); else setUnits(us => us.map(x => x.id === editU.id ? editU : x)); setEditU(null); }} />
        </div>
      </Modal>}
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}><Btn label="+ Nueva Unidad" onClick={() => setEditU(emptyUnit())} /></div>
      <Tbl cols={["Unidad", "Tipo", "Ubicación", "Temporadas", "Occ.", "Estado", ""]} rows={units.map(u => {
        const ut = uts.find(t => t.id === u.typeId); return (<tr key={u.id} style={{ borderBottom: `1px solid ${BG3}`, opacity: u.active ? 1 : .4 }}>
          <td style={tW()}>{u.name}</td>
          <td style={tG3()}>{ut?.name}</td>
          <td style={tG3()}>{u.location || "—"}</td>
          <td style={tS()}>{(u.seasons || []).map(s => { const m = SEASON_META.find(x => x.id === s.id); return (<span key={s.id} style={{ color: m?.color || T3, marginRight: 5 }}>{m?.name}:{s.ptsWd}/{s.ptsWe}</span>); })}</td>
          <td style={tBs()}>{(u.occ || []).length} res.</td>
          <td style={td()}><Bdg l={u.active ? "Active" : "Cancelado"} /></td>
          <td style={tFl()}><Btn label="Editar" variant="ghost" small onClick={() => setEditU({ ...u, seasons: [...(u.seasons || []).map(s => ({ ...s, ranges: [...(s.ranges || [])] }))] })} /><Btn label={u.active ? "Baja" : "Activar"} variant={u.active ? "danger" : "success"} small onClick={() => setUnits(us => us.map(x => x.id === u.id ? { ...x, active: !x.active } : x))} /></td>
        </tr>);
      })} />
    </div>}
  </div>);
}
// ── PAYMENT METHODS ──────────────────────────────────────────────────────────
function PayMethodsView({ pms, setPms }) {
  const [modal, setModal] = useState(null), [form, setForm] = useState({});
  const setF = k => v => setForm(f => ({ ...f, [k]: v }));
  const save = () => { if (modal === "new") setPms(ms => [...ms, { ...form, id: Date.now(), costPct: +(form.costPct || 0), active: true }]); else setPms(ms => ms.map(m => m.id === modal.id ? { ...m, ...form, costPct: +(form.costPct || 0) } : m)); setModal(null); };
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
      <td style={tFl()}><Btn label="Editar" variant="ghost" small onClick={() => { setForm({ ...m }); setModal(m); }} /><Btn label={m.active ? "Desact." : "Activar"} variant={m.active ? "danger" : "success"} small onClick={() => setPms(ms => ms.map(x => x.id === m.id ? { ...x, active: !x.active } : x))} /></td>
    </tr>))} />
  </div>);
}
// ── COMPENSATION ─────────────────────────────────────────────────────────────
function CompView({ users, setUsers, payments, reservations, pp, rc, setRc, cr, setCr }) {
  const [editId, setEditId] = useState(null), [form, setForm] = useState({}), [ctab, setCtab] = useState("personal");
  const setF = k => v => setForm(f => ({ ...f, [k]: v }));
  const staff = users.filter(u => u.role !== "superadmin");
  const save = () => { setUsers(us => us.map(u => u.id === editId ? { ...u, salary: +(form.salary || 0) } : u)); setEditId(null); };
  return (<div>
    {editId && <Modal title="Editar Compensación" onClose={() => setEditId(null)}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}><Inp label="Sueldo mensual ($)" value={form.salary || 0} onChange={v => setF("salary")(+v)} type="number" /></div><div style={{ background: P + "12", borderRadius: 6, padding: "7px 9px", marginTop: 8, fontSize: 10, color: T3 }}>Las comisiones por cobro se configuran <b style={{ color: P }}>por concepto</b>, no por persona. Ve a la pestaña "Por Concepto".</div>
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
        <Kpi label="Comisiones Cobros" value={f$(staff.reduce((a, u) => a + payments.filter(p => p.processedBy === u.username).reduce((b, p) => b + p.amount * (0), 0), 0))} accent={G} />
        <Kpi label="Comisiones Reservas" value={f$(reservations.filter(r => r.status === "Confirmed").length * rc)} accent={P} />
      </div>
      <Tbl cols={["Empleado", "Rol", "Sueldo", "% Cobro", "Comm Cobros", "Comm Res", "Total Est.", ""]}
        rows={staff.map(u => {
          const cP = payments.filter(p => p.processedBy === u.username).reduce((a, p) => a + p.amount * (0), 0); const cR = reservations.filter(r => r.processedBy === u.username && r.status === "Confirmed").length * rc; const tot = (u.salary || 0) + cP + cR; return (<tr key={u.id} style={{ borderBottom: `1px solid ${BG3}` }}>
            <td style={td()}><div style={{ display: "flex", alignItems: "center", gap: 6 }}><div style={{ width: 18, height: 18, borderRadius: 5, background: u.color + "20", border: `1px solid ${u.color}33`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: u.color, fontWeight: 700 }}>{u.name[0]}</div><span style={{ color: T1, fontWeight: 600, fontSize: 11 }}>{u.name}</span></div></td>
            <td style={td()}><RBdg r={u.role} /></td>
            <td style={td({ color: B })}>{f$(u.salary || 0)}</td>
            <td style={tG()}>{((0) * 100).toFixed(1)}%</td>
            <td style={tG()}>{f$(cP)}</td>
            <td style={tP()}>{f$(cR)}</td>
            <td style={td({ color: T1, fontWeight: 700, fontSize: 13 })}>{f$(tot)}</td>
            <td style={td()}><Btn label="Editar" variant="ghost" small onClick={() => { setForm({ salary: u.salary || 0 }); setEditId(u.id); }} /></td>
          </tr>);
        })} />
    </div>}
    {ctab === "reservacion" && <div style={{ maxWidth: 420 }}><div style={{ background: BG2, border: `1px solid ${BD}`, borderRadius: 11, padding: 18 }}>
      <Sec t="Comisión Fija por Reservación" />
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}><div style={{ flex: 1 }}><Inp label="Comisión por reservación ($)" value={rc} onChange={v => setRc(+v)} type="number" /></div><div style={{ color: P, fontWeight: 800, fontSize: 22 }}>{f$(rc)}</div></div>
    </div></div>}
    {ctab === "concepto" && <div>
      <div style={{ fontSize: 11, color: T3, marginBottom: 13 }}>Comisión por tipo de cobro, independiente del gestor. Se suma a la comisión personal.</div>
      <Tbl cols={["Concepto", "Comisión (%)", "Activo", ""]}
        rows={cr.map(r => (<tr key={r.id} style={{ borderBottom: `1px solid ${BG3}` }}>
          <td style={tW()}>{r.l}</td>
          <td style={td()}><div style={{ display: "flex", alignItems: "center", gap: 7 }}><input type="number" value={r.pct} step="0.1" onChange={e => setCr(rs => rs.map(x => x.id === r.id ? { ...x, pct: +e.target.value } : x))} style={{ ...IS, width: 75, padding: "4px 7px", fontSize: 11 }} /><span style={{ color: Y, fontWeight: 700 }}>{r.pct}%</span></div></td>
          <td style={td()}><Bdg l={r.active ? "Active" : "Cancelado"} /></td>
          <td style={td()}><Btn label={r.active ? "Desact." : "Activar"} variant={r.active ? "danger" : "success"} small onClick={() => setCr(rs => rs.map(x => x.id === r.id ? { ...x, active: !x.active } : x))} /></td>
        </tr>))} />
    </div>}
  </div>);
}
// ── USERS / TEAM / CONTRACTS / COURTESIES ────────────────────────────────────
function UsersView({ cu, users, setUsers, rc }) {
  const [modal, setModal] = useState(null), [form, setForm] = useState({});
  const setF = k => v => setForm(f => ({ ...f, [k]: v }));
  const pD = { superadmin: "Todo", admin: "Config+Reportes+Equipo+Contratos", cajero: "Caja", gestor: "Cobranzas+Reservaciones+Venta Pts" };
  const save = () => { if (modal === "new") setUsers(us => [...us, { ...form, id: Date.now(), active: true, salary: +(form.salary || 0), commissions: { collection: 0 } }]); else setUsers(us => us.map(u => u.id === modal.id ? { ...u, ...form, salary: +(form.salary || 0) } : u)); setModal(null); };
  return (<div>
    {modal && <Modal title={modal === "new" ? "Nuevo Usuario" : "Editar Usuario"} onClose={() => setModal(null)}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div style={{ gridColumn: "1/-1" }}><Inp label="Nombre completo" value={form.name || ""} onChange={setF("name")} /></div>
        <Inp label="Usuario" value={form.username || ""} onChange={setF("username")} />
        <Inp label="Contraseña" value={form.password || ""} onChange={setF("password")} />
        <Inp label="Rol" value={form.role || "gestor"} onChange={setF("role")} opts={Object.keys(RM).map(r => ({ v: r, l: RM[r].l }))} />
        <Inp label="Color (hex)" value={form.color || P} onChange={setF("color")} />
        <Inp label="Sueldo mensual ($)" value={form.salary || 0} onChange={v => setF("salary")(+v)} type="number" />
      </div>
      <div style={{ background: BG3, borderRadius: 6, padding: "7px 9px", marginTop: 9, fontSize: 10, color: T4 }}><b style={{ color: T1 }}>Permisos: </b>{pD[form.role || "gestor"]}</div>
      <div style={{ background: P + "12", borderRadius: 6, padding: "7px 9px", marginTop: 6, fontSize: 10, color: T3 }}>Las comisiones se configuran <b style={{ color: P }}>por concepto</b> de cobro (Sueldos → Por Concepto).</div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}><Btn label="Cancelar" variant="ghost" onClick={() => setModal(null)} /><Btn label="Guardar" onClick={save} /></div>
    </Modal>}
    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}><Btn label="+ Nuevo Usuario" onClick={() => { setForm({ username: "", password: "", name: "", role: "gestor", color: P, salary: 0 }); setModal("new"); }} /></div>
    <Tbl cols={["Usuario", "Nombre", "Rol", "Sueldo", "Activo", ""]} rows={users.map(u => (<tr key={u.id} style={{ borderBottom: `1px solid ${BG3}`, opacity: u.active === false ? .4 : 1 }}>
      <td style={td()}><div style={{ display: "flex", alignItems: "center", gap: 6 }}><div style={{ width: 20, height: 20, borderRadius: 5, background: u.color + "20", border: `1px solid ${u.color}33`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: u.color, fontWeight: 700 }}>{u.username[0].toUpperCase()}</div><span style={{ color: T1, fontWeight: 600 }}>{u.username}</span>{u.id === cu.id && <span style={{ fontSize: 8, color: T4, border: `1px solid ${BD}`, borderRadius: 4, padding: "1px 4px" }}>tú</span>}</div></td>
      <td style={tG3()}>{u.name}</td>
      <td style={td()}><RBdg r={u.role} /></td>
      <td style={tT2()}>{f$(u.salary || 0)}</td>
      <td style={td()}><Bdg l={u.active === false ? "Cancelado" : "Active"} /></td>
      <td style={tFl()}><Btn label="Editar" variant="ghost" small onClick={() => { setForm({ ...u }); setModal(u); }} />{u.id !== cu.id && <Btn label={u.active === false ? "Activar" : "Baja"} variant={u.active === false ? "success" : "danger"} small onClick={() => setUsers(us => us.map(x => x.id === u.id ? { ...x, active: !x.active } : x))} />}</td>
    </tr>))} />
  </div>);
}
function TeamView({ users, setUsers, clients, setClients, payments, reservations }) {
  const [ttab, setTtab] = useState("list"), [modal, setModal] = useState(null), [form, setForm] = useState({}), [agt, setAgt] = useState(""), [selC, setSelC] = useState([]);
  const setF = k => v => setForm(f => ({ ...f, [k]: v }));
  const gestors = users.filter(u => u.role === "gestor");
  const save = () => { if (modal === "new") setUsers(us => [...us, { ...form, id: Date.now(), role: "gestor", active: true, commissions: { collection: 0 }, salary: +(form.salary || 0) }]); else setUsers(us => us.map(u => u.id === modal.id ? { ...u, ...form, salary: +(form.salary || 0) } : u)); setModal(null); };
  const doAssign = () => { if (!agt || !selC.length) return; setClients(cs => cs.map(c => selC.includes(c.id) ? { ...c, assignedGestor: agt } : c)); setSelC([]); setAgt(""); };
  return (<div>
    {modal && <Modal title={modal === "new" ? "Nuevo Gestor" : "Editar Gestor"} onClose={() => setModal(null)}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}><div style={{ gridColumn: "1/-1" }}><Inp label="Nombre completo" value={form.name || ""} onChange={setF("name")} /></div><Inp label="Usuario" value={form.username || ""} onChange={setF("username")} /><Inp label="Contraseña" value={form.password || ""} onChange={setF("password")} /><Inp label="Sueldo mensual ($)" value={form.salary || 0} onChange={v => setF("salary")(+v)} type="number" /><Inp label="Color" value={form.color || P} onChange={setF("color")} /></div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}><Btn label="Cancelar" variant="ghost" onClick={() => setModal(null)} /><Btn label="Guardar" onClick={save} /></div>
    </Modal>}
    <div style={{ display: "flex", gap: 5, marginBottom: 14 }}>
      {[["list", "Gestores"], ["assign", "Asignación Cuentas"]].map(([id, l]) => (
        <button key={id} onClick={() => setTtab(id)} style={{ background: ttab === id ? IND : BG2, color: ttab === id ? "#fff" : T4, border: `1px solid ${ttab === id ? IND : BD}`, borderRadius: 7, padding: "5px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{l}</button>
      ))}
    </div>
    {ttab === "list" && <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}><Btn label="+ Nuevo Gestor" onClick={() => { setForm({ username: "", password: "", name: "", color: P, salary: 0 }); setModal("new"); }} /></div>
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
        <div style={{ marginBottom: 9 }}><Inp label="Gestor destino" value={agt} onChange={setAgt} opts={[{ v: "", l: "— Seleccionar —" }, ...gestors.filter(g => g.active !== false).map(g => ({ v: g.username, l: g.name }))]} /></div>
        <div style={{ fontSize: 9, color: T4, textTransform: "uppercase", marginBottom: 5 }}>Seleccionar clientes</div>
        <div style={{ maxHeight: 280, overflowY: "auto" }}>
          {clients.map(c => (<div key={c.id} onClick={() => setSelC(s => s.includes(c.id) ? s.filter(x => x !== c.id) : [...s, c.id])} style={{ padding: "6px 9px", borderBottom: `1px solid ${BG3}`, cursor: "pointer", background: selC.includes(c.id) ? B + "20" : "transparent", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div><span style={{ color: T1, fontSize: 12, fontWeight: selC.includes(c.id) ? 700 : 400 }}>{c.name}</span><span style={{ color: T4, fontSize: 9, marginLeft: 7 }}>{c.contractNo}</span></div>
            <span style={{ color: P, fontSize: 9 }}>{c.assignedGestor || "sin asignar"}</span>
          </div>))}
        </div>
        <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 10, color: T3 }}>{selC.length} seleccionados</span>
          <Btn label="Asignar" onClick={doAssign} disabled={!agt || !selC.length} />
        </div>
      </div>
      <div style={{ background: BG2, border: `1px solid ${BD}`, borderRadius: 11, padding: 16 }}>
        <Sec t="Cuentas por Gestor" />
        {gestors.map(g => {
          const gC = clients.filter(c => c.assignedGestor === g.username); return (<div key={g.id} style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}><span style={{ color: g.color, fontWeight: 700, fontSize: 12 }}>{g.name}</span><span style={{ color: T4, fontSize: 10 }}>{gC.length} cuentas</span></div>
            {gC.map(c => (<div key={c.id} style={{ padding: "4px 7px", background: BG3, borderRadius: 4, marginBottom: 2, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ color: T2, fontSize: 11 }}>{c.name}</span>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}><span style={{ color: c.balance > 0 ? R : G, fontSize: 10 }}>{f$(c.balance)}</span><Btn label="Quitar" variant="danger" small onClick={() => setClients(cs => cs.map(x => x.id === c.id ? { ...x, assignedGestor: "" } : x))} /></div>
            </div>))}
            {gC.length === 0 && <div style={{ fontSize: 10, color: T4, padding: "4px 0" }}>Sin cuentas</div>}
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
        <td style={td()}>{c.contractStatus === "Active" ? <Btn label="Cancelar" variant="danger" small onClick={() => setModal(c)} /> : <Btn label="Reactivar" variant="success" small onClick={() => setClients(cs => cs.map(x => x.id === c.id ? { ...x, contractStatus: "Active", cancelReason: "", cancelDate: "" } : x))} />}</td>
      </tr>))} />
  </div>);
}
function CourtesiesView({ clients, setClients, courtesies, setCourtesies, pp, cu }) {
  const [modal, setModal] = useState(false), [sid, setSid] = useState(null), [ctype, setCtype] = useState("points"), [amt, setAmt] = useState(""), [reason, setReason] = useState(""), [cat, setCat] = useState("Fidelización"), [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const cats = ["Fidelización", "Error operativo", "Campaña comercial", "Compensación", "Acuerdo especial", "Otro"];
  const client = clients.find(c => c.id === sid);
  const doAdd = () => {
    if (!client || !reason || !amt) return;
    const c = { id: Date.now(), clientId: client.id, clientName: client.name, contractNo: client.contractNo, date, type: ctype, amount: +amt, reason, category: cat, grantedBy: cu.username };
    setCourtesies(cs => [...cs, c]);
    if (ctype === "points") setClients(cs => cs.map(x => x.id === client.id ? { ...x, paidPoints: x.paidPoints + (+amt) } : x));
    else if (ctype === "balance_reduction") setClients(cs => cs.map(x => x.id === client.id ? { ...x, balance: Math.max(0, x.balance - (+amt)) } : x));
    setModal(false); setSid(null); setAmt(""); setReason("");
  };
  return (<div>
    {modal && <Modal title="Nueva Cortesía" onClose={() => setModal(false)}>
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        <SearchBox clients={clients.filter(c => c.contractStatus === "Active")} onSelect={setSid} selectedId={sid} />
        <Inp label="Tipo" value={ctype} onChange={setCtype} opts={[{ v: "points", l: "Puntos gratuitos" }, { v: "balance_reduction", l: "Reducción de saldo" }, { v: "free_reservation", l: "Reservación gratuita" }]} />
        <Inp label="Cantidad (pts o $)" value={amt} onChange={setAmt} type="number" />
        <Inp label="Categoría" value={cat} onChange={setCat} opts={cats} />
        <Inp label="Motivo detallado (obligatorio)" value={reason} onChange={setReason} />
        <Inp label="Fecha" value={date} onChange={setDate} type="date" />
      </div>
      {!reason && <div style={{ color: Y, fontSize: 10, marginTop: 4 }}>⚠ El motivo es obligatorio.</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}><Btn label="Cancelar" variant="ghost" onClick={() => setModal(false)} /><Btn label="Registrar Cortesía" variant="purple" disabled={!client || !reason || !amt} onClick={doAdd} /></div>
    </Modal>}
    <div style={{ display: "flex", gap: 9, flexWrap: "wrap", marginBottom: 13 }}>
      <Kpi label="Cortesías Registradas" value={courtesies.length} accent={P} />
      <Kpi label="Valor Total" value={f$(courtesies.reduce((a, c) => c.type === "balance_reduction" ? a + c.amount : c.type === "points" ? a + c.amount * pp : a + 500, 0))} accent={O} warn={courtesies.length > 0} />
    </div>
    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}><Btn label="+ Nueva Cortesía" variant="purple" onClick={() => setModal(true)} /></div>
    <Tbl cols={["Fecha", "Contrato", "Cliente", "Tipo", "Cantidad", "Categoría", "Motivo", "Otorgado por"]}
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
  </div>);
}
// ── DASHBOARD ────────────────────────────────────────────────────────────────
function Dashboard({ clients, reservations, payments, pp, promises, users }) {
  const collT = payments.filter(p => p.date === TOD).reduce((a, p) => a + p.amount, 0);
  const collM = payments.filter(p => p.date && p.date.slice(0, 7) === TOM).reduce((a, p) => a + p.amount, 0);
  const promT = promises.filter(p => p.promiseDate === TOD && p.status === "Pendiente");
  const promM = promises.filter(p => p.promiseDate && p.promiseDate.slice(0, 7) === TOM && p.status === "Pendiente");
  const mPmts = payments.filter(p => p.date && p.date.slice(0, 7) === TOM);
  const txM = mPmts.reduce((a, p) => a + p.amount * (p.costPct || 0) / 100, 0);
  const commM = mPmts.reduce((a, p) => a + (p.agentCommission || 0), 0);
  const salM = users.filter(u => ["gestor", "cajero", "admin"].includes(u.role)).reduce((a, u) => a + (u.salary || 0), 0);
  const costPct = collM > 0 ? (((txM + commM + salM) / collM) * 100).toFixed(1) : "0.0";
  const en = clients.map(c => { const d = dOvr(c.dueDate); const cl = cDelEx(c.balance, d); return { ...c, d, cls: cl, int: cInt(c.balance, d, cl.r * 12) }; });
  return (<div>
    <div style={{ display: "flex", gap: 9, flexWrap: "wrap", marginBottom: 18 }}>
      <Kpi label="Cobrado Hoy" value={f$(collT)} accent={G} />
      <Kpi label="Cobrado este Mes" value={f$(collM)} accent={B} />
      <Kpi label="Promesas Hoy" value={promT.length} sub={f$(promT.reduce((a, p) => a + p.amount, 0))} accent={Y} warn={promT.length > 0} />
      <Kpi label="Promesas Resto Mes" value={promM.length} sub={f$(promM.reduce((a, p) => a + p.amount, 0))} accent={P} />
      <Kpi label="Costo Cobranza Mes" value={costPct + "%"} sub={`${f$(txM + commM + salM)} / ${f$(collM)}`} accent={O} warn={parseFloat(costPct) > 25} />
      <Kpi label="Saldo Pendiente" value={f$(clients.reduce((a, c) => a + c.balance, 0))} accent={R} />
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 13 }}>
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
      <div style={{ background: BG2, border: `1px solid ${BD}`, borderRadius: 10, padding: 15 }}>
        <Sec t="Próximas Reservaciones" />
        {reservations.filter(r => r.status === "Confirmed").slice(0, 5).map(r => (<div key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 0", borderBottom: `1px solid ${BG3}` }}>
          <div><div style={{ color: T1, fontSize: 11, fontWeight: 600 }}>{r.clientName}</div><div style={{ color: T4, fontSize: 9 }}>{r.unitName}·{r.locationName}·{r.checkIn}</div></div>
          <Bdg l={r.status} />
        </div>))}
        {reservations.filter(r => r.status === "Confirmed").length === 0 && <div style={{ color: T4, fontSize: 11, textAlign: "center", padding: "14px 0" }}>Sin reservaciones</div>}
      </div>
      <div style={{ background: BG2, border: `1px solid ${BD}`, borderRadius: 10, padding: 15 }}>
        <Sec t="Pagos Recientes" />
        {[...payments].reverse().slice(0, 5).map(p => (<div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 0", borderBottom: `1px solid ${BG3}` }}>
          <div><div style={{ color: T1, fontSize: 11, fontWeight: 600 }}>{p.clientName}</div><div style={{ color: T4, fontSize: 9 }}>{p.date}·{p.method}·{p.processedBy}</div></div>
          <span style={{ color: G, fontWeight: 700, fontSize: 11 }}>{f$(p.amount)}</span>
        </div>))}
        {payments.length === 0 && <div style={{ color: T4, fontSize: 11, textAlign: "center", padding: "14px 0" }}>Sin pagos</div>}
      </div>
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
  const [cr, setCr] = useState(INIT_CR);
  const [promises, setPromises] = useState([]);
  const [pendingSales, setPendingSales] = useState([]);
  const [pendingPayments, setPendingPayments] = useState([]);
  const [preselClient, setPreselClient] = useState(null);
  const [preselResClient, setPreselResClient] = useState(null);
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

      // Calcular occ en units desde reservaciones
      const unitsWithOcc = dbUnits.map(u => ({
        ...u,
        occ: dbReservations
          .filter(r => r.unitId === u.id && r.status === 'Confirmed')
          .map(r => ({ ci: r.checkIn, co: r.checkOut }))
      }));

      if (dbClients.length > 0) setClients(dbClients);
      else setClients(INIT_C); // fallback a datos demo si DB vacía

      if (dbPayments.length > 0) setPayments(dbPayments);
      if (dbReservations.length > 0) setReservations(dbReservations);
      if (unitsWithOcc.length > 0) setUnits(unitsWithOcc);
      else setUnits(INIT_UNITS);

      setFxRate(dbFxRate);
      if (dbPms.length > 0) setPms(dbPms);
      else setPms(INIT_PM);
      if (dbPromises.length > 0) setPromises(dbPromises);
      if (dbPending.length > 0) setPendingPayments(dbPending);
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
      // Buscar el ID real del usuario en Supabase
      const dbUser = users.find(u => u.username === cu?.username);
      const userId = dbUser?.id && typeof dbUser.id === 'number' && dbUser.id > 100 ? dbUser.id : null;
      const dbPayment = {
        client_id: paymentObj.clientId,
        concept: paymentObj.type || 'maintenance',
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
        processed_by: userId,
        originated_by: userId,
        is_deleted: false,
      };
      await insertPayment(dbPayment);
      // Actualizar cliente en DB
      if (clientUpdates) {
        await updateClient(paymentObj.clientId, {
          paid_points: clientUpdates.paidPoints,
          balance_usd: clientUpdates.balance,
          account_status: clientUpdates.status,
        });
      }
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
      await insertReservation({
        client_id: resObj.clientId,
        unit_id: resObj.unitId,
        season: resObj.season,
        check_in: resObj.checkIn,
        check_out: resObj.checkOut,
        nights: resObj.nights,
        points_used: resObj.pointsUsed,
        status: resObj.status || 'Confirmed',
        processed_by: cu?.id,
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
      const dbPP = {
        client_id: pp2.clientId,
        concept: pp2.ptype === 'prepago_maintenance' ? 'maintenance' : pp2.ptype,
        submitted_by: cu?.id,
        expires_at: new Date(new Date().setHours(23, 59, 59)).toISOString(),
        maint_amount_usd: (pp2.mantAmt || 0) / fx,
        mora_amount_usd: (pp2.moraAmt || 0) / fx,
        maint_discount_usd: (pp2.mantDisc || 0) / fx,
        mora_discount_usd: (pp2.moraDisc || 0) / fx,
        total_usd: (pp2.totalACobrar || 0) / fx,
        note: pp2.note,
        status: 'pending',
        maint_year: pp2.maintYear,
        maint_point_expiry: pp2.maintPointExpiry,
        is_prepago: pp2.isPrepago || false,
      };
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
      await insertPromise({
        client_id: pr.clientId,
        gestor_id: cu?.id,
        promise_date: pr.promiseDate,
        amount_usd: (pr.amount || 0) / fx,
        note: pr.note,
        status: 'pending',
      });
      await loadAll();
    } catch (e) {
      console.error('Error guardando promesa:', e);
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
          {cu.role === "gestor" && <><div style={{ fontSize: 8, color: "#1a3050", marginBottom: 1 }}>Mis cuentas: <b style={{ color: P }}>{clients.filter(c => c.assignedGestor === cu.username).length}</b></div><div style={{ fontSize: 8, color: "#1a3050" }}>Mis reservas: <b style={{ color: P }}>{reservations.filter(r => r.processedBy === cu.username).length}</b></div></>}
          {cu.role === "cajero" && <div style={{ fontSize: 8, color: "#1a3050" }}>Tarifa: <b style={{ color: G }}>{f$(pp)}/pt</b></div>}
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: T2, marginBottom: 15, letterSpacing: ".03em" }}>{active?.l}</div>
        {tab === "dash" && <Dashboard clients={clients} reservations={reservations} payments={payments} pp={pp} promises={promises} users={users} />}
        {tab === "clients" && <ClientsView clients={clients} setClients={setClients} pp={pp} cu={cu} payments={payments} reservations={reservations} onGoToCashier={cid => { setPreselClient(cid); setTab("cashier"); }} onGoToRes={cid => { setPreselResClient(cid); setTab("res"); }} />}
        {tab === "cashier" && <CashierView clients={clients} payments={payments} setPayments={setPayments} setClients={setClients} pp={pp} pms={pms} cu={cu} users={users} pendingPayments={pendingPayments} setPendingPayments={setPendingPayments} promises={promises} setPromises={setPromises} fxRate={fxRate} setFxRate={setFxRate} preselClientId={preselClient} onClearPresel={() => setPreselClient(null)} onSavePayment={savePayment} onSavePending={savePendingPayment} />}
        {tab === "res" && <ReservationsView clients={clients} reservations={reservations} setReservations={setReservations} units={units} setUnits={setUnits} uts={uts} cu={cu} rc={rc} payments={payments} preselClientId={preselResClient} onClearPresel={() => setPreselResClient(null)} onSaveReservation={saveReservation} />}
        {tab === "col" && <CollectionsView clients={clients} payments={payments} pp={pp} promises={promises} setPromises={setPromises} cu={cu} fxRate={fxRate} onSavePromise={savePromise} />}
        {tab === "reports" && <ReportsView clients={clients} reservations={reservations} payments={payments} pp={pp} users={users} role={cu.role} courtesies={courtesies} rc={rc} />}
        {tab === "config" && <ConfigView seasonOrder={seasonOrder} setSeasonOrder={setSeasonOrder} uts={uts} setUts={setUts} units={units} setUnits={setUnits} pp={pp} setPp={setPp} />}
        {tab === "pmethods" && <PayMethodsView pms={pms} setPms={setPms} />}
        {tab === "comp" && <CompView users={users} setUsers={setUsers} payments={payments} reservations={reservations} pp={pp} rc={rc} setRc={setRc} cr={cr} setCr={setCr} />}
        {tab === "users" && <UsersView cu={cu} users={users} setUsers={setUsers} rc={rc} />}
        {tab === "team" && <TeamView users={users} setUsers={setUsers} clients={clients} setClients={setClients} payments={payments} reservations={reservations} />}
        {tab === "contracts" && <ContractsView clients={clients} setClients={setClients} />}
        {tab === "courtesies" && <CourtesiesView clients={clients} setClients={setClients} courtesies={courtesies} setCourtesies={setCourtesies} pp={pp} cu={cu} />}
        {tab === "ps" && <PointSalesView clients={clients} setClients={setClients} payments={payments} setPayments={setPayments} pp={pp} pms={pms} cu={cu} pendingSales={pendingSales} setPendingSales={setPendingSales} />}
      </div>
    </div>
  </div>);
}
