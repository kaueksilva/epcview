/**
 * Carrega um .env local para process.env, sem dependência externa.
 * Só usado em desenvolvimento: no Render (e em qualquer host de verdade) as
 * variáveis vêm do painel do serviço, não de um arquivo. Variáveis já
 * definidas no ambiente nunca são sobrescritas por este loader.
 */

const fs = require('fs');
const path = require('path');

module.exports = function carregarEnvLocal() {
    let texto;
    try {
        texto = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    } catch {
        return; // sem .env: segue só com o que já está no ambiente
    }

    for (const linha of texto.split('\n')) {
        const limpa = linha.trim();
        if (!limpa || limpa.startsWith('#')) continue;
        const igual = limpa.indexOf('=');
        if (igual === -1) continue;

        const chave = limpa.slice(0, igual).trim();
        let valor = limpa.slice(igual + 1).trim();
        if ((valor.startsWith('"') && valor.endsWith('"')) || (valor.startsWith("'") && valor.endsWith("'"))) {
            valor = valor.slice(1, -1);
        }
        if (!(chave in process.env)) process.env[chave] = valor;
    }
};
