'use strict';

/** O .zip da exportação precisa abrir em qualquer descompactador e devolver os bytes exatos. */

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { gerarZip, crc32 } = require('../lib/zip');

/** Leitor mínimo de zip, só para conferir o que gerarZip escreveu. */
function lerZip(zip) {
    const fim = zip.length - 22;
    assert.equal(zip.readUInt32LE(fim), 0x06054b50);
    const total = zip.readUInt16LE(fim + 10);
    let pos = zip.readUInt32LE(fim + 16);
    const saida = [];
    for (let i = 0; i < total; i++) {
        assert.equal(zip.readUInt32LE(pos), 0x02014b50);
        const metodo = zip.readUInt16LE(pos + 10);
        const crc = zip.readUInt32LE(pos + 16);
        const tamComprimido = zip.readUInt32LE(pos + 20);
        const tamNome = zip.readUInt16LE(pos + 28);
        const local = zip.readUInt32LE(pos + 42);
        const nome = zip.toString('utf8', pos + 46, pos + 46 + tamNome);
        const inicio = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
        const corpo = zip.subarray(inicio, inicio + tamComprimido);
        const dados = metodo === 8 ? zlib.inflateRawSync(corpo) : Buffer.from(corpo);
        assert.equal(crc32(dados), crc);
        saida.push({ nome, dados, metodo });
        pos += 46 + tamNome;
    }
    return saida;
}

test('crc32 bate com o valor conhecido', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926);
});

test('zip devolve os mesmos bytes e nomes com acento', () => {
    const texto = Buffer.from('linha;valor\n'.repeat(5000));      // comprime bem: deflate
    const aleatorio = crypto.randomBytes(300 * 1024);             // não comprime: guardado
    const arquivos = lerZip(gerarZip([
        { nome: 'P31-Segurança-REM.csv', dados: texto },
        { nome: 'P15 - Avanço FVI.xlsx', dados: aleatorio }
    ]));
    assert.equal(arquivos.length, 2);
    assert.equal(arquivos[0].nome, 'P31-Segurança-REM.csv');
    assert.equal(arquivos[0].metodo, 8);
    assert.ok(arquivos[0].dados.equals(texto));
    assert.equal(arquivos[1].nome, 'P15 - Avanço FVI.xlsx');
    assert.equal(arquivos[1].metodo, 0);
    assert.ok(arquivos[1].dados.equals(aleatorio));
});
