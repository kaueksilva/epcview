# EPCVIEW — Engineering Intelligence

O sistema serve para duas coisas: **subir as planilhas da obra** e **montar
dashboards sobre elas**. Num só servidor:

- **Site público** em `/` — página institucional (soluções, plataforma,
  projetos, sobre). Não exige login.
- **Painel** (a partir de `/login.html`) — administradores enviam planilhas e
  montam painéis em JavaScript sobre elas; a equipe abre os painéis prontos.

Derivado do UHNIntegra 2: mesmas funções do painel, com a identidade visual
EPCVIEW (paleta e tokens em `static/style.css`).

## Como rodar

```bash
npm install          # única dependência: mysql2
cp .env.example .env # e preencha DB_HOST, DB_NAME, DB_USER, DB_PASSWORD
npm start
```

Painel em http://localhost:8000/login.html · site público em http://localhost:8000/.

Tudo fica num banco **MySQL/MariaDB** — o mesmo da Hostinger. Rodando no seu
computador, o sistema conecta no banco de produção pela rede, então local e
hospedado veem exatamente os mesmos usuários, painéis e planilhas. As tabelas
são criadas sozinhas na primeira execução.

Para conectar do seu computador, a Hostinger precisa liberar o acesso remoto:
**hPanel → Bancos de dados → MySQL remoto** → adicione o seu IP (ou `%` para
qualquer IP) no banco `u504642026_epc`. O host a usar em `DB_HOST` aparece na
mesma tela (algo como `srv1234.hstgr.io` ou um IP).

> Para desligar o site público, defina `SITE_PUBLICO=0` no `.env` (ou nas
> variáveis da hospedagem): a raiz `/` passa a levar ao login (ou aos
> dashboards, com sessão), `/site/` responde 404 e os links "Voltar ao site" /
> "Ver site público" ficam ocultos.

Com o banco vazio, o sistema cria o usuário `admin` e **imprime a senha no
console uma única vez**. Anote: ela não é exibida de novo. Não há credencial
padrão embutida no código.

### Deploy na Hostinger

App Node.js no hPanel, apontando para este repositório, com:

| Campo | Valor |
|---|---|
| Comando de build | `npm install` |
| Arquivo de entrada / start | `server.js` / `npm start` |
| Node | 20 ou mais novo |
| Variáveis | `DB_HOST=localhost`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` |

A porta vem da variável `PORT` que a Hostinger define. Nada fica no disco do
servidor — um novo deploy não apaga painéis, usuários nem planilhas.

## Quem faz o quê

| | Visualizador | Administrador |
|---|---|---|
| Abrir painéis | ✅ | ✅ |
| Ver planilhas | ✅ | ✅ |
| Baixar e exportar planilhas, ver o histórico | ✅ | ✅ |
| Trocar a própria senha (Minha conta) | ✅ | ✅ |
| Criar, editar, duplicar e excluir painéis | — | ✅ |
| Enviar, remover e restaurar versões de planilhas | — | ✅ |
| Gerenciar usuários e grupos | — | ✅ |

O menu lateral e os botões se ajustam ao papel, e o servidor recusa por conta
própria — esconder o botão nunca é a única proteção. O editor (`/index.html`)
nem é entregue a quem não é admin. `test/http.test.js` sobe o servidor e
confere essas travas por HTTP.

**Senha definida pelo admin.** Usuário criado (ou com a senha redefinida) por um
administrador cai em *Minha conta* no primeiro acesso e só usa o resto do
sistema depois de criar a própria senha (8+ caracteres, letras e números).

**Limite de login.** 5 senhas erradas para o mesmo login, ou 20 do mesmo IP, em
15 minutos bloqueiam novas tentativas por 15 minutos (`lib/limite.js`).

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
| Minha conta | `/conta.html` | todos |

## Site público

```
static/site/index.html   a página (seções e textos)
static/site/site.css     estilos próprios do site (usa os tokens de static/style.css)
static/site/site.js      menu móvel, vídeo, animações
static/site/img/         fotos — ver LEIA-ME.md com os nomes esperados
static/site/video/       apresentacao.mp4 (botão "Assista ao vídeo")
```

Sem fotos, o site usa degradês e uma ilustração vetorial — nada quebra. Para usar
as fotos do designer, basta salvar em `static/site/img/` com os nomes listados em
`static/site/img/LEIA-ME.md`.

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

Tudo no MySQL (`lib/db.js`):

| Tabela | O quê |
|---|---|
| `grupos` | nome, se é admin, páginas e painéis liberados |
| `usuarios` | login, nome, e-mail, grupo, hash da senha, último acesso |
| `sessoes` | tokens de login (12 h) |
| `dashboards` | painéis publicados (código JS) |
| `dashboard_versoes` | histórico — as últimas 15 versões de cada painel |
| `planilhas` / `planilha_partes` | os arquivos, gravados em pedaços de 2 MB |
| `planilha_versoes` / `planilha_versao_partes` | histórico — as 5 versões anteriores de cada planilha |

As senhas são guardadas com `scrypt` e salt por usuário; o hash nunca sai nas
respostas da API. As planilhas são divididas em partes porque hospedagem
compartilhada limita o tamanho de cada comando enviado ao MySQL; ao baixar,
o servidor manda um `ETag` com o hash do arquivo, e o navegador não baixa de
novo uma planilha que não mudou.

Escritas que mexem em mais de uma tabela (trocar senha e derrubar sessões,
publicar painel e arquivar a versão anterior, substituir as partes de uma
planilha) rodam numa transação: ou entra tudo, ou nada.

## Testes

Rodam contra um banco **de teste** — o nome precisa conter `test`, e o código
se recusa a limpar qualquer outro. Com Docker:

```bash
docker run -d --name epcview-mysql -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=epc_test -p 3307:3306 mysql:8.0
TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=3307 TEST_DB_USER=root TEST_DB_PASSWORD=root TEST_DB_NAME=epc_test npm test
```

Sem `TEST_DB_NAME`, os testes que precisam de banco são pulados.

## Painéis já publicados

| Painel | Planilhas |
|---|---|
| Dashboard Executivo UHN | P21–P24, P27, P28 |
| Painel Financeiro Executivo | P21, P22, P39–P43 |
| Painel Executivo de SMS | P31–P36 |

O painel de SMS foi traduzido de Streamlit/Altair/pandas para JavaScript. Ele
exige as planilhas **P31 a P36**; sem elas exibe um aviso pedindo a importação,
sem quebrar.

## Arquitetura

Existe **um** runtime, não um HTML por painel:

```
MySQL (dashboards) ──> viewer.html ──postMessage──> sandbox.html
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
| `PUT` | `/api/sessao/senha` · `/conta` | autenticado (a própria conta) |
| `GET` | `/api/dashboards` · `/:id` | autenticado |
| `POST`/`PUT`/`DELETE` | `/api/dashboards` · `/:id` · `/:id/duplicar` · `/:id/restaurar` | admin |
| `GET` | `/api/dashboards/:id/versoes` | admin |
| `GET` | `/api/planilhas` · `/:nome` · `/:nome/versoes` · `/:nome/versoes/:id` | autenticado |
| `POST`/`DELETE` | `/api/planilhas/:nome` · `/:nome/versoes/:id/restaurar` | admin |
| `GET` | `/api/exportar/planilhas?nome=…` ou `?todas=1` (.zip) | autenticado |
| `GET` | `/api/saude` | todos |
| `GET`/`POST`/`PUT`/`DELETE` | `/api/usuarios` · `/:id` | admin |
| `GET`/`POST`/`PUT`/`DELETE` | `/api/grupos` · `/:id` | admin |

## Segurança

Já tratado: sessão em cookie `httpOnly` + `SameSite=Lax`; senhas com `scrypt` e
comparação em tempo constante; path traversal bloqueado nos estáticos, nos ids
de painel e nos nomes de planilha; upload restrito a `.xlsx/.xls/.csv`; limites
de corpo (4 MB para painéis, 60 MB para planilhas); títulos renderizados com
`textContent`.

Dois pontos a considerar antes de expor fora da rede interna:

- **Um painel é código** que roda no navegador de quem o abrir. Só
  administradores publicam, e é por isso que esse papel deve ser restrito.
- **O servidor fala HTTP puro.** Na Hostinger o HTTPS é feito pelo proxy da
  hospedagem; em outro lugar, coloque-o atrás de um proxy com TLS — sem HTTPS,
  a senha trafega em texto claro.
- **MySQL remoto liberado para `%`** aceita conexões de qualquer IP (protegidas
  só pela senha). Prefira liberar apenas o seu IP.
