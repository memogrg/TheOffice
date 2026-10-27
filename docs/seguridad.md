# Seguridad de la Oficina

Lo que hace el servicio solo, y lo que hay que hacer a mano antes de abrirlo a más gente.

## Lo que hace el servicio

| Medida | Detalle |
|---|---|
| Solo esta PC por omisión | Escucha en `127.0.0.1` (`SERVICIO_HOST` para cambiarlo en Docker/Fly/Render). El túnel de Cloudflare se conecta a localhost, así que sigue funcionando. |
| Remoto sin token = rechazado | Una petición que llega por un proxy o túnel (cabeceras `CF-Connecting-IP`, `X-Forwarded-For`…) o desde otra máquina es remota. Sin `SERVICIO_TOKEN` se rechaza entera (403), página incluida. |
| Escribir en Odoo desde afuera = sesión personal | Crear asientos, ejecutar cambios al plan de cuentas, aplicar propuestas y enviar correos: desde afuera solo con la sesión de un usuario **contable** (enlace de acceso), no con el token compartido. Así la auditoría lleva un nombre verificado. Los rechazos quedan en Auditoría. `ESCRITURA_SIN_SESION=si` lo desactiva (no recomendado). |
| Límite de intentos | 10 tokens o enlaces fallidos por IP en 15 minutos bloquean esa IP 15 minutos. |
| CSRF | Los POST tienen que ser JSON; un POST con cookie que trae `Origin` de otro sitio se rechaza. Cookies `HttpOnly; SameSite=Strict` (y `Secure` detrás de HTTPS). |
| Cabeceras | `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer` (el enlace de acceso lleva el token en la URL), política de contenido que solo carga lo propio y las fuentes de Google. |
| Comparaciones | Token y cookie se comparan en tiempo constante; la cookie lleva un HMAC del token, no el token. |
| Permisos de escritura separados | `PERMITIR_ESCRITURA` (facturas con comprobante, pasan por Hacienda), `PERMITIR_ESCRITURA_ASIENTOS` (asientos de diario), `PERMITIR_ESCRITURA_CUENTAS` (plan de cuentas). Nada se escribe sin una aprobación con nombre. |
| Avisos al arrancar | Sin token; token de menos de 24 caracteres; escritura habilitada con el usuario `admin` de Odoo. |

## Lo que hay que hacer a mano

1. **Token largo.** `SERVICIO_TOKEN` de 32+ caracteres al azar (por ejemplo `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`). Cambiarlo invalida las cookies de todos.
2. **Usuario de servicio en Odoo, no admin.** En la copia ya existe `oficina@iasima.cr` (id 24, 80 compañías permitidas, grupo Facturación). Para que la app pueda crear asientos y cambiar el plan de cuentas necesita además:
   - **Facturación / Administrador** (crear y editar cuentas contables),
   - **Técnico / Mostrar todas las funciones contables** (asientos de diario).
   Y **no** necesita: Administración / Ajustes ni Derechos de acceso, ni los grupos de TecnoDEM («Puede validar factura sin Hacienda», «Puede cancelar asientos», «Puede enviar asientos a borrador», «Puede cambiar estado de factura»). Después: entrar como ese usuario, crear su clave de API y poner `ODOO_USER=oficina@iasima.cr` y la clave en `ODOO_PASSWORD`.
3. **Rotar** la clave de API de `admin` que se usó en pruebas, la contraseña de `admin` de la copia y el token del MCP.
4. **Usuarios con nombre.** En la pestaña Usuarios, crear un usuario **contable** para cada persona que vaya a crear asientos desde afuera (Victor, Memo) y mandarles su enlace.
5. **Repositorio privado.** El repositorio es público y el historial tiene una base de pruebas (commit `5eeeabf`). En GitHub: Settings → General → Danger Zone → Change visibility → Private (lo hace el dueño, Memo). Si además se quiere borrar del historial: `git filter-repo --path tmp/ --invert-paths` y forzar el push (reescribe la historia: avisar antes a quien tenga copias).
6. **Hacienda.** `PERMITIR_ESCRITURA` (facturas) queda vacío hasta que TecnoDEM confirme que la copia no manda nada a Hacienda (hoy `api-prod` con el certificado real).
