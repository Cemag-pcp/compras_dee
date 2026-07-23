const path = require("path");
const { google } = require("googleapis");
const log = require("./logger");

const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive"
];

function getServiceAccountKeyPath() {
  return (
    process.env.GOOGLE_SERVICE_ACCOUNT_PATH ||
    path.join(__dirname, "..", "..", "service_account_cemag.json")
  );
}

let authClient = null;

function getAuth() {
  if (!authClient) {
    authClient = new google.auth.GoogleAuth({
      keyFile: getServiceAccountKeyPath(),
      scopes: SCOPES
    });
  }
  return authClient;
}

async function getSheetsApi() {
  return google.sheets({ version: "v4", auth: getAuth() });
}

async function getDriveApi() {
  return google.drive({ version: "v3", auth: getAuth() });
}

// Confirmado ao vivo: a troca do JWT da service account por access token
// (feita internamente pela lib `gtoken`, dependência do google-auth-library)
// já teve uma falha de rede pontual/transitória (timeout total ao bater em
// www.googleapis.com/oauth2/v4/token) que derrubou a automação inteira
// depois de ~1 minuto de trabalho no navegador já feito. O endpoint volta a
// responder normal logo em seguida (confirmado via curl), então não é um
// bloqueio permanente — só não havia nenhuma tolerância a soluço de rede
// pontual. Por isso as chamadas de rede ao Google (auth + Sheets/Drive) são
// envolvidas em retry com backoff.
async function withRetry(fn, { retries = 3, baseDelayMs = 3000, label = "" } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        const delay = baseDelayMs * attempt;
        log.warn(
          `[sheets-client] Falha${label ? ` em ${label}` : ""} (tentativa ${attempt}/${retries}): ${err.message}. Retentando em ${delay}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

const spreadsheetIdCache = new Map();

// Equivalente ao gspread `client.open(nome)`: busca a planilha pelo titulo no Drive da service account.
async function findSpreadsheetIdByName(name) {
  if (spreadsheetIdCache.has(name)) {
    return spreadsheetIdCache.get(name);
  }

  const fileId = await withRetry(
    async () => {
      const drive = await getDriveApi();
      const escapedName = name.replace(/'/g, "\\'");
      const response = await drive.files.list({
        q: `name = '${escapedName}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
        fields: "files(id, name)",
        pageSize: 5
      });

      const file = response.data.files?.[0];
      if (!file) {
        throw new Error(`Planilha "${name}" nao encontrada no Google Drive da service account.`);
      }
      return file.id;
    },
    { label: `findSpreadsheetIdByName("${name}")` }
  );

  spreadsheetIdCache.set(name, fileId);
  return fileId;
}

async function clearRange(spreadsheetId, sheetName, range) {
  await withRetry(
    async () => {
      const sheets = await getSheetsApi();
      await sheets.spreadsheets.values.clear({
        spreadsheetId,
        range: `'${sheetName}'!${range}`
      });
    },
    { label: `clearRange(${sheetName}!${range})` }
  );
}

async function updateRange(spreadsheetId, sheetName, range, values) {
  await withRetry(
    async () => {
      const sheets = await getSheetsApi();
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `'${sheetName}'!${range}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values }
      });
    },
    { label: `updateRange(${sheetName}!${range})` }
  );
}

module.exports = {
  findSpreadsheetIdByName,
  clearRange,
  updateRange
};
