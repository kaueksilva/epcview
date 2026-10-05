/**
 * Pedidos de contato / demonstração vindos do site público
 * ---------------------------------------------------------------------------
 * Ficam em data/contatos.json, FORA do database.json versionado: são dados
 * pessoais de quem preencheu o formulário (nome, e-mail, telefone) e não têm
 * por que ir para o git.
 *
 * O formulário é a única escrita que o servidor aceita sem login, então:
 *   - todo campo tem teto de tamanho e o e-mail é validado;
 *   - um campo "armadilha" (invisível para pessoas) descarta robôs em silêncio;
 *   - há limite de envios por IP numa janela de tempo;
 *   - a lista inteira tem teto, para um ataque não encher o disco.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const ARQUIVO = process.env.EPC_CONTATOS_ARQUIVO || path.join(__dirname, '..', 'data', 'contatos.json');

const MAX_CONTATOS = 5000;
const JANELA_MS = 10 * 60 * 1000;
const MAX_POR_JANELA = 5;

const LIMITES = { nome: 120, empresa: 160, email: 160, telefone: 40, interesse: 60, mensagem: 3000 };
const INTERESSES = ['demonstracao', 'proposta', 'parceria', 'outro'];

let cache = null;
let filaEscrita = Promise.resolve();
const enviosPorIp = new Map();   // ip -> [timestamps]

function carregar() {
    if (cache) return cache;
    try {
        cache = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
        if (!Array.isArray(cache.contatos)) cache.contatos = [];
    } catch {
        cache = { contatos: [] };
    }
    return cache;
}

function salvar() {
    const conteudo = JSON.stringify(cache, null, 2);
    filaEscrita = filaEscrita.then(async () => {
        await fsp.mkdir(path.dirname(ARQUIVO), { recursive: true });
        const tmp = ARQUIVO + '.tmp';
        await fsp.writeFile(tmp, conteudo, 'utf8');
        await fsp.rename(tmp, ARQUIVO);
    }).catch(err => console.error('[contatos] falha ao gravar: ' + err.message));
    return filaEscrita;
}

function erro(mensagem, status) {
    return Object.assign(new Error(mensagem), { status: status || 400 });
}

function texto(valor, limite) {
    return String(valor == null ? '' : valor).replace(/\s+/g, ' ').trim().slice(0, limite);
}

/** Registra o envio do IP; lança 429 se ele já passou do limite na janela. */
function conferirLimite(ip) {
    const agora = Date.now();
    const recentes = (enviosPorIp.get(ip) || []).filter(t => agora - t < JANELA_MS);
    if (recentes.length >= MAX_POR_JANELA) {
        throw erro('Muitos envios em sequência. Tente novamente em alguns minutos.', 429);
    }
    recentes.push(agora);
    enviosPorIp.set(ip, recentes);
}

/**
 * Valida e grava um contato. Retorna { ok: true } — inclusive quando a
 * armadilha pega um robô, para ele não aprender a contorná-la.
 */
function registrar(dados, ip) {
    const d = dados || {};
    if (texto(d.site, 200)) return { ok: true };   // armadilha preenchida: robô

    const contato = {
        nome: texto(d.nome, LIMITES.nome),
        empresa: texto(d.empresa, LIMITES.empresa),
        email: texto(d.email, LIMITES.email).toLowerCase(),
        telefone: texto(d.telefone, LIMITES.telefone),
        interesse: INTERESSES.includes(d.interesse) ? d.interesse : 'demonstracao',
        // Mensagem preserva quebras de linha; só corta o tamanho.
        mensagem: String(d.mensagem == null ? '' : d.mensagem).trim().slice(0, LIMITES.mensagem)
    };

    if (contato.nome.length < 2) throw erro('Informe seu nome.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(contato.email)) throw erro('Informe um e-mail válido.');

    conferirLimite(ip || 'desconhecido');

    const lista = carregar().contatos;
    lista.unshift(Object.assign({
        id: crypto.randomBytes(9).toString('hex'),
        criadoEm: new Date().toISOString(),
        lido: false
    }, contato));
    if (lista.length > MAX_CONTATOS) lista.length = MAX_CONTATOS;
    salvar();
    return { ok: true };
}

function listar() {
    return carregar().contatos.slice();
}

function contarNaoLidos() {
    return carregar().contatos.filter(c => !c.lido).length;
}

function marcar(id, campos) {
    const contato = carregar().contatos.find(c => c.id === id);
    if (!contato) throw erro('Contato não encontrado.', 404);
    if (campos && typeof campos.lido === 'boolean') contato.lido = campos.lido;
    salvar();
    return contato;
}

function remover(id) {
    const lista = carregar().contatos;
    const i = lista.findIndex(c => c.id === id);
    if (i < 0) throw erro('Contato não encontrado.', 404);
    lista.splice(i, 1);
    salvar();
}

/** Esquece IPs sem envio recente — o mapa não cresce para sempre. */
function limparLimites() {
    const agora = Date.now();
    for (const [ip, tempos] of enviosPorIp) {
        if (!tempos.some(t => agora - t < JANELA_MS)) enviosPorIp.delete(ip);
    }
}

module.exports = { registrar, listar, contarNaoLidos, marcar, remover, limparLimites, INTERESSES };
