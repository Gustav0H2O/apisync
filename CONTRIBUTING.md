# Contribuir a apisync

Backend de sincronización de FactuFlow (Vercel serverless + MySQL/libsql).

## Quién puede contribuir

Este repositorio es de desarrollo privado y exclusivo:

1. **Gustavo** ([@Gustav0H2O](https://github.com/Gustav0H2O))
2. **Sua7Dev** ([@Sua7Dev](https://github.com/Sua7Dev))

- **Cierre automático por CI**: cualquier Pull Request creado por otro usuario será rechazado y cerrado automáticamente por el flujo `Restrict Contributors`.
- **Validación Git local**: el repositorio incluye hooks (`pre-commit` y `pre-push` en `.githooks/`) que validan que `user.name`/`user.email` correspondan a Gustavo o Sua7Dev. Actívalos con:

```sh
git config core.hooksPath .githooks
```
