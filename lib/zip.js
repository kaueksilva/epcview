/**
 * Monta um arquivo .zip em memória, só com a biblioteca padrão (zlib).
 * ---------------------------------------------------------------------------
 * Usado para exportar várias planilhas de uma vez. Sem ZIP64: cada arquivo e o
 * total ficam bem abaixo de 4 GB (o upload já é limitado a 60 MB por planilha).
 *
 * Cada arquivo é comprimido com deflate; se isso não reduzir (xlsx já é um zip
 * por dentro), ele vai guardado sem compressão, que é mais rápido de abrir.
 */

const zlib = require('zlib');

const TABELA_CRC = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});

function crc32(dados) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < dados.length; i++) c = TABELA_CRC[(c ^ dados[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

/** Data e hora no formato do MS-DOS, que é o que o cabeçalho do zip guarda. */
function dataDos(data) {
    const d = data instanceof Date && !isNaN(data) ? data : new Date();
    const hora = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    const dia = ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { hora, dia };
}

/**
 * @param {{nome: string, dados: Buffer, data?: Date}[]} arquivos
 * @returns {Buffer}
 */
function gerarZip(arquivos) {
    const partes = [];
    const central = [];
    let deslocamento = 0;

    for (const arquivo of arquivos) {
        const nome = Buffer.from(arquivo.nome, 'utf8');
        const crc = crc32(arquivo.dados);
        const comprimido = zlib.deflateRawSync(arquivo.dados, { level: 6 });
        const usarDeflate = comprimido.length < arquivo.dados.length;
        const corpo = usarDeflate ? comprimido : arquivo.dados;
        const metodo = usarDeflate ? 8 : 0;
        const { hora, dia } = dataDos(arquivo.data);
        const FLAG_UTF8 = 0x0800;   // nomes com acento (Segurança, Avanço...) abrem certo no Windows

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(FLAG_UTF8, 6);
        local.writeUInt16LE(metodo, 8);
        local.writeUInt16LE(hora, 10);
        local.writeUInt16LE(dia, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(corpo.length, 18);
        local.writeUInt32LE(arquivo.dados.length, 22);
        local.writeUInt16LE(nome.length, 26);
        local.writeUInt16LE(0, 28);

        const registro = Buffer.alloc(46);
        registro.writeUInt32LE(0x02014b50, 0);
        registro.writeUInt16LE(20, 4);
        registro.writeUInt16LE(20, 6);
        registro.writeUInt16LE(FLAG_UTF8, 8);
        registro.writeUInt16LE(metodo, 10);
        registro.writeUInt16LE(hora, 12);
        registro.writeUInt16LE(dia, 14);
        registro.writeUInt32LE(crc, 16);
        registro.writeUInt32LE(corpo.length, 20);
        registro.writeUInt32LE(arquivo.dados.length, 24);
        registro.writeUInt16LE(nome.length, 28);
        // extra, comentário, disco, atributos internos/externos: tudo zero
        registro.writeUInt32LE(deslocamento, 42);

        partes.push(local, nome, corpo);
        central.push(registro, nome);
        deslocamento += local.length + nome.length + corpo.length;
    }

    const tamanhoCentral = central.reduce((s, b) => s + b.length, 0);
    const fim = Buffer.alloc(22);
    fim.writeUInt32LE(0x06054b50, 0);
    fim.writeUInt16LE(arquivos.length, 8);
    fim.writeUInt16LE(arquivos.length, 10);
    fim.writeUInt32LE(tamanhoCentral, 12);
    fim.writeUInt32LE(deslocamento, 16);

    return Buffer.concat([...partes, ...central, fim]);
}

module.exports = { gerarZip, crc32 };
