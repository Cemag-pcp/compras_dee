param(
    [string]$Url = "http://192.168.3.141/sistema",
    [string]$Username,
    [string]$Password,
    [string]$SimulationName = "Pendencia Diaria Carretas Compras",
    [int]$DefaultWaitMs = 3000,
    [int]$LongWaitMs = 5000,
    [string]$SessionName = "innovaro-cli-flow"
)

$ErrorActionPreference = "Stop"

if (-not $Username) {
    throw "Informe -Username."
}

if (-not $Password) {
    throw "Informe -Password."
}

function Invoke-PlaywrightCli {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    & npx --yes --package @playwright/cli playwright-cli @Arguments
}

function Invoke-RunCode {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Code
    )

    Invoke-PlaywrightCli -Arguments @("--session", $SessionName, "run-code", $Code)
}

function ConvertTo-JsStringLiteral {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    $escaped = $Value.Replace("\", "\\").Replace("'", "\'")
    return "'$escaped'"
}

Write-Host "Abrindo sessao Playwright: $SessionName"
Invoke-PlaywrightCli -Arguments @("--session", $SessionName, "open", $Url, "--headed")

$jsUsername = ConvertTo-JsStringLiteral -Value $Username
$jsPassword = ConvertTo-JsStringLiteral -Value $Password
$jsSimulationName = ConvertTo-JsStringLiteral -Value $SimulationName

$loginCode = @'
async page => {
  await page.getByRole("textbox", { name: "Usuário" }).fill(__USERNAME__);
  await page.waitForTimeout(500);
  await page.getByRole("textbox", { name: "Senha" }).fill(__PASSWORD__);
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByRole("button", { name: "Menu", exact: true }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(__LONG_WAIT__);
  return await page.title();
}
'@

$loginCode = $loginCode.Replace("__USERNAME__", $jsUsername)
$loginCode = $loginCode.Replace("__PASSWORD__", $jsPassword)
$loginCode = $loginCode.Replace("__LONG_WAIT__", $LongWaitMs)

$producaoCode = @"
async page => {
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.waitForTimeout($DefaultWaitMs);
  await page.getByText('Produção', { exact: true }).click();
  await page.waitForTimeout($DefaultWaitMs);
  await page.getByText('Plano mestre e simulação (MPS)', { exact: true }).click();
  await page.waitForTimeout($DefaultWaitMs);
  await page.getByText('Plano mestre e simulação', { exact: true }).click();
  await page.getByRole('tab', { name: /Plano mestre e simulação/i }).waitFor({ timeout: 30000 });
  await page.waitForTimeout($LongWaitMs);
  return await page.title();
}
"@

$searchSimulationCode = @'
async page => {
  const frame = page.frames()[1];
  const result = await frame.evaluate(async simulationName => {
    const process = window.Environment.getInstance().currentProcess;
    const grid = process.getGrid("grSimulacoes");
    grid.emit("search", {
      gridName: "grSimulacoes",
      fieldName: "NOME",
      searchValue: simulationName,
      allFields: false,
      preventDefault: false
    });
    await new Promise(resolve => setTimeout(resolve, 4000));
    return {
      bookmark: grid.bookmark,
      recNo: grid.recNo,
      clientRecNo: grid.clientRecNo
    };
  }, __SIMULATION_NAME__);
  await page.waitForTimeout(__LONG_WAIT__);
  return result;
}
'@

$searchSimulationCode = $searchSimulationCode.Replace("__SIMULATION_NAME__", $jsSimulationName)
$searchSimulationCode = $searchSimulationCode.Replace("__LONG_WAIT__", $LongWaitMs)

$pendenciaCode = @"
async page => {
  await page.getByRole('button').filter({ hasText: 'Pendência de Pedidos' }).click();
  await page.getByRole('button').filter({ hasText: 'Executa Busca de Pedidos' }).waitFor({ timeout: 30000 });
  await page.waitForTimeout($LongWaitMs);
  const frame = page.frames()[1];
  return await frame.evaluate(() => {
    const process = window.Environment.getInstance().currentProcess;
    return {
      interaction: process.currentInteractionName,
      grids: ['grFiltroDePedidos', 'wf-lookup-grid'].map(name => ({
        name,
        exists: !!process.getGrid(name)
      }))
    };
  });
}
"@

Write-Host "Fazendo login..."
Invoke-RunCode -Code $loginCode

Write-Host "Abrindo Produção > Plano mestre e simulação..."
Invoke-RunCode -Code $producaoCode

Write-Host "Pesquisando simulação alvo..."
Invoke-RunCode -Code $searchSimulationCode

Write-Host "Abrindo Pendência de Pedidos..."
Invoke-RunCode -Code $pendenciaCode

Write-Host "Fluxo validado até Pendência de Pedidos."
