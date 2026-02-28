// Libraries
const MySQL = require('promise-mysql');
const BN = require('bignumber.js');
const Utils = require('../Core/Utils.js');

class WalletManager {
  constructor() {
    this.connection = null;
    this.table = 'wallets'; // Withdrawals now come from funding table
    this.walletsTable = 'wallets'; // Deposits are recorded in wallets table
    this.users = {};
    this.handled = [];
    this.engines = {};
  }

  /*
   * Initializes the database connection using Utils.Connection.
   * No parameters.
   * @returns {void}
   */
  async initializeConnection() {
    this.connection = await Utils.Connection(MySQL, this.connection);
  }
  async Get_Name_By_Address(address) {
    const rows = await this.connection.query('SELECT name FROM wallets WHERE address = ?', [address]);
    return rows.length > 0 ? rows[0].name : null;
  }

  async hasUnconfirmedDeposits(txTemp, address) {
    let unconfirmedCount = 0;
    for (var x = 0; x < txTemp.length; x++) {
      if (txTemp[x].confirmations === 0 && txTemp[x].address === address) {
        unconfirmedCount++;
      }
    }
    return unconfirmedCount;
  }
  Assign_Payment_Object = async (Engine, address) => {
    const Payment_Object = {
      Unspent: 0,
      Amount: 0,
      Address: address,
      Transactions: 0,
      Is_Our_Valid_Transaction: async function (txs) {
        return txs.amount >= 0.0055 && txs.address === address;
      },
    };
    // Filter by address to only get unspent outputs for this specific address
    Payment_Object.Unspent = await Engine.listUnspent(1, 9999999, [address]);
    return Payment_Object;
  };

  // NEW: Add method to check for active invoice
  async checkActiveInvoice(user_uuid, amount, cryptoType) {
    try {
      // Query database for active invoices expecting this amount/crypto type
      const query = `
      SELECT COUNT(*) as count 
      FROM user_invoices 
      WHERE user_uuid = ? 
      AND crypto_currency = ? 
      AND invoice_status = 'pending' 
      AND ABS(amount_crypto - ?) <= (amount_crypto * 0.05)
      AND expires_at > NOW()
    `;

      const result = await this.connection.query(query, [user_uuid, cryptoType, amount]);
      return result.length > 0 && result[0].count > 0;
    } catch (error) {
      console.error('Error checking active invoice:', error);
      return false; // Assume no invoice if error
    }
  }

  // NEW: Add method to convert deposit to fiat
  async convertDepositToFiat(user_uuid, amount, cryptoType, txHash) {
    try {
      // Call PHP API to handle fiat conversion
      const axios = require('axios');

      const response = await axios.post('http://localhost/api/v1/services/fiat-conversion.php', {
        action: 'convert_deposit',
        user_uuid: user_uuid,
        amount: amount,
        crypto_type: cryptoType,
        tx_hash: txHash,
      });

      if (response.data && response.data.success) {
        console.log(`Converted ${amount} ${cryptoType} to fiat for user ${user_uuid}`);
      } else {
        console.error('Fiat conversion failed:', response.data);
      }
    } catch (error) {
      console.error('Error calling fiat conversion API:', error);
    }
  }
  async Check_Addresses(ClientType, Engine, address, user_uuid, txsTemp, i) {
    try {
      // Get the specific transaction data we're processing
      const txData = txsTemp[i];
      if (!txData || txData.confirmations < 1) {
        console.log(`Skipping transaction for index ${i} - needs more confirmations`);
        return;
      }

      // FIXED: Use consistent transaction ID throughout
      const transactionId = txData.txid || txData.tx;
      if (!transactionId) {
        console.log(`Skipping transaction for index ${i} - no valid transaction ID`);
        return;
      }

      // FIXED: Check database and skip if already processed - CRITICAL FIX
      const existingTx = await this.getTransactionByTxid(transactionId);
      if (existingTx && (existingTx.status === 'Completed' || existingTx.status === 'Processing' || existingTx.status === '')) {
        console.log(`Transaction ${transactionId} already processed (status: "${existingTx.status}"), skipping`);
        return;
      }

      console.log(`Transaction ${transactionId} reached ${txData.confirmations}+ confirmations. Processing deposit.`);

      // FIXED: Use consistent transaction ID for locking BEFORE any processing
      if (this._processingTransactions && this._processingTransactions.has(transactionId)) {
        console.log(`Transaction ${transactionId} is already being processed, skipping`);
        return;
      }

      // Initialize set if not exists
      if (!this._processingTransactions) this._processingTransactions = new Set();
      this._processingTransactions.add(transactionId);

      // FIXED: Insert or update transaction as processing with proper error handling
      try {
        if (!existingTx) {
          await this.connection.query('INSERT INTO transactions (uuid, address, balance, tx, transaction_type, status, currency, created) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())', [user_uuid, address, txData.amount, transactionId, 'deposit', 'Processing', ClientType.type.toUpperCase()]);
          console.log(`Marked transaction ${transactionId} as Processing in database`);
        } else {
          await this.connection.query('UPDATE transactions SET status = ? WHERE tx = ?', ['Processing', transactionId]);
          console.log(`Updated transaction ${transactionId} to Processing status`);
        }
      } catch (dbError) {
        if (dbError.code === 'ER_DUP_ENTRY') {
          console.log(`Transaction ${transactionId} already exists, skipping`);
          this._processingTransactions.delete(transactionId);
          return;
        }
        console.error(`Error marking transaction as processing: ${dbError.message}`);
        this._processingTransactions.delete(transactionId);
        return;
      }

      // FIXED: Process only the specific transaction amount, not all UTXOs
      const transactionAmount = parseFloat(txData.amount);

      // Validate minimum amount
      if (transactionAmount < 0.005) {
        console.log(`Transaction amount ${transactionAmount} ${ClientType.type} is below minimum threshold`);
        this._processingTransactions.delete(transactionId);
        return;
      }

      console.log(`Processing ${transactionAmount} ${ClientType.type} from transaction ${transactionId}`);

      // NEW: Check if user has an active invoice expecting this payment
      const hasActiveInvoice = await this.checkActiveInvoice(user_uuid, transactionAmount, ClientType.type);

      if (!hasActiveInvoice) {
        // No active invoice - convert entire deposit to fiat
        console.log(`No active invoice found for ${transactionAmount} ${ClientType.type} - converting to fiat`);

        // Add to crypto balance first
        const added = await this.addBalance(user_uuid, transactionAmount, { type: ClientType.type, decimals: 8 });

        if (added) {
          // Convert to fiat immediately
          await this.convertDepositToFiat(user_uuid, transactionAmount, ClientType.type, transactionId);
        } else {
          console.warn(`Failed to update balance for user ${user_uuid}.`);
          this._processingTransactions.delete(transactionId);
          return;
        }
      } else {
        // Active invoice exists - add to crypto balance normally
        console.log(`Active invoice found - adding ${transactionAmount} ${ClientType.type} to crypto balance`);
        const added = await this.addBalance(user_uuid, transactionAmount, { type: ClientType.type, decimals: 8 });

        if (!added) {
          console.warn(`Failed to update balance for user ${user_uuid}.`);
          this._processingTransactions.delete(transactionId);
          return;
        }
      }

      console.log(`Balance updated for user ${user_uuid}: +${transactionAmount} ${ClientType.type}`);

      // FIXED: Simple status update without conditions
      try {
        await this.connection.query('UPDATE transactions SET status = ? WHERE tx = ?', ['Completed', transactionId]);
        console.log(`Successfully updated transaction ${transactionId} to Completed`);
      } catch (error) {
        console.error(`Error updating transaction status: ${error.message}`);
      }

      // FIXED: Remove from processing set using consistent ID
      this._processingTransactions.delete(transactionId);
    } catch (error) {
      console.error(`Error in Check_Addresses for transaction ${transactionId}: ${error.message}`);
      this._processingTransactions.delete(transactionId);
    }
  }

  // NEW: Add method to check for active invoice
  async checkActiveInvoice(user_uuid, amount, cryptoType) {
    try {
      // Query database for active invoices expecting this amount/crypto type
      const query = `
      SELECT COUNT(*) as count 
      FROM user_invoices 
      WHERE user_uuid = ? 
      AND crypto_currency = ? 
      AND invoice_status = 'pending' 
      AND ABS(amount_crypto - ?) <= (amount_crypto * 0.05)
      AND expires_at > NOW()
    `;

      const result = await this.connection.query(query, [user_uuid, cryptoType, amount]);
      return result.length > 0 && result[0].count > 0;
    } catch (error) {
      console.error('Error checking active invoice:', error);
      return false; // Assume no invoice if error
    }
  }

  // NEW: Add method to convert deposit to fiat
  async convertDepositToFiat(user_uuid, amount, cryptoType, txHash) {
    try {
      // Call PHP API to handle fiat conversion
      const axios = require('axios');

      const response = await axios.post('http://localhost/api/v1/services/fiat-conversion.php', {
        action: 'convert_deposit',
        user_uuid: user_uuid,
        amount: amount,
        crypto_type: cryptoType,
        tx_hash: txHash,
      });

      if (response.data && response.data.success) {
        console.log(`Converted ${amount} ${cryptoType} to fiat for user ${user_uuid}`);
      } else {
        console.error('Fiat conversion failed:', response.data);
      }
    } catch (error) {
      console.error('Error calling fiat conversion API:', error);
    }
  }
  // FIXED: Helper method to check if transaction exists using correct field
  async getTransactionByTxid(txid) {
    try {
      console.log(`Checking database for transaction: ${txid}`);
      const rows = await this.connection.query('SELECT * FROM transactions WHERE tx = ? LIMIT 1', [txid]);

      if (rows.length > 0) {
        console.log(`Found existing transaction ${txid} with status: ${rows[0].status}`);
        return rows[0];
      } else {
        console.log(`No existing transaction found for ${txid}`);

        // Debug: Check what transactions DO exist for this user
        const debugRows = await this.connection.query('SELECT tx, status FROM transactions ORDER BY created DESC LIMIT 5');
        console.log(
          `Recent transactions in database:`,
          debugRows.map((r) => `${r.tx} (${r.status})`),
        );

        return null;
      }
    } catch (error) {
      console.error('Error checking transaction:', error);
      return null;
    }
  }

  /*
   * Returns the UUID for the single account.
   * Since there is only one account, this retrieves it from the wallets table.
   * @param {string} user - The username (unused, kept for compatibility).
   * @returns {string|null} - The user's UUID or null if not found.
   */
  async Get_User_UUID(user) {
    // Single account: get the first wallet's user_uuid
    const rows = await this.connection.query('SELECT DISTINCT user_uuid FROM wallets LIMIT 1');
    return rows.length > 0 ? rows[0].user_uuid : null;
  }

  async Get_Users_Name_By_UUID(uuid) {
    // Single account: get name from wallets table for this uuid
    const rows = await this.connection.query('SELECT name FROM wallets WHERE user_uuid = ? LIMIT 1', [uuid]);
    return rows.length > 0 ? rows[0].name : null;
  }

  /*
   * Retrieves the transaction ID (tx) of a user from the wallets table.
   * @param {string} user_uuid - The user's UUID.
   * @returns {number} - The transaction ID or 0 if not found.
   */
  async GetTxidOf(user_uuid) {
    const rows = await this.connection.query(`SELECT tx FROM ${this.walletsTable} WHERE user_uuid = ?`, [user_uuid]);
    return rows.length > 0 ? rows[0].tx : 0;
  }

  /*
   * Retrieves the username associated with a given address.
   * @param {string} address - The wallet address.
   * @returns {string|null} - The user_uuid or null if not found.
   */
  async Get_User_By_Address(address) {
    const rows = await this.connection.query(`SELECT user_uuid FROM ${this.walletsTable} WHERE address = ?`, [address]);
    return rows.length > 0 ? rows[0].user_uuid : null;
  }

  /*
   * Validates if an address exists in the wallets table.
   * @param {string} address - The wallet address to validate.
   * @returns {boolean} - True if the address exists, false otherwise.
   */
  async Validate_Address(address) {
    const rows = await this.connection.query(`SELECT 1 FROM ${this.walletsTable} WHERE address = ? LIMIT 1`, [address]);
    return rows.length > 0;
  }

  /*
   * Creates a wallet for a user and inserts records into wallets and funding tables.
   * @param {object} user - The user object containing username and other details.
   * @param {string} coinType - The coin type (e.g., 'LTC').
   * @param {string} uuid - The user's UUID.
   * @param {number} decimals - The number of decimals for the coin.
   * @param {object} Engine - The Engine instance for interacting with the blockchain.
   * @returns {boolean} - True if the wallet was created successfully.
   */
  //const created = await this.create(account, coinType, account.uuid, decimals, Engine);
  async create(user, coinType, uuid, decimals, Engine) {
    const wuuid = (coinType + uuid).trim();
    console.log(`Creating wallet with UUID: ${wuuid}`);

    const address = await Engine.createAddress('p2sh-segwit', user.username);
    if (!address) {
      console.error(`Failed to create address for user: ${user.username}`);
      return false;
    }
    console.log(`Generated address for ${user.username}: ${address}`);

    this.users[uuid] = {
      uuid: uuid,
      username: user.username,
      address: address,
      balance: BN(0),
      intent: 0,
      tx: 0,
      type: coinType,
    };

    try {
      await this.connection.query('INSERT INTO wallets (uuid, user_uuid, name, address) VALUES(?, ?, ?, ?)', [wuuid, uuid, user.username, address]);
      console.log(`Wallet inserted into database for ${user.username}`);

      return true;
    } catch (error) {
      console.error(`Error creating wallet for ${user.username}:`, error);
      return false;
    }
  }

  /*
   * Adds amount to the user's deposit balance in the wallets table.
   * @param {string} user_uuid - The user's UUID.
   * @param {number|string|BN} amount - The amount to add.
   * @param {object} hostType - The host type object containing type and decimals.
   * @returns {boolean} - True if the balance was updated successfully.
   */
  async addBalance(user_uuid, amount, hostType) {
    // Ensure amount is a BigNumber instance
    if (!(amount instanceof BN)) amount = BN(amount);

    if (!(await this.checkAmount(amount))) {
      console.error(`Invalid amount ${amount.toString()} for user ${user_uuid}`);
      return false;
    }

    // Ensure the user object exists
    if (!this.users[user_uuid]) {
      const userRows = await this.connection.query('SELECT * FROM wallets WHERE user_uuid = ?', [user_uuid]);

      if (userRows.length > 0) {
        this.users[user_uuid] = {
          uuid: userRows[0].uuid,
          user_uuid: userRows[0].user_uuid,
          address: userRows[0].address,
          balance: BN(userRows[0].balance),
          intent: 0,
          tx: userRows[0].tx,
        };
      } else {
        console.error(`User ${user_uuid} not found in wallets table.`);
        return false;
      }
    }

    // Calculate new balance and transaction ID
    const newBalance = this.users[user_uuid].balance.plus(amount);
    const txid = (await this.GetTxidOf(user_uuid)) + 1;

    try {
      // Update balance and transaction ID in the database using user_uuid
      await this.connection.query('UPDATE wallets SET balance = ?, tx = ? WHERE user_uuid = ?', [newBalance.toFixed(hostType.decimals), txid, user_uuid]);

      // Update in-memory balance
      BN.config(GetBigNumberConfigOf(hostType.decimals));
      this.users[user_uuid].balance = newBalance;

      console.log(`Updated balance for user ${user_uuid}: ${newBalance.toString()} ${hostType.type}`);
      return true;
    } catch (error) {
      console.error(`Failed to update balance for user ${user_uuid}:`, error);
      return false;
    }
  }

  /*
   * Deducts amount from the user's deposit balance in the wallets table.
   * @param {string} user_uuid - The user's UUID.
   * @param {number|string|BN} amount - The amount to deduct.
   * @param {object} hostType - The host type object containing type and decimals.
   * @returns {boolean} - True if the balance was updated successfully.
   */
  async deductBalance(user_uuid, amount, hostType) {
    // Ensure amount is a BigNumber instance
    if (!(amount instanceof BN)) amount = BN(amount);

    if (!(await this.checkAmount(amount))) {
      console.error(`Invalid amount ${amount.toString()} for user ${user_uuid}`);
      return false;
    }

    // Ensure the user object exists
    if (!this.users[user_uuid]) {
      const userRows = await this.connection.query('SELECT * FROM wallets WHERE user_uuid = ?', [user_uuid]);

      if (userRows.length > 0) {
        this.users[user_uuid] = {
          uuid: userRows[0].uuid,
          user_uuid: userRows[0].user_uuid,
          address: userRows[0].address,
          balance: BN(userRows[0].balance),
          intent: 0,
          tx: userRows[0].tx,
        };
      } else {
        console.error(`User ${user_uuid} not found in wallets table.`);
        return false;
      }
    }

    // Calculate new balance and transaction ID
    const newBalance = this.users[user_uuid].balance.minus(amount);
    const txid = (await this.GetTxidOf(user_uuid)) + 1;

    try {
      // Update balance and transaction ID in the database using user_uuid
      await this.connection.query('UPDATE wallets SET balance = ?, tx = ? WHERE user_uuid = ?', [newBalance.toFixed(hostType.decimals), txid, user_uuid]);

      // Update in-memory balance
      BN.config(GetBigNumberConfigOf(hostType.decimals));
      this.users[user_uuid].balance = newBalance;

      return true;
    } catch (error) {
      console.error(`Failed to update balance for user ${user_uuid}:`, error);
      return false;
    }
  }

  /*
   * Retrieves the deposit address for a user.
   * @param {string} uuid - The user's UUID.
   * @param {string} coinType - The coin type (e.g., 'LTC').
   * @returns {string|null} - The deposit address or null if not found.
   */
  async GetDepositAddress(uuid, coinType) {
    const wuuid = (coinType + uuid).trim();
    console.log(`Getting deposit address for UUID: ${wuuid}`);
    const WalletRows = await this.connection.query('SELECT address FROM wallets WHERE uuid = ?', [wuuid]);
    if (WalletRows.length > 0) {
      return WalletRows[0].address;
    } else {
      return null;
    }
  }

  /*
   * Retrieves the transaction record for a given transaction ID.
   * @param {string} txid - The transaction ID.
   * @returns {object|false} - The transaction object or false if not found.
   */
  async GetForTX(txid) {
    const TransactionRows = await this.connection.query('SELECT * FROM transactions WHERE tx = ?', [txid]);
    if (TransactionRows.length > 0) {
      return TransactionRows[0];
    } else return false;
  }

  /*
   * Sets the intent value for a user in the funding table.
   * @param {string} user - The username.
   * @param {number} intent - The intent value to set.
   * @returns {void}
   */
  async setIntent(userId, intent) {
    await this.connection.query('UPDATE wallets SET intent = ? WHERE user_uuid = ?', [intent, userId]);
    if (!this.users[userId]) {
      this.users[userId] = {};
    }
    this.users[userId].intent = intent;
  }

  /*
   * Retrieves the intent value for a user.
   * @param {string} user - The username.
   * @returns {number|null} - The intent value or null if not found.
   */
  async getIntent(userId) {
    const WalletRows = await this.connection.query('SELECT intent FROM wallets WHERE user_uuid = ?', [userId]);
    if (WalletRows.length > 0) {
      return WalletRows[0].intent;
    }
    return null;
  }

  /*
   * Retrieves the wallet address for a user from memory.
   * @param {string} user - The username.
   * @returns {string} - The user's wallet address.
   */
  async getAddress(user_uuid) {
    return this.users[user_uuid].address;
  }

  /*
   * Retrieves the deposit balance for a user.
   * @param {string} user - The username.
   * @returns {BN} - The user's deposit balance as a BigNumber.
   */
  async getBalance(user_uuid) {
    if (!this.users[user_uuid]) {
      const userRows = await this.connection.query('SELECT balance FROM wallets WHERE user_uuid = ?', [user_uuid]);
      if (userRows.length > 0) {
        this.users[user_uuid] = {
          balance: BN(userRows[0].balance),
        };
      } else {
        return BN(0);
      }
    }
    return this.users[user_uuid].balance;
  }

  /*
   * Checks if a user has a wallet for a specific coin type.
   * @param {string} coinType - The coin type (e.g., 'LTC').
   * @param {object} user - The user object containing username and other details.
   * @returns {boolean} - True if the user has a wallet, false otherwise.
   */
  async HasWallet(coinType, user) {
    const wuuid = (coinType + user.uuid).trim();
    try {
      const userRow = await this.connection.query('SELECT 1 FROM wallets WHERE uuid = ? LIMIT 1', [wuuid]);
      return userRow.length > 0;
    } catch (error) {
      console.error('Error querying the database in HasWallet:', error);
      return false;
    }
  }

  /*
   * Creates wallets for all accounts that do not already have one for the given coin type.
   * Also updates existing wallets that have "unknown" addresses.
   * @param {object} ClientType - The client type object containing coin type and decimals.
   * @param {object} Engine - The Engine instance for interacting with the blockchain.
   * @returns {void}
   */
  async createManyAccounts(ClientType, Engine) {
    if (!ClientType || !ClientType.type) return;

    const coinType = ClientType.type;
    const decimals = ClientType.decimals;

    // For single account setup, check if any wallet exists
    const ExistingWallets = await this.connection.query('SELECT * FROM wallets');

    if (ExistingWallets.length === 0) {
      // No wallets exist - create one. Get the first admin/main account from env or config
      const mainUser = { uuid: 'main-user', username: 'agentsmith' };
      console.log(`Creating wallet for: ${mainUser.username} (${coinType})`);
      const created = await this.create(mainUser, coinType, mainUser.uuid, decimals, Engine);
      if (created) console.log(`Wallet Created for ${mainUser.username}`);
    } else {
      // Load existing wallets into memory
      for (let w of ExistingWallets) {
        this.users[w.user_uuid] = {
          uuid: w.uuid,
          user_uuid: w.user_uuid,
          address: w.address,
          balance: BN(w.balance || 0),
          intent: w.intent || 0,
          tx: w.tx || 0,
        };
      }
    }
  }

  /*
   * Updates an existing wallet's address from "unknown" to a valid blockchain address.
   * @param {object} user - The user object containing username and other details.
   * @param {string} coinType - The coin type (e.g., 'LTC').
   * @param {object} Engine - The Engine instance for interacting with the blockchain.
   * @param {string} wuuid - The wallet UUID.
   * @returns {boolean} - True if the address was updated successfully.
   */
  async updateWalletAddress(user, coinType, Engine, wuuid) {
    try {
      // Generate new address from blockchain
      const address = await Engine.createAddress('p2sh-segwit', user.username);
      if (!address) {
        console.error(`Failed to create address for user: ${user.username}`);
        return false;
      }

      console.log(`Generated new address for ${user.username}: ${address}`);

      // Update database with new address
      await this.connection.query('UPDATE wallets SET address = ? WHERE uuid = ?', [address, wuuid]);

      // Update in-memory user object using user_uuid as key
      this.users[user.uuid] = {
        uuid: user.uuid,
        username: user.username,
        address: address,
        balance: BN(0),
        intent: 0,
        tx: 0,
        type: coinType,
      };

      console.log(`Successfully updated address for ${user.username} to ${address}`);
      return true;
    } catch (error) {
      console.error(`Error updating wallet address for ${user.username}:`, error);
      return false;
    }
  }

  /*
   * Checks if the amount is a valid number and greater than zero.
   * @param {number|string|BN} amount - The amount to check.
   * @returns {boolean} - True if the amount is valid, false otherwise.
   */
  async checkAmount(amount) {
    if (!(amount instanceof BN)) {
      amount = BN(amount);
    }
    return !amount.isNaN() && amount.gt(0);
  }

  async Get_Wallet_Accounts() {
    const AccountRows = await this.connection.query('SELECT * FROM wallets');
    return AccountRows;
  }

  async Get_User_Accounts() {
    // For single account setup, return the wallets as user accounts
    const WalletRows = await this.connection.query('SELECT * FROM wallets');
    return WalletRows;
  }
  ///////////////// End of WalletManager Class /////////////////
}

// Helper Functions
/*
 * Configures BigNumber settings based on the number of decimals.
 * @param {number} decimals - The number of decimals.
 * @returns {object} - The BigNumber configuration object.
 */
function GetBigNumberConfigOf(decimals) {
  return {
    ROUNDING_MODE: BN.ROUND_DOWN,
    EXPONENTIAL_AT: decimals + 1,
    DECIMAL_PLACES: decimals,
    DEBUG: false,
  };
}

const walletManager = new WalletManager();
module.exports = async () => {
  await walletManager.initializeConnection();

  return {
    createManyAccounts: walletManager.createManyAccounts.bind(walletManager),
    createUser: walletManager.create.bind(walletManager),
    addBalance: walletManager.addBalance.bind(walletManager),
    deductBalance: walletManager.deductBalance.bind(walletManager),
    GetDepositAddress: walletManager.GetDepositAddress.bind(walletManager),
    GetForTX: walletManager.GetForTX.bind(walletManager),
    getAddress: walletManager.getAddress.bind(walletManager),
    getBalance: walletManager.getBalance.bind(walletManager),
    getIntent: walletManager.getIntent.bind(walletManager),

    Get_User_By_Address: walletManager.Get_User_By_Address.bind(walletManager),
    Get_User_UUID: walletManager.Get_User_UUID.bind(walletManager),
    Validate_Address: walletManager.Validate_Address.bind(walletManager),
    Get_Wallet_Accounts: walletManager.Get_Wallet_Accounts.bind(walletManager),
    Get_User_Accounts: walletManager.Get_User_Accounts.bind(walletManager),
    Get_Users_Name_By_UUID: walletManager.Get_Users_Name_By_UUID.bind(walletManager),
    Check_Addresses: walletManager.Check_Addresses.bind(walletManager),
    Get_Name_By_Address: walletManager.Get_Name_By_Address.bind(walletManager),
  };
};
