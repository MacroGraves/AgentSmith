const axios = require('axios');
const config = require('../Config.json');
const Utils = require('../Utils');
const mysql = require('promise-mysql');
const crypto = require('crypto');

class Commands {
  constructor(bot) {
    this.bot = bot;
    this.session = null;
    this.authProtocol = 0;
    this.apiBaseUrl = config.apiBaseUrl || 'https://judodice.com/api/auth';
    this.dbConnection = null;
    this.db = null;
    this.init();
  }
  async init() {
    this.db = await this.initConnection();
  }

  async initConnection() {
    if (!this.dbConnection) {
      try {
        this.dbConnection = await Utils.Connection(mysql);
        console.log('Database connection established');
      } catch (error) {
        console.error('Database connection error:', error);
      }
    }
    return this.dbConnection;
  }

  async handleCommand(message) {
    if (!message.text) return;

    if (message.text.startsWith('/start auth_')) {
      await this.handleAuthCommand(message);
      return;
    }

    const chatId = message.chat.id;

    try {
      // Check if this chat is already associated with an admin user
      if (!this.session) {
        await this.checkExistingAuth(chatId);
      }

      if (this.session) {
        await this.handleAuthorizedCommand(message);
      } else {
        await this.handleUnauthorizedCommand(message);
      }
    } catch (error) {
      console.error('Command handling error:', error);
      await this.bot.sendMessage(chatId, 'An error occurred while processing your command. Please try again later.');
    }
  }

  async checkExistingAuth(chatId) {
    try {
      /*
      const query = `
        SELECT a.uuid, a.username, t.api_key 
        FROM telegram_api_keys t
        JOIN accounts a ON a.uuid = t.uuid
        WHERE t.telegram_chat_id = ? AND t.status = 'active'
      `;
      const results = await this.db.query(query, [chatId.toString()]);
      // Need to get telegram_chat_id as well as the uuid and api_key
      */
      const query = `
     SELECT a.uuid, a.username, t.api_key, t.telegram_chat_id
     FROM telegram_api_keys t
     JOIN accounts a ON a.uuid = t.uuid
     WHERE t.telegram_chat_id = ? AND t.status = 'active'
     `;
      const results = await this.db.query(query, [chatId.toString()]);

      if (results && results.length > 0) {
        // Check if the telegram_chat_id is this chatId and if the uuid is the same as one on the accounts table with isAdmin
        const isAdmin = await this.db.query('SELECT isAdmin FROM accounts WHERE uuid = ?', [results[0].uuid]);
        if (isAdmin[0].isAdmin !== 1) {
          await this.bot.sendMessage(chatId, '❌ Access denied: Admin privileges required');
          return;
        }
        if (results[0].telegram_chat_id.toString() !== chatId.toString()) {
          await this.bot.sendMessage(chatId, '❌ Access denied: Chat ID mismatch: ID: ' + chatId.toString() + ' Chat ID: ' + results[0].telegram_chat_id);
          return;
        }
        /*
        this.session = {
          userId: results[0].uuid,
          username: results[0].username,
          apiKey: results[0].api_key,
        };
        */
        /*
        this.session = {
          userId: results[0].uuid,
          username: results[0].username,
          apiKey: results[0].api_key,
        };
*/
        // Update last_used timestamp
        await this.db.query('UPDATE telegram_api_keys SET last_used = NOW() WHERE uuid = ? AND api_key = ?', [results[0].uuid, results[0].api_key]);
      }
    } catch (error) {
      console.error('Error checking existing auth:', error);
    }
  }

  async handleAuthCommand(message) {
    /*
    try {
      // Extract authentication parameters from the start command
      // Format: /start auth_{userId}_{timestamp}_{signature}
      const authParams = message.text.substring(7).split('_');

      if (authParams.length !== 4 || authParams[0] !== 'auth') {
        throw new Error('Invalid authentication format');
      }

      const [_, userId, timestamp, signature] = authParams;
      const now = Math.floor(Date.now() / 1000);

      // Check if the link has expired (24 hours)
      if (now - parseInt(timestamp) > 86400) {
        throw new Error('Authentication link has expired');
      }

      // Get user and API key
      const results = await this.db.query(
        `
        SELECT a.username, t.api_key 
        FROM telegram_api_keys t
        JOIN accounts a ON a.uuid = t.uuid
        WHERE t.uuid = ? AND a.isAdmin = 1 AND t.status = 'active'
      `,
        [userId],
      );

      if (!results || results.length === 0) {
        throw new Error('User not found or not authorized');
      }

      const result = results[0];

      // Verify signature
      const expectedSignature = crypto.createHmac('sha256', result.api_key).update(`${userId}:${result.username}:${timestamp}`).digest('hex');

      if (signature !== expectedSignature) {
        throw new Error('Invalid signature');
      }

      // Store the Telegram chat ID
      await this.db.query('UPDATE telegram_api_keys SET telegram_chat_id = ?, last_used = NOW() WHERE uuid = ? AND api_key = ?', [message.chat.id.toString(), userId, result.api_key]);

      this.session = {
        userId: userId,
        username: result.username,
        apiKey: result.api_key,
      };

      await this.bot.sendMessage(message.chat.id, `✅ Authentication successful!\nWelcome, ${this.session.username}.\nYou now have access to JudoDice administrative functions.`, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('Auth error:', error);
      await this.bot.sendMessage(message.chat.id, `❌ Authentication failed: ${error.message || 'Unknown error'}`, { parse_mode: 'Markdown' });
    }
      */
  }

  async handleUnauthorizedCommand(message) {
    const command = message.text.trim().toLowerCase();
    const chatId = message.chat.id;
    // Is the message a command?
    if (!command.startsWith('/')) {
      // Check if it is from JudoModBot and is_bot is true and first_name is JudoMod and id is 5383722207
      // IsFrom?
      const isFrom = message.from;
      if (isFrom && message.reply_to_message && message.reply_to_message.from) {
        const isFromModBot = message.reply_to_message.from.is_bot && message.reply_to_message.from.first_name === 'JudoMod' && message.reply_to_message.from.id === 7334847285;
        const isDM = message.chat.type === 'private';
        const isReply = message.reply_to_message !== null;
        console.log('isFromModBot:', isFromModBot, 'isDM:', isDM, 'isReply:', isReply);
        if (isFromModBot && isDM && isReply) {
          const username = message.text.trim();
          // Check if user exists and is admin
          const users = await this.db.query('SELECT uuid, username, isAdmin FROM accounts WHERE username = ?', [username]);

          // if isAdmin is 1 then it is admin
          if (users && users.length > 0 && users[0].isAdmin === 1) {
            const user = users[0];
            // Generate API key
            const apiKey = crypto.randomBytes(32).toString('hex');

            // Generate the authentication link
            const timestamp = Math.floor(Date.now() / 1000);
            const signature = crypto.createHmac('sha256', apiKey).update(`${user.uuid}:${user.username}:${timestamp}`).digest('hex');

            // Store the API key
            await this.db.query(
              `
            INSERT INTO telegram_api_keys (uuid, api_key, session, created_at, status, telegram_chat_id, last_used)
            VALUES (?, ?, ?, NOW(), 'active', ?, NOW())
            ON DUPLICATE KEY UPDATE
                api_key = VALUES(api_key),
                session = VALUES(session),
                created_at = VALUES(created_at),
                status = VALUES(status),
                telegram_chat_id = VALUES(telegram_chat_id),
                last_used = VALUES(last_used)
            `,
              [user.uuid, apiKey, signature, chatId],
            );

            const authLink = `https://localhost/api/auth/?uuid=${user.uuid}&session=${signature}&key=${apiKey}&action=validate&t=1&chat_id=${chatId}&html=1`;
            // Send the authentication link
            await this.bot.sendMessage(chatId, `✅ Authentication link generated for ${user.username}!\n\nClick the link below to authenticate:\n${authLink}\n\nThis link will expire in 24 hours.`, {});
          } else {
            await this.bot.sendMessage(chatId, '❌ Admin not found. Please check your username and try again.');
          }
        } else {
          await this.bot.sendMessage(chatId, 'Invalid Request.', {});
        }
      } else {
        await this.bot.sendMessage(chatId, 'Invalid Request.', {});
      }

      return;
    } else {
      // sliced command
      const slicedCommand = command.split(' ');
      // Get length of sliced command
      const commandLength = slicedCommand.length;
      const Command = slicedCommand[0];
      let _token = commandLength > 2 ? slicedCommand[2] : null;
      let uuid = commandLength > 1 ? slicedCommand[1] : null;

      //const _token = slicedCommand[2];
      //const uuid = slicedCommand[1];
      // Check if user exists and is admin

      switch (Command) {
        case '/token':
          try {
            if (uuid === null) {
              return await this.bot.sendMessage(chatId, '❌ UUID not found. Please check your username and try again.');
            }
            const users = await this.db.query('SELECT uuid, username, isAdmin FROM accounts WHERE uuid = ?', [uuid]);
            if (users.length > 0) {
              const user = users[0];
              await this.tokenLogin(chatId, message, _token, user.uuid);
            } else {
              await this.bot.sendMessage(chatId, '❌ Admin not found. Please check your username and try again.');
            }
          } catch (error) {
            console.error('Login error:', error);
            await this.bot.sendMessage(chatId, 'An error occurred during login. Please try again.');
          }
          break;

        case '/login':
          try {
            await this.generateAuthLink(chatId);
          } catch (error) {
            console.error('Auth link generation error:', error);
            await this.bot.sendMessage(chatId, '❌ Failed to generate authentication link. Please try again later.');
          }
          break;
      }
    }
  }
  async tokenLogin(chatId, message, _token, uuid) {
    // Get the token from the message
    const token = message.text.split(' ')[1];
    // console.log('Chat ID:', chatId);
    // Check if the token is valid
    //console.log('Token:', _token);
    // Validate if the user is an admin, if the token matches, if the chatId is the same as the one in the database
    // First, get the username, uuid, and isAdmin from the accounts table
    const user = await this.db.query('SELECT uuid, username, isAdmin FROM accounts WHERE uuid = ?', [uuid]);
    if (user.length > 0) {
      // Check if the token is valid
      const tokenCheck = await this.db.query('SELECT * FROM telegram_api_keys WHERE uuid = ? AND session = ? AND status = ? AND telegram_chat_id = ?', [uuid, _token, 'active', chatId]);
      if (tokenCheck.length > 0) {
        this.session = {
          userId: user[0].uuid,
          username: user[0].username,
          apiKey: tokenCheck[0].api_key,
        };
        return await this.bot.sendMessage(chatId, `✅ Authentication successful!\nWelcome, ${user[0].username}.\nYou now have access to JudoDice administrative functions.`, { parse_mode: 'Markdown' });
      } else {
        return await this.bot.sendMessage(chatId, '❌ Invalid token. Please try again.');
      }
    } else {
      return await this.bot.sendMessage(chatId, '❌ Admin not found. Please check your username and try again.');
    }

    //console.log('User:', user);
  }
  async generateAuthLink(chatId) {
    try {
      // Tell user we're creating their auth link
      await this.bot.sendMessage(chatId, 'Generating your authentication link. Please enter your JudoDice admin username:', { reply_markup: { force_reply: true } });

      // Set up a one-time listener for the username response
      this.bot.onReplyToMessage(chatId, null, async (usernameMsg) => {
        const username = usernameMsg.text.trim();

        try {
          // Check if user exists and is admin
          const users = await this.db.query('SELECT uuid, username, isAdmin FROM accounts WHERE username = ?', [username]);

          if (!users || users.length === 0) {
            await this.bot.sendMessage(chatId, '❌ User not found. Please check your username and try again.');
            return;
          }

          const user = users[0];

          if (user.isAdmin !== 1) {
            await this.bot.sendMessage(chatId, '❌ Access denied: Admin privileges required');
            return;
          }

          // Generate API key
          const apiKey = crypto.randomBytes(32).toString('hex');

          // Store the API key
          await this.db.query(
            `
            INSERT INTO telegram_api_keys (uuid, api_key, created_at, status) 
            VALUES (?, ?, NOW(), 'active')
            ON DUPLICATE KEY UPDATE 
              api_key = VALUES(api_key),
              created_at = VALUES(created_at),
              status = VALUES(status)
          `,
            [user.uuid, apiKey],
          );

          // Generate the authentication link
          const timestamp = Math.floor(Date.now() / 1000);
          const signature = crypto.createHmac('sha256', apiKey).update(`${user.uuid}:${user.username}:${timestamp}`).digest('hex');

          const botUsername = this.bot.me.username;
          const authLink = `https://t.me/${botUsername}?start=auth_${user.uuid}_${timestamp}_${signature}`;

          // Send the authentication link
          await this.bot.sendMessage(chatId, `✅ Authentication link generated for ${user.username}!\n\nClick the link below to authenticate:\n${authLink}\n\nThis link will expire in 24 hours.`, {});
        } catch (error) {
          console.error('Auth link generation error:', error);
          await this.bot.sendMessage(chatId, '❌ Failed to generate authentication link. Please try again later.');
        }
      });
    } catch (error) {
      console.error('Failed to set up auth link generation:', error);
      await this.bot.sendMessage(chatId, '❌ An error occurred. Please try again later.');
    }
  }

  async handleAuthorizedCommand(message) {
    const chatId = message.chat.id;

    switch (message.text) {
      case '/start':
        await this.bot.sendMessage(chatId, `Welcome back, ${this.session.username}!\n\nAvailable commands:\n/status - Check system status\n/logout - End your session`, {});
        break;

      case '/status':
        try {
          // Get system status information
          const [usersResult] = await Promise.all([this.db.query('SELECT COUNT(*) as count FROM accounts')]);

          const statusMessage = `📊 *System Status*\n\n` + `Total Users: ${usersResult[0].count}\n` + `\nServer Time: ${new Date().toLocaleString()}`;

          await this.bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
        } catch (error) {
          console.error('Status error:', error);
          await this.bot.sendMessage(chatId, '❌ An error occurred while fetching system status.');
        }
        break;

      case '/logout':
        try {
          if (this.session) {
            // Update the API key status to revoked
            await this.db.query('UPDATE telegram_api_keys SET status = ? WHERE uuid = ? AND api_key = ?', ['revoked', this.session.userId, this.session.apiKey]);

            this.session = null;
          }

          await this.bot.sendMessage(chatId, 'You have been logged out. Thank you for using JudoDice Admin.', {});
        } catch (error) {
          console.error('Logout error:', error);
          await this.bot.sendMessage(chatId, '❌ An error occurred during logout.');
        }
        break;

      default:
        await this.bot.sendMessage(chatId, 'I do not understand that command. Try /start for a list of commands.', {});
        break;
    }
  }
}

module.exports = Commands;
