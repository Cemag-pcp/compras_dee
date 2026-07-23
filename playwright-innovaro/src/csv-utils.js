const fs = require("fs/promises");

function stripExcelQuoting(value) {
  return String(value ?? "")
    .replace(/=/g, "")
    .replace(/"/g, "")
    .trim();
}

function parseInnovaroCsv(content) {
  const lines = content.split(/\r\n|\n/).filter((line) => line.length > 0);
  if (lines.length === 0) {
    return { headers: [], rows: [] };
  }

  const headers = lines[0].split(";").map(stripExcelQuoting);
  const rows = lines.slice(1).map((line) => line.split(";").map(stripExcelQuoting));

  return { headers, rows };
}

async function readInnovaroCsv(filePath) {
  const content = await fs.readFile(filePath, "latin1");
  return parseInnovaroCsv(content);
}

function rowsToObjects(headers, rows) {
  return rows.map((row) =>
    headers.reduce((acc, header, index) => {
      acc[header] = row[index] ?? "";
      return acc;
    }, {})
  );
}

// Inovaro exporta números em formato BR (ponto = separador de milhar,
// vírgula = decimal — ex.: "22.319,62"). Bug confirmado: a versão anterior só
// trocava a vírgula por ponto sem remover o separador de milhar, então
// "22.319,62" virava "22.319.62" -> NaN -> caía no fallback 0. Por isso só
// valores acima de 1.000 apareciam zerados na planilha.
function toBrNumber(value) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/\./g, "")
    .replace(",", ".");
  if (normalized === "") {
    return 0;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function applyNumericColumns(objects, columns) {
  for (const obj of objects) {
    for (const column of columns) {
      obj[column] = toBrNumber(obj[column]);
    }
  }
  return objects;
}

function objectsToMatrix(objects, columns) {
  return objects.map((obj) => columns.map((column) => obj[column] ?? ""));
}

function toCsvField(value) {
  const str = String(value ?? "");
  if (/[";\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function matrixToCsv(headers, matrix) {
  const lines = [headers.map(toCsvField).join(";")];
  for (const row of matrix) {
    lines.push(row.map(toCsvField).join(";"));
  }
  return lines.join("\r\n");
}

async function writeCsv(filePath, headers, matrix) {
  await fs.writeFile(filePath, matrixToCsv(headers, matrix), "utf8");
}

module.exports = {
  stripExcelQuoting,
  parseInnovaroCsv,
  readInnovaroCsv,
  rowsToObjects,
  toBrNumber,
  applyNumericColumns,
  objectsToMatrix,
  matrixToCsv,
  writeCsv
};
