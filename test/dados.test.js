'use strict';

/** Painéis com histórico, planilhas em partes e sessões — o que mudou ao ir para o MySQL. */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { db, prepararBanco, testeComBanco: test } = require('./_banco');

prepararBanco();

const autor = { id: 'u1', nome: 'Fulano' };

test('salvar painel gera slug único e só arquiva versão quando o código muda', async () => {
    const a = await db.salvarDashboard({ titulo: 'Curva S', codigo: 'v1', fontes: ['P21'] }, autor);
    const b = await db.salvarDashboard({ titulo: 'Curva S', codigo: 'x' }, autor);
    assert.equal(a.id, 'curva-s');
    assert.equal(b.id, 'curva-s-2');

    await db.salvarDashboard({ id: a.id, titulo: 'Curva S', codigo: 'v1', fontes: ['P21'] }, autor);
    assert.equal((await db.listarVersoes(a.id)).length, 0);

    await db.salvarDashboard({ id: a.id, titulo: 'Curva S', codigo: 'v2' }, autor);
    await db.salvarDashboard({ id: a.id, titulo: 'Curva S', codigo: 'v3' }, autor);
    const versoes = await db.listarVersoes(a.id);
    assert.equal(versoes.length, 2);
    assert.equal(versoes[0].tamanhoCodigo, 2);
    assert.deepEqual(versoes[1].fontes, ['P21']);   // a mais antiga é a v1
});

test('restaurar versão troca o código e guarda o atual no histórico', async () => {
    const d = await db.salvarDashboard({ titulo: 'Painel', codigo: 'v1' }, autor);
    await db.salvarDashboard({ id: d.id, titulo: 'Painel', codigo: 'v2' }, autor);
    const restaurado = await db.restaurarVersao(d.id, 0, autor);
    assert.equal(restaurado.codigo, 'v1');
    const versoes = await db.listarVersoes(d.id);
    assert.equal(versoes.length, 1);
    assert.equal(versoes[0].tamanhoCodigo, 2);
});

test('histórico para em 15 versões', async () => {
    const d = await db.salvarDashboard({ titulo: 'Longo', codigo: 'c0' }, autor);
    for (let i = 1; i <= 20; i++) await db.salvarDashboard({ id: d.id, titulo: 'Longo', codigo: 'c' + i }, autor);
    assert.equal((await db.listarVersoes(d.id)).length, 15);
});

test('remover painel apaga o histórico e tira o painel das listas dos grupos', async () => {
    const d = await db.salvarDashboard({ titulo: 'Some', codigo: 'a' }, autor);
    await db.salvarDashboard({ id: d.id, titulo: 'Some', codigo: 'b' }, autor);
    const g = await db.criarGrupo({ nome: 'G', dashboards: [d.id, 'outro'] });
    await db.removerDashboard(d.id);
    await db.removerDashboardDosGrupos(d.id);
    assert.equal(await db.acharDashboard(d.id), null);
    assert.deepEqual((await db.acharGrupo(g.id)).dashboards, ['outro']);
    await assert.rejects(() => db.removerDashboard(d.id), /não encontrado/);
});

test('planilha maior que uma parte volta byte a byte igual', async () => {
    const dados = crypto.randomBytes(5 * 1024 * 1024 + 123);
    const meta = await db.salvarPlanilha('P21 - Curva.xlsx', dados, autor);
    assert.equal(meta.apelido, 'P21');
    assert.equal(meta.tamanho, dados.length);
    assert.deepEqual(meta.enviadoPor, autor);

    const lida = await db.lerPlanilha('P21 - Curva.xlsx');
    assert.ok(lida.dados.equals(dados));

    // Reenviar menor substitui todas as partes antigas.
    await db.salvarPlanilha('P21 - Curva.xlsx', Buffer.from('abc'), autor);
    assert.equal((await db.lerPlanilha('P21 - Curva.xlsx')).dados.toString(), 'abc');
    assert.equal((await db.listarPlanilhas()).length, 1);

    assert.equal(await db.removerPlanilha('P21 - Curva.xlsx'), true);
    assert.equal(await db.lerPlanilha('P21 - Curva.xlsx'), null);
});

test('login cria sessão, e trocar a senha derruba as sessões abertas', async () => {
    const g = await db.criarGrupo({ nome: 'Adm', admin: true });
    const u = await db.criarUsuario({ login: 'ana', nome: 'Ana', senha: 'segredo1', grupoId: g.id });
    assert.equal(await db.autenticar('ana', 'errada'), null);
    assert.equal(await db.autenticar('ninguem', 'segredo1'), null);

    const { token, usuario } = await db.autenticar('ANA', 'segredo1');
    assert.equal(usuario.papel, 'admin');
    assert.equal(usuario.senha, undefined);
    assert.equal((await db.usuarioDaSessao(token)).id, u.id);
    assert.ok((await db.acharUsuario(u.id)).ultimoAcesso);

    await db.atualizarUsuario(u.id, { senha: 'nova-senha' });
    assert.equal(await db.usuarioDaSessao(token), null);
    assert.ok(await db.autenticar('ana', 'nova-senha'));
});

test('garantirAdmin cria o primeiro admin uma única vez', async () => {
    const senha = await db.garantirAdmin();
    assert.ok(senha);
    assert.equal(await db.garantirAdmin(), null);
    const { usuario } = await db.autenticar('admin', senha);
    assert.equal(usuario.papel, 'admin');
});
