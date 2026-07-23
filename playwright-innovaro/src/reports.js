const log = require("./logger");
const {
  readInnovaroCsv,
  rowsToObjects,
  applyNumericColumns,
  objectsToMatrix
} = require("./csv-utils");
const { findSpreadsheetIdByName, clearRange, updateRange } = require("./sheets-client");

const SHEET_DEE_NAME =
  process.env.GOOGLE_SHEET_DEE_NAME || "Análise Previsão de Consumo (CMM / NTP ) DEE";
const SHEET_REQUISITADOS_ID =
  process.env.GOOGLE_SHEET_REQUISITADOS_ID || "1PjcZ9uCXYBNYg1s0TSaYIEkSy2zdVBEoCtBMP3H9KPo";

// Aba "Dados Simulação" da planilha DEE: cabeçalho real confirmado vai até a
// coluna N (E2:N, 10 colunas) — Recurso, Unid., Média 3M, CMA, Simulado,
// Qtd.Est., Pedidos Pend., Saldo, Cust.Unit., TRP. A coluna "DEE" do
// CSV/tabela de origem é desconsiderada (não é escrita na planilha). As
// chaves abaixo usam o nome como ele sai da tabela/CSV de origem (ex.:
// "Média", "Ped.Pend."), não o texto do cabeçalho da planilha — a escrita é
// posicional (matriz a partir de E2), então só a ORDEM precisa bater com as
// colunas da aba.
const RECURSOS_COLUMNS_DEE = [
  "Recurso",
  "Unid.",
  "Média",
  "CMA",
  "Simulado",
  "Qtd.Est.",
  "Ped.Pend.",
  "Saldo",
  "Cust.Unit.",
  "TRP"
];
const RECURSOS_NUMERIC_COLUMNS_DEE = [
  "Média",
  "CMA",
  "Simulado",
  "Qtd.Est.",
  "Ped.Pend.",
  "Saldo",
  "Cust.Unit.",
  "TRP"
];

// Aba "Dados Simulação" da planilha "Requisitados" (Materiais Custo
// Indireto): só 9 colunas (E2:M), sem TRP/DEE — confirmado no fluxo antigo
// (main_copy.py, bloco da segunda simulação).
const RECURSOS_COLUMNS_REQUISITADOS = [
  "Recurso",
  "Unid.",
  "Média",
  "CMA",
  "Simulado",
  "Qtd.Est.",
  "Ped.Pend.",
  "Saldo",
  "Cust.Unit."
];
const RECURSOS_NUMERIC_COLUMNS_REQUISITADOS = [
  "Média",
  "CMA",
  "Simulado",
  "Qtd.Est.",
  "Ped.Pend.",
  "Saldo",
  "Cust.Unit."
];

const SALDOS_COLUMNS = [
  "1o. Agrupamento",
  "",
  "Depósito",
  "Recurso#Classe",
  "Recurso#Unid. Medida",
  "Saldo",
  "Custo#Total",
  "Custo#Médio"
];
const SALDOS_NUMERIC_COLUMNS = ["Saldo"];

const PEDIDOS_RENAME_MAP = {
  "1o. Agrupamento": "Região",
  "2o. Agrupamento": "Estado",
  "3o. Agrupamento": "Pessoa",
  "4o. Agrupamento": "Classe Recurso",
  "5o. Agrupamento": "Data Entrega",
  "Chave ¹   Ch Criação ²": "Chave ¹ Ch Criação ²"
};
const PEDIDOS_DROP_COLUMNS = ["Baixa", "Movimentação", "DP", "Tipo", "Número", "Qde Baixa", "Op. Vinculada"];
const PEDIDOS_FINAL_COLUMNS = [
  "Região",
  "Estado",
  "Pessoa",
  "Classe Recurso",
  "Data Entrega",
  "Chave ¹ Ch Criação ²",
  "Emissão",
  "Dias Entrega",
  "Classe",
  "Estabelecimento",
  "Loc Escrit",
  "Recurso",
  "Observação",
  "Núcleo",
  "Qde Ped",
  "Unitário",
  "Desc Venda",
  "% Venda",
  "Desc Item",
  "% Item",
  "Total",
  "Qde Atend",
  // Confirmado ao vivo (2026-07-02): a aba "Dados Pedidos" tem 24 colunas
  // em B:Y, não 23 — faltava "Qde Canc" aqui, entre "Qde Atend" e "Qde
  // Pend". Sem ela, cada gravação desalinhava tudo a partir daqui: o valor
  // de "Qde Pend" ia parar na coluna "Qde Canc" e "Qde Pend" ficava vazio.
  "Qde Canc",
  "Qde Pend"
];
const PEDIDOS_NUMERIC_COLUMNS = ["Qde Ped", "Qde Pend", "Unitário", "Total"];

function renameHeaders(headers, renameMap) {
  return headers.map((header) => renameMap[header] || header);
}

// Computação pura (sem chamar o Sheets) — separada para poder ser usada
// também em inspeção/debug (ex.: imprimir no console antes de gravar).
function buildRecursosUtilizadosMatrix(headers, rows, { columns, numericColumns }) {
  const objects = applyNumericColumns(rowsToObjects(headers, rows), numericColumns);
  const matrix = objectsToMatrix(objects, columns);
  return { objects, matrix };
}

async function writeRecursosUtilizadosMatrix(spreadsheetId, headers, rows, options) {
  const { matrix } = buildRecursosUtilizadosMatrix(headers, rows, options);

  await clearRange(spreadsheetId, "Dados Simulação", options.clearRangeRef);
  await updateRange(spreadsheetId, "Dados Simulação", options.startCell, matrix);
}

async function updatePlanilhaRecursosUtilizados(csvPath) {
  log.step("Atualização: aba Dados Simulação (Recursos Utilizados)");
  const { headers, rows } = await readInnovaroCsv(csvPath);
  const spreadsheetId = await findSpreadsheetIdByName(SHEET_DEE_NAME);
  await writeRecursosUtilizadosMatrix(spreadsheetId, headers, rows, {
    columns: RECURSOS_COLUMNS_DEE,
    numericColumns: RECURSOS_NUMERIC_COLUMNS_DEE,
    clearRangeRef: "E2:N",
    startCell: "E2"
  });
  log.done("Atualização: aba Dados Simulação (Recursos Utilizados)");
}

// Equivalente a updatePlanilhaRecursosUtilizados, mas para quando os dados já
// foram extraídos direto do DOM (v2/Playwright) em vez de lidos de um CSV
// exportado — headers/rows no mesmo formato que readInnovaroCsv produziria.
async function updatePlanilhaRecursosUtilizadosFromRows(headers, rows) {
  log.step("Atualização: aba Dados Simulação (Recursos Utilizados, via DOM v2)");
  const spreadsheetId = await findSpreadsheetIdByName(SHEET_DEE_NAME);
  await writeRecursosUtilizadosMatrix(spreadsheetId, headers, rows, {
    columns: RECURSOS_COLUMNS_DEE,
    numericColumns: RECURSOS_NUMERIC_COLUMNS_DEE,
    clearRangeRef: "E2:N",
    startCell: "E2"
  });
  log.done("Atualização: aba Dados Simulação (Recursos Utilizados, via DOM v2)");
}

async function updateSaldoRecursos(csvPath) {
  log.step("Atualização: aba Est. Produção (Saldos de Recursos)");
  const { headers, rows } = await readInnovaroCsv(csvPath);
  const objects = applyNumericColumns(rowsToObjects(headers, rows), SALDOS_NUMERIC_COLUMNS);
  const matrix = objectsToMatrix(objects, SALDOS_COLUMNS);

  const spreadsheetId = await findSpreadsheetIdByName(SHEET_DEE_NAME);
  await clearRange(spreadsheetId, "Est. Produção", "N3:U");
  await updateRange(spreadsheetId, "Est. Produção", "N3", matrix);
  log.done("Atualização: aba Est. Produção (Saldos de Recursos)");
}

// Equivalente a updateSaldoRecursos, mas para quando os dados já foram
// extraídos direto do DOM (v2/Playwright, ver extractSaldosDeRecursosTable
// em innovaro-automation-v2.js). Cabeçalho real de "Est. Produção"!N3:U
// confirmado ao vivo (2026-07-02) via API do Sheets — bate exatamente com
// SALDOS_COLUMNS (8 colunas, N a U), sem o problema de coluna faltante já
// visto em PEDIDOS_FINAL_COLUMNS ("Qde Canc").
function buildSaldoRecursosMatrix(headers, rows) {
  const objects = applyNumericColumns(rowsToObjects(headers, rows), SALDOS_NUMERIC_COLUMNS);
  const matrix = objectsToMatrix(objects, SALDOS_COLUMNS);
  return { objects, matrix };
}

async function updateSaldoRecursosFromRows(headers, rows) {
  log.step("Atualização: aba Est. Produção (Saldos de Recursos, via DOM v2)");

  const { matrix } = buildSaldoRecursosMatrix(headers, rows);

  const spreadsheetId = await findSpreadsheetIdByName(SHEET_DEE_NAME);
  await clearRange(spreadsheetId, "Est. Produção", "N3:U");
  await updateRange(spreadsheetId, "Est. Produção", "N3", matrix);
  log.done("Atualização: aba Est. Produção (Saldos de Recursos, via DOM v2)");
}

async function updateAnalisePedidosPendentes(csvPath) {
  log.step("Atualização: aba Dados Pedidos (Análise de Pedidos)");
  const { headers, rows } = await readInnovaroCsv(csvPath);
  const renamedHeaders = renameHeaders(headers, PEDIDOS_RENAME_MAP);

  let objects = rowsToObjects(renamedHeaders, rows);
  objects = objects.map((obj) => {
    const filtered = { ...obj };
    for (const column of PEDIDOS_DROP_COLUMNS) {
      delete filtered[column];
    }
    return filtered;
  });
  objects = applyNumericColumns(objects, PEDIDOS_NUMERIC_COLUMNS);
  const matrix = objectsToMatrix(objects, PEDIDOS_FINAL_COLUMNS);

  const spreadsheetId = await findSpreadsheetIdByName(SHEET_DEE_NAME);
  await clearRange(spreadsheetId, "Dados Pedidos", "B2:Y");
  await updateRange(spreadsheetId, "Dados Pedidos", "B2", matrix);
  log.done("Atualização: aba Dados Pedidos (Análise de Pedidos)");
}

// Equivalente a updateAnalisePedidosPendentes, mas para quando os dados já
// foram extraídos direto do DOM (v2/Playwright, ver
// extractAnalisePedidosPendentesTable em innovaro-automation-v2.js) em vez
// de lidos de um CSV exportado. A extração via DOM já produz os headers dos
// 5 níveis de agrupamento com o nome final ("Região", "Estado", "Pessoa",
// "Classe Recurso", "Data Entrega") e os headers de coluna já normalizados
// (via innerText, que respeita quebras de linha <br> como espaço — ao
// contrário de textContent), então nenhum renomeio (PEDIDOS_RENAME_MAP) é
// necessário aqui.
// Computação pura (sem chamar o Sheets) — separada para poder ser usada
// também em inspeção/debug antes de gravar de fato (mesmo padrão de
// buildRecursosUtilizadosMatrix).
function buildAnalisePedidosPendentesMatrix(headers, rows) {
  const objects = applyNumericColumns(rowsToObjects(headers, rows), PEDIDOS_NUMERIC_COLUMNS);
  const matrix = objectsToMatrix(objects, PEDIDOS_FINAL_COLUMNS);
  return { objects, matrix };
}

async function updateAnalisePedidosPendentesFromRows(headers, rows) {
  log.step("Atualização: aba Dados Pedidos (Análise de Pedidos, via DOM v2)");

  const { matrix } = buildAnalisePedidosPendentesMatrix(headers, rows);

  const spreadsheetId = await findSpreadsheetIdByName(SHEET_DEE_NAME);
  await clearRange(spreadsheetId, "Dados Pedidos", "B2:Y");
  await updateRange(spreadsheetId, "Dados Pedidos", "B2", matrix);
  log.done("Atualização: aba Dados Pedidos (Análise de Pedidos, via DOM v2)");
}

async function updateAnalisePedidosMateriaisCustoIndireto(csvPath) {
  log.step("Atualização: aba Dados Simulação (Materiais Custo Indireto)");
  const { headers, rows } = await readInnovaroCsv(csvPath);
  await writeRecursosUtilizadosMatrix(SHEET_REQUISITADOS_ID, headers, rows, {
    columns: RECURSOS_COLUMNS_REQUISITADOS,
    numericColumns: RECURSOS_NUMERIC_COLUMNS_REQUISITADOS,
    clearRangeRef: "E2:M",
    startCell: "E2"
  });
  log.done("Atualização: aba Dados Simulação (Materiais Custo Indireto)");
}

// Equivalente a updateAnalisePedidosMateriaisCustoIndireto, mas para quando
// os dados já foram extraídos direto do DOM (v2/Playwright, ver
// saveRecursosUtilizadosMatIndireto em innovaro-automation-v2.js) em vez de
// lidos de um CSV exportado.
async function updateAnalisePedidosMateriaisCustoIndiretoFromRows(headers, rows) {
  log.step("Atualização: aba Dados Simulação (Materiais Custo Indireto, via DOM v2)");
  await writeRecursosUtilizadosMatrix(SHEET_REQUISITADOS_ID, headers, rows, {
    columns: RECURSOS_COLUMNS_REQUISITADOS,
    numericColumns: RECURSOS_NUMERIC_COLUMNS_REQUISITADOS,
    clearRangeRef: "E2:M",
    startCell: "E2"
  });
  log.done("Atualização: aba Dados Simulação (Materiais Custo Indireto, via DOM v2)");
}

module.exports = {
  updatePlanilhaRecursosUtilizados,
  updatePlanilhaRecursosUtilizadosFromRows,

  // Computação pura (sem Sheets) usada para inspecionar/depurar o resultado
  // do tratamento (conversão numérica) antes de gravar de fato.
  buildRecursosUtilizadosMatrix,
  RECURSOS_COLUMNS_DEE,
  RECURSOS_NUMERIC_COLUMNS_DEE,
  RECURSOS_COLUMNS_REQUISITADOS,
  RECURSOS_NUMERIC_COLUMNS_REQUISITADOS,

  updateSaldoRecursos,
  updateSaldoRecursosFromRows,

  // Computação pura (sem Sheets) usada para inspecionar/depurar o resultado
  // antes de gravar de fato (mesmo padrão de buildRecursosUtilizadosMatrix).
  buildSaldoRecursosMatrix,
  SALDOS_COLUMNS,
  SALDOS_NUMERIC_COLUMNS,

  updateAnalisePedidosPendentes,
  updateAnalisePedidosPendentesFromRows,

  // Computação pura (sem Sheets) usada para inspecionar/depurar o resultado
  // do tratamento antes de gravar de fato (mesmo padrão de
  // buildRecursosUtilizadosMatrix).
  buildAnalisePedidosPendentesMatrix,
  PEDIDOS_FINAL_COLUMNS,
  PEDIDOS_NUMERIC_COLUMNS,

  updateAnalisePedidosMateriaisCustoIndireto,
  updateAnalisePedidosMateriaisCustoIndiretoFromRows
};
