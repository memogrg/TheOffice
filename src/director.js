// EL DIRECTOR para la terminal: lee el roster y las compañías del disco y delega la
// decisión en src/director-core.cjs, el mismo código que corre en la oficina.
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export const DirectorCore = require("./director-core.cjs");

export class Director {
  constructor(rutaRoster, rutaCompanias) {
    this.roster = JSON.parse(readFileSync(rutaRoster, "utf8"));
    this.agentes = this.roster.agentes || [];
    this.noConstruidos = this.roster.noConstruidos || [];
    this.companias = (rutaCompanias && existsSync(rutaCompanias))
      ? JSON.parse(readFileSync(rutaCompanias, "utf8")) : [];
  }

  decidir(instruccion) {
    return DirectorCore.decidir(instruccion, this.roster, this.companias);
  }
}
