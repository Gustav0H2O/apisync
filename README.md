# FactuFlow API (`apisync`)

> API REST que da soporte a **FactuFlow**, una aplicación de **facturación, presupuestos y notas de entrega para el mercado venezolano**.
> El producto completo es privado; este repositorio contiene el módulo de API que lo sostiene: autenticación, sincronización offline-first, licencias y notificaciones.

[![Node](https://img.shields.io/badge/Node.js-24.x-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Deploy](https://img.shields.io/badge/deploy-Vercel-000000?style=for-the-badge&logo=vercel&logoColor=white)](https://vercel.com/)
[![Datos](https://img.shields.io/badge/datos-Turso%2FLibSQL-2A6EF7?style=for-the-badge)](#-datos)

---

## 📑 Índice

1. [Qué expone la API](#-qué-expone-la-api)
2. [Arquitectura](#-arquitectura)
3. [Estructura de carpetas](#-estructura-de-carpetas)
4. [Datos](#-datos)
5. [Cómo extender el sync SIN desplegar](#-cómo-extender-el-sync-sin-desplegar) ← **lo más importante**
6. [Sincronización offline-first](#-sincronización-offline-first)
7. [Licencias y dispositivos](#-licencias-y-dispositivos)
8. [Referencia de endpoints](#-referencia-de-endpoints)
9. [Variables de entorno](#-variables-de-entorno)
10. [Desarrollo local y pruebas](#-desarrollo-local-y-pruebas)
11. [Despliegue](#-despliegue)
12. [Sobre este repositorio](#-sobre-este-repositorio)

---

## 🧩 Qué expone la API

| Área | Prefijo | Qué hace |
|---|---|---|
| **Autenticación y pairing** | `/api/auth/*`, `/api/pairing/*` | Tokens JWT, vinculación de dispositivos, consulta de estado de un dispositivo, roles. |
| **Sincronización** | `/api/sync/*` | Motor offline-first: cursor, feed de cambios, subida y bajada con resolución de conflictos. |
| **Licencias** | `/api/license/*` | Activación, consulta de estado, renovación y rotación de claves. |
| **Notificaciones** | `/api/notifications`, `/api/push-notify` | Avisos en la app y push (Firebase Cloud Messaging). |
| **Configuración del negocio** | dentro de `/api/sync` (tabla `profile`) | Datos de la empresa y preferencias, en JSON. |
| **Automatización** | `/api/cron-bcv` | Tasa oficial del BCV (cron diario). |
| **Datos** | `/api/db`, `/api/proxy` | Proxy SQL con CORS centralizado y control de revocación. |

## 🏗️ Arquitectura

- **Runtime:** Node.js 24 en **funciones serverless** (Vercel). Cada archivo en `api/` **que no empieza por `_`** es una función.
- **Datos:** **Turso / LibSQL** (SQLite en la nube) como almacenamiento único. `mysql2` queda en dependencias por compatibilidad heredada, pero el código ya no usa MySQL.
- **Seguridad:** JWT (`jsonwebtoken`), firma de licencia (`LICENSE_SIGNING_KEY`), CORS por origen permitido.
- **Subida de archivos:** `busboy` (streaming, sin cargar binarios completos en memoria).
- **Pruebas:** `node:test`, sin dependencias de framework.

> ⚠️ **El plan Hobby de Vercel permite 12 funciones serverless por despliegue.** El proyecto está exactamente en 12. Antes de añadir otro archivo en `api/`, ver [Despliegue](#despliegue).

```
api/
├── auth/
│   └── token.js          FUNCIÓN · router de /api/auth/* y /api/pairing/*
├── license/
│   ├── activate.js       FUNCIÓN · activación inicial
│   ├── status.js         FUNCIÓN · estado de la licencia (adopta clave renovada)
│   ├── maintenance.js    FUNCIÓN · renew + rotate-key (despacho por ?action=)
│   └── _sign.js          módulo · firma de payloads de licencia
├── sync/
│   ├── _registry.js      módulo · registry + descubrimiento por PRAGMA
│   ├── _profile.js       módulo · UPDATE del perfil y merge del pull
│   ├── _push.js          módulo · subida v47
│   ├── _changes.js       módulo · feed de cambios
│   ├── _cursor.js        módulo · latido del change-feed (+ long-polling)
│   ├── _pull.js          módulo · bajada completa
│   ├── _ensure.js        módulo · auto-creación de tablas espejo
│   └── _tables.js        módulo · especificación por defecto (fallback)
├── sync.js               FUNCIÓN · protocolo legacy
├── sync_router.js        FUNCIÓN · router /api/sync/:action
├── cron-bcv.js           FUNCIÓN · automatización diaria
├── db.js / _db.js        FUNCIÓN / módulo · proxy SQL y conexión
├── notifications.js      FUNCIÓN · notificaciones
├── push-notify.js        FUNCIÓN · FCM
└── _cors.js _fcm.js _helpers.js   módulos compartidos
```

**Regla de nombres:** los archivos con prefijo `_` NO se despliegan como función; son módulos internos. Es lo que permite compactar endpoints sin perder funcionalidad.

## 💾 Datos

- **Instancia:** Turso (LibSQL) sobre SQLite, con API HTTP.
- **Conexión:** `_db.js` expone `getConnection()` con una interfaz compatible con `mysql2` (`execute` devuelve `[filas, ...]`), y `intMode: 'string'` porque libsql devuelve enteros como texto.
- **Modelado de la configuración:** la configuración del negocio vive en **`clientes.config_data` (JSON)**. Las columnas se conservaron únicamente para identidad (`email`), protocolo (`version`, `profile_change_*`), timestamps y el **logo** (`catalog_logo_path`, que es binario y no cabe en un JSON).

### Tablas de cuenta (no sincronizadas)
`clientes` · `licencias` · `detalles_saas` · `devices` · `user_roles` · `device_role_assignments` · `pairing_sessions` · `license_key_rotations` · `pin_recovery_codes`

### Tablas de sincronización
Espejo del cliente, con el prefijo `sync_`: `sync_clients`, `sync_invoices`, `sync_invoice_items`, `sync_products`, `sync_suppliers`, `sync_categories`, `sync_stock_movements`, `sync_taxes`, `sync_expenses`, `sync_audit_logs`, `fiscal_transmissions`, `user_roles`.

Infraestructura del feed: `change_log` (bitácora), `account_cursor` (posición por cuenta).

---

## 🔧 Cómo extender el sync SIN desplegar

Este es el punto de diseño más importante de la API.

Antes, cambiar el sync exigía editar código y desplegar: las columnas estaban escritas a mano en `sync.js`, `_push.js` y `_tables.js`, y un mismo concepto (el perfil del negocio) estaba **duplicado en tres sitios** — que es exactamente lo que rompió la edición de roles al limpiar la tabla `clientes`.

Hoy la fuente de verdad es la propia base de datos:

### `sync_table_registry`

| Columna | Para qué sirve |
|---|---|
| `local_table` | Nombre de la tabla en el cliente (PK). |
| `remote_table` | Tabla espejo en Turso. |
| `columns` | Lista JSON de columnas a sincronizar. **`NULL` = descubrir todas las físicas**. |
| `account_scoped` | Si el alcance se filtra por cuenta. |
| `business_key` | Clave de negocio para fusionar duplicados (`{"cols":["rif"],...}`). |
| `sealed` | Documentos fiscales: solo se reescriben si el sello y el hash se preservan. |
| `append_only` | Solo inserciones (auditoría). |
| `depends_on` | Dependencias para ordenar la subida. |
| `enabled` | Interruptor para apagar una tabla sin borrarla. |

### Agregar una columna
```sql
ALTER TABLE sync_products ADD COLUMN unit_cost REAL;
UPDATE sync_table_registry
   SET columns = json_insert(columns, '$[#]', 'unit_cost')
 WHERE local_table = 'products';
```
Listo. Sin tocar código, sin desplegar. (Con `columns = NULL` ni siquiera hace falta el `UPDATE`: se sincroniza todo lo físico.)

### Agregar una tabla
1. Crear el espejo: `CREATE TABLE sync_mi_tabla (...)`.
2. Registrar: `INSERT INTO sync_table_registry (local_table, remote_table, columns, account_scoped) VALUES ('mi_tabla','sync_mi_tabla', NULL, 1);`

`_ensure.js` aprovisiona automáticamente tablas nuevas cuando el cliente las envía.

### Cuándo sí hay que tocar código
- Cambios de **reglas de negocio** (inmutabilidad fiscal, normalización de roles).
- Nuevos **endpoints**.
- Nuevas **reglas** que no se pueden expresar en el registro.

> La especificación en `_tables.js` se conserva como **fallback**: si `sync_table_registry` no existe, la API se comporta exactamente como antes. Por eso es seguro desplegar el código antes que la tabla.

### Regenerar la semilla
`gen_seed.mjs` genera `_seed.sql` **desde `_tables.js`**, para que la base y el código no puedan divergir. Si cambia `_tables.js`:
```bash
node gen_seed.mjs && node seed_registry.mjs   # con TURSO_URL y TURSO_TOKEN definidos
```

---

## 🔄 Sincronización offline-first

1. El cliente guarda todo local (SQLite) y trabaja sin conexión.
2. `/api/sync/cursor` es el latido: devuelve el último `seq` del feed. Si no hay cambios, **no cuesta nada**; admite long-polling (`?wait=N`) para recibir el aviso en menos de un segundo.
3. `/api/sync/changes?since=<seq>` devuelve el estado actual de las filas que cambiaron.
4. `/api/sync/push` sube los cambios locales en un **batch atómico**: si algo falla, no se aplica nada.

**Identidad de cuenta:** `account_key` (la license_key) manda; `account_email` queda como respaldo para clientes viejos. Una rotación de clave reescribe `account_key` en todas las tablas sin mover datos.

**Configuración (`profile`):** viaja como objeto plano; la API guarda lo identitario en columnas y el resto en `config_data` (JSON) con `json_patch`, que **fusiona** — así los cambios parciales de una caja no borran lo que otra caja tenga.

---

## 🔑 Licencias y dispositivos

- **Identidad canónica:** `license_key`, estable ante cambios de email y rotaciones.
- **Vencimiento:** una licencia SaaS vencida **no** revoca el dispositivo: bloquea la operación y ofrece renovar, para no perder el trabajo en curso.
- **Revocación:** un dispositivo desvinculado recibe `401 {error:'DEVICE_REVOKED'}` en cada endpoint autenticado (token, cursor, changes, push, status), incluido el latido de 4 s, para que la pantalla de "Acceso Restringido" aparezca casi de inmediato.
- **Límites:** `licencias.max_devices_allowed` y `pair_cooldown_days` controlan cuántas cajas y con qué espera entre vinculaciones.
- **Roles:** vocabulario canónico `admin · supervisor · operador · auditor_seniat · cajero`; `normalizeRole()` traduce alias legacy antes de escribir para no violar el `CHECK`.

---

## 📡 Referencia de endpoints

### Autenticación y pairing
| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/auth/token` | Emite token JWT (`action=token`, o por defecto). |
| POST | `/api/auth/token?action=generate` | Solicita un código de vinculación. |
| POST | `/api/auth/token?action=confirm` | Confirma el código con el QR. |
| POST | `/api/auth/token?action=link` | Autoriza la vinculación de una caja. |
| POST | `/api/auth/token?action=unlink` | **Revoca** un dispositivo. |
| GET  | `/api/auth/token?action=device_status` | ¿Sigue vigente este dispositivo? |
| GET  | `/api/auth/token?action=devices` | Dispositivos de la cuenta. |
| GET  | `/api/auth/token?action=count` | Conteo de dispositivos activos. |
| POST | `/api/auth/token?action=rename` | Renombra una caja. |
| POST | `/api/auth/token?action=fcm_register` | Registra el token de push. |
| GET  | `/api/auth/pin-recovery` · `/api/auth/pin-verify` | Recuperación de acceso por PIN. |

### Sincronización
| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/sync` | Push + pull del protocolo legacy. |
| GET  | `/api/sync/cursor[?since=&wait=]` | Latido del feed (long-polling opcional). |
| GET  | `/api/sync/changes?since=` | Cambios desde un cursor. |
| POST | `/api/sync/push` | Push del protocolo v47 (batch atómico). |
| GET  | `/api/sync/pull` | *(retirado: usar `/api/sync` o `/api/sync/changes`).* |

### Licencias
| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/license/activate` | Activa una clave en un dispositivo. |
| GET  | `/api/license/status` | Estado, tipo y vencimiento. |
| POST | `/api/license/renew` | Extiende el vencimiento de la misma clave. |
| POST | `/api/license/rotate-key` | Rota a una clave nueva conservando los datos. |

### Otros
| Método | Ruta | Descripción |
|---|---|---|
| GET/POST | `/api/notifications` | Listado y alta de notificaciones. |
| POST | `/api/push-notify` | Envío por FCM. |
| POST | `/api/db`, `/api/proxy` | Proxy SQL (ver aviso de seguridad abajo). |
| GET | `/api/cron-bcv` | Automatización de la tasa BCV (invocado por cron). |

> ⚠️ **`/api/db` ejecuta SQL arbitrario.** Acepta `{query, params}` y corre lo que le manden. Está protegido por JWT de sesión y, con `isActivation`, solo deja `SELECT`/`UPDATE` sobre `licencias`, `clientes` y `detalles_saas`. Pero **quien conozca `JWT_SECRET` se autentica como maestro y salta todas las validaciones**. Es el endpoint más sensible de la API: cualquier cliente que se registre en él tiene, en la práctica, acceso de lectura y escritura a toda la base. Si en algún momento se reduce la superficie expuesta, este es el primero que debe cerrarse.

---

## 🔐 Variables de entorno

Se configuran en el proyecto de Vercel; **nunca se commitean**.

| Variable | Para qué |
|---|---|
| `TURSO_URL` | URL de la instancia (LibSQL). |
| `TURSO_TOKEN` | Token de escritura. |
| `JWT_SECRET` | Firma de los tokens de sesión. |
| `LICENSE_SIGNING_KEY` | Firma de los payloads de licencia. |
| `FIREBASE_PROJECT_ID` | Push notifications. |
| `FIREBASE_SERVICE_ACCOUNT` | Credenciales de FCM. |
| `ADMIN_PUSH_SECRET` | Protege el envío de notificaciones administrativas. |

---

## 🛠️ Desarrollo local y pruebas

```bash
npm install
npm test            # node:test — CORS y rutas
npm run test:e2e    # extremo a extremo del sync (requiere variables de entorno)
```

Herramientas de mantenimiento (no forman parte del runtime, y **no se versionan**):
`gen_seed.mjs` (genera la semilla del registro) · `seed_registry.mjs` (la aplica) · `migrate_clientes_v3.mjs` (limpieza de columnas de `clientes`, deja respaldo).

---

## 🚀 Despliegue

Cada `push` a `main` despliega automáticamente en Vercel.

### ⛔ El límite de 12 funciones

Vercel Hobby admite **máximo 12 funciones serverless por despliegue**. Con 13 (por `cron-bcv.js`) **ningún despliegue se publicaba**, aunque el build terminara bien:

```
exceeded_serverless_functions_per_deployment
```

El build pasa y el error solo aparece al publicar, así que conviene revisarlo si un despliegue falla de forma inexplicable.

**Antes de añadir un endpoint nuevo**, dos opciones:
1. **Compactar**: fusionar endpoints pequeños del mismo dominio en una función con despacho por `?action=` (como `license/maintenance.js`) y añadir la reescritura en `vercel.json`.
2. Pasar a un plan con más funciones.

Para contar funciones:
```bash
# Windows PowerShell
Get-ChildItem -Recurse -Filter *.js api | Where-Object { $_.Name -notmatch '^_' } | Measure-Object
```

---

## 📌 Sobre este repositorio

- ✅ El código de la API es **público como muestra de trabajo técnico**.
- 🔒 **FactuFlow** (la app completa) es un producto **privado**: este repo no incluye su frontend, datos ni credenciales.
- ⚠️ `node_modules`, respaldos de la base y herramientas locales están fuera del versionado.