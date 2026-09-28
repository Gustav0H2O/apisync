# FactuFlow API (`apisync`)

> API REST que da soporte a **FactuFlow**, una aplicación de **facturación, presupuestos y notas de entrega para el mercado venezolano**.
> El producto completo es privado; este repositorio contiene el módulo de API que lo sostiene: autenticación, sincronización offline-first, licencias y notificaciones.

[![Node](https://img.shields.io/badge/Node.js-24.x-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Deploy](https://img.shields.io/badge/deploy-Vercel-000000?style=for-the-badge&logo=vercel&logoColor=white)](https://vercel.com/)
[![Tests](https://img.shields.io/badge/tests-node--test-16a34a?style=for-the-badge)](#-desarrollo-local)

## 🧩 Qué expone la API

| Área | Rutas | Qué hace |
|---|---|---|
| **Autenticación** | `/api/auth/token`, `/api/auth/pin-recovery`, `/api/auth/pin-verify` | Emisión y verificación de tokens (JWT), recuperación de acceso por PIN. |
| **Sincronización** | `/api/sync` → `pull`, `push`, `cursor`, `changes`, `tables` | Motor offline-first: el cliente trabaja sin conexión y luego sube/baja solo los cambios desde un cursor — resolución de conflictos incluida. |
| **Licencias** | `/api/license/sign`, `activate`, `status` | Firma, activación y consulta del estado de licencias del producto. |
| **Notificaciones** | `/api/notifications`, `/api/push-notify` | Avisos por correo y push (Firebase Cloud Messaging). |
| **Datos** | `/api/db`, `/api/proxy` | Capa de acceso a base de datos con CORS centralizado. |

## 🏗️ Arquitectura

- **Runtime:** Node.js 24 en funciones serverless (Vercel), rutas mapeadas desde `vercel.json`.
- **Datos:** MySQL (`mysql2`) como almacenamiento principal y LibSQL (`@libsql/client`) como backend compatible SQLite en la nube.
- **Seguridad:** JWT (`jsonwebtoken`), manejo de PIN, cabeceras CORS por origen permitido.
- **Subida de archivos:** `busboy` (streams, sin cargar archivos completos en memoria).
- **Pruebas:** `node:test` (sin dependencias de framework).

```
api/
├── auth/          token, pin-recovery, pin-verify
├── sync/          pull · push · cursor · changes · tables (motor offline-first)
├── license/       sign · activate · status
├── sync_router.js enrutamiento de acciones de sincronización
├── notifications.js / push-notify.js   correo + FCM
├── db.js / _db.js / _cors.js           datos y CORS
└── vercel.json     mapeo de rutas serverless
```

## 💾 Sincronización offline-first (lo más interesante del proyecto)

El patrón completo para que una app de facturación funcione **sin internet** (en Venezuela es un requisito, no un lujo):

1. El cliente guarda los cambios localmente con un **cursor**.
2. Al reconectar, hace `pull` de los cambios remotos desde su último cursor.
3. Hace `push` de sus cambios locales; el servidor detecta y resuelve conflictos por tabla.

## 🛠️ Desarrollo local

```bash
npm install
npm test          # node:test — suites de auth y sincronización (e2e incluido)
```

Las variables de entorno (base de datos, JWT, Firebase) se definen en el proyecto de Vercel; nunca se commitean (`.env` está en `.gitignore`).

## 📌 Sobre este repositorio

- ✅ El código de la API es **público como muestra de trabajo técnico**.
- 🔒 **FactuFlow** (la app completa) es un producto **privado**: este repo no incluye su frontend, datos ni credenciales.
- ⚠️ `node_modules` fue excluido del versionado: instala con `npm install`.
