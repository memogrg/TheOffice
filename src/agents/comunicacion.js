// VICTOR — COMUNICACIÓN. Redacta y despacha. No entra a Odoo.
//
// Recoge la bandeja que le deja Marta (data/bandeja-victor.json) y arma un correo
// por receptor, en dos frentes:
//
//   · AFUERA  — al receptor de la factura, para que le reclame al establecimiento
//     que le giró un tiquete o un documento rechazado la factura electrónica real.
//   · ADENTRO — al humano de la compañía, con el detalle de las duplicidades,
//     errores, pendientes en cola y errores de identificación.
//
// Doble candado, igual que el agente que escribe en Odoo: sin --enviar y sin SMTP
// configurado, Victor deja los correos redactados en ./reportes/borradores-victor-<fecha>/
// y no manda nada. Así se lee lo que iba a salir antes de que salga.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export const meta = {
  id: "comunicacion",
  nombre: "Victor",
  rol: "COMUNICACIÓN",
  puesto: "Redacta y despacha",
  modelo: null,
  escribe: false,          // no escribe en Odoo
  mandaCorreo: true,
  recibeDe: "recepcion"
};

const esc = s => String(s ?? "").replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
const ETIQUETA_ESTADO = {
  isticket: "Tiquete electrónico", rejected: "Rechazado",
  duplicate: "Duplicidad", error: "Error de proceso",
  process: "En cola", vatiderror: "Error de identificación"
};

function marco(titulo, subtitulo, cuerpo) {
  return `<!doctype html><html><body style="margin:0;background:#F4F7F5;font-family:Helvetica,Arial,sans-serif;color:#0E1614">
<div style="max-width:660px;margin:0 auto;padding:28px 22px">
  <div style="border-bottom:2px solid #0B4A3F;padding-bottom:14px;margin-bottom:20px">
    <div style="font-size:11px;letter-spacing:.15em;text-transform:uppercase;color:#0B4A3F;font-weight:700">Oficina IASIMA · Victor, comunicación</div>
    <h1 style="margin:9px 0 0;font-size:22px;line-height:1.2">${esc(titulo)}</h1>
    <div style="margin-top:7px;color:#6B7C77;font-size:13px">${esc(subtitulo)}</div>
  </div>${cuerpo}
  <div style="margin-top:26px;padding-top:14px;border-top:1px solid #D6E0DC;font-size:11.5px;color:#6B7C77;line-height:1.6">
    Este aviso lo preparó Marta, del puesto de recepción, leyendo el buzón de facturas electrónicas.
    Si algo de lo listado ya se resolvió, respóndale a este correo para que deje de aparecer.
  </div>
</div></body></html>`;
}

function tabla(cabeceras, filas) {
  return `<table style="width:100%;border-collapse:collapse;background:#FFF;margin-bottom:14px"><tr>` +
    cabeceras.map((h, i) => `<th style="text-align:${i ? "right" : "left"};padding:7px 10px;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#6B7C77;border-bottom:2px solid #C4D0CC">${esc(h)}</th>`).join("") +
    `</tr>` + filas.map(f => `<tr>` + f.map((c, i) =>
      `<td style="padding:7px 10px;border-bottom:1px solid #E1E8E5;font-size:12.5px;text-align:${i ? "right" : "left"}">${c}</td>`).join("") + `</tr>`).join("") + `</table>`;
}

// ---------- AFUERA: pedirle la factura real al establecimiento ----------
function correoExterno(r) {
  const docs = r.documentosUnicos || r.total;
  const asunto = `Facturas pendientes de recibir — ${docs} documento${docs === 1 ? "" : "s"} (${r.receptor})`;
  const desglose = [r.tiquetes ? `<b>${r.tiquetes}</b> llegaron como tiquete electrónico` : null,
                    r.rechazados ? `<b>${r.rechazados}</b> fueron rechazados` : null]
                   .filter(Boolean).join(" y ");
  let c = `<p style="font-size:14.5px;line-height:1.65;color:#22322D">Buen día. Revisando el buzón de facturas electrónicas de
    <b>${esc(r.companias.join(", "))}</b> quedaron <b>${docs} documento${docs === 1 ? "" : "s"}</b> que no se pueden registrar
    en la contabilidad tal como llegaron${r.total !== docs ? ` (entraron ${r.total} veces al buzón)` : ""}: ${desglose}.</p>`;
  c += r.tiquetes
    ? `<p style="font-size:14.5px;line-height:1.65;color:#22322D">El tiquete electrónico no sirve para respaldar un gasto: hay que pedirle al establecimiento
       que emita la <b>factura electrónica</b> a nombre de la compañía y la envíe a este mismo correo. Lo mismo con los documentos
       rechazados, que hay que pedir de nuevo. Abajo está el detalle, agrupado por establecimiento para que sea una sola gestión con cada uno.</p>`
    : `<p style="font-size:14.5px;line-height:1.65;color:#22322D">Estos documentos no entraron a la contabilidad: hay que pedirle al establecimiento
       que emita de nuevo la <b>factura electrónica</b> a nombre de la compañía y la envíe a este mismo correo.
       Abajo está el detalle, agrupado por establecimiento para que sea una sola gestión con cada uno.</p>`;

  for (const e of r.establecimientos) {
    const quien = e.establecimiento || (e.cedula ? `Cédula ${e.cedula}` : "Emisor sin identificar");
    const pista = e.cedula && e.establecimiento ? `· cédula ${e.cedula}`
      : e.identificadoPor && e.identificadoPor !== "clave" ? `· identificado por el ${e.identificadoPor}` : "";
    c += `<div style="font-size:13px;font-weight:700;margin:18px 0 7px;color:#0B4A3F">${esc(quien)}${pista ? ` <span style="font-weight:400;color:#6B7C77">${esc(pista)}</span>` : ""} — ${e.documentos.length} documento${e.documentos.length === 1 ? "" : "s"}</div>`;
    c += tabla(["Fecha", "Documento", "Qué pasó"], e.documentos.slice(0, 40).map(d => [
      esc(d.fecha || "—"),
      d.consecutivo
        ? `<span style="font-family:monospace;font-size:11.5px">${esc(d.consecutivo)}</span>`
        : `<span style="font-size:11.5px;color:#3C4B47">${esc((d.asunto || "sin referencia").slice(0, 70))}</span>`,
      `<span style="color:${d.estado === "isticket" ? "#8A6410" : "#B3402E"}">${esc(ETIQUETA_ESTADO[d.estado] || d.estado)}</span>${d.veces > 1 ? `<br><span style="font-size:10.5px;color:#6B7C77">llegó ${d.veces} veces</span>` : ""}`
    ]));
    if (e.documentos.length > 40) c += `<div style="font-size:12px;color:#6B7C77;margin:-8px 0 12px">…y ${e.documentos.length - 40} más.</div>`;
  }
  return { asunto, html: marco("Hay facturas que el establecimiento todavía no ha emitido", `${r.receptor} · ${r.companias.join(", ")}`, c) };
}

// ---------- ADENTRO: que un humano de la compañía lo revise ----------
function correoInterno(r) {
  const asunto = `Correos del buzón que necesitan revisión interna — ${r.total} casos (${r.receptor})`;
  let c = `<p style="font-size:14.5px;line-height:1.65;color:#22322D">En el buzón de <b>${esc(r.companias.join(", "))}</b> quedaron
    <b>${r.total} correos</b> (${r.documentosUnicos || r.total} documentos distintos) que no se registraron y que no se arreglan pidiéndole nada al proveedor: hay que revisarlos aquí adentro.
    Va el detalle completo, caso por caso.</p>`;

  if (r.causas && r.causas.length) {
    c += `<div style="font-size:13px;font-weight:700;margin:18px 0 7px;color:#0B4A3F">Por qué se quedaron</div>`;
    c += tabla(["Causa", "Correos"], r.causas.map(x =>
      [`<span style="font-size:12.5px;color:#3C4B47">${esc(x.causa)}</span>`, `<b>${x.correos}</b>`]));
    if (r.causas[0].correos / r.total >= 0.6)
      c += `<p style="font-size:13.5px;line-height:1.6;color:#8A6410;background:#FFF;padding:11px 13px;margin:0 0 14px">
        <b>Una sola causa explica el ${Math.round(r.causas[0].correos / r.total * 100)} % de los casos.</b>
        Resolverla de raíz vale más que revisar los ${r.total} correos uno por uno.</p>`;
  }

  for (const bloque of r.porEstado) {
    c += `<div style="font-size:13px;font-weight:700;margin:20px 0 4px;color:#0B4A3F">${esc(ETIQUETA_ESTADO[bloque.estado] || bloque.estado)} — ${bloque.correos}</div>
      <div style="font-size:12.5px;color:#3C4B47;margin-bottom:8px;line-height:1.55">${esc(bloque.motivo)}</div>`;
    c += tabla(["Documento", "Establecimiento", "Detalle"], bloque.detalle.slice(0, 60).map(d => [
      `<div><b style="font-size:12px">${esc(d.consecutivo || d.asunto.slice(0, 40) || "—")}</b><br>
        <span style="color:#6B7C77;font-size:11px">${esc(d.compania)} · ${esc(d.fechaDocumento || d.fecha || "")}</span></div>`,
      `<span style="font-size:12px">${esc(d.establecimiento || d.cedulaEmisor || "—")}</span>`,
      `<span style="font-size:11.5px;color:#8A6410">${esc((d.error || "").slice(0, 140) || "—")}</span>${d.veces > 1 ? `<br><span style="font-size:10.5px;color:#6B7C77">llegó ${d.veces} veces</span>` : ""}`
    ]));
    if (bloque.detalle.length > 60) c += `<div style="font-size:12px;color:#6B7C77;margin:-8px 0 12px">…y ${bloque.detalle.length - 60} más en el archivo adjunto de la corrida.</div>`;
  }
  return { asunto, html: marco("Correos del buzón que hay que revisar adentro", `${r.receptor} · ${r.companias.join(", ")}`, c) };
}

export async function ejecutar({ cfg, log, raiz, args = [] }) {
  const t0 = Date.now();
  const ahora = new Date();
  const ruta = join(raiz, "data", "bandeja-victor.json");
  if (!existsSync(ruta)) {
    throw new Error("No hay bandeja que despachar. Marta (recepción) tiene que correr primero: node src/run.js recepcion");
  }
  const bandeja = JSON.parse(readFileSync(ruta, "utf8"));
  log(`Bandeja de ${bandeja.de}, corrida ${bandeja.corrida}`);

  const smtpListo = Boolean(cfg.SMTP_HOST && cfg.SMTP_USER && cfg.SMTP_PASS);
  const enviar = args.includes("--enviar") && smtpListo;
  // Mientras se afina el texto, todo va a una sola bandeja de prueba.
  const pruebaA = cfg.COMUNICACION_PRUEBA_A || cfg.REPORTE_PARA || "";
  const modoPrueba = !args.includes("--a-los-receptores");
  log(enviar
    ? `Modo ENVÍO${modoPrueba ? ` (de prueba: todo va a ${pruebaA})` : " REAL a cada receptor"}`
    : `Modo BORRADOR — ${smtpListo ? "falta --enviar" : "SMTP sin configurar"}. No sale ningún correo.`);

  const piezas = [];
  for (const r of bandeja.externo.receptores) {
    const { asunto, html } = correoExterno(r);
    piezas.push({ frente: "afuera", para: r.receptor, asunto, html, casos: r.total,
      companias: r.companias, establecimientos: r.establecimientos.length });
  }
  for (const r of bandeja.interno.receptores) {
    const { asunto, html } = correoInterno(r);
    piezas.push({ frente: "adentro", para: r.receptor, asunto, html, casos: r.total,
      companias: r.companias, establecimientos: 0 });
  }
  log(`${piezas.length} correos redactados: ${piezas.filter(p => p.frente === "afuera").length} afuera, ${piezas.filter(p => p.frente === "adentro").length} adentro`);

  // Los borradores siempre quedan en disco, se envíen o no.
  const fecha = ahora.toISOString().slice(0, 10);
  const carpeta = join(raiz, "reportes", `borradores-victor-${fecha}`);
  mkdirSync(carpeta, { recursive: true });
  piezas.forEach((p, i) => {
    const nombre = `${String(i + 1).padStart(3, "0")}-${p.frente}-${p.para.replace(/[^a-z0-9]+/gi, "_")}.html`;
    writeFileSync(join(carpeta, nombre), p.html);
    p.archivo = nombre;
  });
  log(`Borradores en reportes/borradores-victor-${fecha}/`);

  let enviados = 0;
  const fallos = [];
  if (enviar) {
    const nodemailer = (await import("nodemailer")).default;
    const port = Number(cfg.SMTP_PORT || 465);
    const tr = nodemailer.createTransport({
      host: cfg.SMTP_HOST, port, secure: port === 465,
      auth: { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS }
    });
    for (const p of piezas) {
      const destino = modoPrueba ? pruebaA : p.para;
      if (!destino) { fallos.push({ para: p.para, motivo: "sin destinatario" }); continue; }
      try {
        await tr.sendMail({
          from: cfg.REPORTE_DE || cfg.SMTP_USER, to: destino,
          subject: (modoPrueba ? `[PRUEBA · iba a ${p.para}] ` : "") + p.asunto,
          html: p.html
        });
        enviados++; p.enviadoA = destino;
      } catch (e) { fallos.push({ para: p.para, motivo: e.message }); }
    }
    log(`${enviados} enviados, ${fallos.length} fallos`);
  }

  const casosAfuera  = piezas.filter(p => p.frente === "afuera").reduce((s, p) => s + p.casos, 0);
  const casosAdentro = piezas.filter(p => p.frente === "adentro").reduce((s, p) => s + p.casos, 0);

  const alertas = [];
  if (!enviar) alertas.push({
    nivel: "alto",
    texto: `Los ${piezas.length} correos quedaron redactados pero NO se enviaron.`,
    detalle: [smtpListo
      ? "Falta el permiso explícito: node src/run.js comunicacion --enviar"
      : "Falta configurar SMTP en el archivo .env (use «Configurar correo.command»).",
      `Se pueden leer en reportes/borradores-victor-${fecha}/`]
  });
  if (enviar && modoPrueba) alertas.push({
    nivel: "alto",
    texto: `Envío de prueba: los ${enviados} correos fueron a ${pruebaA}, no a los receptores.`,
    detalle: ["Para que salgan de verdad, agregue --a-los-receptores."]
  });
  if (fallos.length) alertas.push({
    nivel: "critico", texto: `${fallos.length} correos no salieron.`,
    detalle: fallos.slice(0, 10).map(f => `${f.para} — ${f.motivo}`)
  });
  if (!alertas.length) alertas.push({ nivel: "ok", texto: `${enviados} correos despachados a sus receptores.`, detalle: [] });

  return {
    agente: meta.nombre,
    rol: meta.rol,
    titulo: "Avisos a los receptores y a los responsables internos",
    corrida: ahora.toISOString(),
    segundos: Math.round((Date.now() - t0) / 100) / 10,
    llamadasOdoo: 0,
    modo: enviar ? (modoPrueba ? "envío de prueba" : "envío real") : "borrador",
    totales: {
      correos: piezas.length,
      correosAfuera: piezas.filter(p => p.frente === "afuera").length,
      correosAdentro: piezas.filter(p => p.frente === "adentro").length,
      casosAfuera, casosAdentro, enviados
    },
    carpeta: `reportes/borradores-victor-${fecha}`,
    correos: piezas.map(({ html, ...resto }) => resto),
    alertas
  };
}
