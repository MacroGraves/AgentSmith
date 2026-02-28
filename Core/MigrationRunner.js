/**
 * Database Migration Runner
 * Applies pending SQL migrations to update schema
 */
const fs = require('fs');
const path = require('path');
const MySQL = require('promise-mysql');

const Settings = require('../MySQL.json');

async function RunMigrations() {
  const connection = await MySQL.createConnection({
    host: Settings.host,
    user: Settings.user,
    password: Settings.password,
    database: Settings.database,
    port: Settings.port || 3306,
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
