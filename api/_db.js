import mysql from 'mysql2/promise';

let globalPool = null;

export async function getConnection() {
  if (!globalPool) {
    globalPool = mysql.createPool({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      ssl: { rejectUnauthorized: false },
      connectionLimit: 1, // EL CORAZÓN DE LA PETICIÓN: Solo 1 conexión viva por instancia
      waitForConnections: true,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000
    });
  }

  const connection = await globalPool.getConnection();

  // "LIMPIEZA DE ZOMBIES":
  // Reducimos el timeout a 5 segundos. 
  // Si el servidor de Vercel muere, la BD matará esta conexión sola en 5s.
  await connection.query('SET SESSION wait_timeout = 5');
  await connection.query('SET SESSION interactive_timeout = 5');

  /**
   * INTERCEPTOR DE SEGURIDAD:
   * Para evitar que otros scripts cierren accidentalmente el Pool,
   * devolvemos el objeto de conexión pero "falsificamos" el destroy.
   * El pool se encarga de re-usarla.
   */
  const originalRelease = connection.release;
  connection.destroy = () => connection.release(); // En un Pool, destruir es devolver al pool
  connection.end = () => connection.release();
  
  return connection;
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
    if (connection && connection.release) {
      connection.release(); // La devolvemos al Pool de 1 conexión
    }
  }
}
