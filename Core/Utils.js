const Config = require('../MySQL.json');
const axios = require('axios');
const BigNumber = require('bignumber.js');

BigNumber.config({
  ROUNDING_MODE: BigNumber.ROUND_DOWN,
  EXPONENTIAL_AT: 9 + 1,
});

// Helper function to determine if the string has a character
function HasChar(input, n) {
  return input.includes(n);
}
async function isOnWindows() {
  return process.platform === 'win32';
}

// Helper function to return a clean url without ?
function SplitShiftChar(input, n) {
  return input.split(n).shift();
}

// Helper function to allow for a clean closure of the node and provide a reason for doing so
function Closure(Error, Throw) {
  if (!Throw) console.log(Error);
  else console.error(Error);
  process.exit(0);
}
function isOkPacket(result) {
  return result && result.constructor.name === 'OkPacket' && result.affectedRows > 0;
}

async function Connection(MySQL, connection) {
  var isWindows = await isOnWindows();
  // If is windows create a connection where the host is localhost otherwise have the socket path set instead
  if (isWindows) {
    connection = await MySQL.createConnection({
      host: Config.host,
      port: Config.port || 3306,
      user: Config.user,
      password: Config.password,
      database: Config.database,
    });
  } else {
    connection = await MySQL.createConnection({
      socketPath: Config.socketPath,
      user: Config.user,
      password: Config.password,
      database: Config.database,
    });
  }
  return connection;
}

/**
 * Execute a query with automatic reconnection on lost connections.
 * Call with: await Utils.SafeQuery(MySQL, this, sql, values)
 * where `self` is the DB class instance with `this.connection`.
 * @param {Object} MySQL - The promise-mysql module
 * @param {Object} self - The DB class instance (must have .connection property)
 * @param {string} sql - SQL query string
 * @param {Array} values - Query parameters
 * @returns {Promise<*>} Query result
 */
async function SafeQuery(MySQL, self, sql, values) {
  const maxRetries = 2;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (!self.connection) {
        self.connection = await Connection(MySQL, self.connection);
      }
      return await self.connection.query(sql, values);
    } catch (error) {
      const isConnectionLost = error.code === 'PROTOCOL_CONNECTION_LOST' ||
        error.code === 'ECONNRESET' ||
        error.code === 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR' ||
        error.code === 'EPIPE' ||
        error.fatal === true ||
        (error.message && error.message.includes('Connection lost'));

      if (isConnectionLost && attempt < maxRetries) {
        console.warn(`[DB] Connection lost, reconnecting (attempt ${attempt})...`);
        try { self.connection.destroy(); } catch (_) {}
        self.connection = null;
        self.connection = await Connection(MySQL, self.connection);
        continue;
      }
      throw error;
    }
  }
}
/**
 * Attempts to send an HTTP request with retries on failure.
 * @param {string} url - The endpoint to send the request to.
 * @param {object} data - The data to send in the request.
 * @param {number} retries - The number of retry attempts.
 */
async function TryRequest(url, data, retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.post(url, data);
      return response.data;
    } catch (error) {
      console.error(`Attempt ${attempt} failed: ${error.message}`);
      if (attempt === retries) throw new Error('Max retries reached for HTTP request.');
      await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait before retrying
    }
  }
}

module.exports = {
  //Return the functions.
  Connection: Connection,
  SafeQuery: SafeQuery,
  HasChar: HasChar,
  isOkPacket: isOkPacket,
  isOnWindows: isOnWindows,
  SplitShiftChar: SplitShiftChar,
  Closure: Closure,
  TryRequest: TryRequest,
};
