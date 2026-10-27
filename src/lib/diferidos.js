// Calendario de un gasto diferido (ítem 15 de la matriz): amortización lineal en N cuotas
// mensuales desde el mes de inicio. La última cuota absorbe el redondeo, para que la suma sea
// exactamente el monto. Puro: sin Odoo, sin base.
import { sumarMeses } from "./meses.js";

const r2 = x => Math.round((Number(x) || 0) * 100) / 100;

export function calendario({ monto, meses, inicio }) {
  const n = Math.max(1, Math.floor(Number(meses) || 0)), total = r2(monto);
  const cuota = r2(total / n);
  return Array.from({ length: n }, (_, i) => ({ numero: i + 1, mes: sumarMeses(inicio, i), cuota: i === n - 1 ? r2(total - cuota * (n - 1)) : cuota }));
}

// Cuotas vencidas hasta el mes indicado (inclusive) que todavía no se registraron.
// Con hechoHasta (AAAA-MM) se excluyen los meses ya registrados fuera de la app; con hastaBaja, los
// posteriores a la baja del bien.
export function pendientes(d, hasta, aplicados = new Set(), { hechoHasta = null, baja = null } = {}) {
  return calendario(d).filter(c => c.mes <= hasta && !aplicados.has(c.mes) && !(hechoHasta && c.mes <= hechoHasta) && !(baja && c.mes > baja));
}

// Avance: cuántas cuotas van, cuánto se amortizó y el saldo por amortizar.
export function avance(d, aplicados = new Set(), { hechoHasta = null } = {}) {
  const cal = calendario(d), hechas = cal.filter(c => aplicados.has(c.mes) || (hechoHasta && c.mes <= hechoHasta));
  const amortizado = r2(hechas.reduce((t, c) => t + c.cuota, 0));
  return { cuotas: cal.length, registradas: hechas.length, amortizado, saldo: r2(r2(d.monto) - amortizado), fin: cal[cal.length - 1].mes };
}

// Lee un mes en los formatos que salen de una hoja de cálculo: 2026-03, 03/2026, 1/3/2026, 2026-03-15.
export function leerMes(v) {
  const s = String(v ?? "").trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/))) return `${m[1]}-${m[2].padStart(2, "0")}`;
  if ((m = s.match(/^(\d{1,2})[/-](\d{4})$/))) return `${m[2]}-${m[1].padStart(2, "0")}`;
  if ((m = s.match(/^\d{1,2}[/-](\d{1,2})[/-](\d{4})$/))) return `${m[2]}-${m[1].padStart(2, "0")}`;
  return null;
}

// Monto escrito a la costarricense o a la inglesa: 1.250.000,50 · 1,250,000.50 · 1250000.5 · ₡ 1 250 000
export function leerMonto(v) {
  let s = String(v ?? "").replace(/[₡$\s]/g, "").replace(/[^\d.,-]/g, "");
  if (!s) return NaN;
  const miles = sep => new RegExp(`^-?\\d{1,3}(\\${sep}\\d{3})+$`).test(s);   // 1.200.000 · 600.000 · 1,250,000
  const ultimaComa = s.lastIndexOf(","), ultimoPunto = s.lastIndexOf(".");
  if (ultimaComa >= 0 && ultimoPunto >= 0) s = ultimaComa > ultimoPunto ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");   // 1.250.000,50 · 1,250,000.50
  else if (ultimoPunto >= 0) s = miles(".") ? s.replace(/\./g, "") : s;                                                        // 1.200.000 · 1250.50
  else if (ultimaComa >= 0) s = miles(",") ? s.replace(/,/g, "") : s.replace(",", ".");                                          // 1,250,000 · 1250,50
  return Number(s);
}

// CSV con encabezados (separador , ; o tabulador; comillas dobles). Devuelve objetos por fila.
export function leerCSV(texto) {
  const lineas = String(texto || "").replace(/^﻿/, "").split(/\r?\n/).filter(l => l.trim());
  if (!lineas.length) return [];
  const sep = [";", "\t", ","].map(c => [c, lineas[0].split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
  const partir = l => { const out = []; let cur = "", q = false;
    for (let i = 0; i < l.length; i++) { const ch = l[i];
      if (ch === '"') { if (q && l[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (ch === sep && !q) { out.push(cur); cur = ""; } else cur += ch; }
    out.push(cur); return out.map(x => x.trim()); };
  const clave = h => h.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const cab = partir(lineas[0]).map(clave);
  return lineas.slice(1).map((l, i) => Object.fromEntries([["_fila", i + 2], ...partir(l).map((v, j) => [cab[j] || `col${j}`, v])]));
}
