/**
 * EPCVIEW - Servidor
 * ---------------------------------------------------------------------------
 *   - Site público institucional em / (static/site/), sem login.
 *   - Painel administrativo (dashboards, planilhas, usuários, dockers, contatos)
 *     atrás de login.
 *   - Autenticação por sessão (cookie httpOnly), com papéis admin/visualizador.
 *   - CRUD de dashboards e de planilhas, guardados em data/database.json.
 *   - Estáticos com proteção contra path traversal.
 *
 * Sem dependências externas: só a biblioteca padrão do Node.
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

require('./lib/env')();   // .env local, antes de qualquer módulo que leia process.env

const db = require('./lib/db');
const r2 = require('./lib/r2');
const dockers = require('./lib/dockers');
const contatos = require('./lib/contatos');
const { podeVerPagina, podeVerDashboard, podeAbrirApp } = require('./lib/permissoes');

const PORT = Number(process.env.PORT) || 8000;
// Site institucional desligado por enquanto: a raiz leva ao login/painel e
// /site/ e /api/contato respondem 404. SITE_PUBLICO=1 no ambiente religa tudo.
const SITE_PUBLICO = process.env.SITE_PUBLICO === '1';
const STATIC_DIR = path.join(__dirname, 'static');

const MAX_BODY_BYTES = 4 * 1024 * 1024;        // dashboards são só código
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;     // planilhas de obra são pesadas

// Todos os formatos tabulares que o SheetJS consegue abrir. A lista existe
// para barrar executaveis no upload, nao para restringir planilhas legitimas.
const EXTENSOES_PLANILHA = [
    '.xlsx', '.xlsm', '.xlsb', '.xls', '.xlt', '.xltx', '.xltm',
    '.csv', '.tsv', '.txt', '.ods', '.fods', '.dif', '.prn', '.dbf', '.xml'
];

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.ico': 'image/x-icon', '.webp': 'image/webp',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json; charset=utf-8',
    '.mp4': 'video/mp4', '.webm': 'video/webm'
};

// Páginas que podem ser abertas sem sessão. Tudo em /site/ também é público.
const PUBLICAS = new Set(['/login.html', '/style.css', '/favicon.svg', '/assets/ui.js']);
const PREFIXO_SITE = '/site/';
const MAX_CONTATO_BYTES = 16 * 1024;

// ---------------------------------------------------------------------------
// Utilidades HTTP
// ---------------------------------------------------------------------------

function enviarJSON(res, status, payload, cabecalhosExtras) {
    const corpo = JSON.stringify(payload);
    res.writeHead(status, Object.assign({
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(corpo),
        'Cache-Control': 'no-store'
    }, cabecalhosExtras || {}));
    res.end(corpo);
}

function lerCorpo(req, limite) {
    const teto = limite || MAX_BODY_BYTES;
    return new Promise((resolve, reject) => {
        const partes = [];
        let tamanho = 0;
        req.on('data', parte => {
            tamanho += parte.length;
            if (tamanho > teto) {
                reject(Object.assign(new Error('Arquivo maior que o limite de ' +
                    Math.round(teto / 1024 / 1024) + ' MB.'), { status: 413 }));
                req.destroy();
                return;
            }
            partes.push(parte);
        });
        req.on('end', () => resolve(Buffer.concat(partes)));
        req.on('error', reject);
    });
}

async function lerJSON(req) {
    const texto = (await lerCorpo(req)).toString('utf8');
    try {
        return JSON.parse(texto);
    } catch {
        throw Object.assign(new Error('JSON inválido.'), { status: 400 });
    }
}

function lerCookies(req) {
    const cabecalho = req.headers.cookie || '';
    const saida = {};
    for (const parte of cabecalho.split(';')) {
        const i = parte.indexOf('=');
        if (i < 0) continue;
        saida[parte.slice(0, i).trim()] = decodeURIComponent(parte.slice(i + 1).trim());
    }
    return saida;
}

const NOME_COOKIE = 'epc_sessao';

function cookieSessao(token, maxIdade) {
    // httpOnly: JavaScript da página não lê o token, o que limita o estrago
    // de um XSS em código de dashboard (que é, por natureza, código de terceiro).
    return NOME_COOKIE + '=' + encodeURIComponent(token) +
        '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxIdade;
}

// ---------------------------------------------------------------------------
// Autenticação
// ---------------------------------------------------------------------------

function usuarioDaRequisicao(req) {
    return db.usuarioDaSessao(lerCookies(req)[NOME_COOKIE]);
}

function exigirLogin(usuario) {
    if (!usuario) throw Object.assign(new Error('Faça login para continuar.'), { status: 401 });
    return usuario;
}

function exigirAdmin(usuario) {
    exigirLogin(usuario);
    if (usuario.papel !== 'admin') {
        throw Object.assign(new Error('Apenas administradores podem fazer isso.'), { status: 403 });
    }
    return usuario;
}

// ---------------------------------------------------------------------------
// API: sessão
// ---------------------------------------------------------------------------

/** Anexa o que o usuário pode ver (páginas, painéis, aplicações) — resolvido do grupo, nunca guardado no registro. */
function comPermissoes(usuario) {
    return Object.assign({}, usuario, { permissoes: db.permissoesDoUsuario(usuario) });
}

async function rotaSessao(req, res, segmentos, usuario) {
    const acao = segmentos[2];

    if (req.method === 'POST' && acao === 'login') {
        const { login, senha } = await lerJSON(req);
        const resultado = db.autenticar(login, senha);
        if (!resultado) {
            // Mensagem genérica de propósito: não revela se o login existe.
            enviarJSON(res, 401, { error: 'Login ou senha incorretos.' });
            return;
        }
        enviarJSON(res, 200, { usuario: comPermissoes(resultado.usuario) },
            { 'Set-Cookie': cookieSessao(resultado.token, Math.floor(db.DURACAO_SESSAO_MS / 1000)) });
        return;
    }

    if (req.method === 'POST' && acao === 'logout') {
        db.encerrarSessao(lerCookies(req)[NOME_COOKIE]);
        enviarJSON(res, 200, { status: 'ok' }, { 'Set-Cookie': cookieSessao('', 0) });
        return;
    }

    if (req.method === 'GET' && acao === 'eu') {
        if (!usuario) { enviarJSON(res, 401, { error: 'Sem sessão.' }); return; }
        enviarJSON(res, 200, { usuario: comPermissoes(usuario) });
        return;
    }

    enviarJSON(res, 404, { error: 'Rota não encontrada.' });
}

// ---------------------------------------------------------------------------
// API: usuários (somente admin)
// ---------------------------------------------------------------------------

async function rotaUsuarios(req, res, segmentos, usuario) {
    exigirAdmin(usuario);
    const id = segmentos[2] || null;

    if (req.method === 'GET' && !id) { enviarJSON(res, 200, db.listarUsuarios()); return; }

    if (req.method === 'POST' && !id) {
        enviarJSON(res, 201, db.criarUsuario(await lerJSON(req)));
        return;
    }

    if ((req.method === 'PUT' || req.method === 'PATCH') && id) {
        enviarJSON(res, 200, db.atualizarUsuario(id, await lerJSON(req)));
        return;
    }

    if (req.method === 'DELETE' && id) {
        if (id === usuario.id) {
            throw Object.assign(new Error('Você não pode remover a própria conta.'), { status: 400 });
        }
        db.removerUsuario(id);
        enviarJSON(res, 200, { status: 'removido' });
        return;
    }

    enviarJSON(res, 405, { error: 'Método não permitido.' });
}

// ---------------------------------------------------------------------------
// API: dashboards
// ---------------------------------------------------------------------------

async function rotaDashboards(req, res, segmentos, usuario) {
    exigirLogin(usuario);
    const id = segmentos[2] ? decodeURIComponent(segmentos[2]) : null;
    const acao = segmentos[3] || null;   // /api/dashboards/:id/versoes | /restaurar | /duplicar

    if (id && acao === 'versoes' && req.method === 'GET') {
        enviarJSON(res, 200, db.listarVersoes(id));
        return;
    }

    if (id && acao === 'restaurar' && req.method === 'POST') {
        exigirAdmin(usuario);
        const { indice } = await lerJSON(req);
        enviarJSON(res, 200, db.restaurarVersao(id, Number(indice), usuario));
        return;
    }

    if (id && acao === 'duplicar' && req.method === 'POST') {
        exigirAdmin(usuario);
        enviarJSON(res, 201, db.duplicarDashboard(id, usuario));
        return;
    }

    if (req.method === 'GET' && !id) {
        const todos = db.listarDashboards();
        enviarJSON(res, 200, usuario.papel === 'admin' ? todos : todos.filter(d => podeVerDashboard(usuario, d.id)));
        return;
    }

    if (req.method === 'GET' && id) {
        const d = db.acharDashboard(id);
        if (!d) { enviarJSON(res, 404, { error: 'Dashboard não encontrado.' }); return; }
        if (!podeVerDashboard(usuario, id)) {
            enviarJSON(res, 403, { error: 'Seu grupo não tem acesso a este painel.' });
            return;
        }
        enviarJSON(res, 200, d);
        return;
    }

    // Criar, alterar e excluir são privilégio de administrador: um dashboard
    // é código que roda no navegador de todo mundo que o abrir.
    if (req.method === 'POST' || req.method === 'PUT') {
        exigirAdmin(usuario);
        enviarJSON(res, 200, db.salvarDashboard(await lerJSON(req), usuario));
        return;
    }

    if (req.method === 'DELETE' && id) {
        exigirAdmin(usuario);
        db.removerDashboard(id);
        enviarJSON(res, 200, { status: 'removido', id });
        return;
    }

    enviarJSON(res, 405, { error: 'Método não permitido.' });
}

// ---------------------------------------------------------------------------
// API: planilhas
// ---------------------------------------------------------------------------

/** Valida e limpa um nome de planilha; null se inválido. Planilhas moram no R2, não no disco. */
function nomePlanilha(nome) {
    const limpo = path.basename(String(nome || ''));
    if (!limpo || limpo.startsWith('.')) return null;
    if (!EXTENSOES_PLANILHA.includes(path.extname(limpo).toLowerCase())) return null;
    return limpo;
}

async function listarPlanilhas() {
    const objetos = await r2.listar();
    const arquivos = objetos
        .filter(o => EXTENSOES_PLANILHA.includes(path.extname(o.nome).toLowerCase()))
        .map(o => {
            // O apelido (P21, 01...) é o que o editor mostra e o runtime resolve.
            const apelido = (o.nome.match(/^(p?\d+)/i) || [])[1];
            return {
                nome: o.nome,
                apelido: apelido ? apelido.toUpperCase() : null,
                tamanho: o.tamanho,
                atualizadoEm: o.atualizadoEm
            };
        });
    arquivos.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { numeric: true }));
    return arquivos;
}

async function rotaPlanilhas(req, res, segmentos, usuario) {
    exigirLogin(usuario);
    if (!r2.configurado()) {
        enviarJSON(res, 503, { error: 'Armazenamento de planilhas (R2) não configurado no servidor.' });
        return;
    }
    const nome = segmentos[2] ? decodeURIComponent(segmentos[2]) : null;

    if (req.method === 'GET' && !nome) { enviarJSON(res, 200, await listarPlanilhas()); return; }

    if (req.method === 'GET' && nome) {
        const limpo = nomePlanilha(nome);
        if (!limpo) { enviarJSON(res, 400, { error: 'Nome de planilha inválido.' }); return; }
        const dados = await r2.buscar(limpo);
        if (!dados) { enviarJSON(res, 404, { error: 'Planilha "' + nome + '" não encontrada.' }); return; }
        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': dados.length,
            'Cache-Control': 'no-cache'
        });
        res.end(dados);
        return;
    }

    if (req.method === 'POST' && nome) {
        exigirAdmin(usuario);
        const limpo = nomePlanilha(nome);
        if (!limpo) { enviarJSON(res, 400, { error: 'Nome inválido. Use .xlsx, .xls ou .csv.' }); return; }
        const dados = await lerCorpo(req, MAX_UPLOAD_BYTES);
        if (!dados.length) { enviarJSON(res, 400, { error: 'Arquivo vazio.' }); return; }
        await r2.enviar(limpo, dados);
        enviarJSON(res, 200, { status: 'ok', nome: limpo, tamanho: dados.length });
        return;
    }

    if (req.method === 'DELETE' && nome) {
        exigirAdmin(usuario);
        const limpo = nomePlanilha(nome);
        if (!limpo) { enviarJSON(res, 400, { error: 'Nome de planilha inválido.' }); return; }
        await r2.apagar(limpo);
        enviarJSON(res, 200, { status: 'removida', nome: limpo });
        return;
    }

    enviarJSON(res, 405, { error: 'Método não permitido.' });
}

// ---------------------------------------------------------------------------
// API: dockers (outros sistemas rodando como container, dentro do UHNIntegra)
// ---------------------------------------------------------------------------

async function rotaDockers(req, res, segmentos, usuario) {
    exigirLogin(usuario);
    const acao = segmentos[2];

    // Leitura básica: com ?menu=1 (usado pela barra lateral), qualquer papel só vê
    // o que pode abrir; sem isso, admin gerencia a lista inteira (inclusive ocultas).
    if (req.method === 'GET' && !acao) {
        const querMenu = analisarUrl(req).searchParams.get('menu') === '1';
        if (usuario.papel === 'admin' && !querMenu) {
            enviarJSON(res, 200, await dockers.listarComStatus());
        } else {
            const visiveis = dockers.listar()
                .filter(a => a.exibirEm === 'menu' && podeAbrirApp(usuario, a))
                .map(a => ({ id: a.id, titulo: a.titulo, extensaoUrl: a.extensaoUrl }));
            enviarJSON(res, 200, visiveis);
        }
        return;
    }

    if (req.method === 'GET' && acao === 'status-docker') {
        enviarJSON(res, 200, { disponivel: await dockers.dockerDisponivel() });
        return;
    }

    // Tudo daqui pra baixo cria, altera ou controla containers: só admin.
    exigirAdmin(usuario);

    if (req.method === 'POST' && acao === 'upload') {
        try {
            enviarJSON(res, 200, await dockers.receberUpload(req));
        } catch (err) {
            enviarJSON(res, err.status || 500, { error: err.message });
        }
        return;
    }

    if (req.method === 'POST' && !acao) {
        const registro = await dockers.registrarApp(await lerJSON(req), usuario);
        enviarJSON(res, 201, registro);
        return;
    }

    const id = acao;
    if (req.method === 'POST' && id && segmentos[3] === 'parar') {
        await dockers.pausarApp(id);
        enviarJSON(res, 200, { status: 'parado' });
        return;
    }
    if (req.method === 'POST' && id && segmentos[3] === 'iniciar') {
        await dockers.religarApp(id);
        enviarJSON(res, 200, { status: 'rodando' });
        return;
    }
    if (req.method === 'POST' && id && segmentos[3] === 'imagem') {
        enviarJSON(res, 200, await dockers.atualizarImagem(id, await lerJSON(req)));
        return;
    }
    if ((req.method === 'PUT' || req.method === 'PATCH') && id) {
        enviarJSON(res, 200, dockers.atualizarApp(id, await lerJSON(req)));
        return;
    }
    if (req.method === 'DELETE' && id) {
        enviarJSON(res, 200, await dockers.removerApp(id));
        return;
    }

    enviarJSON(res, 405, { error: 'Método não permitido.' });
}

// ---------------------------------------------------------------------------
// API: grupos (só admin) — controlam páginas, painéis e aplicações visíveis
// ---------------------------------------------------------------------------

async function rotaGrupos(req, res, segmentos, usuario) {
    exigirAdmin(usuario);
    const id = segmentos[2] || null;

    if (req.method === 'GET' && !id) {
        const comContagem = db.listarGrupos().map(g =>
            Object.assign({}, g, { usuarios: db.contarUsuariosNoGrupo(g.id) }));
        enviarJSON(res, 200, comContagem);
        return;
    }

    if (req.method === 'POST' && !id) {
        enviarJSON(res, 201, db.criarGrupo(await lerJSON(req)));
        return;
    }

    if ((req.method === 'PUT' || req.method === 'PATCH') && id) {
        enviarJSON(res, 200, db.atualizarGrupo(id, await lerJSON(req)));
        return;
    }

    if (req.method === 'DELETE' && id) {
        db.removerGrupo(id);
        enviarJSON(res, 200, { status: 'removido', id });
        return;
    }

    enviarJSON(res, 405, { error: 'Método não permitido.' });
}

// ---------------------------------------------------------------------------
// API: contato (público: formulário do site) e contatos (admin: caixa de entrada)
// ---------------------------------------------------------------------------

/** IP do visitante — atrás do proxy do Render, o primeiro de X-Forwarded-For. */
function ipDaRequisicao(req) {
    const encaminhado = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return encaminhado || req.socket.remoteAddress || 'desconhecido';
}

async function rotaContato(req, res) {
    if (req.method !== 'POST') { enviarJSON(res, 405, { error: 'Método não permitido.' }); return; }
    const texto = (await lerCorpo(req, MAX_CONTATO_BYTES)).toString('utf8');
    let dados;
    try { dados = JSON.parse(texto); } catch { throw Object.assign(new Error('JSON inválido.'), { status: 400 }); }
    enviarJSON(res, 201, contatos.registrar(dados, ipDaRequisicao(req)));
}

async function rotaContatos(req, res, segmentos, usuario) {
    exigirAdmin(usuario);
    const id = segmentos[2] || null;

    if (req.method === 'GET' && !id) {
        enviarJSON(res, 200, { contatos: contatos.listar(), naoLidos: contatos.contarNaoLidos() });
        return;
    }
    if ((req.method === 'PUT' || req.method === 'PATCH') && id) {
        enviarJSON(res, 200, contatos.marcar(id, await lerJSON(req)));
        return;
    }
    if (req.method === 'DELETE' && id) {
        contatos.remover(id);
        enviarJSON(res, 200, { status: 'removido', id });
        return;
    }
    enviarJSON(res, 405, { error: 'Método não permitido.' });
}

// ---------------------------------------------------------------------------
// Roteamento da API
// ---------------------------------------------------------------------------

async function rotearApi(req, res, url, usuario) {
    const segmentos = url.pathname.split('/').filter(Boolean);   // ['api', recurso, id?]
    const recurso = segmentos[1];

    if (recurso === 'sessao') return rotaSessao(req, res, segmentos, usuario);
    if (recurso === 'usuarios') return rotaUsuarios(req, res, segmentos, usuario);
    if (recurso === 'dashboards') return rotaDashboards(req, res, segmentos, usuario);
    if (recurso === 'planilhas') return rotaPlanilhas(req, res, segmentos, usuario);
    if (recurso === 'dockers') return rotaDockers(req, res, segmentos, usuario);
    if (recurso === 'grupos') return rotaGrupos(req, res, segmentos, usuario);
    if (recurso === 'config') return enviarJSON(res, 200, { sitePublico: SITE_PUBLICO });
    if (recurso === 'contato' && SITE_PUBLICO) return rotaContato(req, res);
    if (recurso === 'contatos') return rotaContatos(req, res, segmentos, usuario);

    enviarJSON(res, 404, { error: 'Rota não encontrada.' });
}

// ---------------------------------------------------------------------------
// Estáticos
// ---------------------------------------------------------------------------

function servirEstatico(req, res, url, usuario) {
    let caminho;
    try {
        caminho = decodeURIComponent(url.pathname);
    } catch {
        res.writeHead(400); res.end('Bad Request'); return;
    }
    if (!SITE_PUBLICO) {
        // Sem site público, a raiz leva direto ao painel (ou ao login).
        if (caminho === '/') {
            res.writeHead(302, { Location: usuario ? '/lista_dashboards.html' : '/login.html' });
            res.end();
            return;
        }
        if (caminho === '/site' || caminho.startsWith(PREFIXO_SITE)) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not Found');
            return;
        }
    }
    // A raiz é o site público; o painel começa em /lista_dashboards.html.
    if (caminho === '/' || caminho === '/site' || caminho === PREFIXO_SITE) caminho = PREFIXO_SITE + 'index.html';

    // resolve + prefixo fecham o traversal: nem ../ nem %2e%2e escapam de static/
    const abs = path.resolve(STATIC_DIR, '.' + caminho);
    if (abs !== STATIC_DIR && !abs.startsWith(STATIC_DIR + path.sep)) {
        console.warn('[segurança] traversal bloqueado: ' + url.pathname);
        res.writeHead(403); res.end('Forbidden');
        return;
    }

    // Sem sessão, qualquer página leva ao login (exceto as públicas).
    const ehPagina = path.extname(abs).toLowerCase() === '.html';
    if (!usuario && ehPagina && !PUBLICAS.has(caminho) && !caminho.startsWith(PREFIXO_SITE)) {
        const destino = encodeURIComponent(caminho + (url.search || ''));
        res.writeHead(302, { Location: '/login.html?destino=' + destino });
        res.end();
        return;
    }

    fs.readFile(abs, (err, dados) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not Found');
            return;
        }
        const ext = path.extname(abs).toLowerCase();
        // Fotos e vídeo do site mudam raramente e pesam: cache de 1 dia.
        const ehMidiaDoSite = caminho.startsWith(PREFIXO_SITE) && /^\.(jpe?g|png|webp|svg|mp4|webm)$/.test(ext);
        res.writeHead(200, {
            'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
            'Cache-Control': ehMidiaDoSite ? 'public, max-age=86400' : 'no-cache',
            'X-Content-Type-Options': 'nosniff'
        });
        res.end(dados);
    });
}

// ---------------------------------------------------------------------------
// Servidor
// ---------------------------------------------------------------------------

/** Analisa a URL sem nunca lançar: um `//` não pode derrubar o processo. */
function analisarUrl(req) {
    try {
        return new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    } catch {
        try {
            return new URL('/' + String(req.url || '').replace(/^\/+/, ''), 'http://localhost');
        } catch {
            return new URL('http://localhost/');
        }
    }
}

const server = http.createServer(async (req, res) => {
    const url = analisarUrl(req);
    let usuario = null;
    try {
        usuario = usuarioDaRequisicao(req);
    } catch (err) {
        console.error('[sessão]', err.message);
    }

    try {
        // Aplicação registrada em /dockers? Encaminha pro container antes de
        // qualquer outra rota — /<extensaoUrl>/... nunca chega em /api/ nem nos estáticos.
        const primeiroSegmento = url.pathname.split('/')[1];
        const dockerRegistrado = primeiroSegmento ? dockers.obterPorExtensao(primeiroSegmento) : null;
        if (dockerRegistrado) {
            if (!usuario) {
                const destino = encodeURIComponent(url.pathname + (url.search || ''));
                res.writeHead(302, { Location: '/login.html?destino=' + destino });
                res.end();
                return;
            }
            if (!podeAbrirApp(usuario, dockerRegistrado)) {
                throw Object.assign(new Error('Seu grupo não tem acesso a esta aplicação.'), { status: 403 });
            }
            const resto = url.pathname.slice(1 + primeiroSegmento.length) || '/';
            dockers.encaminhar(req, res, dockerRegistrado, resto + (url.search || ''));
            return;
        }

        if (url.pathname.startsWith('/api/')) {
            await rotearApi(req, res, url, usuario);
            return;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405); res.end('Method Not Allowed'); return;
        }
        servirEstatico(req, res, url, usuario);
    } catch (err) {
        if (!res.headersSent) enviarJSON(res, err.status || 500, { error: err.message });
        else res.end();
        if (!err.status || err.status >= 500) console.error('[erro]', err);
    }
});

// Uma exceção solta não pode tirar o sistema do ar.
process.on('uncaughtException', err => console.error('[exceção não tratada]', err));
process.on('unhandledRejection', err => console.error('[promise rejeitada]', err));

fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });

const senhaInicial = db.garantirAdmin();
db.limparSessoesVencidas();
setInterval(() => db.limparSessoesVencidas(), 60 * 60 * 1000).unref();
setInterval(() => contatos.limparLimites(), 15 * 60 * 1000).unref();
dockers.limparUploadsOrfaos();

server.listen(PORT, async () => {
    let planilhas = '?';
    if (r2.configurado()) {
        try { planilhas = String((await r2.listar()).length); }
        catch (err) { console.error('[r2] não foi possível listar o bucket: ' + err.message); planilhas = 'erro'; }
    }

    console.log('');
    console.log('  EPCVIEW  ·  ' + (SITE_PUBLICO ? 'site: http://localhost:' + PORT + '  ·  ' : 'site público desligado  ·  ') +
                'painel: http://localhost:' + PORT + '/login.html');
    console.log('  ' + '-'.repeat(70));
    console.log('  ' + db.listarDashboards().length + ' dashboards  ·  ' + planilhas + ' planilhas  ·  ' +
                db.listarUsuarios().length + ' usuários  ·  ' + contatos.contarNaoLidos() + ' contatos não lidos');
    if (!r2.configurado()) {
        console.log('  [r2] variáveis de ambiente ausentes — upload/leitura de planilhas vai falhar.' +
                     ' Configure R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.');
    }
    if (!await dockers.dockerDisponivel()) {
        console.log('  [dockers] Docker não encontrado neste host — a tela de Dockers fica indisponível.');
    }

    if (senhaInicial) {
        console.log('');
        console.log('  ┌' + '─'.repeat(44) + '┐');
        console.log('  │  PRIMEIRO ACESSO                           │');
        console.log('  │  login: admin                              │');
        console.log('  │  senha: ' + senhaInicial.padEnd(35) + '│');
        console.log('  │  Anote: esta senha não será exibida de novo│');
        console.log('  └' + '─'.repeat(44) + '┘');
    }
    console.log('');
});
