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

## El servicio (la app)

```bash
npm run servicio     # http://localhost:4180
```

Un solo proceso: base de datos (SQLite incorporado en Node, `data/oficina.db`), los agentes,
el calendario y la app web. Todo lo que un agente encuentra queda en la base, y todo lo que
escribe en Odoo o manda por correo pasa antes por una persona:

| Pantalla | Qué se hace ahí |
|---|---|
| **Tablero** | Cifras de la última corrida, alertas, compañías y receptores con casos abiertos. Botones para correr cada agente (solo leen y proponen). |
| **Casos** | Un caso por documento y receptor. Filtro por receptor, compañía, frente (afuera/adentro). «Resuelto» lo marca una persona; la corrida siguiente no lo pisa, y lo que deja de aparecer en Odoo se cierra solo. |
| **Aprobaciones** | Las propuestas de Cuentas, línea por línea. Aprobar / rechazar; «Aplicar en Odoo» corre el agente en escritura **solo sobre lo aprobado** de esa compañía. |
| **Correos** | Los borradores de Victor con vista previa. Aprobar / rechazar; enviar en prueba (todo a su correo) o de verdad. |
| **Director** | Chat. Con `CLAUDE_API_KEY`, un modelo de lenguaje decide qué agente atiende, lo corre como herramienta y responde con cifras («¿qué le reclamo a los proveedores de IAR?», «revisá las cuentas de Puuk», «¿en qué cuenta debería ir la factura de Rostipollos?»: `revisar_factura` explica línea por línea lo que Cuentas haría). **Memoria**: cada persona retoma su conversación al volver (la misma en la app y en la oficina 2D), con 30 días de historial y un resumen de lo hablado antes. **Reglas dictadas**: «todo lo de este proveedor va a 5.04.17.01» queda como regla propuesta en Aprobaciones; al aprobarla se guarda en `data/reglas.json` y Cuentas propone cada línea afectada. Sus herramientas son de solo lectura y propuesta: no puede escribir en Odoo ni enviar correos. Sin clave, es el Director de palabras clave. |
| **Usuarios** (contable) | Alta de receptores y contables, y **enlace de acceso** de un solo uso (3 días): se envía por correo si hay SMTP y siempre queda para copiarlo. Desactivar cierra sus sesiones. |
| **Corridas** y **Auditoría** | Qué corrió, cuánto tardó, qué encontró; y quién aprobó, rechazó, aplicó o envió qué, y cuándo. |

API en `/api/*` (JSON). Si `SERVICIO_TOKEN` está en `.env`, **todo** (lectura incluida) exige el token: la app lo pide
una vez en una pantalla de entrada y lo guarda en una cookie firmada; la API acepta `Authorization: Bearer <token>`.
La cabecera `X-Quien` identifica a quien decide y queda en la auditoría.

**Roles.** Un **receptor** (el correo que recibe las facturas en el buzón) entra con su enlace y ve solo lo suyo:
sus compañías, sus casos (y puede marcarlos resueltos, firmados con su nombre) y los avisos aprobados o enviados
dirigidos a él; nada de propuestas, corridas, Director ni oficina 2D. Un **contable** ve y hace todo. El token de
servicio sigue valiendo como contable sin nombre fijo (modo local). Las sesiones viven 30 días en una cookie. Calendario: `CORRIDA_DIARIA=07:00`
corre Recepción y Comunicación (borradores) todos los días; `CONCILIACION_SEMANAL=1` corre Conciliación los lunes.

La oficina 2D sigue existiendo (`/oficina` en el servicio, o `Oficina IASIMA.html` con doble clic).

**Varios inquilinos.** La misma app atiende varias firmas, cada una con su Odoo, su base, sus reglas,
su calendario, su Director y su marca: `INQUILINOS=iasima,sima` y `IASIMA_ODOO_URL=…`, `SIMA_ODOO_URL=…`
(cualquier `<ID>_VARIABLE` pisa la global para ese inquilino; `<ID>_NOMBRE`, `_COLOR`, `_LOGO`, `_DOMINIO`
son la marca). Se entra por `/t/<id>/` o por el dominio del inquilino; la raíz muestra el selector.
Los datos de cada uno viven en `inquilinos/<id>/`. Sin `INQUILINOS`, todo funciona como antes.

**Desplegar**: ver `DESPLIEGUE.md` (Railway/Render/Fly con Docker; por qué no Vercel; flujo PR → pruebas → despliegue).

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
| `src/run.js` | Punto de entrada por terminal. Reporte HTML/JSON, `data/estado.json`, regenera la oficina, correo opcional. Candado contra corridas simultáneas. |
| `src/oficina.js` | Genera la oficina 2D con cifras, Director y marca (la usan `run.js` y el servicio). |
| `src/servicio/inquilinos.js` | Varios inquilinos: configuración por prefijo, raíces separadas, enrutamiento por `/t/<id>` o dominio. |
| `Dockerfile`, `fly.toml`, `render.yaml`, `DESPLIEGUE.md`, `.github/workflows/` | Despliegue (Fly.io, Render, Docker) y CI. |
| `src/servicio/` | **La app**: `db.js` (SQLite), `corridas.js` (corre agentes y persiste; aplica aprobadas; envía aprobados), `programador.js` (calendario), `director-llm.js` (Claude con los agentes como herramientas), `api.js` (HTTP), `index.js` (arranque). |
| `ui/app/index.html` | La app web que sirve el servicio. |
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
factura de proveedor en borrador o publicada y clasifica cada línea con la **guía de Victor**
(`docs/guia-clasificacion-cuentas.md`, en código en `src/clasificador.js`): regla propia del cliente →
naturaleza del gasto (qué dice la línea y qué tipo de proveedor es) → historial (el del cliente y el consenso
entre clientes, `data/referencia/`) → consulta al contador. Nunca propone un comodín. Lo que cierra solo va a
propuestas; lo dudoso, a **Aprobaciones → Consultas al contador**. Con `--aplicar` y `PERMITIR_ESCRITURA=si`
las aplica: borrador → corrige → confirma; publicada → restablece → corrige → confirma, pero solo
si la cuenta actual es un "cajón de sastre" o hay regla humana. Nunca toca facturas pagadas.
Verifica después de escribir. Recuerda lo revisado en `data/revisadas.json` (`--revisar-todo` lo ignora).

**Fase 3A, solo lectura** (pestaña **Hallazgos**; corren solos: Diagnóstico cada día con Recepción, el resto una vez por semana con Conciliación):

- **DIAGNÓSTICO** — reconoce la causa de cada correo con problema en el buzón (periodo fiscal cerrado, impuesto que no existe, medio de pago, factura a otra cédula, proveedor repetido o inexistente, XML dañado, reenvíos), dice qué hacer y quién, y separa lo que es configuración de lo que hay que pedirle al emisor. Da los pendientes concretos: qué mes abrir en qué compañía, qué impuesto crear.
- **RECURRENTES** — por compañía y proveedor, lo que se factura todos los meses; avisa lo que faltó en el último mes cerrado y los montos fuera de lo normal (`RECURRENTES_VENTANA`, `RECURRENTES_MINIMO`, `RECURRENTES_DESVIO`, `RECURRENTES_MES`).
- **BANCOS** — estado de las conciliaciones bancarias del módulo de TecnoDEM por cuenta: al día, atrasada, solo borradores, nunca conciliada (con movimiento), partidas pendientes, fechas en el futuro.
- **DOCUMENTOS** — notas de crédito de compra y venta sin ligar a la factura que corrigen (propone el vínculo por clave o consecutivo) y huecos en los consecutivos de venta.

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
| `RECEPTORES_DOMINIOS` | Cambio de dominio de los receptores: `viejo.com=nuevo.cr`. La misma casilla en los dos dominios es un solo receptor (una carta, un usuario). Recepción avisa si ve la misma casilla en dos dominios sin declarar. |
| `ALERTA_REFERENCIA` | `ultimo-correo` mide la ingesta contra el correo más reciente (para la copia de pruebas, que está congelada). |
| `PERMITIR_ESCRITURA` | `si` habilita a CUENTAS a modificar Odoo (además de `--aplicar`). |
| `CATALOGO_CUENTAS` | Otro catálogo que no sea `data/catalogo-cuentas.json`. |
| `PUERTO`, `BASE_DE_DATOS`, `SERVICIO_TOKEN` | Del servicio: puerto (4180), ruta de la base (`data/oficina.db`), token para las acciones. |
| `CORRIDA_DIARIA`, `CONCILIACION_SEMANAL` | Calendario del servicio: hora local `HH:MM` y día de la semana (0 domingo … 6 sábado). |
| `CLAUDE_API_KEY`, `CLAUDE_WORKSPACE_ID`, `DIRECTOR_MODELO`, `DIRECTOR_MAX_PASOS` | El Director por modelo de lenguaje. Sin clave, Director de palabras. |
| `DIRECTOR_RETENCION_DIAS`, `DIRECTOR_TURNOS_COMPLETOS`, `DIRECTOR_MAX_CONTEXTO` | Memoria del Director: 30 días de historial por persona, cuántos turnos van completos al modelo y el tope de contexto. |

Las variables de entorno pisan al `.env`, así que se puede correr en un contenedor o en CI sin el archivo.

## Pendientes

- [ ] Crear el usuario de servicio con clave API y permisos mínimos; rotar la contraseña de `admin`.
- [ ] Validar con TecnoDEM el efecto de `button_draft` / `action_post` sobre facturas de compra
      con factura electrónica (mensaje de aceptación a Hacienda) antes de usar `--aplicar` en producción.
- [ ] Agentes Diagnóstico, Corrección y Reporte.
- [ ] Desplegar el servicio en un VPS (Docker) apuntando a producción.
