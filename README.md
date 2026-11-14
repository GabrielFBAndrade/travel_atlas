# Atlas de Bolso

Planejador de viagens com IA (Claude): roteiro dia a dia com várias cidades e países, trechos entre cidades, custos em dólar, mapa com ruas reais (OpenStreetMap), guia do país com contatos de emergência e volta para casa. Funciona no computador e no celular, e pode ser instalado na tela de início do iPhone.

Hospedado de graça na **Cloudflare Workers**. O único custo é o uso da API do Claude (centavos por roteiro).

---

## Configuração (uma vez só)

### 1. Cloudflare: build
Em **Workers & Pages → travel-atlas → Settings → Build**:

| Campo | Valor |
|---|---|
| Build command | *(vazio)* |
| Deploy command | `npx wrangler deploy` |
| Root directory | `/` |

### 2. Cloudflare: secrets
Em **Workers & Pages → travel-atlas → Settings → Variables and Secrets → Add**, crie dois itens do tipo **Secret**:

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | sua chave da API (começa com `sk-ant-`) |
| `ACCESS_CODE` | o código que o app vai pedir para entrar (escolha um difícil de adivinhar) |

A chave nunca vai para o navegador nem para este repositório.

### 3. Claude Console: limite de gasto
Em **platform.claude.com → Settings → Limits**, defina um limite mensal (ex.: US$ 5).

### 4. iPhone
Abra o endereço do app no **Safari** → **Compartilhar** → **Adicionar à Tela de Início**.

---

## Como funciona o uso de tokens

O servidor decide o modelo e o tamanho máximo de cada resposta; o navegador só escolhe a tarefa.

| Tarefa | Modelo | Quando roda |
|---|---|---|
| Roteiro de cada cidade | Sonnet 5.5 | Ao montar o roteiro (1 chamada por cidade, em paralelo) |
| Trechos entre cidades | Sonnet 5.5 | 1 chamada para todos os trechos |
| Guia do país (com busca na web) | Haiku 5.5 | Só quando você abre o guia |
| Comida, fotos e descanso | Haiku 5.5 | Só quando você abre a parada |
| Sugerir / localizar lugares | Haiku 5.5 | Sob demanda |
| Ordem, horários, distâncias, dólar | — | Calculado no navegador, 0 tokens |

Respostas ficam guardadas no aparelho por 1 a 30 dias: repetir um pedido não gasta tokens. O contador no topo do app mostra chamadas, tokens e o custo estimado.

Para economizar ainda mais, troque `MODEL_MAIN` por `claude-haiku-5-5` em `wrangler.jsonc`.

---

## Estrutura

```
public/            site (servido direto pela Cloudflare, sem custo)
  index.html       o app inteiro
  sw.js            service worker (abre offline com roteiros salvos)
  manifest.webmanifest, icons/
src/worker.js      backend: /api/claude, /api/ping, /api/fx
wrangler.jsonc     configuração da Cloudflare
```

## Atualizações
Todo envio (`push`) para a branch `main` publica sozinho em cerca de 1 minuto.

Dados de mapa © OpenStreetMap, tiles © CARTO. Cotação: ExchangeRate-API.
