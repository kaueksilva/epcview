'use strict';

/**
 * Testa lib/permissoes.js — as mesmas funções que server.js chama em toda
 * rota de dashboards e páginas. Não testa server.js diretamente
 * porque importá-lo sobe um servidor de verdade (server.listen).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { db, prepararBanco, testeComBanco } = require('./_banco');
const { listaPermite, podeVerPagina, podeVerDashboard } = require('../lib/permissoes');

prepararBanco();

// ---------------------------------------------------------------------------
// listaPermite — a regra de baixo nível que todo o resto usa.
// ---------------------------------------------------------------------------

test('listaPermite: "todos" libera qualquer valor', async () => {
    assert.equal(listaPermite('todos', 'qualquer-coisa'), true);
});

test('listaPermite: curinga "*" dentro da lista libera qualquer valor', async () => {
    assert.equal(listaPermite(['*'], 'qualquer-coisa'), true);
});

test('listaPermite: lista normal só libera o que está nela', async () => {
    assert.equal(listaPermite(['a', 'b'], 'a'), true);
    assert.equal(listaPermite(['a', 'b'], 'c'), false);
});

test('listaPermite: lista vazia nunca libera nada', async () => {
    assert.equal(listaPermite([], 'a'), false);
});

// ---------------------------------------------------------------------------
// podeVerPagina
// ---------------------------------------------------------------------------

test('podeVerPagina: sem usuário logado, nunca', async () => {
    assert.equal(podeVerPagina(null, 'planilhas'), false);
});

testeComBanco('podeVerPagina: admin vê qualquer página', async () => {
    const grupo = await db.criarGrupo({ nome: 'Administradores', admin: true });
    const usuario = await db.criarUsuario({ login: 'admin', nome: 'Admin', senha: 'senha123', grupoId: grupo.id });
    assert.equal(podeVerPagina(usuario, 'planilhas'), true);
    assert.equal(podeVerPagina(usuario, 'galeria'), true);
});

testeComBanco('podeVerPagina: visualizador só vê a página que o grupo libera', async () => {
    const grupo = await db.criarGrupo({ nome: 'Suprimentos', admin: false, paginas: ['planilhas'] });
    const usuario = await db.criarUsuario({ login: 'joao', nome: 'João', senha: 'senha123', grupoId: grupo.id });
    assert.equal(podeVerPagina(usuario, 'planilhas'), true);
    assert.equal(podeVerPagina(usuario, 'galeria'), false);
});

// ---------------------------------------------------------------------------
// podeVerDashboard
// ---------------------------------------------------------------------------

testeComBanco('podeVerDashboard: grupo com dashboards "todos" vê qualquer painel', async () => {
    const grupo = await db.criarGrupo({ nome: 'Diretoria', admin: false, dashboards: 'todos' });
    const usuario = await db.criarUsuario({ login: 'dir', nome: 'Diretor', senha: 'senha123', grupoId: grupo.id });
    assert.equal(podeVerDashboard(usuario, 'qualquer-painel-novo'), true);
});

testeComBanco('podeVerDashboard: grupo com lista específica só vê os painéis dela', async () => {
    const grupo = await db.criarGrupo({ nome: 'Suprimentos', admin: false, dashboards: ['painel-suprimentos'] });
    const usuario = await db.criarUsuario({ login: 'sup', nome: 'Sup', senha: 'senha123', grupoId: grupo.id });
    assert.equal(podeVerDashboard(usuario, 'painel-suprimentos'), true);
    assert.equal(podeVerDashboard(usuario, 'painel-financeiro'), false);
});
