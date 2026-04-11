import mysql from 'mysql2/promise';

let globalConnection = null;

export async function getConnection() {
  if (globalConnection) {
    try {
      await globalConnection.ping();
      return globalConnection;
    } catch (e) {
      globalConnection = null; // La reconectamos si se murió
    }
  }

  globalConnection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false }
  });

  // Elevamos ligeramente los timeouts considerando que interceptaremos destroy
  await globalConnection.query('SET SESSION wait_timeout = 10');
  await globalConnection.query('SET SESSION interactive_timeout = 10');

  // MAGIA DEL SINGLETON:
  // Como `db.js` y `queryDB` llaman fervorosamente a `destroy()`, los interceptamos
  // para mantener la misma conexión viva y compartida bajo el límite de filess.io
  globalConnection.originalDestroy = globalConnection.destroy;
  globalConnection.destroy = async () => { /* No hacer nada, se mantiene viva */ };
  globalConnection.end = async () => { /* No hacer nada, se mantiene viva */ };

  return globalConnection;
}

export async function queryDB(sql, params) {
  let connection;
  try {
    connection = await getConnection();
    const [rows] = await connection.execute(sql, params || []);
    return rows;
  } catch (error) {
    console.error('Database Error:', error);
    throw error;
  } finally {
    if (connection) {
      await connection.destroy();
    }
  }
}
