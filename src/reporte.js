// Reporte HTML generico: cada bloque se dibuja solo si el agente lo trae.
const n = x => (typeof x === "number" ? x.toLocaleString("de-DE") : String(x ?? ""));
const esc = s => String(s ?? "").replace(/[<>&]/g, c => ({ "<":"&lt;", ">":"&gt;", "&":"&amp;" }[c]));
const COL = { critico:"#B3402E", alto:"#8A6410", ok:"#1B7F5E" };

export const ETIQUETA = {
  correosConProblema:"Correos con problema", causas:"Causas distintas", porConfiguracion:"Se arreglan con configuración", porEmisor:"Hay que pedírselo al emisor",
  porDatos:"Datos a corregir", sinArreglo:"Sin nada que corregir", sinCatalogar:"Causas sin catalogar",
  recurrentes:"Servicios recurrentes", faltantes:"Recurrentes sin factura del mes", desvios:"Montos fuera de lo normal",
  cuentas:"Cuentas de banco", alDia:"Conciliadas al día", atrasadas:"Con conciliación atrasada", soloBorradores:"Solo con borradores",
  nuncaConciliadas:"Nunca conciliadas", sinMovimiento:"Sin movimiento", borradores:"Conciliaciones en borrador", partidasPendientes:"Partidas pendientes", fechasFuturas:"Fechas en el futuro",
  notasSinLigar:"Notas de crédito sin ligar", ligables:"Con original encontrado", originalNoEsta:"Original no registrado", sinReferencia:"Sin referencia",
  compra:"De compra", venta:"De venta", seriesConHuecos:"Series de venta con huecos", consecutivosFaltantes:"Consecutivos faltantes",
  total:"Correos revisados", registradas:"Registrados como factura", tiquetes:"Tiquetes electrónicos",
  sinRegistrar:"Sin registrar", pctOk:"Tasa de registro (%)", companias:"Compañías",
  correosDone:"Correos dados por registrados", conClaveLegible:"Con clave legible",
  clavesUnicas:"Documentos únicos verificables", conAsiento:"Con factura en los libros",
  sinAsiento:"SIN factura en los libros", pctCuadrado:"Cuadratura (%)",
  companiasAfectadas:"Compañías afectadas", facturas:"Facturas revisadas",
  lineas:"Líneas revisadas", correctas:"Cuentas correctas", aCorregir:"Cuentas a corregir",
  sinCatalogo:"Artículos sin catálogo", aConsulta:"Líneas a consulta del contador", sinCriterio:"Sin criterio para objetar", aplicadas:"Correcciones aplicadas",
  receptores:"Receptores distintos", porReclamarAfuera:"Por reclamarle al establecimiento",
  porRevisarAdentro:"Por revisar adentro", correos:"Correos redactados",
  correosAfuera:"Correos hacia afuera", correosAdentro:"Correos hacia adentro",
  casosAfuera:"Casos que se reclaman afuera", casosAdentro:"Casos que se revisan adentro",
  enviados:"Correos enviados",
  avisosAfuera:"Avisos a girar afuera", avisosAdentro:"Avisos a girar adentro",
  cuentasPuente:"Cuentas puente revisadas", arrastran:"Arrastran saldo sin liquidar", saldoAFavor:"Crédito fiscal arrastrado", alReves:"Con saldo al revés",
  transitoriasConSaldo:"Transitorias con saldo", sinRegistro:"Compañías sin asientos en el mes", montoArrastrado:"Monto sin liquidar", companiasIva:"Compañías con IVA en el mes",
  ivaMalUbicado:"IVA en cuentas equivocadas", conBorradores:"Compañías con borradores del mes", difDeclaracion:"Diferencias con el Reporte IVA",
  cajasNegativas:"Cajas o bancos en negativo", ladoContrario:"Proveedores o clientes del lado contrario", anioSinCerrar:"Años anteriores sin cerrar",
  descuadres:"Balances que no cuadran", conPerdidaEnElAnio:"Con pérdida en el año",
  documentosAfuera:"Documentos distintos a reclamar", documentosAdentro:"Documentos distintos a revisar"
};

function tablaTotales(t){
  return `<table style="width:100%;border-collapse:collapse;margin-bottom:24px">` +
    Object.entries(t).map(([k, v]) => {
      const rojo = /sinAsiento|sinRegistrar|aCorregir|sinCatalogo|aConsulta|porReclamarAfuera|porRevisarAdentro/.test(k) && Number(v) > 0;
      return `<tr><td style="padding:7px 0;border-bottom:1px solid #E1E8E5;color:#3C4B47;font-size:14px">${esc(ETIQUETA[k] || k)}</td>
        <td style="padding:7px 0;border-bottom:1px solid #E1E8E5;text-align:right;font-weight:700;font-size:16px;color:${rojo ? "#B3402E" : "#0E1614"}">${n(v)}</td></tr>`;
    }).join("") + `</table>`;
}
const titulo = t => `<div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#6B7C77;font-weight:700;margin:24px 0 9px">${esc(t)}</div>`;

function tabla(cabeceras, filas){
  return `<table style="width:100%;border-collapse:collapse;background:#FFF"><tr>` +
    cabeceras.map((h, i) => `<th style="text-align:${i ? "right" : "left"};padding:8px 12px;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:#6B7C77;border-bottom:2px solid #C4D0CC">${esc(h)}</th>`).join("") +
    `</tr>` + filas.map(f => `<tr>` + f.map((c, i) =>
      `<td style="padding:8px 12px;border-bottom:1px solid #E1E8E5;font-size:${i ? 13 : 13}px;text-align:${i ? "right" : "left"};${i ? "" : "color:#0E1614"}">${c}</td>`).join("") + `</tr>`).join("") + `</table>`;
}

export function reporteHTML(r){
  const fecha = new Date(r.corrida).toLocaleString("es-CR", { dateStyle:"long", timeStyle:"short" });
  let h = `<!doctype html><html><body style="margin:0;background:#F4F7F5;font-family:Helvetica,Arial,sans-serif;color:#0E1614">
<div style="max-width:660px;margin:0 auto;padding:28px 22px">
  <div style="border-bottom:2px solid #0B4A3F;padding-bottom:16px;margin-bottom:22px">
    <div style="font-size:11px;letter-spacing:.15em;text-transform:uppercase;color:#0B4A3F;font-weight:700">Agente ${esc(r.agente)} · corrida diaria</div>
    <h1 style="margin:10px 0 0;font-size:25px;line-height:1.15">${esc(r.titulo || "Resultado de la corrida")}</h1>
    <div style="margin-top:8px;color:#6B7C77;font-size:13px">${esc(fecha)} · ${r.segundos}s · ${r.llamadasOdoo} consultas · ${r.modo || "solo lectura"}</div>
  </div>`;

  if (r.totales) h += tablaTotales(r.totales);

  if (r.alertas?.length){
    h += titulo("Alertas");
    h += r.alertas.map(a => `<div style="border-left:4px solid ${COL[a.nivel] || "#6B7C77"};background:#FFF;padding:12px 14px;margin-bottom:9px">
      <div style="font-weight:700;font-size:14px;color:${COL[a.nivel] || "#0E1614"}">${esc(a.texto)}</div>
      ${a.detalle?.length ? `<div style="margin-top:6px;font-size:12.5px;color:#3C4B47;line-height:1.6">${a.detalle.map(esc).join("<br>")}</div>` : ""}
    </div>`).join("");
  }

  if (r.porEstado?.length){
    h += titulo("Desenlace de cada correo");
    h += tabla(["Estado", "Significado", "Correos"], r.porEstado.map(e =>
      [`<span style="font-family:monospace;font-size:12px">${esc(e.estado)}</span>`, `<span style="font-size:12.5px;color:#3C4B47">${esc(e.descripcion)}</span>`, `<b>${n(e.correos)}</b>`]));
  }

  if (r.verificacionTiquetes){
    const v = r.verificacionTiquetes, mal = v.inconsistentes.length + v.coladosComoFactura.length;
    h += titulo("Control de tiquetes electronicos");
    h += `<div style="background:#FFF;padding:14px;font-size:13.5px;line-height:1.6;color:#3C4B47">
      De ${n(v.total)} correos marcados como tiquete, ${n(v.conClaveLegible)} exponen la clave completa y ${n(v.confirmadosTipo04)} traen el tipo <b>04</b>.
      <div style="margin-top:9px;font-weight:700;color:${mal ? "#B3402E" : "#1B7F5E"}">${esc(v.veredicto)}</div></div>`;
  }

  if (r.porTipoDocumento?.length){
    h += titulo("Que tipo de documento falta");
    h += tabla(["Tipo", "Documentos"], r.porTipoDocumento.map(t => [esc(t.tipo), `<b>${n(t.documentos)}</b>`]));
  }

  if (r.companias?.length){
    const c0 = r.companias[0];
    h += titulo("Compañías" + (c0.sinAsiento !== undefined ? " con documentos sin asiento" : " con menor tasa de registro"));
    h += c0.sinAsiento !== undefined
      ? tabla(["Compania", "Verificables", "Sin asiento", "%"], r.companias.slice(0, 15).map(c =>
          [esc(c.compania), n(c.verificables), `<b style="color:#B3402E">${n(c.sinAsiento)}</b>`, `${c.pct} %`]))
      : tabla(["Compania", "Correos", "Registrado", "Ultima ingesta"], r.companias.filter(c => c.total >= 20).slice(0, 12).map(c =>
          [esc(c.nombre), n(c.total),
           `<b style="color:${c.pctOk < 70 ? "#B3402E" : c.pctOk < 95 ? "#8A6410" : "#1B7F5E"}">${c.pctOk} %</b>`,
           `<span style="font-size:12px;color:#6B7C77">${c.ultimaIngesta ? esc(c.ultimaIngesta.slice(0,10)) : "nunca"}</span>`]));
  }


  if (r.receptores?.length){
    h += titulo("Receptores del buzón — quién tiene que mover qué");
    h += tabla(["Receptor", "Compañías", "Reclamar afuera", "Revisar adentro"], r.receptores.slice(0, 25).map(x =>
      [`<div style="font-size:12.5px"><b>${esc(x.receptor)}</b><br><span style="color:#6B7C77;font-size:11px">${esc(x.companias.slice(0,3).map(c=>c.compania).join(" · "))}${x.companias.length>3?` +${x.companias.length-3}`:""}</span></div>`,
       n(x.companias.length),
       `<b style="color:${x.porReclamarAfuera ? "#8A6410" : "#6B7C77"}">${n(x.porReclamarAfuera)}</b>`,
       `<b style="color:${x.porRevisarAdentro ? "#B3402E" : "#6B7C77"}">${n(x.porRevisarAdentro)}</b>`]));
    if (r.receptores.length > 25) h += `<div style="font-size:12px;color:#6B7C77;margin-top:6px">…y ${r.receptores.length - 25} receptores más en el JSON de la corrida.</div>`;
  }

  if (r.paraVictor){
    const ext = r.paraVictor.externo || [], int = r.paraVictor.interno || [];
    h += titulo("Paquetes entregados a Victor (comunicación)");
    h += `<div style="background:#FFF;padding:14px;font-size:13.5px;line-height:1.65;color:#3C4B47;margin-bottom:12px">
      <b style="color:#8A6410">Afuera</b> — ${n(ext.length)} receptores, ${n(ext.reduce((s,x)=>s+x.total,0))} documentos que hay que pedirle al establecimiento.<br>
      <b style="color:#B3402E">Adentro</b> — ${n(int.length)} receptores, ${n(int.reduce((s,x)=>s+x.total,0))} correos que tiene que revisar una persona de la compañía.<br>
      <span style="font-size:12px;color:#6B7C77">Marta solo consolida. El despacho lo hace Victor: <code>node src/run.js comunicacion</code></span></div>`;
    const top = ext.slice(0, 12).flatMap(rx => rx.establecimientos.slice(0, 3).map(e => [rx.receptor, e]));
    if (top.length){
      h += tabla(["Receptor", "Establecimiento a contactar", "Documentos"], top.map(([rec, e]) =>
        [`<span style="font-size:11.5px;color:#6B7C77">${esc(rec)}</span>`,
         `<span style="font-size:12.5px">${esc(e.establecimiento || (e.cedula ? "Cédula " + e.cedula : "no identificado"))}</span>`,
         `<b>${n(e.documentos.length)}</b>`]));
    }
  }

  if (r.correos?.length){
    h += titulo("Correos redactados");
    h += tabla(["Para", "Asunto", "Casos"], r.correos.slice(0, 30).map(c =>
      [`<div style="font-size:12px"><b>${esc(c.para)}</b><br><span style="color:${c.frente === "afuera" ? "#8A6410" : "#B3402E"};font-size:11px">${c.frente === "afuera" ? "al establecimiento" : "revisión interna"}</span></div>`,
       `<span style="font-size:11.5px;color:#3C4B47">${esc(c.asunto)}</span>`,
       `<b>${n(c.casos)}</b>`]));
  }

  if (r.propuestas?.length){
    h += titulo("Cuentas a corregir (primeras 25)");
    h += tabla(["Factura · linea", "Cuenta actual", "Deberia ser"], r.propuestas.slice(0, 25).map(p =>
      [`<div style="font-size:12.5px"><b>${esc(p.factura)}</b><br><span style="color:#6B7C77;font-size:11.5px">${esc(p.articulo)}</span></div>`,
       `<span style="font-size:11.5px;color:#B3402E">${esc(p.cuentaActual)}</span>`,
       `<span style="font-size:11.5px;color:#1B7F5E"><b>${esc(p.cuentaNueva)}</b></span>`]));
  }

  if (r.revisionHumana?.length){
    h += titulo("Necesitan revision humana (primeras 20)");
    h += tabla(["Factura", "Articulo", "Motivo"], r.revisionHumana.slice(0, 20).map(x =>
      [`<span style="font-size:12px">${esc(x.factura)}</span>`, `<span style="font-size:12px">${esc(x.articulo)}</span>`,
       `<span style="font-size:11.5px;color:#8A6410">${esc(x.motivo)}</span>`]));
  }

  h += `<div style="margin-top:26px;padding-top:16px;border-top:1px solid #D6E0DC;font-size:11.5px;color:#6B7C77;line-height:1.6">
    Generado por el agente ${esc(r.agente)} de la Oficina IASIMA. ${r.modo === "escritura" ? "Este agente modifico datos en Odoo." : "Consultas de solo lectura: no se modifico ningun dato."}
  </div></div></body></html>`;
  return h;
}

export function resumenTexto(r){
  const l = [`${r.agente} — ${new Date(r.corrida).toLocaleString("es-CR")}`];
  if (r.totales) for (const [k, v] of Object.entries(r.totales)) l.push(`  ${ETIQUETA[k] || k}: ${n(v)}`);
  l.push("");
  for (const a of r.alertas || []) l.push(`[${a.nivel.toUpperCase()}] ${a.texto}`);
  return l.join("\n");
}
