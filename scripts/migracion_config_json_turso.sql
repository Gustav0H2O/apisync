-- Migración: Soporte para configuraciones ilimitadas en JSON en clientes
-- Permite almacenar cualquier configuración cosmética, de catálogo, impresoras
-- o funciones futuras sin tener que agregar columnas físicas ni tocar la API.

ALTER TABLE clientes ADD COLUMN config_data TEXT DEFAULT '{}';
