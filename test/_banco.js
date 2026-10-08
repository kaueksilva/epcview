'use strict';

/**
 * Prepara o banco dos testes. Eles rodam contra um MySQL/MariaDB de teste,
 * NUNCA o de produção: as credenciais vêm de TEST_DB_* e o nome do banco
 * precisa conter "test" (lib/db.js recusa limpar qualquer outro).
 *
 * Exemplo com Docker:
 *   docker run -d --name epcview-mysql -e MYSQL_ROOT_PASSWORD=root \
 *     -e MYSQL_DATABASE=epc_test -p 3307:3306 mysql:8.0
 *   TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=3307 TEST_DB_USER=root \
 *     TEST_DB_PASSWORD=root TEST_DB_NAME=epc_test npm test
 *
 * Sem TEST_DB_NAME, os testes que precisam de banco são pulados.
 */

const test = require('node:test');

const disponivel = Boolean(process.env.TEST_DB_NAME);
if (disponivel) {
    process.env.DB_HOST = process.env.TEST_DB_HOST || '127.0.0.1';
    process.env.DB_PORT = process.env.TEST_DB_PORT || '3306';
    process.env.DB_USER = process.env.TEST_DB_USER || 'root';
    process.env.DB_PASSWORD = process.env.TEST_DB_PASSWORD || '';
    process.env.DB_NAME = process.env.TEST_DB_NAME;
}

const db = require('../lib/db');

function prepararBanco() {
    if (!disponivel) return;
    test.before(() => db.iniciar());
    test.beforeEach(() => db._limparParaTestes());
    test.after(async () => { await db._limparParaTestes(); await db.encerrar(); });
}

/** test() que é pulado quando não há banco de teste configurado. */
function testeComBanco(nome, fn) {
    return test(nome, { skip: disponivel ? false : 'defina TEST_DB_* para rodar' }, fn);
}

module.exports = { db, prepararBanco, testeComBanco };
