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

test('reenviar planilha guarda a anterior; restaurar troca as duas de lugar', async () => {
    const v1 = Buffer.from('versao 1'), v2 = Buffer.from('versao 2 mais longa');
    await db.salvarPlanilha('P30 - KPI.xlsx', v1, { id: 'a', nome: 'Ana' });
    await db.salvarPlanilha('P30 - KPI.xlsx', v1, autor);           // mesmo conteúdo: não vira versão
    assert.equal((await db.listarVersoesPlanilha('P30 - KPI.xlsx')).length, 0);

    await db.salvarPlanilha('P30 - KPI.xlsx', v2, autor);
    const versoes = await db.listarVersoesPlanilha('P30 - KPI.xlsx');
    assert.equal(versoes.length, 1);
    assert.equal(versoes[0].tamanho, v1.length);
    assert.ok((await db.lerVersaoPlanilha('P30 - KPI.xlsx', versoes[0].id)).dados.equals(v1));
    assert.ok((await db.lerPlanilha('P30 - KPI.xlsx')).dados.equals(v2));

    await db.restaurarVersaoPlanilha('P30 - KPI.xlsx', versoes[0].id, autor);
    assert.ok((await db.lerPlanilha('P30 - KPI.xlsx')).dados.equals(v1));
    const depois = await db.listarVersoesPlanilha('P30 - KPI.xlsx');
    assert.equal(depois.length, 1);                                  // a v2 foi para o histórico
    assert.ok((await db.lerVersaoPlanilha('P30 - KPI.xlsx', depois[0].id)).dados.equals(v2));

    // versão de outra planilha não é acessível por este nome
    assert.equal(await db.lerVersaoPlanilha('Outra.xlsx', depois[0].id), null);
});

test('histórico de planilha guarda só as 5 últimas e some ao remover a planilha', async () => {
    for (let i = 0; i < 8; i++) await db.salvarPlanilha('P40.xlsx', Buffer.from('conteudo ' + i), autor);
    const versoes = await db.listarVersoesPlanilha('P40.xlsx');
    assert.equal(versoes.length, 5);
    assert.ok((await db.lerVersaoPlanilha('P40.xlsx', versoes[0].id)).dados.equals(Buffer.from('conteudo 6')));
    await db.removerPlanilha('P40.xlsx');
    assert.equal((await db.listarVersoesPlanilha('P40.xlsx')).length, 0);
    const [{ total }] = await db.consultar('SELECT COUNT(*) AS total FROM planilha_versao_partes');
    assert.equal(Number(total), 0);
});

test('usuário criado pelo admin precisa trocar a senha; a troca pela própria conta libera', async () => {
    const g = await db.criarGrupo({ nome: 'Leitores' });
    const u = await db.criarUsuario({ login: 'caio', nome: 'Caio', senha: 'inicial1', grupoId: g.id });
    assert.equal(u.trocarSenha, true);

    const { token } = await db.autenticar('caio', 'inicial1');
    const outra = await db.autenticar('caio', 'inicial1');

    await assert.rejects(() => db.trocarPropriaSenha(u.id, 'errada', 'NovaSenha9', token), /senha atual está incorreta/);
    await assert.rejects(() => db.trocarPropriaSenha(u.id, 'inicial1', 'curta1', token), /pelo menos 8/);
    await assert.rejects(() => db.trocarPropriaSenha(u.id, 'inicial1', 'semnumeros', token), /letras e números/);
    await assert.rejects(() => db.trocarPropriaSenha(u.id, 'inicial1', 'inicial1', token), /pelo menos 8|diferente/);

    const trocado = await db.trocarPropriaSenha(u.id, 'inicial1', 'NovaSenha9', token);
    assert.equal(trocado.trocarSenha, false);
    assert.ok(await db.usuarioDaSessao(token));                   // a sessão de onde trocou continua
    assert.equal(await db.usuarioDaSessao(outra.token), null);    // as outras caem
    assert.ok(await db.autenticar('caio', 'NovaSenha9'));

    // admin redefine a senha: volta a exigir a troca
    assert.equal((await db.atualizarUsuario(u.id, { senha: 'outra123' })).trocarSenha, true);
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
