# Oficina IASIMA

Agentes que operan el buzón de factura electrónica de Odoo **desde fuera de la plataforma**.
Corren en su máquina (Mac o Windows), no dentro de Claude.

## Arrancar

```bash
npm install          # solo la primera vez (habilita el envío de correo)
cp .env.example .env # y complete la conexión a Odoo
npm run recepcion    # Marta lee el buzón y regenera "Oficina IASIMA.html"
npm test             # 30 pruebas, sin tocar Odoo
```

Sin credenciales se puede probar todo contra un Odoo de mentira:

```bash
ODOO_SIMULADO=test/simulado/instancia.json npm run recepcion
```

En Mac: doble clic en `Correr agente.command`. En Windows: `Correr agente.cmd`. Ver `GUIA.md`.

## Qué hay aquí

| Archivo | Qué hace |
|---|---|
| `src/odoo.js` | Cliente JSON-RPC. `leer()` solo acepta métodos de lectura, siempre; `escribir()` exige permiso explícito. `leerTodo()` pagina sin límites fijos. Timeout y reintentos. |
| `src/odoo-simulado.js` | El mismo cliente, pero sobre un JSON local. Para pruebas. |
| `src/lib/clave.js` | La clave de 50 dígitos de Hacienda: tipo de documento, cédula del emisor, fecha. Puro. |
| `src/lib/correo.js` | Receptores, remitentes, deduplicación de documentos, causas dominantes. Puro. |
| `src/agents/recepcion.js` | **Marta**. Lee el buzón de todas las compañías, cuenta, verifica tiquetes, consolida por receptor. Deja `data/bandeja-victor.json` y `data/companias.json`. |
| `src/agents/comunicacion.js` | **Victor**. Redacta un correo por receptor. Sin `--enviar` no manda nada. |
| `src/agents/conciliacion.js` | Cruza cada clave del buzón contra `account.move.e_key`. |
| `src/agents/cuentas.js` | Revisa cuentas contables línea por línea. **Único que escribe**, y solo con `--aplicar` + `PERMITIR_ESCRITURA=si`. |
| `src/director-core.cjs` | El Director: decide qué agente ejecuta una instrucción. **Única implementación**: Node la importa y `run.js` la incrusta en la oficina. |
| `src/run.js` | Punto de entrada. Reporte HTML/JSON, `data/estado.json`, regenera la oficina, correo opcional. Candado contra corridas simultáneas. |
| `scripts/construir-catalogo.js` | Arma `data/catalogo-cuentas.json` desde el histórico de Odoo (sin Excel). |
| `data/roster.json` | El contrato de cada agente. El Director lo lee. |
| `data/reglas.json` | Decisiones humanas sobre cuentas. Mandan sobre el histórico. |
| `ui/plantilla.html` | La oficina 2D. `run.js` la rellena y escribe `Oficina IASIMA.html`. |
| `test/` | Pruebas (`node:test`) y el Odoo simulado (`test/simulado/`). |

## Qué hace cada agente

**RECEPCIÓN (Marta)** — solo lectura. Entra a `bdt.invoice.email` de todas las compañías
(Odoo solo muestra la activa; el agente las ve todas), cuenta el desenlace de cada correo
(`done`, `isticket`, `error`, `rejected`, `vatiderror`, `duplicate`, `process`), verifica que lo
marcado como tiquete sea tipo `04` en la clave y que ningún `04` se haya registrado como factura,
detecta buzones sin ingesta, ordena las compañías por tasa de registro, y consolida por receptor
dos paquetes: lo que hay que reclamarle al establecimiento (tiquetes, rechazados) y lo que tiene
que revisar un humano adentro (duplicados, errores, en cola, cédulas inválidas).

**COMUNICACIÓN (Victor)** — no entra a Odoo. Toma la bandeja de Marta y redacta un correo por
receptor. Los borradores quedan en `reportes/borradores-victor-<fecha>/`. Con `--enviar` manda
todo a `REPORTE_PARA` (prueba); con `--enviar --a-los-receptores` manda de verdad.

**CONCILIACIÓN** — solo lectura. Todo correo `done` debería tener su factura en los libros.
Lista los que no.

**CUENTAS** — escribe, con permiso. Para una compañía (`--empresa=<id o nombre>`), abre cada
factura de proveedor en borrador o publicada, compara la cuenta de cada línea con el catálogo
histórico y las reglas humanas, y propone correcciones. Con `--aplicar` y `PERMITIR_ESCRITURA=si`
las aplica: borrador → corrige → confirma; publicada → restablece → corrige → confirma, pero solo
si la cuenta actual es un "cajón de sastre" o hay regla humana. Nunca toca facturas pagadas.
Verifica después de escribir. Recuerda lo revisado en `data/revisadas.json` (`--revisar-todo` lo ignora).

**DIRECTOR** — `node src/run.js director "revisá las cuentas de Puuk"`. Puntúa a todos los
agentes con las palabras del roster, pregunta si hay empate, pide la compañía si falta.

## Configuración — `.env`

| Variable | Para qué |
|---|---|
| `ODOO_URL`, `ODOO_DB`, `ODOO_USER`, `ODOO_PASSWORD` | Conexión. Use un **usuario de servicio con clave API**, no `admin`. |
| `ODOO_SIMULADO` | Ruta a un JSON `{ modelo: [registros] }`. Si está, no se toca la red. |
| `ODOO_TIMEOUT_SEGUNDOS` | Espera por respuesta antes de reintentar (60). |
| `REPORTE_PARA`, `REPORTE_DE` | A quién llega el reporte diario y desde quién. |
| `SMTP_*` | Vacío = no se envía correo. Para Gmail use una **contraseña de aplicación**. |
| `ALERTA_HORAS_SIN_INGESTA`, `ALERTA_PCT_MINIMO` | Umbrales de alerta. |
| `ALERTA_REFERENCIA` | `ultimo-correo` mide la ingesta contra el correo más reciente (para la copia de pruebas, que está congelada). |
| `PERMITIR_ESCRITURA` | `si` habilita a CUENTAS a modificar Odoo (además de `--aplicar`). |
| `CATALOGO_CUENTAS` | Otro catálogo que no sea `data/catalogo-cuentas.json`. |

Las variables de entorno pisan al `.env`, así que se puede correr en un contenedor o en CI sin el archivo.

## Pendientes

- [ ] Crear el usuario de servicio con clave API y permisos mínimos; rotar la contraseña de `admin`.
- [ ] Validar con TecnoDEM el efecto de `button_draft` / `action_post` sobre facturas de compra
      con factura electrónica (mensaje de aceptación a Hacienda) antes de usar `--aplicar` en producción.
- [ ] Programar la corrida diaria (7:00 a.m.).
- [ ] Agentes Diagnóstico, Corrección y Reporte.
- [ ] Servicio web con usuarios (contabilidad y receptores), calendario y cola de aprobaciones.
