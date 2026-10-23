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

## Railway, paso a paso

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

- `SERVICIO_TOKEN` obligatorio: sin él cualquiera que conozca la URL puede correr agentes y aprobar.
- La lectura (GET) todavía es abierta: el login por enlace mágico para receptores es lo siguiente en la Fase 2.
- `PERMITIR_ESCRITURA` vacío hasta que TecnoDEM confirme el ambiente de Hacienda de la copia.
- Claves API de Odoo y de Claude solo en variables del host, nunca en el repo.
