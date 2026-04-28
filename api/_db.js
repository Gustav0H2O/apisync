import { createClient } from "@libsql/client";

let globalClient = null;

export function getLibsqlClient() {
  if (!globalClient) {
    globalClient = createClient({
      url: process.env.TURSO_URL || "",
      authToken: process.env.TURSO_TOKEN || "",
      intMode: 'string',
    });
  }
  return globalClient;
}

/**
 * Mapea el resultado de LibSQL a un formato compatible con mysql2 (Array de Objetos)
 */
function mapRows(data) {
  if (!data.rows || data.rows.length === 0) return [];
  
  // En versiones recientes de @libsql/client, rows ya son objetos.
  // Pero para mayor seguridad, verificamos si el primer elemento es un array.
  return data.rows.map(row => {
    if (typeof row === 'object' && !Array.isArray(row)) {
      return row; // Ya es un objeto {col: val}
    }
    // Si es un array de valores, lo mapeamos usando data.columns
    const rowObj = {};
    data.columns.forEach((col, idx) => {
      rowObj[col] = row[idx];
    });
    return rowObj;
  });
}

/**
 * Proporciona una "conexión" compatible con el código existente.
 * Incluye el método batch() para transacciones atómicas en Turso.
 */
export function getConnection() {
  const client = getLibsqlClient();
  
  return {
    execute: async (sql, params) => {
      const data = await client.execute({ sql, args: params || [] });
      
      // Si la consulta devolvió columnas, es un SELECT
      if (data.columns && data.columns.length > 0) {
        return [mapRows(data), data.columns];
      }
      
      // Si no hay columnas pero sí rowsAffected, es un INSERT/UPDATE/DELETE
      return [{
        affectedRows: data.rowsAffected || 0,
        insertId: data.lastInsertRowid ? data.lastInsertRowid.toString() : null,
        warningStatus: 0,
        serverStatus: 2,
        changedRows: data.rowsAffected || 0
      }, null];
    },
    query: async (sql, params) => {
      const data = await client.execute({ sql, args: params || [] });
      if (data.columns && data.columns.length > 0) {
        return [mapRows(data), data.columns];
      }
      return [[], []];
    },
    batch: async (statements) => {
      // statements: [{ sql, args }]
      const data = await client.batch(statements, "write");
      return data.map(result => {
        if (result.columns && result.columns.length > 0) {
          return [mapRows(result), result.columns];
        }
        return [{
          affectedRows: result.rowsAffected || 0,
          insertId: result.lastInsertRowid ? result.lastInsertRowid.toString() : null,
          warningStatus: 0,
          serverStatus: 2,
          changedRows: result.rowsAffected || 0
        }, null];
      });
    },
    destroy: () => {},
    release: () => {},
    end: () => {},
    close: () => {}
  };
}

export async function queryDB(sql, params) {
  const client = getLibsqlClient();
  try {
    const data = await client.execute({ sql, args: params || [] });
    if (data.columns && data.columns.length > 0) {
      return mapRows(data);
    } else if (data.rowsAffected !== undefined) {
      return {
        affectedRows: data.rowsAffected,
        insertId: data.lastInsertRowid ? data.lastInsertRowid.toString() : null
      };
    }
    return [];
  } catch (error) {
    console.error('Database Error:', error);
    throw error;
  }
}
