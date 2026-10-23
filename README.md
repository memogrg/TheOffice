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
| **Director** | Chat. Con `CLAUDE_API_KEY`, un modelo de lenguaje decide qué agente atiende, lo corre como herramienta y responde con cifras («¿qué le reclamo a los proveedores de IAR?», «revisá las cuentas de Puuk»). Sus herramientas son de solo lectura y propuesta: no puede escribir en Odoo ni enviar correos. Sin clave, es el Director de palabras clave. |
| **Corridas** y **Auditoría** | Qué corrió, cuánto tardó, qué encontró; y quién aprobó, rechazó, aplicó o envió qué, y cuándo. |

API en `/api/*` (JSON). Si `SERVICIO_TOKEN` está en `.env`, toda acción exige `Authorization: Bearer <token>`;
la cabecera `X-Quien` identifica a quien decide y queda en la auditoría. Calendario: `CORRIDA_DIARIA=07:00`
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
| `Dockerfile`, `DESPLIEGUE.md`, `.github/workflows/pruebas.yml` | Despliegue y CI. |
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
| `PUERTO`, `BASE_DE_DATOS`, `SERVICIO_TOKEN` | Del servicio: puerto (4180), ruta de la base (`data/oficina.db`), token para las acciones. |
| `CORRIDA_DIARIA`, `CONCILIACION_SEMANAL` | Calendario del servicio: hora local `HH:MM` y día de la semana (0 domingo … 6 sábado). |
| `CLAUDE_API_KEY`, `DIRECTOR_MODELO`, `DIRECTOR_MAX_PASOS` | El Director por modelo de lenguaje. Sin clave, Director de palabras. |

Las variables de entorno pisan al `.env`, así que se puede correr en un contenedor o en CI sin el archivo.

## Pendientes

- [ ] Crear el usuario de servicio con clave API y permisos mínimos; rotar la contraseña de `admin`.
- [ ] Validar con TecnoDEM el efecto de `button_draft` / `action_post` sobre facturas de compra
      con factura electrónica (mensaje de aceptación a Hacienda) antes de usar `--aplicar` en producción.
- [ ] Login por enlace mágico para receptores (ven solo sus compañías) y roles.
- [ ] Agentes Diagnóstico, Corrección y Reporte.
- [ ] Desplegar el servicio en un VPS (Docker) apuntando a producción.
