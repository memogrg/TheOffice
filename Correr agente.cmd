@echo off
rem Doble clic para que el agente de Recepcion lea Odoo y actualice la oficina (Windows).
cd /d "%~dp0"
echo ===============================================
echo    OFICINA IASIMA  -  agente de Recepcion
echo ===============================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo   No encontre Node.js en esta PC.
  echo.
  echo   Que hacer:
  echo    1. Abra https://nodejs.org
  echo    2. Descargue la version LTS e instalela
  echo    3. Vuelva a hacer doble clic en este archivo
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo   Node encontrado: %%v
echo.
if not exist .env (
  echo   Falta el archivo .env. Copie .env.example a .env y complete la conexion a Odoo.
  echo.
  pause
  exit /b 1
)
node src\run.js recepcion
if errorlevel 1 (
  echo.
  echo   El agente fallo. Revise el mensaje de arriba.
) else (
  echo.
  echo   Abriendo la oficina...
  start "" "Oficina IASIMA.html"
)
echo.
pause
