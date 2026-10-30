# claude-sync — diseño

Fecha: 2026-10-30 · Estado: borrador para aprobación

## 1. Intención

Quien usa Claude Code en varios equipos acaba rehaciendo a mano hooks, `CLAUDE.md`, skills, agentes y plugins, y nunca quedan iguales. `claude-sync` es un plugin de Claude Code que guarda toda esa configuración en un repo de GitHub del propio usuario y la recupera en cualquier otro equipo, eligiendo pieza a pieza qué se sube y qué se aplica, con perfiles, versiones e instalación automática de lo que falte.

Es público y genérico: cada usuario lo instala y usa su propio repo privado (gratuito en GitHub). No hay servidor propio.

## 2. Objetivos

1. Exportar e importar **toda** la configuración de Claude Code, global y de proyecto, incluida la memoria.
2. Seleccionar **elemento a elemento** (cada hook, cada skill, cada plugin, cada archivo de memoria…) qué se sube, qué se aplica y qué entra en un perfil.
3. **Perfiles** con nombre y **perfiles mezcla** creados con piezas de otros.
4. **Versionado**: cada subida es una versión recuperable.
5. **Instalación automática** de plugins, mods y marketplaces que falten, **con su configuración**.
6. **Avisar, nunca aplicar solo**, cuando el repo tiene algo más nuevo.
7. **Ver la diferencia** antes de sobrescribir nada.
8. Funcionar **íntegramente en la terminal, dentro de Claude Code**, en Windows nativo, WSL, macOS y Linux.
9. Guía de instalación muy sencilla para alguien que ni siquiera tiene cuenta de GitHub.

## 3. No objetivos

- No es un gestor de dotfiles general: solo configuración de Claude Code.
- No sincroniza historial, sesiones, transcripciones, cachés ni estadísticas.
- No hay sincronización en segundo plano ni aplicación automática.
- No hay servicio, cuenta ni backend propios; solo GitHub.
- No se comparten perfiles entre usuarios (cada uno su repo). Usar un perfil de otro sería otro proyecto.

## 4. Antiobjetivos (fallaría aunque «funcione»)

- **Un secreto llega a GitHub.** Ni en claro ni cifrado. Es la regla más dura del diseño.
- **Se pierde un cambio local** sin que el usuario lo haya visto y aceptado.
- **Claude Code deja de arrancar** o queda roto después de aplicar un perfil (por ejemplo, un `settings.json` inválido).
- Aplicar en un sistema un hook pensado para otro sin avisar.

## 5. Restricciones

- Todo ocurre en la terminal dentro de Claude Code. Nada de navegador ni aplicación aparte.
- Dependencias del usuario: `git` (obligatorio) y `gh` (para iniciar sesión y crear el repo). No exigir Node, Python ni nada más que no traiga ya Claude Code.
- El código del plugin está en TypeScript, porque los mods de Claude Code se escriben en TS/TSX (importan de `claude-code`, como `sub-meter@better-claude`).
- El repo del plugin también es un **marketplace**, para instalarlo con `/plugin marketplace add <usuario>/claude-sync` + `/plugin install claude-sync@claude-sync`.
- Interfaz bilingüe: inglés por defecto y español si el sistema o Claude están en español. Todos los textos en un único sitio por idioma. La guía también en los dos idiomas.
- Licencia MIT (decisión mía). El repo del plugin se publica en la cuenta de GitHub con la que el autor tenga sesión iniciada en `gh`.

## 6. Qué se sincroniza

### 6.1 Global (`~/.claude/` y `~/.claude.json`)

| Elemento | Origen | Unidad seleccionable |
|---|---|---|
| Instrucciones | `~/.claude/CLAUDE.md` | el archivo |
| Hooks | `settings.json` → `hooks` | **cada entrada** (evento + matcher + comando) |
| Scripts que usan hooks y statusline | `~/.claude/hooks/`, `statusline.sh`, etc. | cada archivo; se arrastran con el hook que los referencia |
| Permisos | `settings.json` → `permissions` | cada regla `allow`/`deny`, y `defaultMode` |
| Resto de ajustes | `settings.json` (model, effortLevel, statusLine, tui, env…) | cada clave |
| Skills | `~/.claude/skills/<skill>/` | cada skill |
| Agentes | `~/.claude/agents/*.md` | cada agente |
| Comandos | `~/.claude/commands/*.md` | cada comando |
| Atajos | `~/.claude/keybindings.json` | el archivo |
| Marketplaces | `known_marketplaces.json` + `extraKnownMarketplaces` | cada marketplace (solo su origen) |
| Plugins y mods | `installed_plugins.json` + `enabledPlugins` | cada plugin: id, marketplace, versión/commit, activado o no |
| Config de plugins y mods | `settings.json` → `pluginConfigs` | va con su plugin |
| Datos de plugins y mods | `~/.claude/plugins/data/<plugin>/`, `plugins/store/`, `plugins/synced/` | van con su plugin, opcionales |
| Servidores MCP | `~/.claude.json` → `mcpServers` | cada servidor |

### 6.2 Proyecto (cuando Claude se abre dentro de un repo)

| Elemento | Origen |
|---|---|
| `.claude/` del repo | skills, agentes, comandos, `settings.json`, `settings.local.json` |
| Instrucciones | `CLAUDE.md`, `CLAUDE.local.md` |
| MCP del proyecto | `.mcp.json` y `~/.claude.json` → `projects[<ruta>]` (solo lo que sea configuración) |
| Memoria | `~/.claude/projects/<ruta codificada>/memory/` (cada archivo) |

Los elementos de proyecto se pueden aplicar al **mismo** proyecto en otro equipo o a **otro repo distinto**.

Alcance (decisión mía):
- Al subir solo entra el proyecto en el que está abierto Claude, no todos los que conoce el equipo.
- Al traer, los elementos de un proyecto se aplican al repo actual o al que elija el usuario, nunca a todos los clones a la vez.
- Los archivos que el proyecto ya tiene en su propio git también se pueden llevar, pero salen marcados como `en el git del proyecto`. Al aplicarlos, el cambio aparece en el git de ese proyecto como cualquier edición; claude-sync no hace commits en repos ajenos.

### 6.3 Nunca se sincroniza

`.credentials.json`, `history.jsonl`, `sessions/`, transcripciones `projects/*/*.jsonl`, `cache/`, `file-history/`, `shell-snapshots/`, `paste-cache/`, `session-env/`, `state/`, `jobs/`, `daemon*`, `backups/`, `stats-cache.json`, `remote-settings.json*`, `*.bak*`, `plugins/cache/`, `plugins/marketplaces/`, los catálogos `plugin-*-cache*.json` y todas las claves internas de `~/.claude.json` excepto `mcpServers` y la parte de configuración de `projects`.

## 7. Secretos

- **Nunca se suben.** Antes de cada subida se analizan todos los elementos seleccionados:
  - Valores de claves con nombre sensible (`*TOKEN*`, `*KEY*`, `*SECRET*`, `*PASSWORD*`, `Authorization`…) en `env`, MCP (`env`, `headers`, argumentos) y `pluginConfigs`.
  - Opciones que el propio plugin declara como sensibles en su `userConfig`. Claude ya las guarda aparte, en `.credentials.json`.
  - Patrones de tokens conocidos (`ghp_`, `github_pat_`, `sk-`, `xox`, claves privadas PEM…) en **cualquier** archivo, también memoria, `CLAUDE.md` y skills.
- Un valor detectado se sustituye por un marcador (`${secret:<nombre>}`) en lo que se sube. El valor real no sale del equipo.
- Si aparece un patrón de token dentro de un texto libre (memoria, skill), la subida de ese elemento **se bloquea** y se le enseña al usuario dónde está. No se sustituye a ciegas dentro de prosa.
- **Excepciones (falsos positivos):** el usuario puede marcar un hallazgo concreto como «no es un secreto». Se recuerda por el hash de ese texto exacto en ese elemento, nunca por patrón ni por elemento entero. Si el texto cambia, vuelve a bloquearse. La lista de excepciones vive en el estado local y también en el repo (solo hashes, nunca el texto).
- Al importar, por cada marcador sin valor en este equipo, se pide el valor. Para los `userConfig` sensibles se usa `claude plugin configure --values-stdin`, de modo que queden donde Claude los espera.

## 8. Modelo de datos

### 8.1 Repo del usuario (`claude-sync-config`, privado)

```
profiles/
  <perfil>/
    manifest.json        elementos, su tipo, hash, sistema de origen y fecha
    global/…             contenido de cada elemento global
    projects/<id>/…      contenido de cada proyecto
README.md                generado, explica qué es este repo
```

- **Versionado = historial de git.** Cada subida es un commit cuyo mensaje dice el perfil y los elementos cambiados. «Historial de versiones» lista esos commits por perfil y permite aplicar cualquiera (pasando por el flujo de importar, con su diferencia).
- **Identidad de proyecto:** URL del remoto `origin` normalizada (sin protocolo, credenciales ni `.git`). Si no hay remoto, el nombre de la carpeta, y el usuario puede asociarlo a mano. Nunca la ruta, que cambia entre equipos.
- **Sistema de origen:** cada elemento recuerda dónde se subió (`windows`, `wsl`, `macos`, `linux`).

### 8.2 Estado local del equipo

En el directorio de datos del plugin (`${CLAUDE_PLUGIN_DATA}`): perfil activo, commit del último sync y hash de cada elemento en ese momento. Con eso se calcula:

- **Cambios sin subir:** hash local actual ≠ hash del último sync.
- **Novedades en el repo:** commit remoto del perfil ≠ commit del último sync.
- **Conflicto:** las dos cosas a la vez en el mismo elemento.

### 8.3 Qué es un perfil y qué pasa con lo no marcado

Un perfil es un **conjunto elegido** de elementos que pueden compartir varios equipos, no la foto completa de uno. Nada se borra de forma implícita: **cuando una operación implicaría quitar algo, se pregunta al usuario**, elemento a elemento, con «aplicar a todos» disponible.

- **Subir:** lo marcado se añade o actualiza. Lo desmarcado que ya estaba en el perfil se queda como está. Si un elemento del perfil ya no existe en este equipo (lo borraste), se pregunta si quitarlo también del perfil o conservarlo.
- **Traer:** lo marcado se crea o actualiza. Si en local hay elementos del mismo tipo que no están en el perfil, se pregunta si borrarlos o conservarlos (por defecto, conservar).
- **Elementos nuevos en local:** aparecen como `no está en el perfil`, desmarcados, y no encienden `●`. El `●` solo cuenta los cambios en elementos que ya pertenecen al perfil.
- **Otro sistema:** un elemento `⚠ otro sistema` que no se aplica en este equipo sigue en el perfil y nunca se ofrece borrarlo por no estar en local. Así un Mac no elimina el hook de Windows.

### 8.4 Perfiles mezcla

Crear un perfil mezclando otros **copia** las piezas en ese momento. Desde entonces es un perfil independiente: los cambios posteriores en los perfiles de origen no le llegan.

## 9. Comportamiento

### 9.1 Indicador en la barra inferior (mod)

```
 ⏵⏵ bypass permissions on · ⇅ casa ●↓
```

- Muestra el perfil activo.
- `●` = cambios locales sin subir. `↓` = novedades en el repo.
- Al pulsarlo se abre el menú (el mod reacciona a clics con `onPointer`, ya visto en mods instalados). Si el usuario no usa ratón, `/sync` abre lo mismo.
- La comprobación del repo se hace al iniciar sesión y después de cada operación, no en bucle.

### 9.2 Menú

```
╭─ Claude Sync · perfil: casa ─────────────────────╮
│  ● 3 cambios sin subir · ↓ 2 novedades           │
│  ▸ Subir cambios                                  │
│    Traer del repo                                 │
│    Cambiar de perfil                              │
│    Crear perfil mezclando otros                   │
│    Historial de versiones                         │
╰───────────────────────────────────────────────────╯
```

### 9.3 Selección

Árbol por categorías desplegable hasta el elemento (§6), con estado por elemento (`nuevo`, `modificado`, `se borraría`, `conflicto`, `⚠ otro sistema`, `⚠ secreto`). Sirve igual para subir, traer y crear perfiles mezcla.

### 9.4 Subir

Seleccionar → análisis de secretos (§7) → commit + push → actualizar estado local.

### 9.5 Traer

1. Si hay cambios locales sin subir, **pregunta primero si quiere subirlos**.
2. Selección con estados.
3. Diferencia por elemento: por líneas en textos (`CLAUDE.md`, skills, memoria, agentes) y por campo en configuración (hooks, permisos, opciones de plugins).
4. Conflictos: se muestran las dos versiones y el usuario elige una. No hay mezcla automática.
5. **Copia local** de todo lo que se va a reemplazar, aunque no haya querido subir sus cambios, para poder deshacer la última aplicación.
6. Aplicar: archivos; claves de `settings.json` y `~/.claude.json` **fusionadas** (nunca se reescribe el archivo entero); marketplaces y plugins con `claude plugin marketplace add` / `claude plugin install` a la versión registrada; config con `claude plugin configure`; pedir secretos que falten.
7. Validar que los JSON resultantes son válidos. Si no lo son, se restaura la copia.
8. Si un plugin no se puede instalar en la versión registrada (ya no existe, el marketplace cambió…), se instala la última versión con un aviso. Si tampoco se puede, se salta ese plugin y se sigue con el resto. La operación es parcial por elemento, no todo o nada, y al final se muestra un resumen de lo aplicado, lo saltado y por qué. «Deshacer» restaura los archivos de la copia y desinstala los plugins que esta operación instaló.
9. Avisar de lo que necesita reiniciar Claude.

### 9.6 Multiplataforma

Rutas siempre con `~` o relativas al proyecto en lo que se sube; se expanden al aplicar. Los elementos que llaman a comandos o rutas propias de otro sistema salen marcados `⚠ otro sistema` y desmarcados por defecto.

### 9.7 Primera vez (`/sync` sin configurar)

Comprobar `git` y `gh` → `gh auth login` si hace falta → crear `claude-sync-config` privado o usar uno existente → crear el primer perfil desde la config actual.

## 10. Guía para el usuario

`README.md` (inglés) y `README.es.md` (español) del repo del plugin, enlazados entre sí, para alguien sin cuenta de GitHub:

1. Qué es y qué no sube nunca (secretos).
2. Crear cuenta de GitHub (con captura).
3. Instalar `git` y `gh` en cada sistema (un bloque por sistema).
4. Instalar el plugin (dos comandos).
5. Primer `/sync` paso a paso, con capturas del menú y la selección.
6. En el segundo equipo: instalar y traer.
7. Problemas frecuentes.

Capturas reales de la terminal, en `docs/images/`.

## 11. Decidido

| Decisión | Quién |
|---|---|
| Nombre `claude-sync`; repo del usuario `claude-sync-config` privado | usuario (nombre del repo: propuesta mía) |
| Todo en terminal dentro de Claude Code, en cualquier sistema | usuario |
| Secretos nunca se suben | usuario |
| Avisar, no aplicar solo; diff antes de sobrescribir; preguntar si subir antes de traer | usuario |
| Selección por elemento, perfiles y perfiles mezcla | usuario |
| Botón con perfil y aviso de cambios | usuario |
| Guía sencilla con imágenes | usuario |
| TypeScript, `git` + `gh`, repo del plugin como marketplace | propuesta mía, sin objeción |
| Versionado con historial de git | suposición mía, no corregida |
| Identidad de proyecto por remoto | suposición mía, no corregida |
| Copia local antes de aplicar; conflictos se eligen, no se mezclan | suposición mía, no corregida |
| Aviso `⚠ otro sistema` | propuesta mía |
| Perfil = conjunto elegido; toda eliminación se pregunta | usuario («que pregunte al usuario»); el detalle de §8.3 es mi interpretación |
| Perfiles mezcla por copia | usuario |
| Excepciones de secretos por texto exacto | usuario; el mecanismo por hash es mío |
| Interfaz y guía en inglés y español | usuario |
| Plugin no instalable: última versión o se salta; operación parcial | decisión mía |
| Alcance de proyecto y archivos ya en el git del proyecto | decisión mía |
| Licencia MIT | decisión mía |

## 12. Para el constructor

- **Primer paso obligatorio: un spike sobre la API de mods.** Comprobar qué permite: dibujar en la barra, clics, abrir una vista interactiva con teclado a pantalla completa o en panel, acceso a archivos y lanzar procesos (`git`, `gh`, `claude plugin`). Si el mod no puede alojar el menú, el plan B es `/sync` como comando, que lanza un script interactivo. En ese caso, la selección no debe depender de los diálogos de pregunta de Claude, porque admiten pocas opciones. El resultado del spike decide la arquitectura de la interfaz.
- Cómo se empaquetan y ejecutan los scripts si no hay Node en el equipo (lo que traiga el runtime de mods).
- Formato exacto de `manifest.json` y de los marcadores de secreto.
- Algoritmo de diff (por líneas y por campos).
- Estructura interna del código y tests (inventario, secretos, diff y fusión de JSON, con un `HOME` falso).
- Cómo se distingue en `~/.claude.json` → `projects` lo que es configuración de lo que es estado interno.
- Cómo se detecta el idioma (ajuste de Claude, variables `LANG`/`LC_*`, configuración de Windows).
