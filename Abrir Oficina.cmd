@echo off
rem Doble clic para ver la oficina con las cifras de la ultima corrida (Windows).
cd /d "%~dp0"
if not exist "Oficina IASIMA.html" (
  echo Todavia no existe la oficina. Haga doble clic primero en "Correr agente.cmd".
  pause
  exit /b 1
)
start "" "Oficina IASIMA.html"
