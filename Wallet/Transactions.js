// Libraries
const MySQL = require('promise-mysql');
const Utils = require('../Core/Utils.js');

//MySQL connection and table vars.
var connection;
async function Transaction_Exists(uuid, tx) {
  var x,
    Exists = false;
  var WalletRows = await connection.query('SELECT * FROM transactions');
  //Iterate over each row
  for (x in WalletRows) {
    if (WalletRows[x].uuid === uuid && WalletRows[x].tx === tx) {
      Exists = true;
    }
  }
  return Exists;
}
async function GetWallets() {
  var x,
    Wallets = [];
  var WalletRows = await connection.query('SELECT * FROM wallets');
  //Iterate over each row
  for (x in WalletRows) {
    Wallets.push(WalletRows[x]);
  }
  return Wallets;
}
async function GetUserByTX(tx) {
  connection.query('SELECT * FROM transactions WHERE tx = ?', [txsTemp[i].txid]);
  var result = await connection.query('SELECT * FROM transactions WHERE tx = ?', [tx]);
  return result[0].uuid ?? null;
}
async function GetUserByAddress(address) {
  var result = await connection.query('SELECT * FROM wallets WHERE address = ?', [address]);
  return result[0].uuid ?? null;
}
async function AddOrUpdateTransaction(uuid, address, balance, tx, transaction_type, currency, txsTemp, status_type = null) {
  // Convert UNIX timestamp to a JavaScript Date object
  const createdDate = new Date(); // Automatically uses current time
  var sql = `
        INSERT INTO transactions (uuid, address, balance, tx, transaction_type, status, currency, created)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
        uuid = VALUES(uuid),
        address = VALUES(address),
        balance = VALUES(balance),
        tx = VALUES(tx),
        transaction_type = VALUES(transaction_type),
        status = VALUES(status),
        currency = VALUES(currency),
        created = VALUES(created)
    `;
  if (status_type === null) status_type = txsTemp.confirmations > 3 ? 'Confirmed' : 'Pending';

  // Use the Date object instead of the Unix timestamp
  var values = [uuid, address, balance, tx, transaction_type, status_type, currency, createdDate];
  var result = await connection.query(sql, values);
  return result;
}

async function UpdateTransactionStatus(tx, status) {
  var sql = `
		UPDATE transactions
		SET status = ?
    WHERE tx = ?
	`;
  var values = [status, tx];
  var result = await connection.query(sql, values);
  return result;
}

async function GetWalletFromAddress(address) {
  var x,
    Wallet = null;
  var WalletRows = await connection.query('SELECT * FROM wallets');
  //Iterate over each row
  for (x in WalletRows) {
    if (WalletRows[x].address === address) {
      Wallet = WalletRows[x];
    }
  }
  return Wallet;
}
async function GetAddresses(uuid) {
  var x,
    Addresses = [];
  var WalletRows = await connection.query('SELECT * FROM transactions');
  //Iterate over each row
  for (x in WalletRows) {
    //console.log(WalletRows[x]);

    var Address = WalletRows[x].uuid === uuid ? WalletRows[x].address : null;
    if (Address != null) Addresses.push(Address);
  }
  // Also add their current address which is in wallets table
  WalletRows = await connection.query('SELECT * FROM wallets');
  for (x in WalletRows) {
    Addresses.push(WalletRows[x].address);
  }
  // Double check the address list for duplicates in case their current address is in the transactions table
  Addresses = [...new Set(Addresses)];

  return Addresses;
}
async function GetAllTransactions() {
  var x,
    Transactions = [];
  var WalletRows = await connection.query('SELECT * FROM transactions');
  //Iterate over each row
  for (x in WalletRows) {
    Transactions.push(WalletRows[x]);
  }
  return Transactions;
}

async function GetTransactionsByUUID(uuid) {
  var x,
    Transactions = [];
  var WalletRows = await connection.query('SELECT * FROM transactions');
  //Iterate over each row
  for (x in WalletRows) {
    if (WalletRows[x].uuid === uuid) {
      Transactions.push(WalletRows[x]);
    }
  }
  return Transactions;
}
async function AddressHasTransactionRecord(address, tx) {
  var x,
    Exists = false;
  var WalletRows = await connection.query('SELECT * FROM transactions');
  //Iterate over each row
  for (x in WalletRows) {
    if (WalletRows[x].address === address && WalletRows[x].tx === tx) {
      Exists = true;
    }
  }
  return Exists;
}
async function GetTransactionsByAddress(address) {
  var x,
    Transactions = [];
  var WalletRows = await connection.query('SELECT * FROM transactions');
  //Iterate over each row
  for (x in WalletRows) {
    if (WalletRows[x].address === address) {
      Transactions.push(WalletRows[x]);
    }
  }
  return Transactions;
}

async function GetAddress(uuid) {
  var Address = null,
    x;
  var WalletRows = await connection.query('SELECT * FROM wallets');
  //Iterate over each row
  for (x in WalletRows) {
    Address = WalletRows[x].uuid === uuid ? WalletRows[x].address : null;
  }
  return Address;
}

async function CheckDepositAddressForTransaction(uuid, Addresses) {
  // Being fed an array called Addresses
  // Query the transactions table to check if the transaction exists
  // We need to make sure that we check the address of the same address only once
  var x;
  var WalletRows = await connection.query('SELECT * FROM transactions');
  var FilteredAddresses = [];
  //Iterate over each row
  for (x in WalletRows) {
    var Address = WalletRows[x].uuid === uuid ? WalletRows[x] : null;
    if (Address != null) FilteredAddresses.push(Address);
  }

  // Double check the address list for duplicates in case their current address is in the transactions table
  FilteredAddresses = [...new Set(FilteredAddresses)];

  return FilteredAddresses.length > 0 ? FilteredAddresses : false;
}

async function TableExists(tableName) {
  const result = await this.connection.query('SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_name = ?', [tableName]);
  return result[0].count > 0;
}

async function CreateTable(tableName, schema) {
  await this.connection.query(`CREATE TABLE IF NOT EXISTS ${tableName} (${schema})`);
}

module.exports = async () => {
  connection = await Utils.Connection(MySQL, connection);
  //Return all the functions.
  return {
    AddOrUpdateTransaction: AddOrUpdateTransaction,
    AddressHasTransactionRecord: AddressHasTransactionRecord,
    GetAddress: GetAddress,
    GetAddresses: GetAddresses,
    GetAllTransactions: GetAllTransactions,
    GetTransactionsByUUID: GetTransactionsByUUID,
    GetTransactionsByAddress: GetTransactionsByAddress,

    Transaction_Exists: Transaction_Exists,
    CheckDepositAddressForTransaction: CheckDepositAddressForTransaction,
    GetWalletFromAddress: GetWalletFromAddress,
    UpdateTransactionStatus: UpdateTransactionStatus,
    GetUserByTX: GetUserByTX,
    GetUserByAddress: GetUserByAddress,
    GetWallets: GetWallets,
    CreateTable: CreateTable,
    TableExists: TableExists,
  };
};
