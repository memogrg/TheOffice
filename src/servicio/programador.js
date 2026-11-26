// El calendario del servicio. Sin cron externo: revisa cada minuto si toca algo.
//
//   CORRIDA_DIARIA=07:00         hora local a la que corre Recepción y luego Comunicación (borradores)
//   CONCILIACION_SEMANAL=1       día de la semana (0 domingo … 6 sábado) para Conciliación; vacío = no
//
// Lo que ya corrió hoy no se repite aunque el servicio se reinicie: se mira la última corrida en la base.
//
// Si la corrida del día falla (Odoo caído, credenciales vencidas), no se reintenta cada minuto: se
// vuelve a intentar a los 10 y a los 30 minutos, y después de tres fallos se deja para mañana. El
// fallo queda en la base y la Oficina lo muestra arriba (salud.js); nadie tiene que mirar Corridas.
const REINTENTOS = 3;                 // intentos por día, contando el primero
const ESPERAS_MIN = [10, 30];         // minutos de espera antes del 2.º y del 3.er intento
export class Programador {
  constructor({ corridas, db, cfg, log = () => {}, reloj = () => new Date() }) {
    this.corridas = corridas; this.db = db; this.cfg = cfg; this.log = log; this.reloj = reloj;
    this.timer = null;
    this.ultimoTick = null;
    this.ultimoFallo = null;          // { agente, cuando, error, intentos } de la última corrida diaria fallida
    this.avisado = null;              // día en que ya se anotó «agotados los intentos»
  }

  plan() {
    const diaria = (this.cfg.CORRIDA_DIARIA || "").trim();
    const semanal = (this.cfg.CONCILIACION_SEMANAL || "").trim();
    return {
      diaria: /^\d{1,2}:\d{2}$/.test(diaria) ? diaria : null,
      conciliacionDia: /^[0-6]$/.test(semanal) ? Number(semanal) : null
    };
  }

  iniciar() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(e => this.log("programador: " + e.message)), 60_000);
    this.timer.unref?.();
    this.log(`programador: ${this.describir()}`);
  }
  detener() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  describir() {
    const p = this.plan();
    const partes = [];
    if (p.diaria) partes.push(`Recepción + Comunicación + Diagnóstico todos los días a las ${p.diaria}`);
    if (p.conciliacionDia !== null) partes.push(`Conciliación, Recurrentes, Bancos y Documentos los ${["domingos", "lunes", "martes", "miércoles", "jueves", "viernes", "sábados"][p.conciliacionDia]}`);
    return partes.length ? partes.join("; ") : "sin corridas programadas (CORRIDA_DIARIA vacío)";
  }

  // "Hoy" en hora local, que es como se configura CORRIDA_DIARIA. La base guarda UTC.
  #yaCorrioHoy(agente, ahora) {
    const u = this.db.ultimaCorrida(agente);
    return Boolean(u) && diaLocal(new Date(u.inicio)) === diaLocal(ahora);
  }
  // ¿Toca intentar hoy? No, si ya salió bien hoy; no, si ya se agotaron los intentos del día; no, si
  // el último fallo es demasiado reciente (espera creciente). Sí en cualquier otro caso.
  #tocaIntentar(agente, ahora) {
    if (this.#yaCorrioHoy(agente, ahora)) return false;
    const hoy = diaLocal(ahora);
    const fallosHoy = this.db.corridasDesde(agente, inicioDelDiaUTC(ahora)).filter(c => c.estado === "fallo" && diaLocal(new Date(c.inicio)) === hoy);
    if (!fallosHoy.length) return true;
    if (fallosHoy.length >= REINTENTOS) {
      if (this.avisado !== `${agente}|${hoy}`) { this.avisado = `${agente}|${hoy}`; this.log(`programador: ${agente} falló ${fallosHoy.length} veces hoy; no se reintenta hasta mañana. Último error: ${fallosHoy[0].error}`); }
      return false;
    }
    const espera = ESPERAS_MIN[Math.min(fallosHoy.length, ESPERAS_MIN.length) - 1] * 60_000;
    return ahora - new Date(fallosHoy[0].fin || fallosHoy[0].inicio) >= espera;
  }

  // Una pasada. Devuelve qué disparó (para los tests).
  async tick() {
    const ahora = this.reloj();
    const p = this.plan();
    const hhmm = `${String(ahora.getHours()).padStart(2, "0")}:${String(ahora.getMinutes()).padStart(2, "0")}`;
    const disparos = [];
    if (p.diaria && hhmm >= p.diaria.padStart(5, "0") && this.#tocaIntentar("recepcion", ahora) && !this.corridas.enCurso) {
      disparos.push("recepcion");
      this.log("programador: corrida diaria de Recepción");
      let ok = false;
      try {
        const { corridaId } = await this.corridas.correr("recepcion", [], { quienPide: "programador" });
        ok = true; this.ultimoFallo = null;
        await this.corridas.reportar(corridaId).catch(e => this.log("reporte: " + e.message));
      } catch (e) {
        // Comunicación y Diagnóstico leen el mismo Odoo: sin Recepción no tiene sentido lanzarlos.
        const intentos = this.db.corridasDesde("recepcion", inicioDelDiaUTC(ahora)).filter(c => c.estado === "fallo" && diaLocal(new Date(c.inicio)) === diaLocal(ahora)).length;
        this.ultimoFallo = { agente: "recepcion", cuando: ahora.toISOString(), error: e.message, intentos };
        this.log(`programador: Recepción falló (intento ${intentos} de ${REINTENTOS}): ${e.message}`);
      }
      if (ok) {
        disparos.push("comunicacion");
        await this.corridas.correr("comunicacion", [], { quienPide: "programador" }).catch(e => this.log("comunicacion: " + e.message));
        // Diagnóstico es barato y explica lo que Recepción encontró: corre con ella cada día.
        disparos.push("diagnostico");
        await this.corridas.correr("diagnostico", [], { quienPide: "programador" }).catch(e => this.log("diagnostico: " + e.message));
      }
    }
    if (p.conciliacionDia !== null && ahora.getDay() === p.conciliacionDia && p.diaria && hhmm >= p.diaria.padStart(5, "0")
        && this.#tocaIntentar("conciliacion", ahora) && !this.corridas.enCurso) {
      disparos.push("conciliacion");
      await this.corridas.correr("conciliacion", [], { quienPide: "programador" }).catch(e => this.log("conciliacion: " + e.message));
      // El resto de la fase 3A, una vez por semana con Conciliación.
      for (const a of ["recurrentes", "bancos", "documentos", "cierre", "estados", "cambiario", "diferidos", "depreciacion", "cartera", "datos", "extractos", "hacienda", "controles"]) {
        disparos.push(a);
        await this.corridas.correr(a, [], { quienPide: "programador" }).catch(e => this.log(`${a}: ${e.message}`));
      }
    }
    this.ultimoTick = ahora.toISOString();
    return disparos;
  }
}

const diaLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// Desde cuándo pedir corridas a la base (UTC) para cubrir el día local entero: un día antes basta.
const inicioDelDiaUTC = d => new Date(d.getTime() - 36 * 3600_000).toISOString();
