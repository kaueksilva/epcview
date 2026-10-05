/**
 * "Dockers" — registra e roda outros sistemas (containers Docker) de dentro
 * do UHNIntegra, no mesmo espírito da versão original: sobe um .tar + um
 * .sha256, o servidor confere o checksum, carrega a imagem, roda o container
 * e passa a expor a aplicação em /<extensaoUrl>/... via proxy reverso.
 *
 * Só funciona num host com o Docker Engine acessível pelo processo Node
 * (funciona local; o plano atual do Render não dá acesso ao daemon do Docker).
 *
 * Uploads são gravados em disco em streaming (nunca bufferizados inteiros em
 * memória) porque o .tar de um container pode chegar a alguns GB.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { execFile } = require('child_process');

const ARQUIVO = path.join(__dirname, '..', 'data', 'dockers.json');
const PASTA_UPLOADS = path.join(__dirname, '..', 'data', 'dockers-uploads');

const PORTA_MIN = 3601;   // faixa própria: não colide com o uhnintegra2 (3501–3600) no mesmo host
const PORTA_MAX = 3700;
const LIMITE_TAR_BYTES = 2 * 1024 * 1024 * 1024; // 2GB — mesmo teto do uhnintegra original

// Slugs que já significam outra coisa na raiz do site; não podem virar extensaoUrl.
const SLUGS_RESERVADOS = new Set([
    'api', 'assets', 'index', 'login', 'usuarios', 'planilhas',
    'viewer', 'sandbox', 'dockers', 'lista_dashboards', 'favicon.svg', 'style.css',
    'site', 'contatos', 'contatos.html'
]);

let cache = null;
let filaEscrita = Promise.resolve();
const uploadsPendentes = new Map(); // uploadId -> { caminho, tamanho, sha256, criadoEm }

// ---------------------------------------------------------------------------
// Persistência (fora do database.json versionado: carrega token de acesso)
// ---------------------------------------------------------------------------

function carregar() {
    if (cache) return cache;
    try {
        cache = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
        if (!Array.isArray(cache.apps)) cache.apps = [];
    } catch {
        cache = { apps: [] };
    }
    // Migração: o antigo "permitirOutrosGrupos" (sim/não) virou uma lista de grupos
    // — '*' preserva o sentido de "qualquer usuário logado" de quem já estava marcado.
    cache.apps.forEach(a => {
        if (a.gruposPermitidos === undefined) {
            a.gruposPermitidos = a.permitirOutrosGrupos ? ['*'] : [];
        }
        delete a.permitirOutrosGrupos;
    });
    return cache;
}

function normalizarGruposPermitidos(valor) {
    if (!Array.isArray(valor)) return [];
    return [...new Set(valor.map(String).filter(Boolean))];
}

function salvar() {
    const conteudo = JSON.stringify(cache, null, 2);
    filaEscrita = filaEscrita.then(async () => {
        await fsp.mkdir(path.dirname(ARQUIVO), { recursive: true });
        const tmp = ARQUIVO + '.tmp';
        await fsp.writeFile(tmp, conteudo, 'utf8');
        await fsp.rename(tmp, ARQUIVO);
    }).catch(err => console.error('[dockers] falha ao gravar: ' + err.message));
    return filaEscrita;
}

function listar() {
    return carregar().apps.slice().sort((a, b) => a.titulo.localeCompare(b.titulo, 'pt-BR'));
}

function obter(id) {
    return carregar().apps.find(a => a.id === id) || null;
}

function obterPorExtensao(extensaoUrl) {
    return carregar().apps.find(a => a.extensaoUrl === extensaoUrl) || null;
}

// ---------------------------------------------------------------------------
// Validação e geração
// ---------------------------------------------------------------------------

function limparExtensaoUrl(bruto) {
    return String(bruto || '').trim().toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function gerarToken() {
    return crypto.randomBytes(32).toString('hex');
}

function novoId() {
    return crypto.randomBytes(9).toString('hex');
}

// ---------------------------------------------------------------------------
// Docker CLI
// ---------------------------------------------------------------------------

function executarDocker(args, opcoes) {
    return new Promise((resolve, reject) => {
        execFile('docker', args, Object.assign({ maxBuffer: 32 * 1024 * 1024 }, opcoes || {}), (err, stdout, stderr) => {
            if (err) { reject(Object.assign(new Error((stderr || err.message).trim()), { stdout, stderr })); return; }
            resolve({ stdout, stderr });
        });
    });
}

async function dockerDisponivel() {
    try {
        await executarDocker(['version', '--format', '{{.Server.Version}}'], { timeout: 5000 });
        return true;
    } catch {
        return false;
    }
}

async function carregarImagem(caminhoTar) {
    const { stdout } = await executarDocker(['load', '-i', caminhoTar], { timeout: 0 });
    const m = stdout.match(/Loaded image(?:\(s\))?:\s*(\S+)/);
    if (!m) throw new Error('Não reconheci a imagem carregada: ' + stdout.trim());
    return m[1]; // ex.: uhnintegra-uhnsup:latest
}

function nomeContainer(extensaoUrl) {
    return 'epcview-docker-' + extensaoUrl;
}

async function containerExiste(nome) {
    try {
        const { stdout } = await executarDocker(
            ['ps', '-a', '--filter', 'name=^' + nome + '$', '--format', '{{.Names}}'], { timeout: 8000 });
        return stdout.trim() === nome;
    } catch {
        return false;
    }
}

/** 'rodando' | 'saudavel' | 'com-problema' | 'parado' | 'nao-encontrado' | 'desconhecido' */
async function statusContainer(nome) {
    try {
        const { stdout } = await executarDocker(
            ['ps', '-a', '--filter', 'name=^' + nome + '$', '--format', '{{.Status}}'], { timeout: 8000 });
        const texto = stdout.trim();
        if (!texto) return 'nao-encontrado';
        if (!/^Up/.test(texto)) return 'parado';
        if (texto.includes('(healthy)')) return 'saudavel';
        if (texto.includes('(unhealthy)')) return 'com-problema';
        return 'rodando';
    } catch {
        return 'desconhecido';
    }
}

async function iniciarContainer({ extensaoUrl, porta, imagem }) {
    const nome = nomeContainer(extensaoUrl);
    if (await containerExiste(nome)) {
        await executarDocker(['start', nome], { timeout: 15000 });
        return;
    }
    // Publica só em loopback: quem acessa de fora passa pelo proxy do
    // UHNIntegra (com login), nunca fala direto com o container.
    await executarDocker([
        'run', '-d', '--name', nome, '--restart', 'unless-stopped',
        '-p', '127.0.0.1:' + porta + ':' + porta,
        '-e', 'PORT=' + porta,
        imagem
    ], { timeout: 30000 });
}

async function pararContainer(extensaoUrl) {
    try { await executarDocker(['stop', nomeContainer(extensaoUrl)], { timeout: 20000 }); } catch { /* já parado */ }
}

async function removerContainer(extensaoUrl) {
    try { await executarDocker(['rm', '-f', nomeContainer(extensaoUrl)], { timeout: 20000 }); } catch { /* já não existe */ }
}

// ---------------------------------------------------------------------------
// Upload em streaming (nunca bufferiza o arquivo inteiro em memória)
// ---------------------------------------------------------------------------

async function receberUpload(req) {
    await fsp.mkdir(PASTA_UPLOADS, { recursive: true });
    return new Promise((resolve, reject) => {
        const uploadId = novoId();
        const caminho = path.join(PASTA_UPLOADS, uploadId);
        const hash = crypto.createHash('sha256');
        const gravador = fs.createWriteStream(caminho);
        let tamanho = 0;
        let estourou = false;

        req.on('data', chunk => {
            tamanho += chunk.length;
            if (tamanho > LIMITE_TAR_BYTES) {
                estourou = true;
                gravador.destroy();
                req.destroy();
                return;
            }
            hash.update(chunk);
        });
        req.on('error', err => { gravador.destroy(); reject(err); });
        req.on('close', () => {
            if (estourou) {
                fsp.unlink(caminho).catch(() => {});
                reject(Object.assign(new Error('Arquivo maior que 2GB.'), { status: 413 }));
            }
        });
        gravador.on('error', reject);
        gravador.on('finish', () => {
            if (estourou) return; // 'close' do req já vai rejeitar
            const sha256 = hash.digest('hex');
            uploadsPendentes.set(uploadId, { caminho, tamanho, sha256, criadoEm: Date.now() });
            resolve({ uploadId, tamanho, sha256 });
        });

        req.pipe(gravador);
    });
}

function pegarUpload(uploadId) {
    return uploadsPendentes.get(uploadId) || null;
}

async function descartarUpload(uploadId) {
    const info = uploadsPendentes.get(uploadId);
    uploadsPendentes.delete(uploadId);
    if (info) await fsp.unlink(info.caminho).catch(() => {});
}

/** Limpa uploads temporários órfãos de uma queda do processo no meio de um envio. */
async function limparUploadsOrfaos() {
    try {
        const arquivos = await fsp.readdir(PASTA_UPLOADS);
        await Promise.all(arquivos.map(f => fsp.unlink(path.join(PASTA_UPLOADS, f)).catch(() => {})));
    } catch { /* pasta ainda não existe */ }
}

// ---------------------------------------------------------------------------
// CRUD de alto nível
// ---------------------------------------------------------------------------

async function registrarApp(dados, autor) {
    const { titulo, extensaoUrl, porta, tokenAcesso, gruposPermitidos, exibirEm, uploadIdTar, uploadIdSha256 } = dados || {};

    if (!await dockerDisponivel()) {
        throw Object.assign(new Error('Docker não está disponível neste servidor.'), { status: 503 });
    }

    const tituloLimpo = String(titulo || '').trim();
    if (!tituloLimpo) throw Object.assign(new Error('Dê um título para a aplicação.'), { status: 400 });

    const slug = limparExtensaoUrl(extensaoUrl);
    if (!slug) throw Object.assign(new Error('Extensão de URL inválida.'), { status: 400 });
    if (SLUGS_RESERVADOS.has(slug) || obterPorExtensao(slug)) {
        throw Object.assign(new Error('Essa extensão de URL já está em uso.'), { status: 409 });
    }

    const portaNum = Number(porta);
    if (!Number.isInteger(portaNum) || portaNum < PORTA_MIN || portaNum > PORTA_MAX) {
        throw Object.assign(new Error('Porta deve ser um número entre ' + PORTA_MIN + ' e ' + PORTA_MAX + '.'), { status: 400 });
    }
    if (carregar().apps.some(a => a.porta === portaNum)) {
        throw Object.assign(new Error('Essa porta já está em uso por outra aplicação.'), { status: 409 });
    }

    const uploadTar = pegarUpload(uploadIdTar);
    const uploadSha = pegarUpload(uploadIdSha256);
    if (!uploadTar) throw Object.assign(new Error('Envie o arquivo .TAR antes de cadastrar.'), { status: 400 });
    if (!uploadSha) throw Object.assign(new Error('Envie o arquivo .sha256 antes de cadastrar.'), { status: 400 });

    const shaEsperado = (await fsp.readFile(uploadSha.caminho, 'utf8')).trim().split(/\s+/)[0].toLowerCase();
    if (shaEsperado !== uploadTar.sha256) {
        await descartarUpload(uploadIdTar);
        await descartarUpload(uploadIdSha256);
        throw Object.assign(new Error('O checksum do .sha256 não confere com o .TAR enviado.'), { status: 400 });
    }

    let imagem;
    try {
        imagem = await carregarImagem(uploadTar.caminho);
    } finally {
        await descartarUpload(uploadIdTar);
        await descartarUpload(uploadIdSha256);
    }

    const registro = {
        id: novoId(),
        titulo: tituloLimpo,
        extensaoUrl: slug,
        porta: portaNum,
        tokenAcesso: (tokenAcesso && String(tokenAcesso).trim()) || gerarToken(),
        gruposPermitidos: normalizarGruposPermitidos(gruposPermitidos),
        exibirEm: exibirEm === 'oculto' ? 'oculto' : 'menu',
        imagem,
        autor: autor ? { id: autor.id, nome: autor.nome } : null,
        criadoEm: new Date().toISOString(),
        atualizadoEm: new Date().toISOString()
    };

    try {
        await iniciarContainer(registro);
    } catch (err) {
        throw Object.assign(new Error('Imagem carregada, mas falhou ao iniciar o container: ' + err.message), { status: 500 });
    }

    carregar().apps.push(registro);
    await salvar();
    return registro;
}

/** Campos leves, editáveis sem redeploy: título, visibilidade no menu e quem acessa. */
function atualizarApp(id, campos) {
    const registro = obter(id);
    if (!registro) throw Object.assign(new Error('Aplicação não encontrada.'), { status: 404 });

    if (campos.titulo !== undefined) {
        const tituloLimpo = String(campos.titulo).trim();
        if (!tituloLimpo) throw Object.assign(new Error('Dê um título para a aplicação.'), { status: 400 });
        registro.titulo = tituloLimpo;
    }
    if (campos.exibirEm !== undefined) {
        registro.exibirEm = campos.exibirEm === 'oculto' ? 'oculto' : 'menu';
    }
    if (campos.gruposPermitidos !== undefined) {
        registro.gruposPermitidos = normalizarGruposPermitidos(campos.gruposPermitidos);
    }
    registro.atualizadoEm = new Date().toISOString();

    salvar();
    return registro;
}

/**
 * Redeploy: troca a imagem de uma aplicação já cadastrada, sem mexer no resto
 * (extensão, porta, token, grupos). O container atual é derrubado e recriado
 * com a imagem nova — quem estiver usando a aplicação sente uma interrupção breve.
 */
async function atualizarImagem(id, dados) {
    const registro = obter(id);
    if (!registro) throw Object.assign(new Error('Aplicação não encontrada.'), { status: 404 });

    if (!await dockerDisponivel()) {
        throw Object.assign(new Error('Docker não está disponível neste servidor.'), { status: 503 });
    }

    const { uploadIdTar, uploadIdSha256 } = dados || {};
    const uploadTar = pegarUpload(uploadIdTar);
    const uploadSha = pegarUpload(uploadIdSha256);
    if (!uploadTar) throw Object.assign(new Error('Envie o arquivo .TAR antes de atualizar.'), { status: 400 });
    if (!uploadSha) throw Object.assign(new Error('Envie o arquivo .sha256 antes de atualizar.'), { status: 400 });

    const shaEsperado = (await fsp.readFile(uploadSha.caminho, 'utf8')).trim().split(/\s+/)[0].toLowerCase();
    if (shaEsperado !== uploadTar.sha256) {
        await descartarUpload(uploadIdTar);
        await descartarUpload(uploadIdSha256);
        throw Object.assign(new Error('O checksum do .sha256 não confere com o .TAR enviado.'), { status: 400 });
    }

    let imagem;
    try {
        imagem = await carregarImagem(uploadTar.caminho);
    } finally {
        await descartarUpload(uploadIdTar);
        await descartarUpload(uploadIdSha256);
    }

    // Precisa recriar o container: um "start" reaproveitaria a imagem antiga já vinculada a ele.
    await removerContainer(registro.extensaoUrl);
    try {
        await iniciarContainer({ extensaoUrl: registro.extensaoUrl, porta: registro.porta, imagem });
    } catch (err) {
        throw Object.assign(new Error('Imagem carregada, mas falhou ao reiniciar o container: ' + err.message), { status: 500 });
    }

    registro.imagem = imagem;
    registro.atualizadoEm = new Date().toISOString();
    await salvar();
    return registro;
}

async function removerApp(id) {
    const dados = carregar();
    const registro = dados.apps.find(a => a.id === id);
    if (!registro) throw Object.assign(new Error('Aplicação não encontrada.'), { status: 404 });

    await removerContainer(registro.extensaoUrl);
    dados.apps = dados.apps.filter(a => a.id !== id);
    await salvar();
    return { status: 'removida' };
}

async function pausarApp(id) {
    const registro = obter(id);
    if (!registro) throw Object.assign(new Error('Aplicação não encontrada.'), { status: 404 });
    await pararContainer(registro.extensaoUrl);
}

async function religarApp(id) {
    const registro = obter(id);
    if (!registro) throw Object.assign(new Error('Aplicação não encontrada.'), { status: 404 });
    await iniciarContainer(registro);
}

async function listarComStatus() {
    return Promise.all(listar().map(async a => {
        const { tokenAcesso, ...semToken } = a;
        return Object.assign(semToken, { status: await statusContainer(nomeContainer(a.extensaoUrl)) });
    }));
}

// ---------------------------------------------------------------------------
// Proxy reverso
// ---------------------------------------------------------------------------

/** Encaminha a requisição para o container local, na porta registrada. */
function encaminhar(req, res, registro, caminhoResto) {
    const upstream = http.request({
        host: '127.0.0.1',
        port: registro.porta,
        path: caminhoResto || '/',
        method: req.method,
        headers: req.headers
    }, respostaUpstream => {
        res.writeHead(respostaUpstream.statusCode, respostaUpstream.headers);
        respostaUpstream.pipe(res);
    });
    upstream.on('error', () => {
        if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'A aplicação "' + registro.titulo + '" não respondeu.' }));
        } else {
            res.end();
        }
    });
    req.pipe(upstream);
}

module.exports = {
    listar, obter, obterPorExtensao, listarComStatus,
    dockerDisponivel, receberUpload, descartarUpload, limparUploadsOrfaos,
    registrarApp, atualizarApp, atualizarImagem, removerApp, pausarApp, religarApp, encaminhar,
    PORTA_MIN, PORTA_MAX
};
