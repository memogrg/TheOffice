// Cierre de mes por cliente: una lista por compañía y mes que junta lo que ya encontraron los
// agentes (última corrida de cada uno) y lo que espera en la cola de la app. No lee Odoo: usa lo
// guardado. Un ítem pendiente se resuelve en su pestaña, o se «da por bueno» con una nota; cuando
// no queda nada pendiente, el mes de esa compañía se marca cerrado (queda la foto de la lista).
import { sumarMeses, mesDe, hoyLocal } from "../lib/meses.js";

const n = x => Number(x) || 0;
const plural = (k, s, p) => `${k} ${k === 1 ? s : p}`;
const colones = x => Math.round(n(x)).toLocaleString("es-CR");

// Los ítems, en el orden en que se trabaja un cierre.
export const ITEMS = [
  { id: "buzon", titulo: "Buzón: documentos por reclamar o revisar", vista: "casos", agente: "recepcion" },
  { id: "periodos", titulo: "Periodos fiscales abiertos", vista: "hallazgos", agente: "diagnostico" },
  { id: "recurrentes", titulo: "Servicios recurrentes del mes recibidos", vista: "hallazgos", agente: "recurrentes" },
  { id: "documentos", titulo: "Notas de crédito ligadas", vista: "hallazgos", agente: "documentos" },
  { id: "cuentas", titulo: "Cuentas de gasto revisadas (consultas y propuestas)", vista: "aprobaciones", agente: "cuentas" },
  { id: "borradores", titulo: "Documentos del mes publicados (sin borradores)", vista: "hallazgos", agente: "estados" },
  { id: "bancos", titulo: "Bancos conciliados", vista: "hallazgos", agente: "bancos" },
  { id: "puente", titulo: "Cuentas puente liquidadas (salarios, CCSS, IVA, retenciones)", vista: "hallazgos", agente: "cierre" },
  { id: "iva", titulo: "IVA del mes sin observaciones", vista: "hallazgos", agente: "cierre" },
  { id: "cambiario", titulo: "Diferencial cambiario registrado", vista: "aprobaciones", agente: "cambiario" },
  { id: "diferidos", titulo: "Cuotas de diferidos registradas", vista: "diferidos", agente: "diferidos" },
  { id: "depreciacion", titulo: "Depreciación registrada", vista: "activos", agente: "depreciacion" },
  { id: "asientos", titulo: "Asientos propuestos decididos", vista: "aprobaciones", agente: null },
  { id: "estados", titulo: "Estados financieros sin observaciones", vista: "hallazgos", agente: "estados" }
];

export function mesPorOmision(db) {
  for (const a of ["cierre", "estados", "cambiario"]) { const m = db.ultimaCorrida(a)?.resultado?.mes; if (m) return m; }
  return sumarMeses(mesDe(hoyLocal()), -1);
}

// Lo que se necesita de las corridas, leído una vez para todas las compañías.
function contexto(db, mes) {
  const r = a => db.ultimaCorrida(a)?.resultado || null;
  const ctx = { mes, recepcion: r("recepcion"), diagnostico: r("diagnostico"), recurrentes: r("recurrentes"), documentos: r("documentos"), bancos: r("bancos"),
    cierre: r("cierre"), estados: r("estados"), cambiario: r("cambiario"), diferidos: r("diferidos"), depreciacion: r("depreciacion") };
  ctx.asientos = db.asientos({ estado: "todos", limite: 5000 });
  ctx.casos = db.casos({ seguimiento: "abierto", limite: 100000 });
  ctx.consultas = db.consultas({ limite: 100000 });
  ctx.propuestas = db.propuestas({ estado: "propuesta", limite: 100000 });
  ctx.diferidosReg = db.diferidos({ estado: "activo" });
  ctx.activosReg = db.activos({ estado: "activo" });
  return ctx;
}
const delMes = (res, mes) => res && res.mes === mes;
const asiento = (ctx, clave) => ctx.asientos.filter(a => a.clave === clave).sort((a, b) => b.id - a.id)[0] || null;

function evaluar(it, cia, ctx) {
  const { mes } = ctx, nombre = cia.name;
  const ok = (detalle = null) => ({ estado: "ok", detalle }), pend = detalle => ({ estado: "pendiente", detalle }), na = (detalle = null) => ({ estado: "na", detalle });
  const sinDatos = agente => ({ estado: "sin-datos", detalle: `Sin corrida de ${agente} para ${mes}: córralo.` });
  switch (it.id) {
    case "buzon": {
      const c = ctx.casos.filter(x => x.compania_id === cia.id);
      if (!ctx.recepcion) return sinDatos("Recepción");
      const af = c.filter(x => x.frente === "afuera").length, ad = c.length - af;
      return c.length ? pend(`${plural(af, "documento", "documentos")} por reclamar afuera, ${ad} por revisar adentro.`) : ok();
    }
    case "periodos": {
      if (!ctx.diagnostico) return sinDatos("Diagnóstico");
      const p = (ctx.diagnostico.causas || []).find(c => c.id === "periodo-fiscal");
      const mios = (p?.pendientes || []).filter(x => x.compania === nombre);
      return mios.length ? pend(`Abrir: ${mios.map(x => `${x.detalle} (${x.correos} correos)`).join(", ")}.`) : ok();
    }
    case "recurrentes": {
      if (!delMes(ctx.recurrentes, mes)) return sinDatos("Recurrentes");
      const f = (ctx.recurrentes.faltantes || []).filter(x => x.companiaId === cia.id);
      return f.length ? pend(`Faltan: ${f.slice(0, 5).map(x => x.proveedor).join(", ")}${f.length > 5 ? ` y ${f.length - 5} más` : ""}.`) : ok();
    }
    case "documentos": {
      if (!ctx.documentos) return sinDatos("Documentos");
      const nc = (ctx.documentos.notas || []).filter(x => x.companiaId === cia.id);
      return nc.length ? pend(`${plural(nc.length, "nota de crédito sin ligar", "notas de crédito sin ligar")}.`) : ok();
    }
    case "cuentas": {
      const k = ctx.consultas.filter(x => x.compania_id === cia.id).length, p = ctx.propuestas.filter(x => x.compania_id === cia.id).length;
      return k || p ? pend(`${plural(k, "consulta abierta", "consultas abiertas")}, ${plural(p, "propuesta por decidir", "propuestas por decidir")}.`) : ok();
    }
    case "borradores": {
      if (!delMes(ctx.estados, mes)) return sinDatos("Estados");
      const e = (ctx.estados.companias || []).find(x => x.companiaId === cia.id);
      if (!e) return na("Sin asientos.");
      return e.borradores ? pend(`${plural(e.borradores, "documento", "documentos")} de ${mes} en borrador.`) : ok();
    }
    case "bancos": {
      if (!ctx.bancos) return sinDatos("Bancos");
      const b = (ctx.bancos.cuentas || []).filter(x => x.companiaId === cia.id);
      if (!b.length) return na("Sin cuentas de banco.");
      const mal = b.filter(x => ["atrasada", "solo-borradores", "nunca-conciliada"].includes(x.estado));
      return mal.length ? pend(mal.map(x => `${x.diario}: ${x.estado === "atrasada" ? `hasta ${x.ultimaConciliada}` : x.estado.replace("-", " ")}`).join("; ") + ".") : ok();
    }
    case "puente": {
      if (!delMes(ctx.cierre, mes)) return sinDatos("Cierre");
      const c = (ctx.cierre.cuentas || []).filter(x => x.companiaId === cia.id && ((x.estado === "arrastra" && !x.saldoAFavor) || x.estado === "al-reves"));
      return c.length ? pend(c.map(x => `${x.cuenta}: ${x.estado === "al-reves" ? "al revés" : `₡${colones(x.arrastre)} sin liquidar`}`).join("; ") + ".") : ok();
    }
    case "iva": {
      if (!delMes(ctx.cierre, mes)) return sinDatos("Cierre");
      const i = (ctx.cierre.iva || []).find(x => x.companiaId === cia.id);
      if (!i) return na("Sin IVA en el mes.");
      const obs = [];
      if (n(i.malUbicado)) obs.push(`₡${colones(i.malUbicado)} de IVA en cuentas que no son de IVA`);
      if (i.declarado && (Math.abs(n(i.declarado.difDebito)) > 1000 || Math.abs(n(i.declarado.difCredito)) > 1000)) obs.push("diferencia con el Reporte IVA");
      return obs.length ? pend(obs.join("; ") + ".") : ok(`${i.resultado === "a pagar" ? "A pagar" : "A favor"} ₡${colones(Math.abs(i.neto))}.`);
    }
    case "cambiario": {
      if (!delMes(ctx.cambiario, mes)) return sinDatos("Diferencial cambiario");
      const c = (ctx.cambiario.companias || []).find(x => x.companiaId === cia.id);
      if (!c || !c.ajustes) return na("Sin saldos en moneda extranjera que ajustar.");
      const a = asiento(ctx, `cambiario|${cia.id}|${mes}`);
      return a?.estado === "aplicada" ? ok(`Asiento ${a.move_name || a.id}.`) : pend(`Neto ₡${colones(c.neto)}: asiento ${a ? a.estado : "sin proponer"}.`);
    }
    case "diferidos": {
      const reg = ctx.diferidosReg.filter(x => x.compania_id === cia.id);
      if (!reg.length) return na("Sin diferidos registrados.");
      if (!delMes(ctx.diferidos, mes)) return sinDatos("Diferidos");
      const sug = (ctx.diferidos.asientosSugeridos || []).some(x => x.companiaId === cia.id);
      const a = asiento(ctx, `diferidos|${cia.id}|${mes}`);
      if (a?.estado === "aplicada") return ok(`Asiento ${a.move_name || a.id}.`);
      return sug ? pend(`Asiento de cuotas ${a ? a.estado : "sin proponer"}.`) : ok("Sin cuotas pendientes.");
    }
    case "depreciacion": {
      const reg = ctx.activosReg.filter(x => x.compania_id === cia.id);
      if (!reg.length) return na("Sin activos registrados en la app.");
      if (!delMes(ctx.depreciacion, mes)) return sinDatos("Depreciación");
      if ((ctx.depreciacion.duplicados || []).some(x => x.companiaId === cia.id)) return ok("Registrada a mano en Odoo.");
      const sug = (ctx.depreciacion.asientosSugeridos || []).some(x => x.companiaId === cia.id);
      const a = asiento(ctx, `depreciacion|${cia.id}|${mes}`);
      if (a?.estado === "aplicada") return ok(`Asiento ${a.move_name || a.id}.`);
      return sug ? pend(`Asiento de depreciación ${a ? a.estado : "sin proponer"}.`) : ok("Sin meses pendientes.");
    }
    case "asientos": {
      const ab = ctx.asientos.filter(a => a.compania_id === cia.id && ["propuesta", "aprobada", "fallo"].includes(a.estado));
      if (!ab.length) return ok();
      const c = s => ab.filter(a => a.estado === s).length;
      return pend([c("propuesta") && `${c("propuesta")} por decidir`, c("aprobada") && `${c("aprobada")} aprobados sin crear`, c("fallo") && `${c("fallo")} con fallo`].filter(Boolean).join(", ") + ".");
    }
    case "estados": {
      if (!delMes(ctx.estados, mes)) return sinDatos("Estados");
      const e = (ctx.estados.companias || []).find(x => x.companiaId === cia.id);
      if (!e) return na("Sin asientos.");
      const obs = [];
      if (Math.abs(n(e.balance?.diferencia)) > 1) obs.push("el balance no cuadra");
      const cajas = (ctx.estados.cajasNegativas || []).filter(x => x.companiaId === cia.id);
      if (cajas.length) obs.push(`${plural(cajas.length, "caja o banco", "cajas o bancos")} en negativo`);
      if ((ctx.estados.ladoContrario || []).some(x => x.companiaId === cia.id)) obs.push("proveedores o clientes del lado contrario");
      return obs.length ? pend(obs.join("; ") + ".") : ok(`Utilidad del año ₡${colones(e.resultadosAnio?.utilidad)}.`);
    }
  }
  return na();
}

// La lista de un mes: una fila por compañía con sus ítems, lo dado por bueno y si está cerrada.
export function lista(db, { mes, companias, companiaId = null }) {
  const ctx = contexto(db, mes);
  const registros = new Map(db.cierresMes(mes).map(c => [c.compania_id, c]));
  const filas = [];
  for (const cia of companias.filter(c => !companiaId || c.id === Number(companiaId))) {
    const reg = registros.get(cia.id) || null, revisados = reg?.revisados || {};
    const items = ITEMS.map(it => {
      const r = evaluar(it, cia, ctx), rev = revisados[it.id];
      return { ...it, ...r, ...(rev && r.estado !== "ok" && r.estado !== "na" ? { estado: "revisado", revisado: rev } : {}) };
    });
    const pendientes = items.filter(i => i.estado === "pendiente" || i.estado === "sin-datos").length;
    filas.push({ companiaId: cia.id, compania: cia.name, mes, estado: reg?.estado === "cerrado" ? "cerrado" : pendientes ? "abierto" : "listo",
      pendientes, cerradoPor: reg?.cerrado_por || null, cerradoEn: reg?.cerrado_en || null, nota: reg?.nota || null, items });
  }
  const orden = { abierto: 0, listo: 1, cerrado: 2 };
  filas.sort((a, b) => (orden[a.estado] - orden[b.estado]) || (b.pendientes - a.pendientes) || a.compania.localeCompare(b.compania));
  return { mes, items: ITEMS.map(({ id, titulo, vista }) => ({ id, titulo, vista })), companias: filas,
    totales: { companias: filas.length, cerradas: filas.filter(f => f.estado === "cerrado").length, listas: filas.filter(f => f.estado === "listo").length, abiertas: filas.filter(f => f.estado === "abierto").length } };
}
