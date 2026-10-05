/**
 * Cliente para o Cloudflare R2 (armazenamento compatível com S3).
 * ---------------------------------------------------------------------------
 * As planilhas moram aqui em vez do disco local: o disco do Render é efêmero
 * (some a cada deploy/reinício no plano gratuito), enquanto o R2 é o mesmo
 * balde acessado de qualquer lugar — local e hospedado enxergam os mesmos
 * arquivos, e nada se perde.
 *
 * Sem SDK: só `https` e `crypto` da biblioteca padrão, assinando as
 * requisições manualmente com AWS Signature V4 (o R2 fala o mesmo protocolo
 * do S3). Mantém a filosofia do projeto de zero dependências.
 */

const https = require('https');
const crypto = require('crypto');

const ENDPOINT = process.env.R2_ENDPOINT || '';          // ex.: https://<id>.r2.cloudflarestorage.com
const BUCKET = process.env.R2_BUCKET || '';
const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const REGIAO = 'auto';

function configurado() {
    return Boolean(ENDPOINT && BUCKET && ACCESS_KEY_ID && SECRET_ACCESS_KEY);
}

function host() {
    return new URL(ENDPOINT).host;
}

// --- Assinatura AWS Signature V4 -------------------------------------------

function sha256Hex(dados) {
    return crypto.createHash('sha256').update(dados).digest('hex');
}

function hmac(chave, dado) {
    return crypto.createHmac('sha256', chave).update(dado, 'utf8').digest();
}

/** Codifica como o S3 exige: como encodeURIComponent, mas também escapando !'()* */
function codificar(segmento) {
    return encodeURIComponent(segmento).replace(/[!'()*]/g, c =>
        '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function caminhoCanonico(chave) {
    return '/' + codificar(BUCKET) + (chave ? '/' + chave.split('/').map(codificar).join('/') : '');
}

function assinar({ metodo, chave, query, corpo, cabecalhosExtra }) {
    const agora = new Date();
    const dataHora = agora.toISOString().replace(/[:-]|\.\d{3}/g, ''); // AAAAMMDDTHHMMSSZ
    const data = dataHora.slice(0, 8);
    const hashCorpo = sha256Hex(corpo || Buffer.alloc(0));

    const cabecalhos = Object.assign({
        host: host(),
        'x-amz-content-sha256': hashCorpo,
        'x-amz-date': dataHora
    }, corpo ? { 'content-length': String(corpo.length) } : {}, cabecalhosExtra || {});

    const nomesOrdenados = Object.keys(cabecalhos).sort();
    const cabecalhosCanonicos = nomesOrdenados.map(n => n + ':' + String(cabecalhos[n]).trim() + '\n').join('');
    const cabecalhosAssinados = nomesOrdenados.join(';');

    const queryCanonica = Object.keys(query || {}).sort()
        .map(k => codificar(k) + '=' + codificar(String(query[k])))
        .join('&');

    const requisicaoCanonica = [
        metodo, caminhoCanonico(chave), queryCanonica,
        cabecalhosCanonicos, cabecalhosAssinados, hashCorpo
    ].join('\n');

    const escopo = data + '/' + REGIAO + '/s3/aws4_request';
    const paraAssinar = ['AWS4-HMAC-SHA256', dataHora, escopo, sha256Hex(requisicaoCanonica)].join('\n');

    const kData = hmac('AWS4' + SECRET_ACCESS_KEY, data);
    const kRegiao = hmac(kData, REGIAO);
    const kServico = hmac(kRegiao, 's3');
    const kAssinatura = hmac(kServico, 'aws4_request');
    const assinatura = crypto.createHmac('sha256', kAssinatura).update(paraAssinar, 'utf8').digest('hex');

    const autorizacao = 'AWS4-HMAC-SHA256 Credential=' + ACCESS_KEY_ID + '/' + escopo +
        ', SignedHeaders=' + cabecalhosAssinados + ', Signature=' + assinatura;

    return Object.assign({}, cabecalhos, { Authorization: autorizacao });
}

function requisitar({ metodo, chave, query, corpo, cabecalhosExtra }) {
    return new Promise((resolve, reject) => {
        const cabecalhos = assinar({ metodo, chave, query, corpo, cabecalhosExtra });
        const queryString = Object.keys(query || {}).sort()
            .map(k => codificar(k) + '=' + codificar(String(query[k])))
            .join('&');
        const caminho = caminhoCanonico(chave) + (queryString ? '?' + queryString : '');

        const req = https.request(ENDPOINT + caminho, { method: metodo, headers: cabecalhos }, res => {
            const partes = [];
            res.on('data', d => partes.push(d));
            res.on('end', () => resolve({
                status: res.statusCode,
                corpo: Buffer.concat(partes)
            }));
        });
        req.on('error', reject);
        if (corpo) req.write(corpo);
        req.end();
    });
}

// --- API de alto nível -------------------------------------------------------

/** Lista os objetos do bucket como {nome, tamanho, atualizadoEm}. */
async function listar() {
    const objetos = [];
    let continuationToken = null;

    do {
        const query = { 'list-type': '2', 'max-keys': '1000' };
        if (continuationToken) query['continuation-token'] = continuationToken;

        const resp = await requisitar({ metodo: 'GET', chave: '', query });
        if (resp.status !== 200) throw erroR2('listar', resp);
        const xml = resp.corpo.toString('utf8');

        for (const bloco of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) || []) {
            const chave = (bloco.match(/<Key>([\s\S]*?)<\/Key>/) || [])[1];
            const tamanho = (bloco.match(/<Size>([\s\S]*?)<\/Size>/) || [])[1];
            const modificado = (bloco.match(/<LastModified>([\s\S]*?)<\/LastModified>/) || [])[1];
            if (chave) {
                objetos.push({
                    nome: decodificarEntidades(chave),
                    tamanho: Number(tamanho) || 0,
                    atualizadoEm: modificado || null
                });
            }
        }

        const truncado = /<IsTruncated>true<\/IsTruncated>/.test(xml);
        continuationToken = truncado
            ? (xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/) || [])[1]
            : null;
    } while (continuationToken);

    return objetos;
}

function decodificarEntidades(texto) {
    return texto.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

/** Busca um objeto; retorna null se não existir. */
async function buscar(chave) {
    const resp = await requisitar({ metodo: 'GET', chave });
    if (resp.status === 404) return null;
    if (resp.status !== 200) throw erroR2('buscar "' + chave + '"', resp);
    return resp.corpo;
}

/** Envia (cria ou sobrescreve) um objeto. */
async function enviar(chave, dados, tipoConteudo) {
    const resp = await requisitar({
        metodo: 'PUT', chave, corpo: dados,
        cabecalhosExtra: { 'content-type': tipoConteudo || 'application/octet-stream' }
    });
    if (resp.status !== 200) throw erroR2('enviar "' + chave + '"', resp);
}

/** Apaga um objeto. Não falha se ele já não existir (R2 responde 204 do mesmo jeito). */
async function apagar(chave) {
    const resp = await requisitar({ metodo: 'DELETE', chave });
    if (resp.status !== 204 && resp.status !== 200) throw erroR2('apagar "' + chave + '"', resp);
}

function erroR2(operacao, resp) {
    const trecho = resp.corpo.toString('utf8').slice(0, 300);
    return new Error('R2 falhou ao ' + operacao + ' (HTTP ' + resp.status + '): ' + trecho);
}

module.exports = { configurado, listar, buscar, enviar, apagar };
