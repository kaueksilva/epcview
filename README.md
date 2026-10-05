# EPCVIEW — Engineering Intelligence

Duas partes num só servidor:

- **Site público** em `/` — página institucional (soluções, plataforma,
  projetos, sobre) com formulário "Solicite uma demonstração". Não exige login.
- **Painel** (a partir de `/login.html`) — onde administradores montam painéis
  em JavaScript sobre as planilhas da obra, publicam, e a equipe abre prontos.

Derivado do UHNIntegra 2: mesmas funções do painel, com a identidade visual
EPCVIEW (paleta e tokens em `static/style.css`).

## Como rodar

```bash
node server.js
```

Sem dependências e sem `npm install` — só Node.js. Site em http://localhost:8000,
painel em http://localhost:8000/login.html.

Na primeira execução o sistema cria o usuário `admin` e **imprime a senha no
console uma única vez**. Anote: ela não é exibida de novo. Não há credencial
padrão embutida no código.

## Quem faz o quê

| | Visualizador | Administrador |
|---|---|---|
| Abrir painéis | ✅ | ✅ |
| Ver planilhas | ✅ | ✅ |
| Criar e editar painéis | — | ✅ |
| Enviar e remover planilhas | — | ✅ |
| Gerenciar usuários | — | ✅ |

O menu lateral e os botões se ajustam ao papel, e o servidor recusa por conta
própria — esconder o botão nunca é a única proteção.

## Telas

| Tela | Caminho | Para quem |
|---|---|---|
| Site institucional | `/` (arquivos em `static/site/`) | público |
| Login | `/login.html` | todos |
| Dashboards | `/lista_dashboards.html` | todos |
| Ver painel | `/viewer.html?id=<id>` | todos |
| Editor | `/index.html` | admin |
| Planilhas | `/planilhas.html` | todos (envio: admin) |
| Usuários | `/usuarios.html` | admin |
| Contatos | `/contatos.html` | admin |
| Dockers | `/dockers.html` | admin |

## Site público

```
static/site/index.html   a página (seções e textos)
static/site/site.css     estilos próprios do site (usa os tokens de static/style.css)
static/site/site.js      menu móvel, formulário, vídeo, animações
static/site/img/         fotos — ver LEIA-ME.md com os nomes esperados
static/site/video/       apresentacao.mp4 (botão "Assista ao vídeo")
```

Sem fotos, o site usa degradês e uma ilustração vetorial — nada quebra. Para usar
as fotos do designer, basta salvar em `static/site/img/` com os nomes listados em
`static/site/img/LEIA-ME.md`.

O formulário de contato grava em `data/contatos.json` (fora do git: dados
pessoais) e aparece na tela **Contatos** do painel. Proteções: validação e
teto de tamanho por campo, campo-armadilha contra robôs, 5 envios por IP a cada
10 min e no máximo 5.000 contatos guardados.

> No plano free do Render o disco é efêmero: `data/contatos.json` some a cada
> deploy/reinício. Leia os contatos com frequência ou ative o Persistent Disk
> (bloco `disk:` em `render.yaml`).

## Montando um painel

**1. Escolha as planilhas.** No editor, clique em *Escolher planilhas* e marque
as que o painel usa. Você vê as colunas já normalizadas antes de escrever
qualquer linha — `Avanço Físico (%)` aparece como `avanco_fisico`.

**2. Use os dados.** O que foi marcado chega pronto, sem `await` e sem saber o
nome do arquivo:

```js
const linhas = dados.P21;          // planilha escolhida no seletor
const colunas = Object.keys(linhas[0] || {});
```

**3. Execute e publique.** `Ctrl+Enter` roda no preview ao lado; `Ctrl+S`
publica para todo mundo.

Precisa de algo fora da lista? `await consultar('P30')` continua funcionando e
aceita `'P30'`, `'planilha_30'`, `'30'` ou o nome do arquivo.

Disponíveis no código: `dados`, `consultar()`, `UHN`, `Plotly`, `XLSX` e o
elemento `#dash-root` onde o painel é renderizado.

## Atalhos

| Atalho | Ação |
|---|---|
| `Ctrl+Enter` | executar no preview |
| `Ctrl+S` | publicar |
| `Esc` | fechar painéis e modais |
| `F` (no viewer) | tela cheia |

## Onde ficam os dados

```
data/database.json   usuários, grupos e painéis publicados
data/contatos.json   pedidos do formulário do site (fora do git)
lib/r2.js            cliente do Cloudflare R2 — onde as planilhas moram
static/              as páginas
lib/db.js            camada de acesso ao banco
backup/              material de versões anteriores — fora do git
```

O `database.json` é gravado de forma atômica (escreve num `.tmp` e renomeia), e
as gravações são serializadas numa fila — dois pedidos simultâneos não se
sobrescrevem. As senhas são guardadas com `scrypt` e salt por usuário; o hash
nunca sai nas respostas da API.

**Planilhas ficam no Cloudflare R2**, não no disco: são dados de obra, pesam
dezenas de MB e mudam a cada medição — versioná-las no git criaria uma cópia
nova para sempre no histórico. O R2 é um balde único (plano free, 10GB)
acessado tanto local quanto do Render, então local e hospedado sempre veem as
mesmas planilhas e nada some entre deploys/reinícios. Configure as 4
variáveis `R2_*` num `.env` local (copie de `.env.example`) e, no Render, no
painel do serviço em Environment — nunca commitar essas credenciais.

**O que vai para o git:** o código e o `database.json` (painéis e usuários).
No plano gratuito do Render, o disco é efêmero: qualquer painel criado pela
tela que não for commitado de volta no `database.json` se perde no próximo
deploy/reinício. As planilhas não têm esse problema porque vivem no R2.

## Painéis já publicados

| Painel | Planilhas |
|---|---|
| Dashboard Executivo UHN | P21–P24, P27, P28 |
| Painel Financeiro Executivo | P21, P22, P39–P43 |
| Painel Executivo de SMS | P31–P36 |

O painel de SMS foi traduzido de Streamlit/Altair/pandas para JavaScript. Ele
exige as planilhas **P31 a P36**, que ainda não estão em `planilhas/`; até lá
exibe um aviso pedindo a importação, sem quebrar. Para vê-lo com dados
fictícios:

```bash
cp "backup/planilhas-exemplo-sms/"*.xlsx planilhas/
```

Esses arquivos são **dados de teste**, não da obra — remova antes de subir os reais.

## Arquitetura

Existe **um** runtime, não um HTML por painel:

```
data/database.json ──> viewer.html ──postMessage──> sandbox.html
                                                        │
                        assets/uhn-runtime.js ──────────┘
                        (consultar / cache / normalização)
```

O editor usa o mesmo `sandbox.html` no preview, então o que você vê enquanto
escreve é o que a equipe recebe. O código nunca é interpolado em string: vai por
`postMessage`, o que permite usar crase e `${}` livremente no painel.

## API

| Método | Rota | Quem |
|---|---|---|
| `POST` | `/api/sessao/login` · `/logout` | todos |
| `GET` | `/api/sessao/eu` | autenticado |
| `GET` | `/api/dashboards` · `/:id` | autenticado |
| `POST`/`DELETE` | `/api/dashboards` · `/:id` | admin |
| `GET` | `/api/planilhas` · `/:nome` | autenticado |
| `POST`/`DELETE` | `/api/planilhas/:nome` | admin |
| `GET`/`POST`/`PUT`/`DELETE` | `/api/usuarios` · `/:id` | admin |
| `POST` | `/api/contato` | **público** (formulário do site) |
| `GET` · `PATCH`/`DELETE` | `/api/contatos` · `/:id` | admin |

## Segurança

Já tratado: sessão em cookie `httpOnly` + `SameSite=Lax`; senhas com `scrypt` e
comparação em tempo constante; path traversal bloqueado nos estáticos, nos ids
de painel e nos nomes de planilha; upload restrito a `.xlsx/.xls/.csv`; limites
de corpo (4 MB para painéis, 60 MB para planilhas); títulos renderizados com
`textContent`.

Dois pontos a considerar antes de expor fora da rede interna:

- **Um painel é código** que roda no navegador de quem o abrir. Só
  administradores publicam, e é por isso que esse papel deve ser restrito.
- **`/api/contato` é a única escrita sem login.** Tem limites (ver "Site
  público"), mas o limite por IP confia em `X-Forwarded-For`, que só é
  confiável atrás de um proxy (como o do Render).
- **O servidor fala HTTP puro.** Em rede aberta, coloque-o atrás de um proxy
  com TLS — sem HTTPS, a senha trafega em texto claro.
