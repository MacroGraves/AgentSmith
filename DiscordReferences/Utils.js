const Crypto = require("crypto-js");
const Config = require('./Config.json');
async function isOnWindows() {
  return process.platform === 'win32';
}
async function Connection(MySQL, connection) {
  var isWindows = await isOnWindows();
  // If is windows create a connection where the host is localhost otherwise have the socket path set instead
  if (isWindows) {
    connection = await MySQL.createConnection({
      host: Config.mysql.host,
      user: Config.mysql.user,
      password: Config.mysql.password,
      database: Config.mysql.database,
    });
  } else {
    connection = await MySQL.createConnection({
      socketPath: Config.mysql.socketPath,
      user: Config.mysql.user,
      password: Config.mysql.password,
      database: Config.mysql.database,
    });
  }
  return connection;
}

var nBits = 52; // Most significant value is 52
// Helper function to determine if the string has a character
function HasChar(input, n) {
  return input.includes(n);
}
// Helper function to return a clean url without ?
function SplitShiftChar(input, n) {
  return input.split(n).shift();
}
// Helper function to capatalise the first letter
function Capitalise(input) {
  return input.charAt(0).toUpperCase() + input.slice(1);
}
// Helper function to allow for a clean closure of the node and provide a reason for doing so
function Closure(Error, Throw) {
  if (!Throw) console.log(Error);
  else console.error(Error);
  process.exit(0);
}
function AppendProperty(object, property, value, writable = true, enumerable = true, configurable = true) {
  Object.defineProperty(object, 'newProperty', {
    value: value,
    writable: writable,
    enumerable: enumerable,
    configurable: configurable,
  });
  return object;
}
function Result(input1, input2, nonce, gameType, edge = 100, faces = 6) {
  const combinedString = input1 + '|' + input2 + '|' + nonce;
  const hash = Crypto.SHA256(combinedString).toString();
  const hashHex = hash.slice(0, nBits / 4);
  const r = parseInt(hashHex, 16);
  edge = edge == 100 ? 100 : 100 - edge;
  const X = edge / (1 - r / Math.pow(2, nBits));
  const result = Math.floor(X);

  switch (gameType) {
    case 'dice':
      return (result % faces) + 1;
    case 'lottery':
      return (result % 100) + 1;
    default:
      return Math.max(1, result / 100);
  }
}
function QwikResult(input, nonce) {
  const combinedString = input + '|' + nonce;
  const hash = Crypto.SHA256(combinedString).toString();
  const hashHex = hash.slice(0, nBits / 4);
  const r = parseInt(hashHex, 16);
  const X = 100 / (1 - r / Math.pow(2, nBits));
  const result = Math.floor(X);
  return (result % 3) + 1;
}
function Hash_It(input) {
  return Crypto.SHA256(input).toString(Crypto.enc.Hex) ?? 'No Hash';
}
// Return the pbkdf2 Encryption using Password, Username, Salt, Encryption type and length as an encryption base
function pbkdf2(username, password, passwordSalt, iterations, length) {
  var salt = passwordSalt + username;
  var iv = crypto.pbkdf2Sync(password, salt, iterations, length, settings.cryptography.encryption);
  var hash = iv.toString('hex').toUpperCase().substring(0, length);
  return hash;
}
async function Deny_If_Not_Staff(interaction) {
  const StaffRole = interaction.guild.roles.cache.get(Config.Discord.Staff_Role);
  return !interaction.member.roles.cache.has(StaffRole.id) ? interaction.reply('You do not have the required role to use this command.') : null;
}
module.exports = {
  //Return the functions.
  HasChar: HasChar,
  Hash_It: Hash_It,
  SplitShiftChar: SplitShiftChar,
  Closure: Closure,
  Capitalise: Capitalise,
  AppendProperty: AppendProperty,
  Result: Result,
  QwikResult: QwikResult,
  Deny_If_Not_Staff: Deny_If_Not_Staff,
  Connection: Connection,
};
