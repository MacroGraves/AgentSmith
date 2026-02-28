/**
 * Database Migration Runner
 * Applies pending SQL migrations to update schema
 */
const fs = require('fs');
const path = require('path');
const MySQL = require('promise-mysql');

const Settings = require('../Settings.json');

async function RunMigrations() {
  const connection = await MySQL.createConnection({
    host: Settings.mysql.host,
    user: Settings.mysql.user,
    password: Settings.mysql.password,
    database: Settings.mysql.database,
    port: Settings.mysql.port || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });

  try {
    const migrationsDir = path.join(__dirname, '../migrations');
    const migrationFiles = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of migrationFiles) {
      const filepath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filepath, 'utf8');

      console.log(`\n[MIGRATION] Running ${file}...`);
      
      try {
        const statements = sql.split(';').filter(s => s.trim());
        
        for (const statement of statements) {
          if (statement.trim()) {
            await connection.query(statement);
          }
        }
        
        console.log(`[MIGRATION] ✓ ${file} completed successfully`);
      } catch (error) {
        console.error(`[MIGRATION] ✗ ${file} failed:`, error.message);
      }
    }

    console.log('\n[MIGRATION] All migrations completed');
  } catch (error) {
    console.error('[MIGRATION] Error:', error.message);
  } finally {
    connection.end();
  }
}

// Run if called directly
if (require.main === module) {
  RunMigrations().catch(console.error);
}

module.exports = RunMigrations;
