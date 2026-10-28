// EL DIRECTOR por modelo de lenguaje. Recibe una instrucción en palabras, decide qué
// agente la atiende, lo ejecuta con herramientas y responde con cifras.
//
// Principios (los mismos de toda la oficina):
//   · Determinismo en el centro: las herramientas son los agentes y la base de datos.
//     El modelo no inventa cifras, las pide.
//   · Humano en cada escritura: NO EXISTE herramienta que escriba en Odoo ni que envíe
//     correo. Cuentas corre en modo propuesta, Comunicación en modo borrador. Aprobar y
//     aplicar sigue siendo trabajo de una persona en la pestaña Aprobaciones.
//   · Sin dependencias: la API de Claude se llama con fetch.
//
// Configuración (.env): CLAUDE_API_KEY (obligatoria para este Director; sin ella el servicio
// usa el Director de palabras clave), CLAUDE_WORKSPACE_ID (solo si la clave es de usuario,
// sk-ant-usr-…), DIRECTOR_MODELO (por defecto claude-sonnet-4-5), DIRECTOR_MAX_PASOS (12).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { causasDominantes } from "../lib/correo.js";
import { DirectorCore } from "../director.js";
import { Catalogo, canon, norm } from "../catalogo.js";
import { proponerRegla } from "./reglas.js";
import * as asientosSrv from "./asientos.js";
import * as cambiosSrv from "./cambios.js";
import * as diferidosSrv from "./diferidos.js";
import * as activosSrv from "./activos.js";
import * as cierreMesSrv from "./cierreMes.js";
import { Clasificador, resolverEnPlan } from "../clasificador.js";

const API = "https://api.anthropic.com/v1/messages";

export class DirectorLLM {
  constructor({ db, corridas, cfg, raiz, log = () => {}, fetchImpl = globalThis.fetch }) {
    this.db = db; this.corridas = corridas; this.cfg = cfg; this.raiz = raiz; this.log = log; this.fetch = fetchImpl;
    this.modelo = cfg.DIRECTOR_MODELO || "claude-sonnet-4-5";
    this.maxPasos = Number(cfg.DIRECTOR_MAX_PASOS || 12);
    // Memoria: cuántos turnos recientes van completos (con resultados de herramientas) y el tope
    // de caracteres del historial que se manda al modelo. Lo anterior se conserva como texto.
    this.turnosCompletos = Number(cfg.DIRECTOR_TURNOS_COMPLETOS || 6);
    this.maxContexto = Number(cfg.DIRECTOR_MAX_CONTEXTO || 160_000);
    this.retencionDias = Number(cfg.DIRECTOR_RETENCION_DIAS || 30);
    this.roster = leerJSON(join(raiz, "data", "roster.json"), { agentes: [], noConstruidos: [] });
  }

  get disponible() { return Boolean(this.cfg.CLAUDE_API_KEY); }

  // --- Las herramientas. Solo lectura y propuesta. -----------------------------------
  herramientas() {
    return [
      { name: "companias", description: "Lista las compañías de la instancia (id y nombre). Úsala para resolver el nombre que dio el usuario a un id antes de llamar a cuentas o filtrar casos.",
        input_schema: { type: "object", properties: { buscar: { type: "string", description: "texto a buscar en el nombre (opcional)" } } } },
      { name: "estado", description: "Estado general: última corrida de cada agente con sus totales y alertas, casos abiertos por frente/receptor/compañía, pendientes de aprobación.",
        input_schema: { type: "object", properties: {} } },
      { name: "correr_agente", description: "Ejecuta un agente contra Odoo AHORA y devuelve sus totales y alertas. recepcion (Marta): buzón de todas las compañías. conciliacion: correos registrados sin asiento. cuentas: propone cuentas contables de UNA compañía (obligatorio empresa), solo propone. comunicacion (Victor): redacta borradores a partir de la última corrida de Marta, no envía. diagnostico: por qué fallan los correos del buzón (causa, qué hacer, quién; periodos fiscales por abrir). recurrentes: servicios que llegan todos los meses y faltaron o vinieron con monto anormal en el último mes cerrado. bancos: estado de las conciliaciones bancarias por cuenta (atrasadas, borradores, nunca conciliadas). documentos: notas de crédito sin ligar a su factura (propone el vínculo) y huecos en consecutivos de venta. cierre: cuentas puente (salarios, CCSS, IVA, retenciones, renta, transitorias) que arrastran saldo sin liquidar y cuadre de IVA del mes (débito, crédito, IVA en cuentas equivocadas, borradores). estados: balance de situación y estado de resultados por compañía al cierre del mes (cajas en negativo, proveedores del lado contrario, años sin cerrar). cambiario: revalúa a fin de mes los saldos en dólares (bancos en moneda extranjera, clientes y proveedores abiertos) y propone el asiento de diferencial cambiario con reversión el día 1. diferidos: arma el asiento del mes con la cuota de cada gasto diferido registrado (y las atrasadas). depreciacion: arma el asiento de depreciación del mes de los activos fijos registrados (no lo propone si la compañía ya depreció a mano ese mes). cartera: antigüedad de cuentas por cobrar y por pagar por compañía, clientes morosos, pagos que vencen pronto; redacta recordatorios de cobro (borradores en Correos, no envía). datos: calidad de los contactos (cédulas repetidas, inválidas o faltantes, clientes sin correo, posibles duplicados por nombre). extractos: empareja los extractos bancarios subidos en la app con los libros, propone asientos de cargos bancarios, intereses y transferencias propias, y sugiere la factura de cada cobro o pago sin registrar. hacienda: prepara por compañía las declaraciones de TRIBU-CR del último mes cerrado (IVA formulario 150, informativa 270 y el acumulado de renta 102) con el juez de reglas; quedan en la pestaña Hacienda. Tarda de 5 a 60 segundos.",
        input_schema: { type: "object", properties: { agente: { type: "string", enum: ["recepcion", "conciliacion", "cuentas", "comunicacion", "diagnostico", "recurrentes", "bancos", "documentos", "cierre", "estados", "cambiario", "diferidos", "depreciacion", "cartera", "datos", "extractos", "hacienda"] }, empresa: { type: "integer", description: "id de compañía, obligatorio para cuentas" } }, required: ["agente"] } },
      { name: "casos", description: "Casos abiertos que dejó Recepción (uno por documento y receptor): tiquetes, rechazados, duplicados, errores, en cola, cédulas inválidas. Filtra por receptor (correo), compañía (id) o frente (afuera = reclamar al establecimiento; adentro = revisar en la compañía).",
        input_schema: { type: "object", properties: { receptor: { type: "string" }, compania: { type: "integer" }, frente: { type: "string", enum: ["afuera", "adentro"] }, seguimiento: { type: "string", enum: ["abierto", "resuelto", "cerrado", "todos"] }, limite: { type: "integer" } } } },
      { name: "propuestas", description: "Propuestas de corrección de cuenta contable del agente Cuentas, con su estado (propuesta, aprobada, rechazada, aplicada, fallo).",
        input_schema: { type: "object", properties: { estado: { type: "string" }, compania: { type: "integer" } } } },
      { name: "correos", description: "Correos redactados por Victor y su estado (borrador, aprobado, enviado, rechazado). No incluye el HTML.",
        input_schema: { type: "object", properties: { estado: { type: "string" } } } },
      { name: "causas_errores", description: "Agrupa los correos en estado error por causa (texto del error normalizado). Es el adelanto del agente Diagnóstico, que todavía no está construido.",
        input_schema: { type: "object", properties: { compania: { type: "integer" } } } },
      { name: "hallazgos", description: "Detalle de la última corrida de un agente de la fase 3A sin volver a correrlo: diagnostico (causas y pendientes concretos: qué mes abrir, qué impuesto crear), recurrentes (faltantes y desvíos), bancos (cuentas atrasadas, borradores), documentos (notas de crédito y consecutivos), cierre (cuentas puente con saldo viejo, IVA del mes por compañía) estados (balance y resultados de una compañía: pasá compania) o cambiario (diferencial cambiario del mes por compañía) diferidos (cuotas del mes y atrasos), depreciacion (activos y lo ya depreciado a mano) cartera (antigüedad por compañía, morosos, pagos próximos) o datos (contactos duplicados, sin cédula, sin correo) o extractos (por banco: líneas en libros y pendientes, saldo del extracto contra libros; cobros y pagos sin registrar con la factura que calza) o hacienda (resumen de las declaraciones del periodo: compañía, impuesto a pagar, semáforo). Filtra por compañía (id).",
        input_schema: { type: "object", properties: { agente: { type: "string", enum: ["diagnostico", "recurrentes", "bancos", "documentos", "cierre", "estados", "cambiario", "diferidos", "depreciacion", "cartera", "datos", "extractos", "hacienda"] }, compania: { type: "integer" } }, required: ["agente"] } },
      { name: "consultas", description: "Consultas al contador que dejó el agente Cuentas (paso 3 y 4 de la guía de clasificación): líneas con historial dividido o que choca con la naturaleza, gasto que parece personal, o sin identificar en un comodín. Cada una trae cuenta actual, sugerida y motivo.",
        input_schema: { type: "object", properties: { compania: { type: "integer" }, estado: { type: "string", enum: ["abierta", "resuelta", "descartada", "cerrada", "todas"] } } } },
      { name: "revisar_factura", description: "Revisa UNA factura de proveedor línea por línea con el criterio del agente Cuentas: para cada línea devuelve la cuenta actual y la cuenta que el catálogo histórico de esa compañía (o una regla humana) sugiere, con fuente y confianza, si esa cuenta existe en el plan de la compañía y qué hacen las demás compañías con el mismo artículo. Úsala cuando pregunten en qué cuenta debería ir una factura o sus ítems. Solo lee y propone; no cambia nada.",
        input_schema: { type: "object", properties: { factura: { type: "integer", description: "id de account.move" }, nombre: { type: "string", description: "número de la factura (name) o parte, si no se sabe el id" }, proveedor: { type: "string", description: "nombre del proveedor, para acotar la búsqueda por nombre" }, compania: { type: "integer", description: "id de compañía, para acotar la búsqueda" } } } },
      { name: "proponer_regla", description: "Deja PROPUESTA una regla contable que la persona dictó («todo lo de Rostipollos va a 5.04.17.01», «este artículo siempre a tal cuenta»). No escribe en Odoo: queda en Aprobaciones → Reglas; cuando un contable la aprueba se guarda como regla humana y el agente Cuentas vuelve a revisar esa compañía y propone el cambio de cada línea afectada. Alcance: por proveedor (todo lo que factura ese proveedor a esa compañía), por artículo (una o varias descripciones exactas de línea) o por tipo de gasto (naturaleza: «toda comida de restaurante, de cualquier proveedor»). Validá antes que el código exista en el plan de esa compañía (la herramienta también lo valida).",
        input_schema: { type: "object", properties: { compania: { type: "integer", description: "id de la compañía (cliente) a la que aplica" }, codigo: { type: "string", description: "código de la cuenta destino, p. ej. 5.04.17.01" }, proveedor_id: { type: "integer", description: "id de res.partner del proveedor (regla por proveedor)" }, articulos: { type: "array", items: { type: "string" }, description: "descripciones de línea (regla por artículo)" }, naturaleza: { type: "string", description: "tipo de gasto (regla por naturaleza, p. ej. alimentacion-restaurante, alimentacion-supermercado, combustible): aplica a toda línea de esa naturaleza en esa compañía, de cualquier proveedor" }, motivo: { type: "string", description: "la decisión en palabras de la persona" }, factura: { type: "integer", description: "id de la factura que originó la regla (opcional)" } }, required: ["compania", "codigo", "motivo"] } },
      { name: "asientos", description: "Asientos de diario propuestos (fase 3B: sin comprobante electrónico) y su estado: propuesta, aprobada, rechazada, aplicada, fallo, obsoleta. Los deja el agente Cierre (liquidar salarios, CCSS, IVA o retenciones que arrastran saldo, con la contrapartida que esa cuenta usó antes) o se dictan con proponer_asiento.",
        input_schema: { type: "object", properties: { estado: { type: "string", enum: ["abiertos", "propuesta", "aprobada", "rechazada", "aplicada", "fallo", "obsoleta", "todos"] }, compania: { type: "integer" } } } },
      { name: "proponer_asiento", description: "Deja PROPUESTO un asiento de diario que la persona dictó («registrá el pago de la CCSS de enero de X por 1.250.000 contra el BNCR»). No escribe en Odoo: queda en Aprobaciones → Asientos para que un contable lo apruebe. Las cuentas van por código del plan de esa compañía (buscalo antes con leer_odoo en account.account con compania si no lo sabés); tiene que cuadrar. Sin diario usa el general de la compañía.",
        input_schema: { type: "object", properties: { compania: { type: "integer" }, fecha: { type: "string", description: "AAAA-MM-DD" }, diario: { type: "string", description: "id o nombre del diario (opcional)" },
          referencia: { type: "string" }, motivo: { type: "string", description: "por qué, en palabras de la persona" },
          lineas: { type: "array", items: { type: "object", properties: { codigo: { type: "string" }, descripcion: { type: "string" }, debito: { type: "number" }, credito: { type: "number" } }, required: ["codigo"] } } },
          required: ["compania", "fecha", "lineas", "motivo"] } },
      { name: "proponer_cambio_masivo", description: "Deja PROPUESTO un cambio al plan de cuentas en varias compañías a la vez («renombrá la 5.04.17.01 a Alimentación y viáticos en todos los clientes», «creá la 1.01.012.003 Saldo a favor IVA en todas», «marcá obsoleta la 5.04.99 en los clientes de X»). tipo: renombrar | recodificar | crear | obsoleta. Lee el plan de cada compañía y arma la previsualización (nombre actual, conflictos, compañías donde ese código significa otra cosa). No escribe en Odoo: queda en Aprobaciones → Cambios al plan de cuentas. Si sabés cómo se llama hoy la cuenta, pasá nombre_actual para dejar fuera las compañías donde el código es otra cosa.",
        input_schema: { type: "object", properties: { tipo: { type: "string", enum: cambiosSrv.TIPOS }, codigo: { type: "string" }, nombre_actual: { type: "string" },
          nuevo_codigo: { type: "string" }, nuevo_nombre: { type: "string" }, tipo_cuenta: { type: "string", enum: cambiosSrv.TIPOS_CUENTA, description: "solo para crear" },
          companias: { type: "array", items: { type: "integer" }, description: "ids; vacío = todas" }, excluir: { type: "array", items: { type: "integer" } }, motivo: { type: "string" } },
          required: ["tipo", "codigo", "motivo"] } },
      { name: "cambios_masivos", description: "Cambios masivos al plan de cuentas propuestos y su estado, con el resumen por compañía.",
        input_schema: { type: "object", properties: { estado: { type: "string", enum: ["abiertos", "propuesta", "aprobada", "rechazada", "aplicada", "parcial", "fallo", "todos"] } } } },
      { name: "registrar_diferido", description: "Registra un gasto diferido (póliza, alquiler o licencia pagados por adelantado) en la app: compañía, descripción, cuenta del activo diferido y cuenta del gasto (por código del plan de esa compañía), monto, meses e inicio (AAAA-MM de la primera cuota). No escribe en Odoo: cada mes el agente Diferidos propone el asiento con la cuota, que pasa por Aprobaciones.",
        input_schema: { type: "object", properties: { compania: { type: "integer" }, descripcion: { type: "string" }, cuenta_activo: { type: "string" }, cuenta_gasto: { type: "string" },
          monto: { type: "number" }, meses: { type: "integer" }, inicio: { type: "string" }, referencia: { type: "string" } }, required: ["compania", "descripcion", "cuenta_activo", "cuenta_gasto", "monto", "meses", "inicio"] } },
      { name: "diferidos", description: "Gastos diferidos registrados, con avance (cuotas registradas, saldo por amortizar, mes final).",
        input_schema: { type: "object", properties: { compania: { type: "integer" } } } },
      { name: "registrar_activo", description: "Registra un activo fijo en la app para depreciarlo: compañía, descripción, cuentas por código (depreciación acumulada y gasto por depreciación; la del activo es opcional), costo, valor residual, vida útil en meses (o años), mes de inicio y, si ya se venía depreciando a mano, el mes hasta el que ya está depreciado. No escribe en Odoo.",
        input_schema: { type: "object", properties: { compania: { type: "integer" }, descripcion: { type: "string" }, categoria: { type: "string" }, cuenta_activo: { type: "string" },
          cuenta_acumulada: { type: "string" }, cuenta_gasto: { type: "string" }, costo: { type: "number" }, residual: { type: "number" }, vida_meses: { type: "integer" }, vida_anios: { type: "number" },
          inicio: { type: "string" }, depreciado_hasta: { type: "string" }, referencia: { type: "string" } }, required: ["compania", "descripcion", "cuenta_acumulada", "cuenta_gasto", "costo", "inicio"] } },
      { name: "activos", description: "Activos fijos registrados con su depreciación acumulada, valor en libros y meses que faltan.",
        input_schema: { type: "object", properties: { compania: { type: "integer" } } } },
      { name: "cierre_mes", description: "Lista de cierre de mes por compañía: junta lo que encontraron los agentes (buzón, periodos, recurrentes, notas de crédito, cuentas, borradores, bancos, movimientos del extracto, cuentas puente, IVA, diferencial, diferidos, depreciación, asientos, estados) y dice qué falta para cerrar cada cliente y qué ya está cerrado. Sin compania: resumen de todas.",
        input_schema: { type: "object", properties: { compania: { type: "integer" }, mes: { type: "string", description: "AAAA-MM; vacío = el del último Cierre" } } } },
      { name: "leer_odoo", description: "Lectura directa de Odoo (search_read) con un dominio. SOLO LECTURA. Modelos útiles: bdt.invoice.email (buzón), account.move (asientos; e_key es la clave de Hacienda), account.move.line, res.partner (vat = cédula), res.company, account.account. OJO: en account.account el campo code depende de la compañía; pasá siempre compania o vendrá code=false. Máximo 200 filas; para conteos usa agrupar_odoo.",
        input_schema: { type: "object", properties: { modelo: { type: "string" }, dominio: { type: "array", description: "dominio Odoo, p. ej. [[\"state\",\"=\",\"done\"],[\"company_id\",\"=\",126]]" }, campos: { type: "array", items: { type: "string" } }, limite: { type: "integer" }, orden: { type: "string" }, compania: { type: "integer", description: "id de compañía para leer en su contexto (códigos de cuenta, campos por compañía)" } }, required: ["modelo", "dominio", "campos"] } },
      { name: "agrupar_odoo", description: "Conteos y agregados en Odoo (read_group). SOLO LECTURA. Ej.: correos por estado y compañía: modelo bdt.invoice.email, agrupar [\"company_id\",\"state\"].",
        input_schema: { type: "object", properties: { modelo: { type: "string" }, dominio: { type: "array" }, agrupar: { type: "array", items: { type: "string" } }, campos: { type: "array", items: { type: "string" }, description: "agregados como \"date:max\" o \"amount_total:sum\"" }, compania: { type: "integer", description: "id de compañía para leer en su contexto" } }, required: ["modelo", "dominio", "agrupar"] } }
    ];
  }

  async ejecutarHerramienta(nombre, args, quien) {
    const db = this.db;
    switch (nombre) {
      case "companias": {
        const lista = leerJSON(join(this.raiz, "data", "companias.json"), []);
        const q = (args.buscar || "").toLowerCase();
        return lista.filter(c => !q || c.name.toLowerCase().includes(q)).map(c => ({ id: c.id, nombre: c.name })).slice(0, 100);
      }
      case "estado": {
        const ultimas = {};
        for (const a of ["recepcion", "comunicacion", "conciliacion", "cuentas", "diagnostico", "recurrentes", "bancos", "documentos", "cierre", "estados", "cambiario", "diferidos", "depreciacion", "cartera", "datos", "extractos", "hacienda"]) {
          const u = db.ultimaCorrida(a);
          ultimas[a] = u ? { corrida: u.id, fin: u.fin, compania: u.compania, totales: u.totales, alertas: (u.alertas || []).map(x => x.texto), porEstado: u.resultado?.porEstado } : null;
        }
        return { ultimas, casos: db.resumenCasos(), pendientes: { propuestas: db.propuestas({ estado: "propuesta" }).length, correosBorrador: db.correos({ estado: "borrador" }).length } };
      }
      case "correr_agente": {
        const a = args.agente;
        const extra = [];
        if (a === "cuentas") {
          if (!args.empresa) return { error: "Para cuentas hay que indicar la compañía (empresa = id). Por seguridad se revisa una a la vez." };
          extra.push(`--empresa=${args.empresa}`);
        }
        // Nunca --aplicar ni --enviar: el Director solo lee y propone.
        const { corridaId, resultado, resumen } = await this.corridas.correr(a, extra, { quienPide: `director:${quien}` });
        return { corridaId, resumen, totales: resultado.totales, alertas: resultado.alertas, porEstado: resultado.porEstado, companias: (resultado.companias || []).slice(0, 15),
          propuestas: (resultado.propuestas || []).slice(0, 30), revisionHumana: (resultado.revisionHumana || []).slice(0, 15), correos: (resultado.correos || []).slice(0, 30) };
      }
      case "casos": return db.casos({ receptor: args.receptor || null, companiaId: args.compania || null, frente: args.frente || null, seguimiento: args.seguimiento || "abierto", limite: Math.min(args.limite || 100, 300) })
        .map(c => ({ id: c.id, receptor: c.receptor, compania: c.compania, frente: c.frente, estado: c.estado_buzon, establecimiento: c.establecimiento, cedula: c.cedula_emisor, consecutivo: c.consecutivo, fecha: c.fecha_documento, veces: c.veces, error: c.error, seguimiento: c.seguimiento }));
      case "propuestas": return db.propuestas({ estado: args.estado || "propuesta", companiaId: args.compania || null, limite: 200 })
        .map(p => ({ id: p.id, factura: p.factura, estadoFactura: p.factura_estado, articulo: p.articulo, cuentaActual: p.cuenta_actual, cuentaNueva: p.cuenta_nueva, fuente: p.fuente, confianza: p.confianza, estado: p.estado }));
      case "correos": return db.correos({ estado: args.estado || "borrador" }).map(c => ({ id: c.id, frente: c.frente, para: c.para, asunto: c.asunto, casos: c.casos, estado: c.estado }));
      case "causas_errores": {
        const casos = db.casos({ frente: "adentro", companiaId: args.compania || null, seguimiento: "todos", limite: 5000 }).filter(c => c.estado_buzon === "error");
        return { correosConError: casos.length, causas: causasDominantes(casos.map(c => ({ error: c.error, estado: "error" })), { max: 10 }) };
      }
      case "hallazgos": {
        const u = db.ultimaCorrida(args.agente);
        if (!u) return { error: `${args.agente} no ha corrido todavía; usá correr_agente.` };
        const r = u.resultado || {};
        const deCia = x => !args.compania || x.companiaId === args.compania || (x.companias || []).some(c => c.companiaId === args.compania);
        const corta = (xs, n = 40) => (xs || []).filter(deCia).slice(0, n);
        const base = { corrida: u.id, fin: u.fin, totales: r.totales, alertas: (r.alertas || []).map(a => a.texto) };
        if (args.agente === "diagnostico") return { ...base, causas: (r.causas || []).map(c => ({ ...c, ejemplos: undefined, companias: c.companias.filter(deCia).slice(0, 10), pendientes: c.pendientes.filter(p => !args.compania || c.companias.some(x => x.companiaId === args.compania && x.compania === p.compania)).slice(0, 15) })).filter(c => c.companias.length) };
        if (args.agente === "recurrentes") return { ...base, mes: r.mes, faltantes: corta(r.faltantes), desvios: corta(r.desvios) };
        if (args.agente === "bancos") return { ...base, esperadoHasta: r.esperadoHasta, cuentas: corta((r.cuentas || []).filter(c => c.estado !== "al-dia" && c.estado !== "sin-movimiento"), 60) };
        if (args.agente === "cierre") return { ...base, mes: r.mes, cuentas: corta(r.cuentas, 50).map(c => ({ ...c, serie: undefined })),
          iva: corta(r.iva, args.compania ? 1 : 30), ivaMalUbicado: corta(r.ivaMalUbicado, 20), sinRegistro: corta(r.sinRegistro, 30) };
        if (args.agente === "hacienda") return { ...base, mes: r.mes, declaraciones: corta(r.resumen, 60) };
        if (args.agente === "extractos") return { ...base, bancos: corta(r.bancos, 40).map(b => ({ ...b, transito: (b.transito || []).slice(0, 10) })), cobros: corta(r.cobros, 30), pagos: corta(r.pagos, 30) };
        if (args.agente === "datos") return { ...base, duplicados: corta(r.duplicados, 30), sinCedula: corta(r.sinCedula, 30), cedulas: corta(r.cedulas, 30), sinCorreo: corta(r.sinCorreo, 30), parecidos: corta(r.parecidos, 20) };
        if (args.agente === "cartera") return { ...base, corte: r.corte, companias: corta(r.companias, args.compania ? 1 : 40), morosos: corta(r.morosos, 40), pagosProximos: corta(r.pagosProximos, 30), sinCorreo: corta(r.sinCorreo, 20) };
        if (args.agente === "depreciacion") return { ...base, mes: r.mes, activos: corta(r.activos, 60), duplicados: corta(r.duplicados, 20), problemas: corta(r.problemas, 20) };
        if (args.agente === "diferidos") return { ...base, mes: r.mes, diferidos: corta(r.diferidos, 60), problemas: corta(r.problemas, 20) };
        if (args.agente === "cambiario") return { ...base, fecha: r.fecha, reversa: r.reversa, companias: corta(r.companias, args.compania ? 1 : 40), sinMoneda: corta(r.sinMoneda, 20) };
        if (args.agente === "estados") {
          if (!args.compania) return { ...base, mes: r.mes, companias: (r.companias || []).map(c => ({ companiaId: c.companiaId, compania: c.compania, activo: c.balance.activo, pasivo: c.balance.pasivo,
            patrimonio: c.balance.patrimonio, utilidadAnio: c.resultadosAnio.utilidad, utilidadMes: c.resultadosMes?.utilidad, borradores: c.borradores })).slice(0, 80),
            cajasNegativas: (r.cajasNegativas || []).slice(0, 20), ladoContrario: (r.ladoContrario || []).slice(0, 20), aviso: "Para el detalle de una compañía pasá compania." };
          const c = (r.companias || []).find(x => x.companiaId === args.compania);
          return c ? { ...base, ...c, rubros: c.rubros.map(x => ({ ...x, cuentas: x.cuentas.slice(0, 12) })), detalleResultados: c.detalleResultados.slice(0, 40) } : { ...base, error: "Esa compañía no aparece en la última corrida de estados." };
        }
        return { ...base, notas: corta(r.notas), consecutivos: corta(r.consecutivos, 20) };
      }
      case "consultas": return db.consultas({ estado: args.estado || "abierta", companiaId: args.compania || null, limite: 150 })
        .map(c => ({ id: c.id, compania: c.compania, factura: c.factura, articulo: c.articulo, proveedor: c.proveedor, cuentaActual: c.cuenta_actual, sugerida: c.sugerida, tipo: c.tipo, motivo: c.motivo, nota: c.nota, estado: c.estado }));
      case "revisar_factura": return this.#revisarFactura(args);
      case "proponer_regla": return this.#proponerRegla(args, quien);
      case "asientos": return db.asientos({ estado: args.estado || "abiertos", companiaId: args.compania || null, limite: 60 })
        .map(a => ({ id: a.id, compania: a.compania, fecha: a.fecha, diario: a.diario, referencia: a.referencia, motivo: a.motivo, total: a.total, estado: a.estado, porDefinir: a.porDefinir,
          lineas: a.lineas.map(l => ({ cuenta: l.cuenta, debito: l.debito, credito: l.credito })), asientoOdoo: a.move_name || null }));
      case "proponer_cambio_masivo": return cambiosSrv.proponer({ corridas: this.corridas, db, propuso: `director:${quien}`, instruccion: { tipo: args.tipo, codigo: args.codigo,
        nombreActual: args.nombre_actual, nuevoCodigo: args.nuevo_codigo, nuevoNombre: args.nuevo_nombre, tipoCuenta: args.tipo_cuenta, companias: args.companias, excluir: args.excluir, motivo: args.motivo } });
      case "cambios_masivos": return db.cambios({ estado: args.estado || "abiertos", limite: 20 }).map(c => ({ id: c.id, tipo: c.tipo, instruccion: c.instruccion, motivo: c.motivo, estado: c.estado,
        propuso: c.propuso, resumen: cambiosSrv.resumen(c.items), revisar: c.items.filter(i => i.estado !== "listo" && i.estado !== "aplicado").slice(0, 10).map(i => `${i.compania}: ${i.estado}${i.motivo ? ` — ${i.motivo}` : ""}`) }));
      case "registrar_diferido": return diferidosSrv.registrar({ corridas: this.corridas, db, quien: `director:${quien}`, d: { compania: args.compania, descripcion: args.descripcion,
        cuentaActivo: args.cuenta_activo, cuentaGasto: args.cuenta_gasto, monto: args.monto, meses: args.meses, inicio: args.inicio, referencia: args.referencia } });
      case "diferidos": { const ap = db.mesesAplicadosDiferidos(); const { avance } = await import("../lib/diferidos.js");
        return db.diferidos({ companiaId: args.compania || null }).slice(0, 80).map(d => ({ id: d.id, compania: d.compania, descripcion: d.descripcion, monto: d.monto, meses: d.meses, inicio: d.inicio, ...avance(d, ap.get(d.id) || new Set()) })); }
      case "registrar_activo": return activosSrv.registrar({ corridas: this.corridas, db, quien: `director:${quien}`, d: { compania: args.compania, descripcion: args.descripcion, categoria: args.categoria,
        cuentaActivo: args.cuenta_activo, cuentaAcumulada: args.cuenta_acumulada, cuentaGasto: args.cuenta_gasto, costo: args.costo, residual: args.residual, vidaMeses: args.vida_meses, vidaAnios: args.vida_anios,
        inicio: args.inicio, hechoHasta: args.depreciado_hasta, referencia: args.referencia } });
      case "activos": { const ap = db.mesesAplicadosActivos(); const { avance } = await import("../lib/diferidos.js");
        return db.activos({ companiaId: args.compania || null }).slice(0, 80).map(a => { const av = avance({ monto: a.costo - a.residual, meses: a.vida_meses, inicio: a.inicio }, ap.get(a.id) || new Set(), { hechoHasta: a.hecho_hasta });
          return { id: a.id, compania: a.compania, descripcion: a.descripcion, costo: a.costo, vidaMeses: a.vida_meses, inicio: a.inicio, depreciado: av.amortizado, valorEnLibros: Math.round((a.costo - av.amortizado) * 100) / 100, fin: av.fin }; }); }
      case "cierre_mes": {
        const lista = leerJSON(join(this.raiz, "data", "companias.json"), []);
        const l = cierreMesSrv.lista(db, { mes: args.mes || cierreMesSrv.mesPorOmision(db), companias: lista, companiaId: args.compania || null });
        if (args.compania) return l.companias[0] ? { mes: l.mes, ...l.companias[0], items: l.companias[0].items.map(i => ({ item: i.titulo, estado: i.estado, detalle: i.detalle, revisado: i.revisado?.nota })) } : { error: "No existe esa compañía." };
        return { mes: l.mes, totales: l.totales, companias: l.companias.slice(0, 80).map(c => ({ companiaId: c.companiaId, compania: c.compania, estado: c.estado, pendientes: c.pendientes,
          falta: c.items.filter(i => i.estado === "pendiente" || i.estado === "sin-datos").map(i => i.titulo) })) };
      }
      case "proponer_asiento": return asientosSrv.proponer({ corridas: this.corridas, db, compania: args.compania, fecha: args.fecha, diario: args.diario || null,
        referencia: args.referencia || "", motivo: args.motivo || "", lineas: args.lineas || [], propuso: `director:${quien}` });
      case "leer_odoo": {
        const odoo = this.corridas.crearCliente({ meta: { escribe: false } });
        const filas = await odoo.leer(args.modelo, "search_read", [args.dominio || [], args.campos || []],
          { limit: Math.min(args.limite || 50, 200), ...(args.orden ? { order: args.orden } : {}), context: contextoTodas(this.raiz, args.compania) });
        return filas;
      }
      case "agrupar_odoo": {
        const odoo = this.corridas.crearCliente({ meta: { escribe: false } });
        return odoo.leer(args.modelo, "read_group", [args.dominio || [], args.campos || ["id"], args.agrupar || []], { lazy: false, context: contextoTodas(this.raiz, args.compania) });
      }
      default: return { error: `No existe la herramienta ${nombre}.` };
    }
  }

  // Una factura con el criterio de Cuentas, sin escribir ni registrar propuestas: lo que el
  // agente haría con esa factura, explicado línea por línea para que el Director lo cuente.
  async #revisarFactura(args) {
    const rutaCatalogo = this.cfg.CATALOGO_CUENTAS ? join(this.raiz, this.cfg.CATALOGO_CUENTAS) : join(this.raiz, "data", "catalogo-cuentas.json");
    if (!existsSync(rutaCatalogo)) return { error: "No hay catálogo de cuentas (data/catalogo-cuentas.json). Hay que construirlo con: npm run catalogo" };
    const odoo = this.corridas.crearCliente({ meta: { escribe: false } });
    const ctxTodas = { context: contextoTodas(this.raiz) };
    let dom;
    if (args.factura) dom = [["id", "=", Number(args.factura)]];
    else if (args.nombre || args.proveedor) {
      dom = [["move_type", "in", ["in_invoice", "in_refund"]]];
      if (args.nombre) dom.push(["name", "ilike", args.nombre]);
      if (args.proveedor) dom.push(["partner_id.name", "ilike", args.proveedor]);
      if (args.compania) dom.push(["company_id", "=", Number(args.compania)]);
    } else return { error: "Indique la factura: id (factura), número (nombre) o proveedor." };
    const campos = ["name", "state", "payment_state", "partner_id", "invoice_date", "amount_total", "company_id", "move_type"];
    let facturas;
    try { facturas = await odoo.leer("account.move", "search_read", [dom, [...campos, "economic_activity_purchase_id"]], { limit: 5, order: "invoice_date desc", ...ctxTodas }); }
    catch { facturas = await odoo.leer("account.move", "search_read", [dom, campos], { limit: 5, order: "invoice_date desc", ...ctxTodas }); }
    if (!facturas.length) return { error: "No encontré esa factura." };
    if (facturas.length > 1 && !args.factura) return { varias: facturas.map(f => ({ id: f.id, nombre: f.name, proveedor: f.partner_id?.[1], compania: f.company_id?.[1], fecha: f.invoice_date, total: f.amount_total })), nota: "Hay varias; vuelva a llamar con el id (factura)." };
    const f = facturas[0];
    const CID = f.company_id?.[0], ciaNombre = f.company_id?.[1] || "";
    const ctx = { context: { allowed_company_ids: [CID] } };
    const lineas = await odoo.leer("account.move.line", "search_read",
      [[["move_id", "=", f.id], ["display_type", "in", ["product", "other"]]], ["name", "account_id", "product_id", "balance", "quantity", "price_unit"]], ctx);
    const plan = await odoo.leerTodo("account.account", [["company_ids", "in", [CID]]], ["code", "name", "account_type", "deprecated"], { context: ctx.context });
    const cat = new Catalogo(rutaCatalogo, join(this.raiz, "data", "reglas.json"));
    // El mismo criterio que el agente Cuentas: la guía de Victor (src/clasificador.js).
    const clas = new Clasificador({ catalogo: cat });
    const proveedor = { id: f.partner_id?.[0] || null, nombre: f.partner_id?.[1] || null };
    const actividad = Array.isArray(f.economic_activity_purchase_id) ? f.economic_activity_purchase_id[1] : null;
    const items = lineas.map(l => {
      const texto = l.name || (l.product_id ? l.product_id[1] : "");
      const actual = l.account_id ? l.account_id[1] : "(sin cuenta)";
      const cuentaActual = l.account_id ? plan.find(c => c.id === l.account_id[0]) : null;
      const d = clas.clasificar({ compania: ciaNombre, articulo: texto, proveedor, actividad });
      const r0 = d.codigo || d.cuenta ? resolverEnPlan(clas, d, plan) : { cuenta: null };
      const destino = r0.cuenta;
      const r = { lineaId: l.id, articulo: String(texto).slice(0, 80), monto: l.balance, cuentaActual: actual, esComodin: Boolean(cuentaActual && clas.esComodin(cuentaActual.code)),
        decision: d.decision, sugerida: destino ? `${destino.code} ${destino.name}` : (d.codigo ? `${d.codigo} ${d.cuenta || ""}`.trim() : null),
        fuente: d.fuente || null, confianza: d.confianza ?? null, naturaleza: d.naturaleza?.nombre || null, motivo: d.motivo || null, pasos: d.pasos };
      if (destino && l.account_id && l.account_id[0] === destino.id && d.decision !== "no-identificado") r.veredicto = "correcta: ya está donde la guía la pondría";
      else if (d.decision === "proponer" && !destino) r.veredicto = `iría a consulta: ${r0.motivo}`;
      else if (d.decision === "proponer") r.veredicto = `Cuentas propondría cambiarla a ${r.sugerida}`;
      else if (d.decision === "consulta") r.veredicto = `consulta al contador: ${d.motivo}`;
      else r.veredicto = `no identificada: ${d.motivo}`;
      return r;
    });
    return { factura: { id: f.id, nombre: f.name, proveedor: f.partner_id?.[1], compania: ciaNombre, companiaId: CID, estado: f.state, pago: f.payment_state, fecha: f.invoice_date, total: f.amount_total },
      lineas: items, planCuentas: plan.length,
      proveedor: { ...proveedor, actividad }, referencia: clas.referenciaEstado,
      nota: "Nada se cambió. Para que quede como propuesta formal hay que correr el agente cuentas sobre la compañía (correr_agente) y aprobar en la pestaña Aprobaciones; las consultas quedan en Aprobaciones → Consultas." };
  }

  // Una regla dictada en el chat → queda propuesta (base de la app, no Odoo). Ver src/servicio/reglas.js.
  async #proponerRegla(args, quien) {
    return proponerRegla({ corridas: this.corridas, db: this.db, compania: args.compania, codigo: args.codigo, proveedorId: args.proveedor_id,
      articulos: args.articulos, naturaleza: args.naturaleza || null, motivo: args.motivo, factura: args.factura, propuso: `director:${quien}` });
  }

  // --- Memoria ----------------------------------------------------------------------------
  // Lo que esta persona habló antes con el Director (otras conversaciones de los últimos
  // retencionDias días), como texto corto para el sistema. La conversación en curso va aparte,
  // completa, en los mensajes.
  memoriaDe(quien, { excepto = null, maxChars = 6000 } = {}) {
    if (!quien || !this.db?.conversaciones) return "";
    const lista = this.db.conversaciones({ quien, limite: 10, dias: this.retencionDias }).filter(c => c.id !== excepto);
    const partes = [];
    let total = 0;
    for (const c of lista) {
      const fecha = String(c.ultimo || c.inicio || "").slice(0, 10);
      for (const t of (c.resumen || []).slice(-6)) {
        const linea = `- [${fecha}] P: ${corto(t.pregunta, 160)} / R: ${corto(t.respuesta, 240)}`;
        if (total + linea.length > maxChars) break;
        partes.push(linea); total += linea.length;
      }
      if (total >= maxChars) break;
    }
    return partes.join("\n");
  }

  // El historial que se manda al modelo. Los últimos turnosCompletos turnos van tal cual
  // (con herramientas y resultados); los anteriores quedan como pregunta y respuesta en texto,
  // que es lo que importa para seguir el hilo. Y nunca más de maxContexto caracteres.
  podar(mensajes) {
    const turnos = [];
    for (const m of mensajes) {
      const esInicio = m.role === "user" && typeof m.content === "string";
      if (esInicio || !turnos.length) turnos.push([]);
      turnos[turnos.length - 1].push(m);
    }
    const compacto = turno => turno.flatMap(m => {
      if (m.role === "user") return typeof m.content === "string" ? [m] : [];
      const texto = (Array.isArray(m.content) ? m.content : []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
      return texto ? [{ role: "assistant", content: [{ type: "text", text: texto }] }] : [];
    });
    let salida = turnos.map((t, i) => i >= turnos.length - this.turnosCompletos ? t : compacto(t));
    const tam = s => JSON.stringify(s).length;
    // Si aun así es mucho: primero compactar los completos más viejos, luego soltar los más viejos.
    for (let i = turnos.length - this.turnosCompletos; i < turnos.length - 1 && tam(salida) > this.maxContexto; i++) if (i >= 0) salida[i] = compacto(turnos[i]);
    while (salida.length > 1 && tam(salida) > this.maxContexto) salida.shift();
    const plano = salida.flat();
    // La API exige empezar por user y alternar; un turno compactado puede haber quedado sin assistant.
    const limpio = [];
    for (const m of plano) {
      if (!limpio.length && m.role !== "user") continue;
      if (limpio.length && limpio[limpio.length - 1].role === m.role) {
        // dos seguidos del mismo rol: fusionar textos
        const a = limpio[limpio.length - 1];
        const ta = typeof a.content === "string" ? a.content : a.content.filter(b => b.type === "text").map(b => b.text).join("\n");
        const tb = typeof m.content === "string" ? m.content : m.content.filter(b => b.type === "text").map(b => b.text).join("\n");
        limpio[limpio.length - 1] = { role: m.role, content: m.role === "user" ? `${ta}\n${tb}` : [{ type: "text", text: `${ta}\n${tb}` }] };
        continue;
      }
      limpio.push(m);
    }
    return limpio;
  }

  // --- El bucle de conversación -------------------------------------------------------
  sistema(memoria = "") {
    const ag = this.roster.agentes.map(a => `- ${a.nombre}${a.rol && a.rol !== a.nombre ? ` (${a.rol})` : ""}: ${a.hace} No hace: ${a.noHace}${a.escribe ? " ESCRIBE EN ODOO: por el Director solo propone." : ""}`).join("\n");
    const nc = (this.roster.noConstruidos || []).map(a => `- ${a.nombre}: ${a.hace}`).join("\n");
    const congelada = this.cfg.ALERTA_REFERENCIA === "ultimo-correo" ? "\nEsta instancia es una copia de pruebas congelada: las horas sin ingesta se miden contra el último correo, no contra hoy." : "";
    return `Sos el Director de la Oficina IASIMA: un equipo de agentes que operan el buzón de factura electrónica y la contabilidad de Odoo (Costa Rica, localización TecnoDEM, ${leerJSON(join(this.raiz, "data", "companias.json"), []).length || "varias"} compañías).
Recibís instrucciones en lenguaje natural de contadores y receptores. Decidís qué agente atiende, lo ejecutás con las herramientas y respondés con cifras concretas y qué sigue.

Agentes:
${ag}
No construidos todavía (si te lo piden, decilo y ofrecé el adelanto que puedas con las herramientas):
${nc}

Reglas:
1. Nunca inventés cifras: toda cifra sale de una herramienta. Si no hay corrida reciente, corré el agente.
2. Si la instrucción puede ser de dos agentes, preguntá cuál. Si falta la compañía para Cuentas, pedila (buscá primero con "companias" si dieron un nombre).
3. No existe herramienta para escribir en Odoo ni para enviar correos, y así debe ser. Nunca le digas a la persona que lo cambie a mano en Odoo «para que el agente aprenda»: el agente aprende de reglas, no de ediciones.
   - Si dicta una decisión contable que vale de ahora en adelante («este tipo de gasto siempre va a 5.04.17.01», «todo lo de este proveedor va a…»), llamá a "proponer_regla" en el mismo turno. Si dice «este tipo de gastos» refiriéndose a una factura: si habla del tipo de gasto (comida de restaurante, combustible…) usá naturaleza; si habla de ese proveedor, proveedor_id; decí qué alcance usaste. Luego explicá: quedó en Aprobaciones → Reglas; al aprobarla, Cuentas propone cada línea afectada; aplicar en Odoo requiere que se habilite la escritura.
   - Si pide un cambio al plan de cuentas en varias compañías (renombrar, recodificar, crear u obsoletar una cuenta), llamá a "proponer_cambio_masivo" y contá el resumen (cuántas listas, cuántas a revisar y por qué).
   - Si dicta un gasto diferido («la póliza del INS de X, 1.200.000 a 12 meses desde enero»), llamá a "registrar_diferido" (buscá antes los códigos de cuenta si no los dieron).
   - Si dicta un activo fijo («compramos un vehículo de 18 millones, 10 años, desde marzo»), llamá a "registrar_activo"; si ya se venía depreciando a mano, preguntá hasta qué mes.
   - Si pregunta qué falta para cerrar el mes de un cliente, o cómo va el cierre, usá "cierre_mes".
   - Si dicta un asiento puntual (un pago, una reclasificación, una provisión), llamá a "proponer_asiento": queda en Aprobaciones → Asientos. Si pregunta qué asientos hay pendientes o qué propuso Cierre, usá "asientos".
   - Si pide corregir, publicar, enviar o borrar algo puntual, explicá exactamente qué se cambiaría y terminá con: "Esto requiere aprobación humana en la pestaña Aprobaciones; no lo ejecuté."
4. Respondé en español, breve, con las cifras y, cuando sea útil, el agente y la herramienta que usaste. Podés usar **negrita** y listas con "- "; la app las muestra formateadas.
5. Criterio contable (guía de Victor, docs/guia-clasificacion-cuentas.md): regla propia del cliente → naturaleza del gasto (qué se compró y a quién) → historial → consulta al contador. Nunca propongas 7.01.01 ni 5.04.99/5.04.999 como destino: lo no identificado se reporta. Gasto que parece personal: consulta. Relaciones públicas frente a Gastos no justificados afecta la deducibilidad: la confirma el contador. Si preguntan en qué cuenta contable debería ir una factura o sus ítems, usá "revisar_factura" (una sola llamada trae líneas, cuenta actual, sugerencia del catálogo y plan): no reconstruyas eso con leer_odoo. Si leés account.account con leer_odoo, pasá compania: sin ella el code viene vacío y NO significa que la cuenta no tenga código.
6. Estados del buzón: done registrada; isticket tiquete (no deducible, se reclama al establecimiento); rejected rechazada (se reclama); duplicate, error, process, vatiderror (se revisan adentro). La clave de Hacienda son 50 dígitos; tipo de documento en posiciones 30-31 (04 = tiquete); cédula del emisor en 10-21.${congelada}
7. Tenés memoria: la conversación en curso te llega completa y abajo va lo que esta persona habló con vos en otras conversaciones de los últimos ${this.retencionDias} días. Si se refiere a algo de antes («la factura que vimos ayer», «lo de Ceiba»), usalo. Las cifras de antes pueden estar viejas: si pide un dato actual, volvé a consultar la herramienta.${memoria ? `\n\nConversaciones anteriores con esta persona:\n${memoria}` : ""}`;
  }

  // conversacion: el historial guardado de ESTA conversación; conversacionId: su id, para que la
  // memoria de otras conversaciones no la repita.
  async responder(mensaje, { conversacion = [], conversacionId = null, quien = "anónimo" } = {}) {
    if (!this.disponible) {
      // Sin clave: el Director de palabras, que al menos sabe a quién va.
      const d = DirectorCore.decidir(mensaje, this.roster, leerJSON(join(this.raiz, "data", "companias.json"), []));
      return { respuesta: d.mensaje + (d.accion === "ejecutar" ? ` (Director de palabras: para ejecutarlo use el tablero o configure CLAUDE_API_KEY.)` : ""), pasos: [], conversacion: [...conversacion, { role: "user", content: mensaje }, { role: "assistant", content: d.mensaje }], modo: "palabras" };
    }
    const mensajes = [...this.podar(conversacion), { role: "user", content: mensaje }];
    const sistema = this.sistema(this.memoriaDe(quien, { excepto: conversacionId }));
    const pasos = [];
    for (let i = 0; i < this.maxPasos; i++) {
      const r = await this.#llamar(mensajes, { sistema });
      const bloques = r.content || [];
      mensajes.push({ role: "assistant", content: bloques });
      const usos = bloques.filter(b => b.type === "tool_use");
      if (r.stop_reason !== "tool_use" || !usos.length) {
        const texto = bloques.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
        return { respuesta: texto || "(sin respuesta)", pasos, conversacion: mensajes, modo: "llm", modelo: this.modelo };
      }
      const resultados = [];
      for (const u of usos) {
        const t0 = Date.now();
        let salida;
        try { salida = await this.ejecutarHerramienta(u.name, u.input || {}, quien); }
        catch (e) { salida = { error: e.message }; }
        const texto = JSON.stringify(salida);
        pasos.push({ herramienta: u.name, args: u.input, ms: Date.now() - t0, resumen: texto.slice(0, 160) });
        this.log(`director[${quien}] ${u.name}(${JSON.stringify(u.input)}) → ${texto.length} chars`);
        resultados.push({ type: "tool_result", tool_use_id: u.id, content: texto.slice(0, 60_000) });
      }
      mensajes.push({ role: "user", content: resultados });
    }
    // Se acabaron los pasos: una última llamada sin herramientas para que responda con lo
    // que ya consultó y diga qué le faltó, en vez de rendirse en silencio.
    mensajes.push({ role: "user", content: `Se agotó el límite de ${this.maxPasos} consultas. No podés usar más herramientas: respondé ahora con lo que ya obtuviste, con las cifras que tengas, y decí en una línea qué quedó sin consultar.` });
    try {
      const r = await this.#llamar(mensajes, { sistema, sinHerramientas: true });
      const bloques = r.content || [];
      mensajes.push({ role: "assistant", content: bloques });
      const texto = bloques.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
      if (texto && !bloques.some(b => b.type === "tool_use")) return { respuesta: texto, pasos, conversacion: mensajes, modo: "llm", modelo: this.modelo, truncado: true };
    } catch (e) { this.log(`director[${quien}] cierre sin herramientas falló: ${e.message}`); }
    return { respuesta: "Me quedé sin pasos antes de terminar. Intente con una pregunta más acotada.", pasos, conversacion: mensajes, modo: "llm" };
  }

  async #llamar(mensajes, { sistema = this.sistema(), sinHerramientas = false } = {}) {
    const res = await this.fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": this.cfg.CLAUDE_API_KEY, "anthropic-version": "2023-06-01",
        // Una clave de usuario (sk-ant-usr-…) no está atada a un workspace y la API exige decir cuál;
        // una clave de workspace (sk-ant-api03-…) no lo necesita.
        ...(this.cfg.CLAUDE_WORKSPACE_ID ? { "anthropic-workspace-id": this.cfg.CLAUDE_WORKSPACE_ID } : {}) },
      // Las herramientas van siempre (la conversación ya trae tool_use); "none" le impide pedir más.
      body: JSON.stringify({ model: this.modelo, max_tokens: 2000, system: sistema, tools: this.herramientas(), messages: mensajes,
        ...(sinHerramientas ? { tool_choice: { type: "none" } } : {}) })
    });
    const j = await res.json();
    if (!res.ok) throw new Error(`API de Claude: ${j.error?.message || res.status}`);
    return j;
  }
}

function leerJSON(ruta, siNoExiste) { return existsSync(ruta) ? JSON.parse(readFileSync(ruta, "utf8")) : siNoExiste; }
function corto(s, n) { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; }
// Todas las compañías habilitadas; si se indica una, va PRIMERA: Odoo 18 toma de ella los campos
// que dependen de la compañía (el code de account.account, por ejemplo).
function contextoTodas(raiz, primera = null) {
  const ids = leerJSON(join(raiz, "data", "companias.json"), []).map(c => c.id);
  if (primera) return { allowed_company_ids: [Number(primera), ...ids.filter(i => i !== Number(primera))] };
  return ids.length ? { allowed_company_ids: ids } : {};
}
