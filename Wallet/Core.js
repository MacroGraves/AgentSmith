const axios = require('axios');
const Config = require('../Settings.json'); // Adjust the path to your Settings.json file

/*
Client.Engine
Useful for many core clients, such as BTC, LTC, Doge, Dash etc
This class is universal, despite it being named "Core" it can be used for tokens as well.
To do this, it uses custom classes such as Solana.js, Ethereum.js, etc.
This class is used to interact with the core client, such as Bitcoin Core, Litecoin Core, etc.
However it is also designed to be used with tokens, such as ERC20 tokens.
For example we may want Client.Engine.Tick['deposit'] to be a function that watches for deposits to a specific address.
*/

// Helper Functions
/*
 * Encodes a value using encodeURIComponent.
 * @param {string} value - The value to encode.
 * @returns {string} - The encoded value.
 */
function Encode(value) {
  return encodeURIComponent(value);
}

/*
 * Constructs the RPC URL for the client.
 * @param {object} client - The client object.
 * @returns {string} - The constructed URL.
 */
function URL(client) {
  return `http://${Encode(client.Engine.host)}:${Encode(client.Engine.port)}/`;
}

class Core {
  /*
   * Initializes the Core class with configuration.
   * @param {object} config - The configuration object containing host, port, username, and password.
   */
  constructor(config) {
    const { host, port, username, password } = config;
    this.Engine = { host, port, username, password };
    this.baseURL = URL(this);
    this.auth = { username, password };
    this.txs = {};
    this.processingTransactions = new Set(); // In-memory set to track processing transactions
  }
  getProcessingTransactions() {
    return this.processingTransactions;
  }
  getTxs() {
    return this.txs;
  }
  setTxs(newTxs) {
    this.txs = newTxs;
  }

  Start_Tick(fn, interval) {
    if (typeof fn !== 'function') {
      throw new Error('First argument must be a function');
    }

    return setInterval(fn, interval);
  }
  /*
   * Sends an RPC request to the Bitcoin Core RPC server.
   * @param {string} method - The RPC method name.
   * @param {array} params - The parameters for the RPC method.
   * @returns {Promise<any>} - The result of the RPC call.
   */
  async RPC_Request(method, params = []) {
    try {
      const requestData = { jsonrpc: '1.0', method, params };
      const response = await axios.post(this.baseURL, requestData, {
        auth: this.auth,
        headers: { 'Content-Type': 'text/plain' },
      });
      return response.data.result;
    } catch (error) {
      if (!Config.Production) console.error('Error:', error);
      return null;
    }
  }

  /*
   * Creates a new address.
   * @param {string} [walletType="p2sh-segwit"] - The address type.
   * @param {string} [label=""] - The label for the address.
   * @returns {Promise<string>} - The new address.
   */
  async createAddress(walletType = 'p2sh-segwit', label = '') {
    const params = label ? [label, walletType] : [walletType];
    return await this.RPC_Request('getnewaddress', params);
  }

  /*
   * Gets blockchain info.
   * @returns {Promise<object>} - The blockchain info.
   */
  async getBlockchainInfo() {
    return await this.RPC_Request('getblockchaininfo');
  }

  /*
   * Validates an address.
   * @param {string} address - The address to validate.
   * @returns {Promise<object>} - The validation result.
   */
  async validateAddress(address) {
    return await this.RPC_Request('validateaddress', [address]);
  }

  /*
   * Gets transactions for an address.
   * @param {string} address - The address to get transactions for.
   * @returns {Promise<array>} - The transactions.
   */
  async getTransactions(address) {
    return await this.RPC_Request('listtransactions', [address]);
  }

  /*
   * Gets all transactions.
   * @returns {Promise<array>} - All transactions.
   */
  async getAllTransactions() {
    return await this.RPC_Request('listtransactions');
  }

  /*
   * Lists balances by receiving address.
   * @param {string} address - The address to get balance for.
   * @param {number} [confirmations=1] - The number of confirmations.
   * @returns {Promise<array>} - The list of balances.
   */
  async getAddressBalance(address, confirmations = 1) {
    return await this.RPC_Request('listreceivedbyaddress', [confirmations, false, false, address]);
  }

  /*
   * Sends amount to an address.
   * @param {string} address - The address to send to.
   * @param {number} amount - The amount to send.
   * @param {boolean} [subtractFeeFromAmount=false] - Whether to subtract the fee from the amount.
   * @param {boolean} [replaceable=false] - Whether the transaction is replaceable (RBF).
   * @returns {Promise<string>} - The transaction ID.
   */
  async sendToAddress(address, amount, subtractFeeFromAmount = false, replaceable = false) {
    const params = [address, amount, '', '', subtractFeeFromAmount, replaceable];
    return await this.RPC_Request('sendtoaddress', params);
  }

  /*
   * Gets the total amount received by an address.
   * @param {string} address - The address to check.
   * @param {number} [minConf=1] - The minimum number of confirmations.
   * @returns {Promise<number>} - The total amount received.
   */
  async getReceivedByAddress(address, minConf = 1) {
    return await this.RPC_Request('getreceivedbyaddress', [address, minConf]);
  }

  /*
   * Sends amount to an address using a payload object.
   * @param {object} payload - The payload containing address and amount.
   * @returns {Promise<string>} - The transaction ID.
   */
  async send(payload) {
    return await this.RPC_Request('sendtoaddress', [payload.address, payload.amount]);
  }

  /*
   * Lists unspent transaction outputs (UTXOs) for specified addresses.
   * @param {number} [minConf=1] - The minimum number of confirmations.
   * @param {number} [maxConf=9999999] - The maximum number of confirmations.
   * @param {array} [addresses=[]] - The list of addresses to filter.
   * @returns {Promise<array>} - The list of unspent outputs.
   */
  async listUnspent(minConf = 1, maxConf = 9999999, addresses = []) {
    return await this.RPC_Request('listunspent', [minConf, maxConf, addresses]);
  }

  /*
   * Creates a raw transaction.
   * @param {array} inputs - The list of inputs.
   * @param {object} outputs - The outputs object.
   * @returns {Promise<string>} - The raw transaction hex.
   */
  async createRawTransaction(inputs, outputs) {
    return await this.RPC_Request('createrawtransaction', [inputs, outputs]);
  }

  /*
   * Signs a raw transaction with the wallet's private keys.
   * @param {string} rawTxHex - The raw transaction hex string.
   * @returns {Promise<object>} - The result object containing signed transaction hex and completion status.
   */
  async signRawTransactionWithWallet(rawTxHex) {
    return await this.RPC_Request('signrawtransactionwithwallet', [rawTxHex]);
  }

  /*
   * Sends a raw transaction to the network.
   * @param {string} signedTxHex - The signed transaction hex string.
   * @returns {Promise<string>} - The transaction ID.
   */
  async sendRawTransaction(signedTxHex) {
    try {
      const txid = await this.RPC_Request('sendrawtransaction', [signedTxHex]);
      if (!txid || typeof txid !== 'string' || txid.length < 10) {
        console.error(`Invalid transaction ID returned: ${txid}`);
        return null;
      }
      return txid;
    } catch (error) {
      console.error(`Error in sendRawTransaction: ${error.message}`);
      return null;
    }
  }
  /*
   * Estimates the smart fee for a transaction.
   * @param {number} confTarget - Confirmation target in blocks.
   * @returns {Promise<object>} - The fee rate.
   */
  async estimateSmartFee(confTarget) {
    return await this.RPC_Request('estimatesmartfee', [confTarget]);
  }

  // Function to send funds from a specific address
  /*
   * Sends funds from a specific address.
   * @param {string} fromAddress - The address to send funds from.
   * @param {string} toAddress - The recipient address.
   * @param {number|string} amount - The amount to send.
   * @param {number|null} [feeRate=null] - The fee rate in satoshis per byte. If null, estimates the fee.
   * @returns {Promise<string|boolean>} - The transaction ID or false if failed.
   */
  async sendFromAddress(fromAddress, toAddress, amount, feeRate = null) {
    try {
      // Step 1: List unspent outputs from the specific address
      const unspentOutputs = await this.listUnspent(1, 9999999, [fromAddress]);
      if (!unspentOutputs || unspentOutputs.length === 0) {
        throw new Error(`No unspent outputs found for address ${fromAddress}`);
      }

      // Define the fixed target amount to send
      const targetAmount = parseFloat(amount);
      let feePerByte;
      if (feeRate) {
        feePerByte = parseFloat(feeRate); // Fee rate in satoshis per byte
      } else {
        // Estimate fee rate if not provided
        const feeEstimate = await this.estimateSmartFee(2);
        if (feeEstimate && feeEstimate.feerate) {
          feePerByte = Math.max((feeEstimate.feerate * 1e8) / 1000, 20);
        } else {
          feePerByte = 20;
        }
      }

      // Step 2: Select inputs sufficient to cover the target amount and fee
      let inputs = [];
      let inputAmount = 0;
      let fee = 0;
      const feeBuffer = 1.1; // A 10% buffer for fee estimation
      for (const utxo of unspentOutputs) {
        inputs.push({ txid: utxo.txid, vout: utxo.vout });
        inputAmount += utxo.amount;
        // Estimate transaction size: each input is ~180 bytes, each output ~34 bytes, plus ~10 bytes overhead.
        const estimatedSize = inputs.length * 180 + 2 * 34 + 10;
        fee = ((estimatedSize * feePerByte) / 1e8) * feeBuffer;
        if (inputAmount >= targetAmount + fee) {
          break;
        }
      }
      if (inputAmount < targetAmount + fee) {
        throw new Error(`Insufficient funds: ${inputAmount} available, ${targetAmount + fee} required (including fee)`);
      }

      // Step 3: Calculate the change and set up outputs
      const change = inputAmount - targetAmount - fee;
      if (change < 0) {
        throw new Error('Insufficient funds to cover the fee');
      }
      const outputs = {};
      outputs[toAddress] = targetAmount;
      // If change exceeds the dust threshold, send it back to the sender.
      if (change > 0.00000546) {
        outputs[fromAddress] = parseFloat(change.toFixed(8));
      } else {
        // If the change is too small, add it to the fee.
        fee += change;
      }

      // Step 4: Create, sign, and broadcast the transaction
      const rawTx = await this.createRawTransaction(inputs, outputs);
      if (!rawTx) {
        throw new Error('Failed to create raw transaction');
      }
      const signedTx = await this.signRawTransactionWithWallet(rawTx);
      if (!signedTx || !signedTx.complete) {
        throw new Error('Transaction signing failed');
      }
      const txid = await this.sendRawTransaction(signedTx.hex);
      if (!txid) {
        throw new Error('Transaction broadcasting failed');
      }
      console.log(`Transaction successful! TXID: ${txid}`);

      return { txid, fee, amountSent: targetAmount, to: toAddress };
    } catch (error) {
      console.error('Error in sendFromAddress:', error.message);
      if (error.response && error.response.data && error.response.data.error) {
        console.error('RPC Error:', error.response.data.error);
      }
      return false;
    }
  }
}  

module.exports = Core;
