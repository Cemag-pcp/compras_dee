# Automacao Innovaro com Playwright

Rebuild da automação do Innovaro usando Playwright, separado da base antiga em Selenium (`main.py`, na raiz do projeto).

A versão atual e mantida é a **v2** (`src/innovaro-automation-v2.js`), que usa a API interna do Innovaro
(`window.Environment...getGrid(nome)`) em vez de `document.querySelector`, mais robusta às mudanças de UI do ERP.
A v1 (`src/innovaro-automation.js`, `run-innovaro-cli.ps1`) foi a primeira tentativa e está mantida só como
referência histórica.

## O que a v2 faz

Login → simulação principal (especificação → pendência → explosão → relatório → grava "Recursos Utilizados" na
planilha DEE) → Saldos de Recursos → Análise de Pedidos Pendentes → volta pro plano mestre → simulação de
materiais indiretos (busca → explosão → relatório → grava "Recursos Utilizados" na planilha Requisitados).

## Pré-requisitos

1. `.env` na pasta `playwright-innovaro` (copie de `.env.example` e preencha usuário/senha do Innovaro).
2. `service_account_cemag.json` na raiz do projeto (um nível acima desta pasta) — acesso de Editor às planilhas
   no Google Drive da service account.
3. Dependências instaladas: `npm install`.
4. Navegador do Playwright instalado (só na primeira vez): `npm run install:browsers`.

## Como rodar

### Fluxo completo

```powershell
npm run start:v2
```

Roda tudo do login ao fim, na ordem descrita acima. O Chrome abre visível e fecha sozinho ao final (sucesso ou
erro). Cada etapa salva um screenshot em `output/playwright/` e o log completo fica em `output/logs/`.

### Por estágio (quando o ERP está instável e o erro só aparece numa etapa específica)

Rodar o fluxo inteiro só para chegar numa etapa do fim é lento. `src/run-stage.js` divide o fluxo em 4 estágios
**independentes** — cada um roda a partir de um login limpo, sem precisar repetir os anteriores:

```powershell
node src/run-stage.js <estagio>
# ou
npm run stage -- <estagio>
```

| Estágio | O que faz |
|---|---|
| `primeira-simulacao` | Simulação principal completa (especificação, pendência, explosão, relatório, Recursos Utilizados) |
| `saldos-recursos` | Saldos de Recursos - CEMAG |
| `analise-pedidos` | Análise de Pedidos Pendentes ou Baixados - CEMAG |
| `segunda-simulacao` | Simulação de materiais indiretos completa |

Listar as opções: `node src/run-stage.js --list`.

Isso funciona porque, a partir da grade Especificação em diante, cada navegação (Saldos, Análise de Pedidos, 2ª
simulação) é uma ida direta pelo menu — não depende de nada que outro estágio tenha feito na mesma sessão, só do
que já está persistido no próprio ERP (ex.: uma simulação já explodida continua explodida). Não dá pra fatiar
mais fino que isso com segurança: dentro de `primeira-simulacao`, os passos da grade Especificação são
sequenciais de verdade entre si.

### Codegen (gerar seletores explorando o ERP manualmente)

```powershell
npm run codegen
```

## Estrutura

- `src/index-v2.js`: ponto de entrada do fluxo completo (v2)
- `src/innovaro-automation-v2.js`: fluxo principal e todas as funções de navegação/extração (v2)
- `src/run-stage.js`: runner por estágio (v2)
- `src/reports.js`: tratamento de dados e gravação no Google Sheets
- `src/sheets-client.js`: cliente da API do Google Sheets/Drive
- `src/csv-utils.js`: parsing/formatação de CSV e conversão numérica BR
- `src/index.js`, `src/innovaro-automation.js`, `run-innovaro-cli.ps1`: v1 (Selenium→Playwright, legado)

## Planilhas atualizadas

- **DEE** (`Análise Previsão de Consumo (CMM / NTP ) DEE`, localizada por nome via `GOOGLE_SHEET_DEE_NAME`):
  abas `Dados Simulação` (Recursos Utilizados), `Est. Produção` (Saldos de Recursos), `Dados Pedidos` (Análise
  de Pedidos Pendentes).
- **Requisitados** (`Análise Previsão de Consumo (Materiais Custo Indireto "Requisitados")`, por ID fixo via
  `GOOGLE_SHEET_REQUISITADOS_ID`): aba `Dados Simulação` (Recursos Utilizados da 2ª simulação).
