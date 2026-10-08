# Orquestador Comité Sellers

Tablero de SLA publicado como aplicación web de Apps Script. Abrir y filtrar no consulta BigQuery: a las 7:00, hora de Bogotá, se lee una vez y el archivo queda en Drive.

El enlace que ya usa la gente es el de producción. La rama `dev` publica en otro proyecto de Apps Script, para probar.

## Qué va en cada rama

| Rama | Apps Script | Enlace |
|---|---|---|
| `dev` | proyecto de pruebas | el de desarrollo |
| `main` | el proyecto que ya está publicado | el mismo `/exec` de ahora |

Al hacer push, GitHub sube los archivos de `app/` y actualiza la implementación que ya existe. No crea un enlace nuevo.

## Secrets del repositorio

En Settings → Secrets and variables → Actions:

| Secret | Qué es |
|---|---|
| `CLASPRC` | contenido de `~/.clasprc.json` después de `clasp login` |
| `SCRIPT_ID_PROD` | ID del script de producción (engranaje del proyecto) |
| `SCRIPT_ID_DEV` | ID del script de desarrollo |
| `DEPLOY_ID_PROD` | ID de la implementación web de producción (`AKfycb…`) |
| `DEPLOY_ID_DEV` | ID de la implementación web de desarrollo |

`CLASPRC` es una credencial. No se commitea.

## Archivos

`app/` es el proyecto de Apps Script. El servidor empieza por `Srv`. La página son los HTML. `index.html` los junta.

La semana de Documentos, Pricing y Remo empieza el lunes. El conteo es `COUNT(nid)`. Una hora nula entra en la barra y no entra en «cumple».
