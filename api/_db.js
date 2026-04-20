import { createClient } from "@libsql/client/web";

let globalClient = null;

export function getLibsqlClient() {
  if (!globalClient) {
    globalClient = createClient({
      url: process.env.TURSO_URL,
      authToken: process.env.TURSO_TOKEN,
    });
  }
  return globalClient;
}

/**
 * Mapea el resultado de LibSQL a un formato compatible con mysql2 (Array de Objetos)
 */
function mapRows(data) {
  if (!data.rows || data.rows.length === 0) return [];
  return data.rows.map(row => {
    const rowObj = {};
    data.columns.forEach((col, idx) => {
      rowObj[col] = row[idx];
    });
    return rowObj;
  });
}

// Para compatibilidad con el código existente que espera una "conexión"
export async function getConnection() {
  const client = getLibsqlClient();
  
  return {
    execute: async (sql, params) => {
      // Reemplazar sintaxis mysql por sqlite
      let sqlReplaced = sql;
      
      const data = await client.execute({ sql: sqlReplaced, args: params || [] });
      
      // Si la consulta devolvió columnas, es un SELECT (incluso si hay 0 filas)
      if (data.columns && data.columns.length > 0) {
        return [mapRows(data), data.columns];
      }
      
      // Si no hay columnas pero sí rowsAffected, es un INSERT/UPDATE/DELETE
      if (data.rowsAffected !== undefined) {
        // Simular ResultSetHeader de mysql2
        return [{
          affectedRows: data.rowsAffected,
          insertId: data.lastInsertRowid ? data.lastInsertRowid.toString() : null,
          warningStatus: 0,
          serverStatus: 2,
          changedRows: data.rowsAffected
        }, null];
      }

      return [[], []];
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
          affectedRows: result.rowsAffected,
          insertId: result.lastInsertRowid ? result.lastInsertRowid.toString() : null,
          warningStatus: 0,
          serverStatus: 2,
          changedRows: result.rowsAffected
        }, null];
      });
    },
    destroy: () => {},
    release: () => {},
    end: () => {}
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
