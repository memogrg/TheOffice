# Desplegar la Oficina

El servicio es **un proceso Node que corre todo el día**, con una base SQLite en disco, un
calendario interno y corridas que pueden durar más de un minuto. Eso define el host:

| Host | ¿Sirve? | Por qué |
|---|---|---|
| **Railway** (recomendado), Render, Fly.io | Sí | Proceso persistente, volumen para `data/` e `inquilinos/`, despliegue automático desde GitHub, una URL por rama para probar. |
| Un VPS con Docker | Sí | Igual, a mano. `docker compose up -d`. |
| Vercel, Netlify, Cloudflare Workers | **No, tal como está** | Funciones sin estado y de vida corta: sin disco (la base se pierde), tope de segundos por petición, sin procesos de fondo. Llevarla ahí exige Postgres, partir los agentes en pasos cortos y mover el calendario a Vercel Cron. |

## Flujo de trabajo (Memo y David cambian, Victor prueba)

1. Cada cambio va en una **rama** y entra por **pull request** a `main`.
2. GitHub Actions corre las 42+ pruebas y una corrida simulada en cada push (`.github/workflows/pruebas.yml`). Un PR con pruebas en rojo no se mezcla.
3. Railway crea un **entorno de prueba por PR** (URL propia) donde Victor prueba contra la copia neutralizada de Odoo.
4. Al mezclar a `main`, Railway despliega producción solo.

> **Octubre 2026:** Railway tiene los registros nuevos pausados tras un incidente de seguridad del 21 de
> octubre (acceso indebido a variables de entorno de clientes). Mientras tanto: Fly.io o Render para el
> host definitivo, y Cloudflare Tunnel sobre una PC para probar hoy.

## Probar hoy desde una PC: Cloudflare Tunnel

Sin cuenta, URL temporal (cambia en cada arranque):

```powershell
Invoke-WebRequest https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe -OutFile "$HOME\Downloads\cloudflared.exe"
& "$HOME\Downloads\cloudflared.exe" tunnel --url http://localhost:4180
```

Con cuenta gratuita de Cloudflare y un dominio en Cloudflare, URL fija que sobrevive reinicios:

```powershell
cloudflared tunnel login                      # abre el navegador, elige el dominio
cloudflared tunnel create oficina
cloudflared tunnel route dns oficina oficina.sudominio.cr
cloudflared tunnel run --url http://localhost:4180 oficina
```

En ambos casos: `SERVICIO_TOKEN` en el `.env` **antes** de abrir el túnel, y la PC sin suspensión.

## Fly.io, paso a paso (recomendado mientras Railway esté cerrado)

1. Cuenta en fly.io (pide tarjeta; la app cuesta unos US$4–7/mes). Instale `flyctl` (`winget install flyctl` o `iwr https://fly.io/install.ps1 -useb | iex`).
2. En la carpeta del repo: `flyctl auth login`, luego `flyctl launch --copy-config --no-deploy` (usa el `fly.toml` del repo; acepte o cambie el nombre de la app y la región `mia`).
3. Volumen: `flyctl volumes create oficina_datos --size 1 --region mia`.
4. Secretos (nunca en el repo):
   ```
   flyctl secrets set INQUILINOS=iasima,sima IASIMA_NOMBRE=IASIMA IASIMA_ODOO_URL=https://iasima.tecnodem.net IASIMA_ODOO_DB=iasima IASIMA_ODOO_USER=oficina@iasima.cr IASIMA_ODOO_PASSWORD=… IASIMA_ALERTA_REFERENCIA=ultimo-correo SIMA_NOMBRE=SIMA SERVICIO_TOKEN=… CLAUDE_API_KEY=… CORRIDA_DIARIA=07:00
   ```
5. `flyctl deploy`. La app queda en `https://<app>.fly.dev/t/iasima/`.
6. Despliegue automático desde GitHub: en el repo, *Settings → Secrets and variables → Actions*: secreto `FLY_API_TOKEN` (`flyctl tokens create deploy`) y variable `DESPLEGAR_FLY=si`. Desde ahí, cada merge a `main` despliega solo (`.github/workflows/desplegar-fly.yml`).
7. Catálogo: `flyctl ssh console -C "node scripts/construir-catalogo.js --inquilino=iasima"`.

## Render, paso a paso

1. Cuenta en render.com. *New → Blueprint* → conecte el repo: lee `render.yaml` (instancia Starter US$7/mes + disco 1 GB).
2. Complete las variables marcadas `sync: false` en el panel.
3. Cada push a `main` despliega solo. Las *Preview Environments* por PR están en el plan Pro del workspace.

## Railway, paso a paso (cuando reabra registros)

1. Suba el repo a GitHub (branch `app` → PR → `main`).
2. En [railway.app](https://railway.app): **New Project → Deploy from GitHub repo** → elija `TheOffice`. Railway detecta el `Dockerfile`.
3. **Volume**: en el servicio, *Settings → Volumes → Add Volume*, mount path `/app/inquilinos` (y otro en `/app/data` si usa un solo inquilino). Sin volumen, la base se borra en cada despliegue.
4. **Variables** (*Settings → Variables*), mínimo:

   ```
   INQUILINOS=iasima,sima
   IASIMA_NOMBRE=IASIMA
   IASIMA_ODOO_URL=https://iasima.tecnodem.net
   IASIMA_ODOO_DB=iasima
   IASIMA_ODOO_USER=oficina@iasima.cr
   IASIMA_ODOO_PASSWORD=<clave API>
   IASIMA_ALERTA_REFERENCIA=ultimo-correo      # mientras sea la copia congelada
   SIMA_NOMBRE=SIMA
   SIMA_ODOO_URL=…  SIMA_ODOO_DB=…  SIMA_ODOO_USER=…  SIMA_ODOO_PASSWORD=…
   SERVICIO_TOKEN=<cadena larga al azar>       # la app ya no está en localhost
   CLAUDE_API_KEY=…                            # el Director por modelo de lenguaje
   CORRIDA_DIARIA=07:00
   TZ=America/Costa_Rica
   ```

   Cualquier variable con prefijo `<ID>_` vale solo para ese inquilino; sin prefijo vale para todos.
5. **Networking → Generate Domain**: Railway da `algo.up.railway.app`. La app queda en `/t/iasima/` y `/t/sima/`; la raíz muestra el selector.
6. Dominios propios (opcional): agregue `iasima.oficina.cr` en *Custom Domains* y ponga `IASIMA_DOMINIO=iasima.oficina.cr`; entonces ese dominio entra directo sin prefijo.
7. *Settings → Environments → Enable PR environments* para que cada pull request tenga su URL.

## Primer arranque en el host

1. Abra `/t/iasima/`, escriba su nombre en «Soy» y el token en la cajita del token.
2. Tablero → «Recepción (Marta)». Si conecta, verá las 79 compañías.
3. En una terminal del host (Railway: *Deployments → ⋯ → Shell*): `node scripts/construir-catalogo.js --inquilino=iasima`.
4. Repita para `sima` cuando tenga su Odoo.

## Docker a mano

```bash
docker build -t oficina .
docker run -d --name oficina -p 4180:4180 --env-file .env \
  -v oficina-inquilinos:/app/inquilinos -v oficina-data:/app/data oficina
```

## Seguridad en internet

- `SERVICIO_TOKEN` obligatorio: con él, **nada** del inquilino se ve sin entrar (lectura incluida). La app pide el token una vez y lo guarda en una cookie firmada; la API acepta `Authorization: Bearer <token>`.
- El login por enlace mágico para receptores (cada uno ve solo sus compañías) es lo siguiente en la Fase 2.
- `PERMITIR_ESCRITURA` vacío hasta que TecnoDEM confirme el ambiente de Hacienda de la copia.
- Claves API de Odoo y de Claude solo en variables del host, nunca en el repo.
