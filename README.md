# Oficina IASIMA

Agentes que operan el buzon de factura electronica de Odoo **desde fuera de la plataforma**.
Corre en su Mac, no dentro de Claude.

## Arrancar

```bash
cd ~/Proyectos/IASIMA-Oficina
npm install          # solo la primera vez (habilita el envio de correo)
npm run recepcion    # corre el agente de Recepcion
npm run oficina      # abre la oficina 2D en http://localhost:4173
```

## Que hay aqui

| Archivo | Que hace |
|---|---|
| `src/odoo.js` | Cliente de Odoo con **candado de solo lectura**: cualquier metodo que escriba se rechaza antes de salir a la red |
| `src/agents/recepcion.js` | El agente de Recepcion |
| `src/reporte.js` | Arma el reporte en HTML |
| `src/mailer.js` | Envia el reporte por correo (opcional) |
| `src/run.js` | Punto de entrada |
| `ui/index.html` | La oficina 2D |
| `reportes/` | Un reporte por corrida, en HTML y JSON |
| `data/estado.json` | Lo que la oficina lee para pintar a los agentes |

## Que hace el agente RECEPCION

Solo lectura. En una corrida (~2 segundos, 6 consultas):

1. **Entra al buzon** `bdt.invoice.email` — la pantalla Contabilidad > Proveedores > Correo de facturas.
2. **Barre las 72 companias a la vez.** Odoo solo muestra la compania activa; el agente las ve todas.
3. **Cuenta el desenlace de cada correo**: registrada, tiquete electronico, error, rechazada, cedula invalida, duplicada, en cola.
4. **Verifica los tiquetes contra la clave numerica.** El tipo de documento vive en las posiciones 30-31 de la clave de 50 digitos; `04` es tiquete electronico. Comprueba dos cosas: que lo marcado como tiquete de verdad sea `04`, y que ningun `04` se haya colado como factura registrada.
5. **Detecta buzones caidos** — compania sin un correo nuevo en mas de `ALERTA_HORAS_SIN_INGESTA` horas.
6. **Ordena las companias** por tasa de registro y marca las que caen bajo `ALERTA_PCT_MINIMO`.
7. **Entrega**: guarda el reporte en `reportes/`, actualiza `data/estado.json` para la oficina, y lo manda a `REPORTE_PARA`.

**No escribe nada en Odoo.** Ni corrige, ni confirma, ni reprocesa. Eso sera del agente Correccion, y solo con aprobacion.

## Configuracion — `.env`

| Variable | Para que |
|---|---|
| `ODOO_URL`, `ODOO_DB`, `ODOO_USER`, `ODOO_PASSWORD` | Conexion. Hoy apunta a la **copia de pruebas** (`is_neutralized = true`) |
| `REPORTE_PARA` | A quien llega el reporte diario |
| `SMTP_*` | Vacio = no se envia correo, solo se guarda. Para Gmail use una **contrasena de aplicacion**, no la del correo |
| `ALERTA_HORAS_SIN_INGESTA` | Cuantas horas sin correo nuevo disparan alerta critica |
| `ALERTA_PCT_MINIMO` | Bajo que porcentaje de registro se levanta alerta |

## Pendientes

- [ ] Rotar la contrasena de `admin` y crear un usuario de servicio de **solo lectura** para el agente.
- [ ] Configurar SMTP para que el reporte salga por correo.
- [ ] Programar la corrida diaria (7:00 a.m.).
- [ ] Agentes Conciliacion, Diagnostico, Correccion y Reporte.
- [ ] Empaquetar como aplicacion de escritorio.
