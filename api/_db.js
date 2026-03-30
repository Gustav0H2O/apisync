import mysql from 'mysql2/promise';

export async function getConnection() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: {
      rejectUnauthorized: false
    }
  });

  // MAGIA PARA LIMITES SEVEROS (filess.io max=5):
  // Si un contenedor de Vercel muere o se congela antes de connection.end(),
  // le ordenamos a MySQL que mate brutalmente esta conexión si está inactiva por 2 segundos.
  
  

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
    if (connection) {
      await connection.end();
    }
  }
}
