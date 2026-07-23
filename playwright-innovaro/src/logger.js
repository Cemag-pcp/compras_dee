const fs = require("fs");
const path = require("path");

const LOG_DIR = path.join(process.cwd(), "output", "logs");
const LOG_FILE = path.join(LOG_DIR, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);

let logFileReady = false;

function ensureLogDir() {
  if (!logFileReady) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    logFileReady = true;
  }
}

function formatLine(level, message) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 23);
  return `[${ts}] [${level.padEnd(5)}] ${message}`;
}

function writeToFile(line) {
  try {
    ensureLogDir();
    fs.appendFileSync(LOG_FILE, line + "\n", "utf8");
  } catch (_) {}
}

function info(message) {
  const line = formatLine("INFO", message);
  console.log(line);
  writeToFile(line);
}

function warn(message) {
  const line = formatLine("WARN", message);
  console.warn(line);
  writeToFile(line);
}

function error(message) {
  const line = formatLine("ERROR", message);
  console.error(line);
  writeToFile(line);
}

function step(name) {
  const line = formatLine("STEP", `>>> ${name}`);
  console.log(line);
  writeToFile(line);
}

function done(name) {
  const line = formatLine("DONE", `<<< ${name}`);
  console.log(line);
  writeToFile(line);
}

function getLogFilePath() {
  return LOG_FILE;
}

module.exports = { info, warn, error, step, done, getLogFilePath };
