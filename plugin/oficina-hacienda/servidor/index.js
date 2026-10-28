#!/usr/bin/env node
// Servidor MCP (stdio) del plugin «Oficina Hacienda»: las manos del plugin hacia la Oficina.
// Habla con /api/hacienda de TheOffice. Sin dependencias. No guarda credenciales de Hacienda:
// el portal lo abre la persona en su propio navegador.
//
//   OFICINA_URL    https://…trycloudflare.com  o  http://127.0.0.1:4180  (con /t/<inquilino> si hay varios)
//   OFICINA_TOKEN  SERVICIO_TOKEN de la Oficina (o vacío si corre en la misma PC sin token)
//   OFICINA_QUIEN  nombre que queda en la auditoría (p. ej. «plugin (Victor)»)
import { createInterface } from "node:readline";

const URL_BASE = String(process.env.OFICINA_URL || "http://127.0.0.1:4180").replace(/\/+$/, "");
const TOKEN = process.env.OFICINA_TOKEN || "";
const QUIEN = process.env.OFICINA_QUIEN || "plugin oficina-hacienda";

async function oficina(ruta, cuerpo) {
  const op = { headers: { "X-Quien": QUIEN, ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) } };
  if (cuerpo !== undefined) { op.method = "POST"; op.headers["Content-Type"] = "application/json"; op.body = JSON.stringify(cuerpo); }
  const r = await fetch(URL_BASE + ruta, op);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

const HERRAMIENTAS = [
  { name: "declaraciones_pendientes", description: "Declaraciones que la Oficina ya preparó y que se pueden llevar al portal: pendientes, con el juez en verde o amarillo y cifras al día. Devuelve id, compañía, periodo, totales y las casillas (id, etiqueta, monto). Filtra por periodo (AAAA-MM) e impuesto (150 por omisión).",
    inputSchema: { type: "object", properties: { periodo: { type: "string" }, impuesto: { type: "string", enum: ["150", "270", "102"] } } } },
  { name: "declaracion", description: "Una declaración completa por id: casillas con su rastro, juez, ajustes, estado y lo que ya se cargó en el portal.",
    inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } },
  { name: "registrar_carga", description: "Reporta a la Oficina lo que quedó en el portal después de llenar el borrador: campos = { casillaId: valor leído del portal }, prellenado = { casillaId: valor que Hacienda traía } (opcional), capturas = nombres de archivo, borradorGuardado = true solo si el portal confirmó el guardado, notas. La Oficina compara contra el paquete y baja el semáforo si algo no calza. Nunca presenta.",
    inputSchema: { type: "object", properties: { id: { type: "integer" }, campos: { type: "object" }, prellenado: { type: "object" }, capturas: { type: "array", items: { type: "string" } }, borradorGuardado: { type: "boolean" }, notas: { type: "string" }, portal: { type: "string", description: "URL o pantalla del portal donde quedó el borrador" } }, required: ["id", "campos", "borradorGuardado"] } },
  { name: "registrar_presentacion", description: "Después de que la PERSONA tocó Presentar en el portal: registra el número de la declaración que dio TRIBU-CR. Solo funciona si la declaración está aprobada en la Oficina.",
    inputSchema: { type: "object", properties: { id: { type: "integer" }, numero: { type: "string" }, fecha: { type: "string", description: "ISO, opcional" } }, required: ["id", "numero"] } },
  { name: "estado_oficina", description: "Comprueba que la Oficina responde y con qué inquilino y periodo trabaja.", inputSchema: { type: "object", properties: {} } }
];

async function ejecutar(nombre, args = {}) {
  switch (nombre) {
    case "declaraciones_pendientes": { const q = new URLSearchParams(); if (args.periodo) q.set("periodo", args.periodo); q.set("impuesto", args.impuesto || "150"); return oficina(`/api/hacienda/pendientes?${q}`); }
    case "declaracion": return oficina(`/api/hacienda/${Number(args.id)}`);
    case "registrar_carga": return oficina(`/api/hacienda/${Number(args.id)}/cargada`, { campos: args.campos || {}, prellenado: args.prellenado, capturas: args.capturas || [], borradorGuardado: args.borradorGuardado === true, notas: args.notas || "", portal: args.portal || null });
    case "registrar_presentacion": return oficina(`/api/hacienda/${Number(args.id)}/presentada`, { numero: args.numero, fecha: args.fecha || null });
    case "estado_oficina": { const e = await oficina("/api/estado"); const h = await oficina("/api/hacienda"); return { inquilino: e.inquilino || e.marca || null, periodo: h.periodo, declaraciones: h.declaraciones.length, url: URL_BASE }; }
    default: throw new Error(`Herramienta desconocida: ${nombre}`);
  }
}

// --- JSON-RPC por stdin/stdout, una línea por mensaje ---
const escribir = m => process.stdout.write(JSON.stringify(m) + "\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", async linea => {
  if (!linea.trim()) return;
  let msj; try { msj = JSON.parse(linea); } catch { return; }
  const { id, method, params = {} } = msj;
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;
  const responder = result => escribir({ jsonrpc: "2.0", id, result });
  const fallar = (code, message) => escribir({ jsonrpc: "2.0", id, error: { code, message } });
  try {
    if (method === "initialize") return responder({ protocolVersion: params.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "oficina-hacienda", version: "0.1.0" } });
    if (method === "ping") return responder({});
    if (method === "tools/list") return responder({ tools: HERRAMIENTAS });
    if (method === "tools/call") {
      try { const r = await ejecutar(params.name, params.arguments || {}); return responder({ content: [{ type: "text", text: JSON.stringify(r, null, 2) }] }); }
      catch (e) { return responder({ content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }); }
    }
    if (id !== undefined) fallar(-32601, `Método no soportado: ${method}`);
  } catch (e) { if (id !== undefined) fallar(-32603, e.message); }
});
