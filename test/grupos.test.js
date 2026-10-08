'use strict';

/**
 * Grupo substituiu papel: estes testes protegem exatamente o que mudou —
 * criação/edição de grupos e usuários, e as travas que nunca deixam o
 * sistema ficar sem nenhum administrador.
 *
 * Roda contra um banco de teste (ver test/_banco.js), nunca o de produção.
 */

const assert = require('node:assert/strict');
const { db, prepararBanco, testeComBanco: test } = require('./_banco');

prepararBanco();

// ---------------------------------------------------------------------------
// Criar usuário exige grupo — é o grupo que decide admin ou não agora.
// ---------------------------------------------------------------------------

test('criarUsuario recusa quando não informa grupo', async () => {
    await assert.rejects(
        () => db.criarUsuario({ login: 'joao', nome: 'João', senha: 'senha123' }),
        /Selecione um grupo/
    );
});

test('criarUsuario recusa um grupoId que não existe', async () => {
    await assert.rejects(
        () => db.criarUsuario({ login: 'joao', nome: 'João', senha: 'senha123', grupoId: 'inexistente' }),
        /Selecione um grupo/
    );
});

test('usuário num grupo admin resolve papel "admin"', async () => {
    const grupo = await db.criarGrupo({ nome: 'Administradores', admin: true });
    const usuario = await db.criarUsuario({ login: 'admin2', nome: 'Admin', senha: 'senha123', grupoId: grupo.id });
    assert.equal(usuario.papel, 'admin');
});

test('usuário num grupo comum resolve papel "visualizador"', async () => {
    const grupo = await db.criarGrupo({ nome: 'Suprimentos', admin: false, paginas: ['planilhas'] });
    const usuario = await db.criarUsuario({ login: 'joao', nome: 'João', senha: 'senha123', grupoId: grupo.id });
    assert.equal(usuario.papel, 'visualizador');
});

test('e-mail inválido é recusado ao criar e ao editar', async () => {
    const grupo = await db.criarGrupo({ nome: 'Suprimentos', admin: false });
    await assert.rejects(
        () => db.criarUsuario({ login: 'joao', nome: 'João', senha: 'senha123', grupoId: grupo.id, email: 'não é email' }),
        /E-mail inválido/
    );
    const usuario = await db.criarUsuario({ login: 'joao', nome: 'João', senha: 'senha123', grupoId: grupo.id });
    await assert.rejects(
        () => db.atualizarUsuario(usuario.id, { email: 'não é email' }), /E-mail inválido/);
});

// ---------------------------------------------------------------------------
// permissoesDoUsuario — o que cada papel efetivamente enxerga.
// ---------------------------------------------------------------------------

test('permissoesDoUsuario: admin vê tudo, independente do que o grupo tem configurado', async () => {
    const grupo = await db.criarGrupo({ nome: 'Administradores', admin: true, paginas: [], dashboards: [] });
    const usuario = await db.criarUsuario({ login: 'admin2', nome: 'Admin', senha: 'senha123', grupoId: grupo.id });
    assert.deepEqual(db.permissoesDoUsuario(usuario), { paginas: 'todos', dashboards: 'todos' });
});

test('permissoesDoUsuario: visualizador herda exatamente o que o grupo libera', async () => {
    const grupo = await db.criarGrupo({
        nome: 'Suprimentos', admin: false,
        paginas: ['planilhas'], dashboards: ['painel-suprimentos']
    });
    const usuario = await db.criarUsuario({ login: 'joao', nome: 'João', senha: 'senha123', grupoId: grupo.id });
    const permissoes = db.permissoesDoUsuario(usuario);
    assert.deepEqual(permissoes.paginas, ['planilhas']);
    assert.deepEqual(permissoes.dashboards, ['painel-suprimentos']);
});

// ---------------------------------------------------------------------------
// Nunca deixar o sistema sem nenhum administrador.
// ---------------------------------------------------------------------------

test('não deixa remover o único administrador', async () => {
    const grupo = await db.criarGrupo({ nome: 'Administradores', admin: true });
    const usuario = await db.criarUsuario({ login: 'admin2', nome: 'Admin', senha: 'senha123', grupoId: grupo.id });
    await assert.rejects(
        () => db.removerUsuario(usuario.id), /único administrador/);
});

test('permite remover um admin quando existe outro', async () => {
    const grupo = await db.criarGrupo({ nome: 'Administradores', admin: true });
    const a1 = await db.criarUsuario({ login: 'admin1', nome: 'Admin 1', senha: 'senha123', grupoId: grupo.id });
    const a2 = await db.criarUsuario({ login: 'admin2', nome: 'Admin 2', senha: 'senha123', grupoId: grupo.id });
    await db.removerUsuario(a1.id);
    assert.notEqual(await db.acharUsuario(a2.id), null);
});

test('não deixa mover o único admin para um grupo comum', async () => {
    const grupoAdmin = await db.criarGrupo({ nome: 'Administradores', admin: true });
    const grupoComum = await db.criarGrupo({ nome: 'Visualizadores', admin: false });
    const usuario = await db.criarUsuario({ login: 'admin2', nome: 'Admin', senha: 'senha123', grupoId: grupoAdmin.id });
    await assert.rejects(
        () => db.atualizarUsuario(usuario.id, { grupoId: grupoComum.id }), /único administrador/);
});

test('permite mover um admin de grupo quando outro grupo admin com gente cobre a saída', async () => {
    const grupoAdmin1 = await db.criarGrupo({ nome: 'Administradores', admin: true });
    const grupoAdmin2 = await db.criarGrupo({ nome: 'Superadmins', admin: true });
    const usuario = await db.criarUsuario({ login: 'admin2', nome: 'Admin', senha: 'senha123', grupoId: grupoAdmin1.id });
    await db.criarUsuario({ login: 'admin3', nome: 'Admin 3', senha: 'senha123', grupoId: grupoAdmin2.id });
    await assert.doesNotReject(() => db.atualizarUsuario(usuario.id, { grupoId: grupoAdmin2.id }));
});

test('não deixa rebaixar o único grupo admin enquanto tem membro', async () => {
    const grupo = await db.criarGrupo({ nome: 'Administradores', admin: true });
    await db.criarUsuario({ login: 'admin2', nome: 'Admin', senha: 'senha123', grupoId: grupo.id });
    await assert.rejects(
        () => db.atualizarGrupo(grupo.id, { admin: false }), /sem nenhum administrador/);
});

test('permite rebaixar um grupo admin vazio', async () => {
    const grupo = await db.criarGrupo({ nome: 'Administradores', admin: true });
    await assert.doesNotReject(() => db.atualizarGrupo(grupo.id, { admin: false }));
});

// ---------------------------------------------------------------------------
// Grupo com gente dentro não pode sumir sem avisar pra onde eles vão.
// ---------------------------------------------------------------------------

test('não deixa remover um grupo que ainda tem usuários', async () => {
    const grupo = await db.criarGrupo({ nome: 'Suprimentos', admin: false });
    await db.criarUsuario({ login: 'joao', nome: 'João', senha: 'senha123', grupoId: grupo.id });
    await assert.rejects(
        () => db.removerGrupo(grupo.id), /Mova/);
});

test('remove um grupo vazio sem problema', async () => {
    const grupo = await db.criarGrupo({ nome: 'Suprimentos', admin: false });
    await db.removerGrupo(grupo.id);
    assert.equal(await db.acharGrupo(grupo.id), null);
});

test('não deixa criar dois grupos com o mesmo nome (sem diferenciar maiúsculas)', async () => {
    await db.criarGrupo({ nome: 'Suprimentos', admin: false });
    await assert.rejects(
        () => db.criarGrupo({ nome: 'suprimentos', admin: false }), /Já existe um grupo/);
});
