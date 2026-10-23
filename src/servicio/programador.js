// El calendario del servicio. Sin cron externo: revisa cada minuto si toca algo.
//
//   CORRIDA_DIARIA=07:00         hora local a la que corre Recepción y luego Comunicación (borradores)
//   CONCILIACION_SEMANAL=1       día de la semana (0 domingo … 6 sábado) para Conciliación; vacío = no
//
// Lo que ya corrió hoy no se repite aunque el servicio se reinicie: se mira la última corrida en la base.
export class Programador {
  constructor({ corridas, db, cfg, log = () => {}, reloj = () => new Date() }) {
    this.corridas = corridas; this.db = db; this.cfg = cfg; this.log = log; this.reloj = reloj;
    this.timer = null;
    this.ultimoTick = null;
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
    if (p.diaria) partes.push(`Recepción + Comunicación todos los días a las ${p.diaria}`);
    if (p.conciliacionDia !== null) partes.push(`Conciliación los ${["domingos", "lunes", "martes", "miércoles", "jueves", "viernes", "sábados"][p.conciliacionDia]}`);
    return partes.length ? partes.join("; ") : "sin corridas programadas (CORRIDA_DIARIA vacío)";
  }

  // "Hoy" en hora local, que es como se configura CORRIDA_DIARIA. La base guarda UTC.
  #yaCorrioHoy(agente, ahora) {
    const u = this.db.ultimaCorrida(agente);
    return Boolean(u) && diaLocal(new Date(u.inicio)) === diaLocal(ahora);
  }

  // Una pasada. Devuelve qué disparó (para los tests).
  async tick() {
    const ahora = this.reloj();
    const p = this.plan();
    const hhmm = `${String(ahora.getHours()).padStart(2, "0")}:${String(ahora.getMinutes()).padStart(2, "0")}`;
    const disparos = [];
    if (p.diaria && hhmm >= p.diaria.padStart(5, "0") && !this.#yaCorrioHoy("recepcion", ahora) && !this.corridas.enCurso) {
      disparos.push("recepcion");
      this.log("programador: corrida diaria de Recepción");
      const { corridaId } = await this.corridas.correr("recepcion", [], { quienPide: "programador" });
      await this.corridas.reportar(corridaId).catch(e => this.log("reporte: " + e.message));
      disparos.push("comunicacion");
      await this.corridas.correr("comunicacion", [], { quienPide: "programador" }).catch(e => this.log("comunicacion: " + e.message));
    }
    if (p.conciliacionDia !== null && ahora.getDay() === p.conciliacionDia && p.diaria && hhmm >= p.diaria.padStart(5, "0")
        && !this.#yaCorrioHoy("conciliacion", ahora) && !this.corridas.enCurso) {
      disparos.push("conciliacion");
      await this.corridas.correr("conciliacion", [], { quienPide: "programador" }).catch(e => this.log("conciliacion: " + e.message));
    }
    this.ultimoTick = ahora.toISOString();
    return disparos;
  }
}

const diaLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
