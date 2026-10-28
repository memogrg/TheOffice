// Fase 4: graduación de NIVELES (todo pasa por Aprobaciones) a AUTÓNOMO, por tipo de propuesta ×
// compañía, medida con lo que ya decidieron las personas.
//
//   historial  — por tipo × compañía y por mes: aprobadas sin cambios, corregidas (editadas antes de
//                aprobar), rechazadas, fallidas al crearse en Odoo y aprobadas solas.
//   candidato  — los dos últimos meses con decisiones son seguidos, cada uno con al menos
//                AUTONOMIA_MINIMO decisiones de una persona, y ninguna corregida, rechazada ni fallida.
//   otorgar    — una persona da la autonomía a un candidato (queda en la auditoría con la evidencia).
//   aprobar    — después de cada corrida, lo nuevo de un tipo × compañía autónomo se aprueba solo si
//                pasa las mismas validaciones que al aprobar a mano. Crearlo en Odoo sigue siendo un
//                botón, salvo AUTONOMIA_APLICAR=si (y el permiso de escritura de asientos).
//   revocar    — a mano, o sola si un asiento aprobado por autonomía falla al crearse en Odoo.
//
// Nunca son autónomos: los asientos dictados al Director o a mano, los correos y los cambios al plan.
import { revisarForma, validar, escrituraAsientos, aplicar as aplicarAsiento } from "./asientos.js";
import { sumarMeses } from "../lib/meses.js";

export const QUIEN = "autonomía (nivel autónomo)";
export const TIPOS = {
  cierre: "Cierre: liquidar cuentas puente",
  cambiario: "Diferencial cambiario",
  diferidos: "Cuotas de diferidos",
  depreciacion: "Depreciación",
  "extractos-cargos": "Extractos: cargos bancarios",
  "extractos-intereses": "Extractos: intereses",
  "extractos-transferencia": "Extractos: transferencias propias",
  cuentas: "Cuentas: clasificación de compras"
};
export function tipoDeAsiento(a) {
  if (a.origen === "extractos") { const t = String(a.clave || "").split("|")[1]; return t ? `extractos-${t}` : null; }
  return TIPOS[a.origen] ? a.origen : null;
}
const minimo = cfg => Math.max(1, Number(cfg?.AUTONOMIA_MINIMO) || 1);
const aplicaSola = cfg => String(cfg?.AUTONOMIA_APLICAR || "").toLowerCase() === "si";
const esAuto = quien => String(quien || "").startsWith("autonomía");

// Historial y estado de cada tipo × compañía.
export function historial(db, cfg = {}) {
  const editados = db.asientosEditados();
  const filas = new Map();
  const fila = (tipo, cia, nombre) => {
    const k = `${tipo}|${cia}`;
    if (!filas.has(k)) filas.set(k, { tipo, titulo: TIPOS[tipo], companiaId: cia, compania: nombre, meses: {} });
    return filas.get(k);
  };
  const contar = (f, mes, campo) => { const m = (f.meses[mes] = f.meses[mes] || { aprobadas: 0, corregidas: 0, rechazadas: 0, fallidas: 0, solas: 0 }); m[campo]++; };

  for (const a of db.decisionesAsientos()) {
    const tipo = tipoDeAsiento(a);
    if (!tipo) continue;
    const f = fila(tipo, a.compania_id, a.compania), mes = a.mes || String(a.fecha).slice(0, 7);
    const lineas = JSON.parse(a.lineas || "[]");
    const corregida = editados.has(a.id) || lineas.some(l => l.editada);
    if (a.estado === "fallo") contar(f, mes, "fallidas");
    else if (a.estado === "rechazada") contar(f, mes, "rechazadas");
    else if (esAuto(a.decidio)) contar(f, mes, "solas");
    else if (["aprobada", "aplicada"].includes(a.estado)) contar(f, mes, corregida ? "corregidas" : "aprobadas");
  }
  for (const p of db.decisionesPropuestas()) {
    const f = fila("cuentas", p.compania_id, p.compania), mes = String(p.decidido_en || "").slice(0, 7);
    if (!mes) continue;
    if (p.estado === "fallo") contar(f, mes, "fallidas");
    else if (p.estado === "rechazada") contar(f, mes, "rechazadas");
    else if (esAuto(p.decidio)) contar(f, mes, "solas");
    else contar(f, mes, "aprobadas");
  }

  const activas = db.autonomias({ estado: "activa" });
  const revocadas = db.autonomias({ estado: "revocada" });
  const min = minimo(cfg);
  const out = [];
  for (const f of filas.values()) {
    const meses = Object.keys(f.meses).sort();
    const humanas = m => { const x = f.meses[m]; return x.aprobadas + x.corregidas + x.rechazadas + x.fallidas; };
    const conDecision = meses.filter(m => humanas(m) > 0);
    const ult = conDecision.slice(-2);
    const limpio = m => { const x = f.meses[m]; return x.corregidas === 0 && x.rechazadas === 0 && x.fallidas === 0 && x.aprobadas >= min; };
    const seguidos = ult.length === 2 && sumarMeses(ult[0], 1) === ult[1];
    const activa = activas.find(a => a.tipo === f.tipo && a.compania_id === f.companiaId) || null;
    const revocada = revocadas.find(a => a.tipo === f.tipo && a.compania_id === f.companiaId) || null;
    // después de una revocación se vuelve a empezar: cuentan solo los meses posteriores
    const desdeRevocacion = revocada && !activa ? String(revocada.revocada_en).slice(0, 7) : null;
    const validos = desdeRevocacion ? ult.filter(m => m > desdeRevocacion) : ult;
    const candidato = !activa && seguidos && validos.length === 2 && ult.every(limpio);
    let motivo;
    if (activa) motivo = `Autónomo desde ${String(activa.otorgada_en).slice(0, 10)} (lo dio ${activa.otorgo}).`;
    else if (candidato) motivo = `${ult.join(" y ")} sin correcciones (${ult.map(m => f.meses[m].aprobadas).join(" y ")} aprobadas).`;
    else if (!conDecision.length) motivo = "Todavía sin decisiones de una persona.";
    else if (ult.length < 2) motivo = `Hace falta otro mes: solo ${ult[0]} tiene decisiones.`;
    else if (!seguidos) motivo = `Los dos últimos meses con decisiones (${ult.join(", ")}) no son seguidos.`;
    else if (validos.length < 2) motivo = `Se revocó el ${String(revocada.revocada_en).slice(0, 10)}: cuentan los meses posteriores.`;
    else {
      const malo = ult.find(m => !limpio(m)), x = f.meses[malo];
      const malas = [x.corregidas && `${x.corregidas} corregidas`, x.rechazadas && `${x.rechazadas} rechazadas`, x.fallidas && `${x.fallidas} fallidas`].filter(Boolean);
      motivo = malas.length ? `${malo}: ${malas.join(", ")}.` : `${malo}: ${x.aprobadas} aprobadas (mínimo ${min}).`;
    }
    out.push({ ...f, nivel: activa ? "autonomo" : candidato ? "candidato" : "niveles", motivo, autonomiaId: activa?.id ?? null,
      evidencia: candidato ? ult.map(m => ({ mes: m, ...f.meses[m] })) : null });
  }
  const orden = { candidato: 0, autonomo: 1, niveles: 2 };
  return out.sort((a, b) => orden[a.nivel] - orden[b.nivel] || String(a.compania).localeCompare(String(b.compania)) || a.tipo.localeCompare(b.tipo));
}

export function otorgar({ db, cfg, tipo, companiaId, nota, quien }) {
  if (!TIPOS[tipo]) return { error: "Tipo desconocido." };
  const f = historial(db, cfg).find(x => x.tipo === tipo && x.companiaId === Number(companiaId));
  if (!f) return { error: "No hay historial de ese tipo en esa compañía." };
  if (f.nivel === "autonomo") return { error: "Ya es autónomo." };
  if (f.nivel !== "candidato") return { error: `Todavía no: ${f.motivo}` };
  const id = db.otorgarAutonomia({ tipo, companiaId: f.companiaId, compania: f.compania, nota: nota || null, evidencia: f.evidencia }, quien);
  return { id, mensaje: `Desde la próxima corrida, «${TIPOS[tipo]}» de ${f.compania} se aprueba solo si pasa las validaciones.${aplicaSola(cfg) && (tipo === "cuentas" || escrituraAsientos(cfg)) ? " Y se crea en Odoo (AUTONOMIA_APLICAR=si)." : " Crearlo en Odoo sigue siendo un botón."}` };
}

// Después de una corrida: aprueba (y, si corresponde, aplica) lo nuevo de los tipos autónomos.
export async function aprobarAutonomos({ db, corridas, odoo, cfg, log = () => {} }) {
  const activas = db.autonomias({ estado: "activa" });
  if (!activas.length) return null;
  const es = (tipo, cia) => activas.find(a => a.tipo === tipo && a.compania_id === cia);
  const out = { aprobados: 0, aplicados: 0, retenidos: [], revocadas: 0 };
  for (const a of db.asientos({ estado: "propuesta", limite: 5000 })) {
    const aut = es(tipoDeAsiento(a), a.compania_id);
    if (!aut) continue;
    const forma = revisarForma(a);
    let v = { ok: !forma.errores.length, errores: forma.errores };
    if (v.ok) { try { v = await validar(odoo, a); } catch (e) { v = { ok: false, errores: [`no se pudo validar: ${e.message}`] }; } }
    if (!v.ok) { out.retenidos.push({ id: a.id, compania: a.compania, referencia: a.referencia, motivo: v.errores.join(" ") }); continue; }
    db.decidirAsiento(a.id, "aprobada", QUIEN, `Autonomía #${aut.id}`);
    out.aprobados++;
    if (aplicaSola(cfg) && escrituraAsientos(cfg) && corridas) {
      const r = await aplicarAsiento({ corridas, db, id: a.id, quien: QUIEN });
      if (r.ok) out.aplicados++;
      else {
        if (db.autonomiaActiva(aut.tipo, aut.compania_id)) db.revocarAutonomia(aut.id, QUIEN, `Falló al crear el asiento #${a.id} en Odoo: ${r.error || "la verificación no calzó"}`);
        out.revocadas++; activas.splice(activas.indexOf(aut), 1);
      }
    }
  }
  for (const p of db.propuestas({ estado: "propuesta", limite: 20000 })) {
    const aut = es("cuentas", p.compania_id);
    if (!aut) continue;
    db.decidirPropuesta(p.id, "aprobada", QUIEN, `Autonomía #${aut.id}`);
    out.aprobados++;
  }
  if (out.aprobados || out.retenidos.length) log(`Autonomía: ${out.aprobados} aprobados solos, ${out.retenidos.length} retenidos para una persona`);
  return out;
}

// Un asiento aprobado por autonomía que falla al crearse en Odoo le quita la autonomía a su tipo × compañía.
export function alFallar(db, a, motivo) {
  if (!esAuto(a.decidio)) return false;
  const aut = db.autonomiaActiva(tipoDeAsiento(a), a.compania_id);
  return aut ? db.revocarAutonomia(aut.id, QUIEN, `Falló al crear el asiento #${a.id} en Odoo: ${motivo}`) : false;
}
