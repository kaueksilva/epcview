'use strict';

/**
 * Testa lib/permissoes.js — as mesmas funções que server.js chama em toda
 * rota de dashboards e páginas. Não testa server.js diretamente
 * porque importá-lo sobe um servidor de verdade (server.listen).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ARQUIVO_DB = path.join(os.tmpdir(), 'epcview-teste-permissoes-db-' + process.pid + '.json');
const ARQUIVO_SESSOES = path.join(os.tmpdir(), 'epcview-teste-permissoes-sessoes-' + process.pid + '.json');
process.env.UHN_DB_ARQUIVO = ARQUIVO_DB;
process.env.UHN_DB_ARQUIVO_SESSOES = ARQUIVO_SESSOES;

const db = require('../lib/db');
const { listaPermite, podeVerPagina, podeVerDashboard } = require('../lib/permissoes');

async function limpar() {
    await db._resetParaTestes();
    for (const arquivo of [ARQUIVO_DB, ARQUIVO_SESSOES]) {
        try { fs.unlinkSync(arquivo); } catch { /* já não existe */ }
    }
}

test.beforeEach(limpar);
test.after(limpar);

// ---------------------------------------------------------------------------
// listaPermite — a regra de baixo nível que todo o resto usa.
// ---------------------------------------------------------------------------

test('listaPermite: "todos" libera qualquer valor', () => {
    assert.equal(listaPermite('todos', 'qualquer-coisa'), true);
});

test('listaPermite: curinga "*" dentro da lista libera qualquer valor', () => {
    assert.equal(listaPermite(['*'], 'qualquer-coisa'), true);
});

test('listaPermite: lista normal só libera o que está nela', () => {
    assert.equal(listaPermite(['a', 'b'], 'a'), true);
    assert.equal(listaPermite(['a', 'b'], 'c'), false);
});

test('listaPermite: lista vazia nunca libera nada', () => {
    assert.equal(listaPermite([], 'a'), false);
});

// ---------------------------------------------------------------------------
// podeVerPagina
// ---------------------------------------------------------------------------

test('podeVerPagina: sem usuário logado, nunca', () => {
    assert.equal(podeVerPagina(null, 'planilhas'), false);
});

test('podeVerPagina: admin vê qualquer página', () => {
    const grupo = db.criarGrupo({ nome: 'Administradores', admin: true });
    const usuario = db.criarUsuario({ login: 'admin', nome: 'Admin', senha: 'senha123', grupoId: grupo.id });
    assert.equal(podeVerPagina(usuario, 'planilhas'), true);
    assert.equal(podeVerPagina(usuario, 'galeria'), true);
});

test('podeVerPagina: visualizador só vê a página que o grupo libera', () => {
    const grupo = db.criarGrupo({ nome: 'Suprimentos', admin: false, paginas: ['planilhas'] });
    const usuario = db.criarUsuario({ login: 'joao', nome: 'João', senha: 'senha123', grupoId: grupo.id });
    assert.equal(podeVerPagina(usuario, 'planilhas'), true);
    assert.equal(podeVerPagina(usuario, 'galeria'), false);
});

// ---------------------------------------------------------------------------
// podeVerDashboard
// ---------------------------------------------------------------------------

test('podeVerDashboard: grupo com dashboards "todos" vê qualquer painel', () => {
    const grupo = db.criarGrupo({ nome: 'Diretoria', admin: false, dashboards: 'todos' });
    const usuario = db.criarUsuario({ login: 'dir', nome: 'Diretor', senha: 'senha123', grupoId: grupo.id });
    assert.equal(podeVerDashboard(usuario, 'qualquer-painel-novo'), true);
});

test('podeVerDashboard: grupo com lista específica só vê os painéis dela', () => {
    const grupo = db.criarGrupo({ nome: 'Suprimentos', admin: false, dashboards: ['painel-suprimentos'] });
    const usuario = db.criarUsuario({ login: 'sup', nome: 'Sup', senha: 'senha123', grupoId: grupo.id });
    assert.equal(podeVerDashboard(usuario, 'painel-suprimentos'), true);
    assert.equal(podeVerDashboard(usuario, 'painel-financeiro'), false);
});
