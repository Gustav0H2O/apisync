import mysql from 'mysql2/promise';

// Creamos el Pool fuera del handler para que se mantenga vivo
// entre distintas peticiones que lleguen a la misma instancia de Vercel.
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: {
    rejectUnauthorized: false
  },
  waitForConnections: true,
  connectionLimit: 1, // <--- AQUÍ ESTÁ EL EMBUDO: Solo una conexión activa a la DB
  queueLimit: 0       // Sin límite de cola (los usuarios esperan su turno)
});

export async function queryDB(sql, params) {
  try {
    const [rows] = await pool.execute(sql, params || []);
    return rows;
  } catch (error) {
    console.error('Database Error:', error);
    throw error;
  }
}
