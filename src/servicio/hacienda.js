// Declaraciones de Hacienda: el ciclo de vida de cada una y lo que el plugin y las personas hacen con ella.
//
//   preparada → revisada (juez de IA, opcional) → cargada (el plugin la dejó como borrador en el
//   portal y releyó cada casilla) → aprobada (una persona, con su nombre) → presentada (número que
//   dio el portal; el clic de presentar lo da la persona). rechazada vuelve a preparada en la corrida
//   siguiente. Nada aquí escribe en Odoo ni entra al portal.
//
// El juez tiene dos capas: las reglas (src/lib/hacienda.js, siempre) y un modelo de lenguaje que lee
// el paquete y dice en palabras qué le parece raro. El modelo no cambia cifras: solo puede dejar el
// semáforo igual o ponerlo peor.
import { paquete150, paquete102, juezDeReglas, comparar, semaforoDe, FORMULARIOS, r2 } from "../lib/hacienda.js";

const API = "https://api.anthropic.com/v1/messages";
const PEOR = { verde: 0, amarillo: 1, rojo: 2 };
const peor = (a, b) => (PEOR[b] > PEOR[a] ? b : a);
const colones = x => Math.round(Number(x) || 0).toLocaleString("es-CR");
const esc = s => String(s ?? "").replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

// Vuelve a armar el paquete con los ajustes guardados (sin Odoo) y lo vuelve a juzgar por reglas.
export function recalcular({ db, id }) {
  const d = db.declaracion(id);
  if (!d) return { error: "No existe esa declaración." };
  const aj = d.ajustes || {}, p = d.paquete;
  let nuevo;
  if (d.impuesto === "150") nuevo = paquete150({ compania: d.compania, companiaId: d.compania_id, periodo: d.periodo, agregados: p.fuentes || [], extra: { ...p.extra, proporcion: aj.proporcion ?? null, saldoAFavorAnterior: aj.saldoAnterior ?? p.extra?.saldoAFavorAnterior ?? 0, fuenteSaldoAnterior: aj.saldoAnterior != null ? "indicado a mano" : p.extra?.fuenteSaldoAnterior } });
  else if (d.impuesto === "102") nuevo = paquete102({ compania: d.compania, companiaId: d.compania_id, periodo: d.periodo, saldos: p.fuentes || [], extra: { ...p.extra, tarifa: aj.tarifa ?? p.extra?.tarifa ?? 30, pagosParciales: aj.pagosParciales ?? p.extra?.pagosParciales ?? 0, retenciones: aj.retenciones ?? p.extra?.retenciones ?? 0 } });
  else return { ok: true, sinCambio: true };
  nuevo.fuentes = p.fuentes;
  const juez = juezDeReglas(nuevo);
  db.reemplazarPaqueteDeclaracion(id, nuevo, juez);
  return { ok: true, paquete: nuevo, juez };
}

export function ajustar({ db, id, ajustes, quien }) {
  const permitidos = ["proporcion", "saldoAnterior", "tarifa", "pagosParciales", "retenciones"];
  const limpio = {};
  for (const k of permitidos) if (k in (ajustes || {})) {
    const v = ajustes[k];
    if (v == null || v === "") { limpio[k] = null; continue; }
    const n = Number(String(v).replace(",", "."));
    if (!Number.isFinite(n) || n < 0) return { error: `${k}: tiene que ser un número.` };
    if ((k === "proporcion" || k === "tarifa") && n > 100) return { error: `${k}: es un porcentaje.` };
    limpio[k] = n;
  }
  if (!db.ajustarDeclaracion(id, limpio, quien)) return { error: "La declaración ya no se puede ajustar (está cargada, aprobada o presentada)." };
  return recalcular({ db, id });
}

// --- El juez de IA. Lee el paquete y las observaciones de las reglas; responde JSON. ---
const SISTEMA_JUEZ = `Sos el revisor de declaraciones de impuestos de un despacho contable en Costa Rica. Te dan el paquete de una declaración de TRIBU-CR (IVA formulario 150, renta 102 o informativa 270) armado desde la contabilidad en Odoo, con sus casillas, el rastro de cada cifra y lo que ya observó el juez de reglas.
Tu trabajo es SOLO revisar y marcar. No podés cambiar ninguna cifra ni proponer otra. Buscá: incoherencias entre casillas, proporciones raras entre ventas y compras, una tarifa con base pero sin impuesto (o al revés), meses con cambios bruscos, señales de documentos faltantes, y cualquier cosa que un contador querría ver antes de presentar.
Respondé ÚNICAMENTE un JSON con esta forma, sin texto alrededor:
{"semaforo":"verde|amarillo|rojo","resumen":"una o dos frases","observaciones":[{"nivel":"critico|alto|info","texto":"..."}]}
Reglas: "rojo" solo si creés que NO debe presentarse así; "amarillo" si alguien tiene que mirar algo antes; "verde" si no ves nada. No repitas lo que ya dijo el juez de reglas; agregá lo que falte. Escribí en español de Costa Rica, con cifras en colones.`;

export async function juezIA({ db, cfg, id, quien, fetchImpl = globalThis.fetch }) {
  if (!cfg.CLAUDE_API_KEY) return { error: "Sin CLAUDE_API_KEY: el juez de IA no está disponible; queda el de reglas." };
  const d = db.declaracion(id);
  if (!d) return { error: "No existe esa declaración." };
  const reglas = juezDeReglas(d.paquete);
  const entrada = { impuesto: d.impuesto, formulario: d.paquete.formulario, compania: d.compania, periodo: d.periodo,
    casillas: d.paquete.casillas.map(c => ({ id: c.id, etiqueta: c.etiqueta, monto: c.monto, ...(c.tasa ? { tasa: c.tasa } : {}), documentos: (c.rastro || []).reduce((t, r) => t + (r.documentos || 0), 0) || undefined })),
    totales: d.paquete.totales, contexto: { mesAnterior: d.paquete.extra?.anterior || null, borradores: d.paquete.extra?.borradores || 0, proporcionCalculada: d.paquete.extra?.proporcionCalculada, filas: d.paquete.filas?.slice(0, 30) },
    juezDeReglas: reglas.observaciones };
  const modelo = cfg.HACIENDA_JUEZ_MODELO || cfg.DIRECTOR_MODELO || "claude-sonnet-4-5";
  const res = await fetchImpl(API, { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": cfg.CLAUDE_API_KEY, "anthropic-version": "2023-06-01", ...(cfg.CLAUDE_WORKSPACE_ID ? { "anthropic-workspace-id": cfg.CLAUDE_WORKSPACE_ID } : {}) },
    body: JSON.stringify({ model: modelo, max_tokens: 1500, system: SISTEMA_JUEZ, messages: [{ role: "user", content: JSON.stringify(entrada) }] }) });
  const j = await res.json();
  if (!res.ok) return { error: `API de Claude: ${j.error?.message || res.status}` };
  const texto = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("");
  let ia;
  try { ia = JSON.parse(texto.replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, "$1")); } catch { return { error: "El juez de IA no respondió en el formato esperado.", texto: texto.slice(0, 500) }; }
  const semIA = ["verde", "amarillo", "rojo"].includes(ia.semaforo) ? ia.semaforo : "amarillo";
  const observaciones = [...reglas.observaciones, ...(Array.isArray(ia.observaciones) ? ia.observaciones : []).filter(o => o && o.texto).map(o => ({ regla: "ia", nivel: ["critico", "alto", "info"].includes(o.nivel) ? o.nivel : "info", texto: String(o.texto).slice(0, 400) }))];
  const juez = { semaforo: peor(reglas.semaforo, semIA), observaciones, ia: { modelo, fecha: new Date().toISOString(), resumen: String(ia.resumen || "").slice(0, 500), semaforo: semIA } };
  db.juzgarDeclaracion(id, juez, quien);
  return { ok: true, juez };
}

// --- Lo que el plugin reporta después de dejar el borrador en el portal ---
export function registrarCarga({ db, id, cuerpo, quien }) {
  const d = db.declaracion(id);
  if (!d) return { error: "No existe esa declaración.", codigo: 404 };
  if (!["preparada", "revisada", "cargada"].includes(d.estado)) return { error: `La declaración está ${d.estado}.`, codigo: 409 };
  if (d.desactualizada) return { error: "Las cifras cambiaron después de la última corrida: actualice la declaración antes de cargarla.", codigo: 409 };
  const campos = cuerpo.campos && typeof cuerpo.campos === "object" ? cuerpo.campos : {};
  const prellenado = cuerpo.prellenado && typeof cuerpo.prellenado === "object" ? cuerpo.prellenado : null;
  const diferencias = comparar(d.paquete, campos);
  const difPrellenado = prellenado ? comparar(d.paquete, prellenado) : null;
  const faltan = d.paquete.casillas.filter(c => c.resultado || c.total).filter(c => !(c.id in campos)).map(c => c.id);
  const carga = { fecha: new Date().toISOString(), quien, campos, prellenado, diferencias, difPrellenado, faltan, capturas: Array.isArray(cuerpo.capturas) ? cuerpo.capturas.slice(0, 20) : [],
    borradorGuardado: cuerpo.borradorGuardado === true, notas: String(cuerpo.notas || "").slice(0, 1000), portal: cuerpo.portal || null };
  db.cargarDeclaracion(id, carga, quien);
  // la carga también es una revisión: lo que no calza baja el semáforo
  const j = d.juez || juezDeReglas(d.paquete);
  const obs = (j.observaciones || []).filter(o => o.regla !== "carga");
  if (diferencias.length) obs.push({ regla: "carga", nivel: "critico", texto: `${diferencias.length} casillas quedaron distintas en el portal: ${diferencias.slice(0, 3).map(x => `${x.etiqueta} (₡${colones(x.portal)} vs ₡${colones(x.paquete)})`).join("; ")}.` });
  if (!carga.borradorGuardado) obs.push({ regla: "carga", nivel: "alto", texto: "El plugin no confirmó que el borrador quedó guardado en el portal." });
  if (difPrellenado && difPrellenado.length) obs.push({ regla: "carga", nivel: "alto", texto: `${difPrellenado.length} casillas difieren del prellenado de Hacienda: ${difPrellenado.slice(0, 3).map(x => `${x.etiqueta} (Hacienda ₡${colones(x.portal)}, Odoo ₡${colones(x.paquete)})`).join("; ")}. Puede haber facturas que Hacienda tiene y Odoo no, o al revés.` });
  const nuevo = { ...j, observaciones: obs, semaforo: peor(semaforoDe(obs), j.ia ? j.ia.semaforo : "verde") };
  db.juzgarDeclaracion(id, nuevo, quien);
  return { ok: true, estado: "cargada", diferencias, difPrellenado, faltan, semaforo: nuevo.semaforo };
}

// --- Notificación: un correo (borrador en Correos) con el resumen del periodo ---
export function notificar({ db, periodo, para, quien }) {
  const lista = db.declaraciones({ periodo, impuesto: "150" }).filter(d => d.periodo === periodo);
  if (!lista.length) return { error: `No hay declaraciones de IVA de ${periodo}.` };
  const fila = d => `<tr><td>${esc(d.compania)}</td><td style="text-align:right">${d.paquete.totales.pagar ? "₡" + colones(d.paquete.totales.pagar) : "—"}</td><td style="text-align:right">${d.paquete.totales.favor ? "₡" + colones(d.paquete.totales.favor) : "—"}</td><td>${esc(d.juez?.semaforo || "")}</td><td>${esc(d.estado)}${d.carga && d.carga.diferencias.length ? " · " + d.carga.diferencias.length + " dif." : ""}</td></tr>`;
  const total = r2(lista.reduce((t, d) => t + (d.paquete.totales.pagar || 0), 0));
  const observadas = lista.filter(d => d.juez && d.juez.semaforo !== "verde");
  const html = `<div style="font-family:sans-serif;font-size:14px;color:#222"><p>Las declaraciones de IVA de <b>${esc(periodo)}</b> están preparadas en la Oficina: ${lista.length} compañías, <b>₡${colones(total)}</b> a pagar en total.</p>
<table style="border-collapse:collapse;font-size:13px" border="1" cellpadding="5"><tr><th>Compañía</th><th>A pagar</th><th>A favor</th><th>Semáforo</th><th>Estado</th></tr>${lista.map(fila).join("")}</table>
${observadas.length ? `<p><b>Con observaciones (${observadas.length}):</b></p><ul>${observadas.map(d => `<li><b>${esc(d.compania)}</b>: ${(d.juez.observaciones || []).slice(0, 3).map(o => esc(o.texto)).join(" · ")}</li>`).join("")}</ul>` : "<p>Sin observaciones del juez.</p>"}
<p>Para aprobar entre a la Oficina → pestaña <b>Hacienda</b>. Presentar en TRIBU-CR sigue siendo un clic suyo por compañía.</p></div>`;
  const [id] = db.registrarCorreos(null, [{ frente: `hacienda:${periodo}`, para, asunto: `IVA ${periodo}: ${lista.length} declaraciones listas para revisar (₡${colones(total)})`, html, casos: lista.length, companias: lista.map(d => d.compania) }]);
  db.marcarNotificadas(lista.map(d => d.id));
  db.auditar(quien, "notificar", "declaracion", null, { periodo, para, declaraciones: lista.length });
  return { ok: true, correoId: id, declaraciones: lista.length, total };
}

// Resumen para la app, el Director y el plugin.
export function resumen(d) {
  return { id: d.id, impuesto: d.impuesto, formulario: FORMULARIOS[d.impuesto]?.nombre || d.impuesto, compania: d.compania, companiaId: d.compania_id, periodo: d.periodo, estado: d.estado,
    semaforo: d.juez?.semaforo || null, observaciones: (d.juez?.observaciones || []).length, ia: Boolean(d.juez?.ia), totales: d.paquete.totales, porValidar: Boolean(d.paquete.porValidar),
    desactualizada: Boolean(d.desactualizada), carga: d.carga ? { fecha: d.carga.fecha, diferencias: d.carga.diferencias.length, difPrellenado: d.carga.difPrellenado ? d.carga.difPrellenado.length : null, borradorGuardado: d.carga.borradorGuardado } : null,
    decidio: d.decidio, nota: d.nota, numero: d.numero_presentacion, presentadaEn: d.presentada_en, notificadaEn: d.notificada_en, actualizadaEn: d.actualizado_en || d.creado_en };
}
// Lo que el plugin puede cargar: pendiente, sin rojo, con cifras al día.
export const cargable = d => ["preparada", "revisada"].includes(d.estado) && d.juez?.semaforo !== "rojo" && !d.desactualizada;
