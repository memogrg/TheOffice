// AGENTE CUENTAS — el unico que modifica Odoo, y solo con permiso explicito.
//
// Entra a Contabilidad > Proveedores > Facturas de proveedores, abre factura por factura,
// revisa linea por linea el tab "Lineas de factura" y verifica que la cuenta contable
// corresponda al articulo segun el catalogo historico. Si no corresponde, la corrige.
//
//   Borrador  -> corrige las lineas -> Confirmar (queda Publicada)
//   Publicada -> Restablecer a borrador -> corrige -> Confirmar
//
// Nunca toca una factura pagada o conciliada. Lo que no reconoce lo manda a revision humana.
// Guarda en data/revisadas.json cuales ya reviso, para no repetir ni entrar en bucle.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Catalogo, canon, norm } from "../catalogo.js";

export const meta = {
  id: "cuentas", nombre: "CUENTAS", puesto: "Revisa las cuentas de cada linea",
  modelo: "account.move", escribe: true
};

const LINEAS_REALES = ["product", "other"];

// Cuentas "cajon de sastre": tenerlas ahi es un error evidente, sacarlas es siempre una mejora.
// Solo por estas se despublica una factura ya confirmada.
const CAJON_DE_SASTRE = ["5.04.999", "5.04.099", "5.04.99", "7.01.001", "7.01"];

export async function ejecutar({ odoo, cfg, log, raiz, args }){
  const t0 = Date.now();
  const aplicar = args.includes("--aplicar") && String(cfg.PERMITIR_ESCRITURA || "").toLowerCase() === "si";
  const pidioAplicar = args.includes("--aplicar");
  odoo.permitirEscritura = aplicar;
  const modo = aplicar ? "escritura" : "solo lectura (propuesta)";
  log(`Modo: ${modo}`);
  if (pidioAplicar && !aplicar) log("AVISO: pidio --aplicar pero PERMITIR_ESCRITURA no es 'si' en .env. Corre en propuesta.");

  await odoo.conectar();

  const cat = new Catalogo(join(raiz, "data", "catalogo-cuentas.json"), join(raiz, "data", "reglas.json"));
  log(`Catalogo: ${cat.articulosCliente} articulos por cliente, ${cat.articulosGlobal} globales, ${cat.nReglas} reglas humanas`);

  // --- compania a revisar
  const arg = (args.find(a => a.startsWith("--empresa=")) || "").split("=")[1];
  if (!arg) throw new Error("Indique la compania: --empresa=<id o nombre>. Por seguridad no se revisan las 72 de una vez.");
  const dom = /^\d+$/.test(arg) ? [["id", "=", Number(arg)]] : [["name", "ilike", arg]];
  const cias = await odoo.leer("res.company", "search_read", [dom, ["name"]]);
  if (!cias.length) throw new Error(`No encontre la compania "${arg}".`);
  const cia = cias[0], CID = cia.id, ctx = { context: { allowed_company_ids: [CID] } };
  log(`Compania: ${cia.name} (id ${CID})`);

  // --- plan de cuentas de esa compania
  const ctas = await odoo.leer("account.account", "search_read",
    [[["company_ids", "in", [CID]]], ["code", "name", "account_type", "deprecated"]], { ...ctx, limit: 4000 });
  const porCodigo = new Map();
  for (const c of ctas) if (!c.deprecated) porCodigo.set(canon(c.code), c);
  const porNombre = new Map();
  for (const c of ctas) if (!c.deprecated) porNombre.set(norm(c.name), c);
  const porId = new Map();
  for (const c of ctas) porId.set(c.id, c);
  log(`${ctas.length} cuentas en el plan de la compania`);

  const resolverCuenta = d => porCodigo.get(d.codigo) || porNombre.get(norm(d.cuenta)) || null;

  // --- memoria de lo ya revisado
  const rutaMem = join(raiz, "data", "revisadas.json");
  const mem = existsSync(rutaMem) ? JSON.parse(readFileSync(rutaMem, "utf8")) : {};
  const rehacer = args.includes("--revisar-todo");

  // --- facturas de proveedor
  const facturas = await odoo.leer("account.move", "search_read",
    [[["move_type", "in", ["in_invoice", "in_refund"]], ["company_id", "=", CID], ["state", "in", ["draft", "posted"]]],
     ["name", "state", "payment_state", "partner_id", "invoice_date", "amount_total", "ref"]],
    { ...ctx, limit: 2000, order: "invoice_date desc" });
  log(`${facturas.length} facturas de proveedor (borrador + publicadas)`);

  const propuestas = [], revisionHumana = [], aplicadas = [], fallos = [];
  const censo = new Map(), segundaOpinion = new Map();
  let nLineas = 0, nCorrectas = 0, nSaltadas = 0, nFacturasRevisadas = 0;

  for (const f of facturas){
    const memk = String(f.id);
    if (!rehacer && mem[memk] && mem[memk].estado === "ok"){ nSaltadas++; continue; }

    const lineas = await odoo.leer("account.move.line", "search_read",
      [[["move_id", "=", f.id], ["display_type", "in", LINEAS_REALES]],
       ["name", "account_id", "product_id", "display_type", "balance", "other_charge_id"]], ctx);
    if (!lineas.length){ mem[memk] = { fecha: new Date().toISOString(), estado: "ok", lineas: 0, corregidas: 0 }; continue; }

    nFacturasRevisadas++;
    const arreglos = [], dudas = [];
    for (const l of lineas){
      nLineas++;
      const texto = l.name || (l.product_id ? l.product_id[1] : "");
      const d = cat.resolver(cia.name, texto);
      if (!d){
        dudas.push({ lineaId: l.id, articulo: String(texto).slice(0, 70),
                     motivo: "el articulo no esta en el catalogo", cuentaActual: l.account_id ? l.account_id[1] : "(sin cuenta)" });
        continue;
      }
      const destino = resolverCuenta(d);
      if (!destino){
        dudas.push({ lineaId: l.id, articulo: String(texto).slice(0, 70),
                     motivo: `el catalogo pide ${d.codigo} ${d.cuenta}, pero esa cuenta no existe en el plan de ${cia.name}`,
                     cuentaActual: l.account_id ? l.account_id[1] : "(sin cuenta)" });
        continue;
      }
      const actual = l.account_id ? l.account_id[0] : null;
      const nomActual = l.account_id ? l.account_id[1] : "(sin cuenta)";
      censo.set(nomActual, (censo.get(nomActual) || 0) + 1);
      if (actual === destino.id){
        nCorrectas++;
        // Segunda opinion: que hacen las OTRAS companias con este mismo articulo.
        // El historico del propio cliente puede estar repitiendo una mala costumbre.
        const g = cat.global[norm(texto)];
        if (g && !nomActual.includes(g[1])){
          const k = nomActual + " -> " + g[1];
          const e = segundaOpinion.get(k) || { de: nomActual, a: g[1], lineas: 0, monto: 0, ejemplos: [] };
          e.lineas++; e.monto += (l.balance || 0);
          if (e.ejemplos.length < 3) e.ejemplos.push(String(texto).slice(0, 40));
          segundaOpinion.set(k, e);
        }
        continue;
      }
      if (d.confianza < 0.9){
        dudas.push({ lineaId: l.id, articulo: String(texto).slice(0, 70),
                     motivo: `parecido no seguro (${d.confianza}) a "${d.parecidoA || ""}" -> ${d.cuenta}`,
                     cuentaActual: l.account_id ? l.account_id[1] : "(sin cuenta)" });
        continue;
      }
      // Salvaguarda: una factura ya publicada solo se despublica cuando la cuenta actual
      // es un cajon de sastre. Cambiar una cuenta especifica por otra en un asiento
      // confirmado es un criterio contable, no una correccion mecanica.
      const ctaActual = actual ? porId.get(actual) : null;
      const esCajon = ctaActual && CAJON_DE_SASTRE.includes(canon(ctaActual.code));
      if (f.state === "posted" && !esCajon && d.fuente !== "regla-humana"){
        dudas.push({ lineaId: l.id, articulo: String(texto).slice(0, 70),
                     motivo: `factura ya publicada y la cuenta actual no es un cajon de sastre; el catalogo sugiere ${d.cuenta}. Decision contable, no mecanica.`,
                     cuentaActual: l.account_id ? l.account_id[1] : "(sin cuenta)" });
        continue;
      }
      arreglos.push({ lineaId: l.id, cargoId: l.other_charge_id ? l.other_charge_id[0] : null,
                      articulo: String(texto).slice(0, 70),
                      cuentaActualId: actual, cuentaActual: l.account_id ? l.account_id[1] : "(sin cuenta)",
                      cuentaNuevaId: destino.id, cuentaNueva: `${destino.code} ${destino.name}`,
                      fuente: d.fuente, confianza: d.confianza });
    }

    const etiqueta = `${f.name || "(sin numero)"} · ${f.partner_id ? f.partner_id[1] : ""}`;
    for (const a of arreglos) propuestas.push({ facturaId: f.id, factura: etiqueta, estado: f.state, ...a });
    for (const x of dudas) revisionHumana.push({ facturaId: f.id, factura: etiqueta, estado: f.state, ...x });

    if (!arreglos.length){
      mem[memk] = { fecha: new Date().toISOString(), estado: dudas.length ? "con-dudas" : "ok",
                    lineas: lineas.length, corregidas: 0, dudas: dudas.length };
      continue;
    }

    if (!aplicar){
      mem[memk] = { fecha: new Date().toISOString(), estado: "propuesto", lineas: lineas.length,
                    corregidas: 0, porCorregir: arreglos.length, dudas: dudas.length };
      continue;
    }

    // --- aplicar
    if (f.payment_state && f.payment_state !== "not_paid"){
      fallos.push({ facturaId: f.id, factura: etiqueta, motivo: `no se toca: estado de pago "${f.payment_state}"` });
      mem[memk] = { fecha: new Date().toISOString(), estado: "saltada-pagada", lineas: lineas.length, corregidas: 0 };
      continue;
    }
    try {
      if (f.state === "posted"){ await odoo.leer("account.move", "button_draft", [[f.id]], ctx); log(`  ${etiqueta}: restablecida a borrador`); }
      for (const a of arreglos){
        // Los "Otros cargos" no viven en la linea de factura sino en bdt.other.charge.line.
        // Escribir en la linea no sirve: Odoo la recalcula al publicar.
        if (a.cargoId) await odoo.leer("bdt.other.charge.line", "write", [[a.cargoId], { account_id: a.cuentaNuevaId }], ctx);
        await odoo.leer("account.move.line", "write", [[a.lineaId], { account_id: a.cuentaNuevaId }], ctx);
      }
      await odoo.leer("account.move", "action_post", [[f.id]], ctx);

      // VERIFICACION: releer y confirmar que la cuenta quedo donde debia.
      const despues = await odoo.leer("account.move.line", "search_read",
        [[["move_id", "=", f.id], ["display_type", "in", LINEAS_REALES]], ["name", "account_id"]], ctx);
      const noPego = [];
      for (const a of arreglos){
        const igual = despues.find(x => norm(x.name) === norm(a.articulo));
        if (!igual || !igual.account_id || igual.account_id[0] !== a.cuentaNuevaId)
          noPego.push({ articulo: a.articulo, quedoEn: igual && igual.account_id ? igual.account_id[1] : "(no encontrada)" });
      }
      const pegaron = arreglos.length - noPego.length;
      if (noPego.length){
        fallos.push({ facturaId: f.id, factura: etiqueta,
                      motivo: `${noPego.length} de ${arreglos.length} lineas revirtieron: ${noPego.map(x => x.articulo + " quedo en " + x.quedoEn).join("; ").slice(0, 120)}` });
        log(`  ${etiqueta}: ${pegaron}/${arreglos.length} corregidas — ${noPego.length} revirtieron`);
      } else log(`  ${etiqueta}: ${arreglos.length} lineas corregidas y confirmada`);
      if (pegaron) aplicadas.push({ facturaId: f.id, factura: etiqueta, corregidas: pegaron });
      mem[memk] = { fecha: new Date().toISOString(), estado: noPego.length ? "parcial" : "corregida",
                    lineas: lineas.length, corregidas: pegaron, revirtieron: noPego.length, dudas: dudas.length };
    } catch (e){
      fallos.push({ facturaId: f.id, factura: etiqueta, motivo: e.message.slice(0, 160) });
      mem[memk] = { fecha: new Date().toISOString(), estado: "fallo", error: e.message.slice(0, 160) };
      log(`  ${etiqueta}: FALLO — ${e.message.slice(0, 90)}`);
    }
  }

  writeFileSync(rutaMem, JSON.stringify(mem, null, 2));
  log(`Memoria: ${Object.keys(mem).length} facturas registradas como revisadas`);

  // Concentracion: si casi todo cae en una sola cuenta, nadie clasifico nada.
  const totalCensadas = [...censo.values()].reduce((a, b) => a + b, 0);
  const top = [...censo.entries()].sort((a, b) => b[1] - a[1])[0];
  const concentracion = top && totalCensadas ? { cuenta: top[0], lineas: top[1],
    pct: Math.round((top[1] / totalCensadas) * 1000) / 10 } : null;
  const opiniones = [...segundaOpinion.values()].sort((a, b) => b.lineas - a.lineas);

  const alertas = [];
  if (concentracion && concentracion.pct >= 60) alertas.push({
    nivel: "alto",
    texto: `${concentracion.pct} % de las lineas estan en una sola cuenta: ${concentracion.cuenta}. Eso no es clasificar, es acumular.`,
    detalle: ["El catalogo no lo detecta como error porque aprendio esa misma costumbre de esta compania."]
  });
  if (opiniones.length) alertas.push({
    nivel: "alto",
    texto: `${opiniones.reduce((a, o) => a + o.lineas, 0)} lineas que el propio historico da por buenas, pero las otras companias registran distinto.`,
    detalle: opiniones.slice(0, 8).map(o => `${o.lineas} lineas · ¢${Math.round(Math.abs(o.monto)).toLocaleString("de-DE")} — ${o.de.split(" ").slice(1).join(" ")} -> ${o.a} (ej: ${o.ejemplos[0]})`)
  });
  if (revisionHumana.length) alertas.push({
    nivel: "alto",
    texto: `${revisionHumana.length} lineas que el agente no pudo cerrar solo. Necesitan que una persona diga la cuenta.`,
    detalle: revisionHumana.slice(0, 8).map(x => `${x.factura} — "${x.articulo}" (${x.motivo})`)
  });
  if (propuestas.length && !aplicar) alertas.push({
    nivel: "alto",
    texto: `${propuestas.length} lineas tienen la cuenta equivocada. Nada se cambio: el agente solo propone.`,
    detalle: [`Para aplicarlas: PERMITIR_ESCRITURA=si en .env y correr con --aplicar`]
  });
  if (aplicadas.length) alertas.push({
    nivel: "ok", texto: `${aplicadas.length} facturas corregidas y confirmadas.`,
    detalle: aplicadas.slice(0, 8).map(a => `${a.factura} — ${a.corregidas} lineas`)
  });
  if (fallos.length) alertas.push({
    nivel: "critico", texto: `${fallos.length} facturas no se pudieron cerrar.`,
    detalle: fallos.slice(0, 8).map(f => `${f.factura} — ${f.motivo}`)
  });
  if (!alertas.length) alertas.push({ nivel: "ok", texto: `Listo. Todas las cuentas de ${cia.name} estan bien.`, detalle: [] });

  return {
    agente: meta.nombre, titulo: `Cuentas de ${cia.name}`, corrida: new Date().toISOString(),
    segundos: Math.round((Date.now() - t0) / 100) / 10, llamadasOdoo: odoo.llamadas, modo,
    compania: cia.name, companiaId: CID,
    totales: {
      facturas: nFacturasRevisadas, lineas: nLineas, correctas: nCorrectas,
      aCorregir: propuestas.length, sinCatalogo: revisionHumana.length, aplicadas: aplicadas.length
    },
    saltadasPorMemoria: nSaltadas, concentracion, segundaOpinion: opiniones.slice(0, 40),
    propuestas, revisionHumana, aplicadas, fallos, alertas
  };
}
