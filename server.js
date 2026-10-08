/**
 * EPCVIEW - Servidor
 * ---------------------------------------------------------------------------
 *   - Site público institucional em / (static/site/), sem login.
 *   - Painel administrativo (dashboards, planilhas, usuários) atrás de login.
 *   - Autenticação por sessão (cookie httpOnly), com papéis admin/visualizador.
 *   - CRUD de dashboards, planilhas, usuários e grupos, guardados no MySQL (lib/db.js).
 *   - Estáticos com proteção contra path traversal.
 *
 * Única dependência externa: o driver mysql2.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

require('./lib/env')();   // .env local, antes de qualquer módulo que leia process.env

const db = require('./lib/db');
const { gerarZip } = require('./lib/zip');
const { criarLimitador } = require('./lib/limite');
const { podeVerPagina, podeVerDashboard } = require('./lib/permissoes');

const PORT = Number(process.env.PORT) || 8000;
// Site institucional ligado por padrão em /. SITE_PUBLICO=0 no ambiente o
// desliga: a raiz passa a levar ao login/painel e /site/ responde 404.
const SITE_PUBLICO = process.env.SITE_PUBLICO !== '0';
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

/**
 * IP de quem fez o pedido. Na Hostinger o app fica atrás de um proxy, então o
 * IP real vem no X-Forwarded-For (o primeiro da lista é o do navegador).
 */
function ipDaRequisicao(req) {
    const encaminhado = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return encaminhado || req.socket.remoteAddress || '?';
}

const limiteLogin = criarLimitador();
setInterval(() => limiteLogin.limpar(), 10 * 60 * 1000).unref();

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

/** Anexa o que o usuário pode ver (páginas e painéis) — resolvido do grupo, nunca guardado no registro. */
function comPermissoes(usuario) {
    return Object.assign({}, usuario, { permissoes: db.permissoesDoUsuario(usuario) });
}

async function rotaSessao(req, res, segmentos, usuario) {
    const acao = segmentos[2];

    if (req.method === 'POST' && acao === 'login') {
        const { login, senha } = await lerJSON(req);
        const ip = ipDaRequisicao(req);
        const espera = limiteLogin.bloqueio(login, ip);
        if (espera > 0) {
            const minutos = Math.ceil(espera / 60000);
            enviarJSON(res, 429, { error: 'Muitas tentativas erradas. Tente de novo em ' + minutos +
                (minutos === 1 ? ' minuto.' : ' minutos.') }, { 'Retry-After': String(Math.ceil(espera / 1000)) });
            return;
        }
        const resultado = await db.autenticar(login, senha);
        if (!resultado) {
            limiteLogin.falhou(login, ip);
            // Mensagem genérica de propósito: não revela se o login existe.
            enviarJSON(res, 401, { error: 'Login ou senha incorretos.' });
            return;
        }
        limiteLogin.acertou(login);
        enviarJSON(res, 200, { usuario: comPermissoes(resultado.usuario) },
            { 'Set-Cookie': cookieSessao(resultado.token, Math.floor(db.DURACAO_SESSAO_MS / 1000)) });
        return;
    }

    if (req.method === 'POST' && acao === 'logout') {
        await db.encerrarSessao(lerCookies(req)[NOME_COOKIE]);
        enviarJSON(res, 200, { status: 'ok' }, { 'Set-Cookie': cookieSessao('', 0) });
        return;
    }

    if (req.method === 'GET' && acao === 'eu') {
        if (!usuario) { enviarJSON(res, 401, { error: 'Sem sessão.' }); return; }
        enviarJSON(res, 200, { usuario: comPermissoes(usuario) });
        return;
    }

    // "Minha conta": cada um troca a própria senha e ajusta nome/e-mail.
    if (req.method === 'PUT' && acao === 'senha') {
        exigirLogin(usuario);
        const { senhaAtual, novaSenha } = await lerJSON(req);
        const atualizado = await db.trocarPropriaSenha(usuario.id, senhaAtual, novaSenha, lerCookies(req)[NOME_COOKIE]);
        enviarJSON(res, 200, { usuario: comPermissoes(atualizado) });
        return;
    }

    if (req.method === 'PUT' && acao === 'conta') {
        exigirLogin(usuario);
        const { nome, email } = await lerJSON(req);
        const atualizado = await db.atualizarPropriaConta(usuario.id, { nome, email });
        enviarJSON(res, 200, { usuario: comPermissoes(atualizado) });
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

    if (req.method === 'GET' && !id) { enviarJSON(res, 200, await db.listarUsuarios()); return; }

    if (req.method === 'POST' && !id) {
        enviarJSON(res, 201, await db.criarUsuario(await lerJSON(req)));
        return;
    }

    if ((req.method === 'PUT' || req.method === 'PATCH') && id) {
        enviarJSON(res, 200, await db.atualizarUsuario(id, await lerJSON(req)));
        return;
    }

    if (req.method === 'DELETE' && id) {
        if (id === usuario.id) {
            throw Object.assign(new Error('Você não pode remover a própria conta.'), { status: 400 });
        }
        await db.removerUsuario(id);
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
        exigirAdmin(usuario);   // histórico é ferramenta de quem edita
        enviarJSON(res, 200, await db.listarVersoes(id));
        return;
    }

    if (id && acao === 'restaurar' && req.method === 'POST') {
        exigirAdmin(usuario);
        const { indice } = await lerJSON(req);
        enviarJSON(res, 200, await db.restaurarVersao(id, Number(indice), usuario));
        return;
    }

    if (id && acao === 'duplicar' && req.method === 'POST') {
        exigirAdmin(usuario);
        enviarJSON(res, 201, await db.duplicarDashboard(id, usuario));
        return;
    }

    if (req.method === 'GET' && !id) {
        const todos = await db.listarDashboards();
        enviarJSON(res, 200, usuario.papel === 'admin' ? todos : todos.filter(d => podeVerDashboard(usuario, d.id)));
        return;
    }

    if (req.method === 'GET' && id) {
        const d = await db.acharDashboard(id);
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
        enviarJSON(res, 200, await db.salvarDashboard(await lerJSON(req), usuario));
        return;
    }

    if (req.method === 'DELETE' && id) {
        exigirAdmin(usuario);
        await db.removerDashboard(id);
        await db.removerDashboardDosGrupos(id);
        enviarJSON(res, 200, { status: 'removido', id });
        return;
    }

    enviarJSON(res, 405, { error: 'Método não permitido.' });
}

// ---------------------------------------------------------------------------
// API: planilhas
// ---------------------------------------------------------------------------

/**
 * Content-Disposition que funciona com acento no nome: o filename simples vai
 * sem acentos (navegadores antigos), e o filename* leva o nome real em UTF-8.
 */
function anexo(nomeArquivo) {
    const simples = nomeArquivo.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]|["\\]/g, '_');
    return 'attachment; filename="' + simples + "\"; filename*=UTF-8''" + encodeURIComponent(nomeArquivo);
}

/** Valida e limpa um nome de planilha; null se inválido. */
function nomePlanilha(nome) {
    const limpo = path.basename(String(nome || '')).trim();
    if (!limpo || limpo.startsWith('.') || limpo.length > 191) return null;
    if (!EXTENSOES_PLANILHA.includes(path.extname(limpo).toLowerCase())) return null;
    return limpo;
}

/**
 * Versões anteriores de uma planilha. Ver e baixar: quem acessa planilhas.
 * Restaurar troca o dado que os painéis leem, então é só para admin.
 */
async function rotaVersoesPlanilha(req, res, segmentos, usuario, nome) {
    const limpo = nomePlanilha(nome);
    if (!limpo) { enviarJSON(res, 400, { error: 'Nome de planilha inválido.' }); return; }
    const versaoId = segmentos[4] ? Number(segmentos[4]) : null;
    if (segmentos[4] && !(Number.isInteger(versaoId) && versaoId > 0)) {
        enviarJSON(res, 400, { error: 'Versão inválida.' });
        return;
    }

    if (req.method === 'GET' && !versaoId) {
        enviarJSON(res, 200, await db.listarVersoesPlanilha(limpo));
        return;
    }

    if (req.method === 'GET' && versaoId && !segmentos[5]) {
        const versao = await db.lerVersaoPlanilha(limpo, versaoId);
        if (!versao) { enviarJSON(res, 404, { error: 'Versão não encontrada.' }); return; }
        // "P21 - Curva.xlsx" de 08/10/2026 vira "P21 - Curva (versão 2026-10-08).xlsx"
        const data = (versao.meta.atualizadoEm || '').slice(0, 10);
        const ext = path.extname(limpo);
        const nomeArquivo = limpo.slice(0, -ext.length) + ' (versão ' + data + ')' + ext;
        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': versao.dados.length,
            'Cache-Control': 'no-store',
            'Content-Disposition': anexo(nomeArquivo)
        });
        res.end(versao.dados);
        return;
    }

    if (req.method === 'POST' && versaoId && segmentos[5] === 'restaurar') {
        exigirAdmin(usuario);
        const restaurada = await db.restaurarVersaoPlanilha(limpo, versaoId, usuario);
        enviarJSON(res, 200, restaurada);
        return;
    }

    enviarJSON(res, 405, { error: 'Método não permitido.' });
}

async function rotaPlanilhas(req, res, segmentos, usuario, url) {
    exigirLogin(usuario);
    const baixar = url.searchParams.has('baixar');   // ?baixar=1: salva como arquivo em vez de ser lido pelo runtime
    const nome = segmentos[2] ? decodeURIComponent(segmentos[2]) : null;

    if (req.method === 'GET' && !nome) { enviarJSON(res, 200, await db.listarPlanilhas()); return; }

    // Histórico: /api/planilhas/:nome/versoes[/:id[/restaurar]]
    if (nome && segmentos[3] === 'versoes') {
        await rotaVersoesPlanilha(req, res, segmentos, usuario, nome);
        return;
    }

    if (req.method === 'GET' && nome) {
        const limpo = nomePlanilha(nome);
        if (!limpo) { enviarJSON(res, 400, { error: 'Nome de planilha inválido.' }); return; }

        // O conteúdo só muda num novo envio: com o hash como ETag, o navegador
        // revalida sem baixar de novo uma planilha de 10 MB que não mudou.
        const meta = await db.acharPlanilha(limpo);
        if (!meta) { enviarJSON(res, 404, { error: 'Planilha "' + nome + '" não encontrada.' }); return; }
        const etag = '"' + meta.sha256 + '"';
        if (!baixar && req.headers['if-none-match'] === etag) {
            res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
            res.end();
            return;
        }
        const arquivo = await db.lerPlanilha(limpo);
        if (!arquivo) { enviarJSON(res, 404, { error: 'Planilha "' + nome + '" não encontrada.' }); return; }
        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': arquivo.dados.length,
            'Cache-Control': 'no-cache',
            ETag: etag,
            ...(baixar ? { 'Content-Disposition': anexo(limpo) } : {})
        });
        res.end(arquivo.dados);
        return;
    }

    if (req.method === 'POST' && nome) {
        exigirAdmin(usuario);
        const limpo = nomePlanilha(nome);
        if (!limpo) { enviarJSON(res, 400, { error: 'Nome inválido. Use .xlsx, .xls ou .csv (até 191 caracteres).' }); return; }
        const dados = await lerCorpo(req, MAX_UPLOAD_BYTES);
        if (!dados.length) { enviarJSON(res, 400, { error: 'Arquivo vazio.' }); return; }
        const salva = await db.salvarPlanilha(limpo, dados, usuario);
        enviarJSON(res, 200, { status: 'ok', nome: salva.nome, tamanho: salva.tamanho });
        return;
    }

    if (req.method === 'DELETE' && nome) {
        exigirAdmin(usuario);
        const limpo = nomePlanilha(nome);
        if (!limpo) { enviarJSON(res, 400, { error: 'Nome de planilha inválido.' }); return; }
        if (!await db.removerPlanilha(limpo)) { enviarJSON(res, 404, { error: 'Planilha não encontrada.' }); return; }
        enviarJSON(res, 200, { status: 'removida', nome: limpo });
        return;
    }

    enviarJSON(res, 405, { error: 'Método não permitido.' });
}

/**
 * GET /api/exportar/planilhas?nome=A.xlsx&nome=B.xls  (ou ?todas=1)
 * Baixa as planilhas pedidas num .zip. É GET de propósito: o navegador trata
 * como download normal, com a barra de progresso dele, sem passar tudo pela
 * memória da página.
 */
async function rotaExportar(req, res, segmentos, usuario, url) {
    exigirLogin(usuario);
    if (req.method !== 'GET' || segmentos[2] !== 'planilhas') {
        enviarJSON(res, 404, { error: 'Rota não encontrada.' });
        return;
    }

    const existentes = await db.listarPlanilhas();
    let nomes;
    if (url.searchParams.has('todas')) {
        nomes = existentes.map(p => p.nome);
    } else {
        const pedidos = new Set(url.searchParams.getAll('nome').map(nomePlanilha).filter(Boolean));
        nomes = existentes.map(p => p.nome).filter(n => pedidos.has(n));
    }
    if (!nomes.length) { enviarJSON(res, 400, { error: 'Nenhuma planilha para exportar.' }); return; }

    const arquivos = [];
    for (const nome of nomes) {   // uma por vez: não abre 40 leituras grandes no banco ao mesmo tempo
        const arquivo = await db.lerPlanilha(nome);
        if (arquivo) arquivos.push({ nome, dados: arquivo.dados, data: new Date(arquivo.meta.atualizadoEm) });
    }

    const zip = gerarZip(arquivos);
    const hoje = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': zip.length,
        'Cache-Control': 'no-store',
        'Content-Disposition': anexo('planilhas-epcview-' + hoje + '.zip')
    });
    res.end(zip);
}

// ---------------------------------------------------------------------------
// API: grupos (só admin) — controlam páginas e painéis visíveis
// ---------------------------------------------------------------------------

async function rotaGrupos(req, res, segmentos, usuario) {
    exigirAdmin(usuario);
    const id = segmentos[2] || null;

    if (req.method === 'GET' && !id) {
        enviarJSON(res, 200, await db.listarGrupos());   // já vem com a contagem de usuários
        return;
    }

    if (req.method === 'POST' && !id) {
        enviarJSON(res, 201, await db.criarGrupo(await lerJSON(req)));
        return;
    }

    if ((req.method === 'PUT' || req.method === 'PATCH') && id) {
        enviarJSON(res, 200, await db.atualizarGrupo(id, await lerJSON(req)));
        return;
    }

    if (req.method === 'DELETE' && id) {
        await db.removerGrupo(id);
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
    if (recurso === 'planilhas') return rotaPlanilhas(req, res, segmentos, usuario, url);
    if (recurso === 'exportar') return rotaExportar(req, res, segmentos, usuario, url);
    if (recurso === 'grupos') return rotaGrupos(req, res, segmentos, usuario);
    if (recurso === 'config') return enviarJSON(res, 200, { sitePublico: SITE_PUBLICO });

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

    if (usuario && ehPagina) {
        // Senha definida pelo admin: antes de qualquer outra tela, o usuário escolhe a dele.
        if (usuario.trocarSenha && caminho !== '/conta.html' && caminho !== '/login.html') {
            res.writeHead(302, { Location: '/conta.html?obrigatorio=1' });
            res.end();
            return;
        }
        // O editor cria, altera e exclui painéis: nem chega a ser entregue a quem não é admin.
        if (caminho === '/index.html' && usuario.papel !== 'admin') {
            res.writeHead(302, { Location: '/lista_dashboards.html' });
            res.end();
            return;
        }
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

// ---------------------------------------------------------------------------
// Banco indisponível: o servidor fica no ar e diz o porquê
// ---------------------------------------------------------------------------

/**
 * Sem o banco, o servidor não cai: se caísse, a hospedagem mostraria só um
 * "503 Service Unavailable" genérico, sem pista do motivo. Em vez disso ele
 * sobe, tenta reconectar sozinho e explica o problema em /api/saude e numa
 * página de status.
 */
const estadoBanco = { motivo: 'Conectando ao banco de dados...', desde: new Date().toISOString() };

function escaparHtml(texto) {
    return String(texto).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function paginaBancoIndisponivel(res) {
    const corpo = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<meta http-equiv="refresh" content="20"><title>EPCVIEW · aguardando o banco</title>' +
        '<style>body{font-family:system-ui,sans-serif;background:#0b1730;color:#e8eefc;display:grid;place-items:center;' +
        'min-height:100vh;margin:0;padding:16px}main{max-width:34rem}h1{font-size:1.3rem}code{background:#16264a;' +
        'padding:.15rem .4rem;border-radius:4px}p{line-height:1.5;color:#b9c6e4}</style></head><body><main>' +
        '<h1>O sistema está no ar, mas sem acesso ao banco de dados</h1>' +
        '<p><strong>Motivo:</strong> ' + escaparHtml(estadoBanco.motivo) + '</p>' +
        '<p>O servidor tenta reconectar sozinho a cada 15 segundos, e esta página se atualiza a cada 20. ' +
        'Na Hostinger, confira as variáveis <code>DB_HOST</code>, <code>DB_PORT</code>, <code>DB_NAME</code>, ' +
        '<code>DB_USER</code> e <code>DB_PASSWORD</code> do app Node.js.</p></main></body></html>';
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '20' });
    res.end(corpo);
}

/** Atende o que dá para atender sem banco. Devolve true se já respondeu. */
function atenderSemBanco(req, res, url) {
    const caminho = url.pathname;
    if (caminho === '/api/saude') {
        enviarJSON(res, 503, { banco: 'indisponivel', motivo: estadoBanco.motivo, desde: estadoBanco.desde });
        return true;
    }
    if (caminho === '/api/config') return false;
    if (caminho.startsWith('/api/')) {
        enviarJSON(res, 503, { error: 'Banco de dados indisponível: ' + estadoBanco.motivo });
        return true;
    }
    // Site público, CSS, JS e imagens não dependem do banco; páginas do painel sim.
    const ehSite = SITE_PUBLICO && (caminho === '/' || caminho === '/site' || caminho.startsWith(PREFIXO_SITE));
    const ehPagina = caminho === '/' || caminho.endsWith('.html');
    if (ehPagina && !ehSite) { paginaBancoIndisponivel(res); return true; }
    return false;
}

const server = http.createServer(async (req, res) => {
    const url = analisarUrl(req);
    if (!db.pronto() && atenderSemBanco(req, res, url)) return;
    if (url.pathname === '/api/saude') { enviarJSON(res, 200, { banco: 'ok' }); return; }

    let usuario = null;
    try {
        usuario = await usuarioDaRequisicao(req);
    } catch (err) {
        console.error('[sessão]', err.message);
    }

    try {
        if (url.pathname.startsWith('/api/')) {
            // Com troca de senha pendente, só a sessão (login, logout, "eu", trocar senha) responde.
            if (usuario && usuario.trocarSenha && !url.pathname.startsWith('/api/sessao/') && url.pathname !== '/api/config') {
                enviarJSON(res, 403, { error: 'Troque sua senha para continuar.', codigo: 'TROCAR_SENHA' });
                return;
            }
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

const INTERVALO_RECONEXAO_MS = 15 * 1000;

/** Conecta ao banco; se falhar, registra o motivo e tenta de novo depois, sem derrubar o servidor. */
async function conectarBanco() {
    if (!db.configurado()) {
        estadoBanco.motivo = 'Variáveis do banco não configuradas (DB_NAME e DB_USER estão vazias).';
        console.error('  [db] ' + estadoBanco.motivo + ' Defina DB_HOST, DB_PORT, DB_NAME, DB_USER e DB_PASSWORD' +
                      ' no .env (local) ou nas variáveis de ambiente da hospedagem.');
        setTimeout(conectarBanco, INTERVALO_RECONEXAO_MS).unref();
        return;
    }
    try {
        await db.iniciar();
    } catch (err) {
        estadoBanco.motivo = db.explicarErroConexao(err);
        console.error('  [db] ' + estadoBanco.motivo + ' — nova tentativa em 15 s.');
        setTimeout(conectarBanco, INTERVALO_RECONEXAO_MS).unref();
        return;
    }

    try {
        const senhaInicial = await db.garantirAdmin();
        await db.limparSessoesVencidas();
        const totais = await db.resumo();
        console.log('  banco: ' + process.env.DB_NAME + ' @ ' + (process.env.DB_HOST || 'localhost'));
        console.log('  ' + totais.dashboards + ' dashboards  ·  ' + totais.planilhas + ' planilhas  ·  ' +
                    totais.usuarios + ' usuários  ·  ' + totais.grupos + ' grupos');
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
    } catch (err) {
        console.error('  [db] conectado, mas falhou ao preparar os dados: ' + err.message);
    }
}

setInterval(() => {
    if (db.pronto()) db.limparSessoesVencidas().catch(err => console.error('[db]', err.message));
}, 60 * 60 * 1000).unref();

// O servidor sobe primeiro, sem esperar o banco: a hospedagem considera o app
// no ar assim que a porta abre, e a página de status explica se o banco falhar.
server.listen(PORT, () => {
    console.log('');
    console.log('  EPCVIEW  ·  ' + (SITE_PUBLICO ? 'site: http://localhost:' + PORT + '  ·  ' : 'site público desligado  ·  ') +
                'painel: http://localhost:' + PORT + '/login.html');
    console.log('  ' + '-'.repeat(70));
    conectarBanco();
});
