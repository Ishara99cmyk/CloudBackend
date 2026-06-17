const mysql = require('mysql2/promise');
require('dotenv').config();

const dbUrl = process.env.DATABASE_URL;

if (!dbUrl) {
  console.error("Error: DATABASE_URL is not set in environment variables.");
  process.exit(1);
}

// Create connection pool. We parse the connection string by passing it to createPool
// and explicitly force SSL rejectUnauthorized: false to work with DigitalOcean's required SSL.
let actualPool = null;

// The pool exported to server.js acts as a proxy, forwarding calls to the actual connection pool
// once it is created inside initializeDatabase().
const pool = {
  async query(...args) {
    if (!actualPool) throw new Error('Database pool is not initialized.');
    return actualPool.query(...args);
  },
  async getConnection(...args) {
    if (!actualPool) throw new Error('Database pool is not initialized.');
    return actualPool.getConnection(...args);
  },
  async execute(...args) {
    if (!actualPool) throw new Error('Database pool is not initialized.');
    return actualPool.execute(...args);
  },
  async end(...args) {
    if (actualPool) return actualPool.end(...args);
  }
};

async function initializeDatabase() {
  try {
    let dbName = 'fullstackdb';
    let serverUrl = dbUrl;

    try {
      // Parse the connection URI to extract database name and construct server URL without database
      const parsedUrl = new URL(dbUrl);
      dbName = parsedUrl.pathname.replace('/', '') || 'fullstackdb';
      parsedUrl.pathname = '/';
      serverUrl = parsedUrl.toString();
    } catch (urlErr) {
      console.warn('Failed to parse DATABASE_URL as a strict URL, attempting default connection:', urlErr.message);
    }

    console.log(`Connecting to database server to check/create database "${dbName}"...`);
    const tempConnection = await mysql.createConnection({
      uri: serverUrl,
      ssl: {
        rejectUnauthorized: false
      }
    });

    await tempConnection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
    console.log(`Database "${dbName}" verified/created successfully.`);
    await tempConnection.end();

    // Now initialize the actual connection pool with the target database specified
    actualPool = mysql.createPool({
      uri: dbUrl,
      ssl: {
        rejectUnauthorized: false
      },
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000, // Send keep-alive packet every 10 seconds
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });

    const connection = await actualPool.getConnection();
    console.log('Successfully connected to the MySQL database pool!');
    
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

    // Check if profile_picture_url column exists in users table, and add it if not
    const [columns] = await connection.query("SHOW COLUMNS FROM users LIKE 'profile_picture_url'");
    if (columns.length === 0) {
      await connection.query("ALTER TABLE users ADD COLUMN profile_picture_url VARCHAR(2048) DEFAULT NULL;");
      console.log('Added profile_picture_url column to users table.');
    }

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
