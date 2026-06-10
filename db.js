const mysql = require('mysql2/promise');
require('dotenv').config();

const dbUrl = process.env.DATABASE_URL;

if (!dbUrl) {
  console.error("Error: DATABASE_URL is not set in environment variables.");
  process.exit(1);
}

// Create connection pool. We parse the connection string by passing it to createPool
// and explicitly force SSL rejectUnauthorized: false to work with DigitalOcean's required SSL.
let pool;
try {
  // mysql2 allows passing the connection string as a URI, and we can also add options
  pool = mysql.createPool({
    uri: dbUrl,
    ssl: {
      rejectUnauthorized: false
    },
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  });
} catch (err) {
  console.error('Failed to create MySQL pool:', err.message);
  process.exit(1);
}

async function initializeDatabase() {
  try {
    const connection = await pool.getConnection();
    console.log('Successfully connected to the MySQL database!');
    
    // Create users table if it does not exist
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(255) NOT NULL UNIQUE,
        email VARCHAR(255) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;
    `;
    
    await connection.query(createTableQuery);
    console.log('Database tables initialized successfully.');
    connection.release();
  } catch (error) {
    console.error('Database initialization failed:', error.message);
    process.exit(1);
  }
}

module.exports = {
  pool,
  initializeDatabase
};
