'use strict';

/**
 * Grupo substituiu papel: estes testes protegem exatamente o que mudou —
 * criação/edição de grupos e usuários, e as travas que nunca deixam o
 * sistema ficar sem nenhum administrador.
 *
 * Roda contra um database.json temporário (nunca o de desenvolvimento):
 * as variáveis de ambiente precisam ser definidas ANTES do primeiro
 * require('../lib/db'), porque o caminho do arquivo é lido uma única vez.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ARQUIVO_DB = path.join(os.tmpdir(), 'epcview-teste-grupos-db-' + process.pid + '.json');
const ARQUIVO_SESSOES = path.join(os.tmpdir(), 'epcview-teste-grupos-sessoes-' + process.pid + '.json');
process.env.UHN_DB_ARQUIVO = ARQUIVO_DB;
process.env.UHN_DB_ARQUIVO_SESSOES = ARQUIVO_SESSOES;

const db = require('../lib/db');

async function limpar() {
    await db._resetParaTestes();
    for (const arquivo of [ARQUIVO_DB, ARQUIVO_SESSOES]) {
        try { fs.unlinkSync(arquivo); } catch { /* já não existe */ }
    }
}

test.beforeEach(limpar);
test.after(limpar);

// ---------------------------------------------------------------------------
// Criar usuário exige grupo — é o grupo que decide admin ou não agora.
// ---------------------------------------------------------------------------

test('criarUsuario recusa quando não informa grupo', () => {
    assert.throws(
        () => db.criarUsuario({ login: 'joao', nome: 'João', senha: 'senha123' }),
        /Selecione um grupo/
    );
});

test('criarUsuario recusa um grupoId que não existe', () => {
    assert.throws(
        () => db.criarUsuario({ login: 'joao', nome: 'João', senha: 'senha123', grupoId: 'inexistente' }),
        /Selecione um grupo/
    );
});

test('usuário num grupo admin resolve papel "admin"', () => {
    const grupo = db.criarGrupo({ nome: 'Administradores', admin: true });
    const usuario = db.criarUsuario({ login: 'admin2', nome: 'Admin', senha: 'senha123', grupoId: grupo.id });
    assert.equal(usuario.papel, 'admin');
});

test('usuário num grupo comum resolve papel "visualizador"', () => {
    const grupo = db.criarGrupo({ nome: 'Suprimentos', admin: false, paginas: ['planilhas'] });
    const usuario = db.criarUsuario({ login: 'joao', nome: 'João', senha: 'senha123', grupoId: grupo.id });
    assert.equal(usuario.papel, 'visualizador');
});

test('e-mail inválido é recusado ao criar e ao editar', () => {
    const grupo = db.criarGrupo({ nome: 'Suprimentos', admin: false });
    assert.throws(
        () => db.criarUsuario({ login: 'joao', nome: 'João', senha: 'senha123', grupoId: grupo.id, email: 'não é email' }),
        /E-mail inválido/
    );
    const usuario = db.criarUsuario({ login: 'joao', nome: 'João', senha: 'senha123', grupoId: grupo.id });
    assert.throws(() => db.atualizarUsuario(usuario.id, { email: 'não é email' }), /E-mail inválido/);
});

// ---------------------------------------------------------------------------
// permissoesDoUsuario — o que cada papel efetivamente enxerga.
// ---------------------------------------------------------------------------

test('permissoesDoUsuario: admin vê tudo, independente do que o grupo tem configurado', () => {
    const grupo = db.criarGrupo({ nome: 'Administradores', admin: true, paginas: [], dashboards: [], aplicacoes: [] });
    const usuario = db.criarUsuario({ login: 'admin2', nome: 'Admin', senha: 'senha123', grupoId: grupo.id });
    assert.deepEqual(db.permissoesDoUsuario(usuario), { paginas: 'todos', dashboards: 'todos', aplicacoes: 'todos' });
});

test('permissoesDoUsuario: visualizador herda exatamente o que o grupo libera', () => {
    const grupo = db.criarGrupo({
        nome: 'Suprimentos', admin: false,
        paginas: ['planilhas'], dashboards: ['painel-suprimentos'], aplicacoes: ['*']
    });
    const usuario = db.criarUsuario({ login: 'joao', nome: 'João', senha: 'senha123', grupoId: grupo.id });
    const permissoes = db.permissoesDoUsuario(usuario);
    assert.deepEqual(permissoes.paginas, ['planilhas']);
    assert.deepEqual(permissoes.dashboards, ['painel-suprimentos']);
    assert.deepEqual(permissoes.aplicacoes, ['*']);
});

// ---------------------------------------------------------------------------
// Nunca deixar o sistema sem nenhum administrador.
// ---------------------------------------------------------------------------

test('não deixa remover o único administrador', () => {
    const grupo = db.criarGrupo({ nome: 'Administradores', admin: true });
    const usuario = db.criarUsuario({ login: 'admin2', nome: 'Admin', senha: 'senha123', grupoId: grupo.id });
    assert.throws(() => db.removerUsuario(usuario.id), /único administrador/);
});

test('permite remover um admin quando existe outro', () => {
    const grupo = db.criarGrupo({ nome: 'Administradores', admin: true });
    const a1 = db.criarUsuario({ login: 'admin1', nome: 'Admin 1', senha: 'senha123', grupoId: grupo.id });
    const a2 = db.criarUsuario({ login: 'admin2', nome: 'Admin 2', senha: 'senha123', grupoId: grupo.id });
    db.removerUsuario(a1.id);
    assert.notEqual(db.acharUsuario(a2.id), null);
});

test('não deixa mover o único admin para um grupo comum', () => {
    const grupoAdmin = db.criarGrupo({ nome: 'Administradores', admin: true });
    const grupoComum = db.criarGrupo({ nome: 'Visualizadores', admin: false });
    const usuario = db.criarUsuario({ login: 'admin2', nome: 'Admin', senha: 'senha123', grupoId: grupoAdmin.id });
    assert.throws(() => db.atualizarUsuario(usuario.id, { grupoId: grupoComum.id }), /único administrador/);
});

test('permite mover um admin de grupo quando outro grupo admin com gente cobre a saída', () => {
    const grupoAdmin1 = db.criarGrupo({ nome: 'Administradores', admin: true });
    const grupoAdmin2 = db.criarGrupo({ nome: 'Superadmins', admin: true });
    const usuario = db.criarUsuario({ login: 'admin2', nome: 'Admin', senha: 'senha123', grupoId: grupoAdmin1.id });
    db.criarUsuario({ login: 'admin3', nome: 'Admin 3', senha: 'senha123', grupoId: grupoAdmin2.id });
    assert.doesNotThrow(() => db.atualizarUsuario(usuario.id, { grupoId: grupoAdmin2.id }));
});

test('não deixa rebaixar o único grupo admin enquanto tem membro', () => {
    const grupo = db.criarGrupo({ nome: 'Administradores', admin: true });
    db.criarUsuario({ login: 'admin2', nome: 'Admin', senha: 'senha123', grupoId: grupo.id });
    assert.throws(() => db.atualizarGrupo(grupo.id, { admin: false }), /sem nenhum administrador/);
});

test('permite rebaixar um grupo admin vazio', () => {
    const grupo = db.criarGrupo({ nome: 'Administradores', admin: true });
    assert.doesNotThrow(() => db.atualizarGrupo(grupo.id, { admin: false }));
});

// ---------------------------------------------------------------------------
// Grupo com gente dentro não pode sumir sem avisar pra onde eles vão.
// ---------------------------------------------------------------------------

test('não deixa remover um grupo que ainda tem usuários', () => {
    const grupo = db.criarGrupo({ nome: 'Suprimentos', admin: false });
    db.criarUsuario({ login: 'joao', nome: 'João', senha: 'senha123', grupoId: grupo.id });
    assert.throws(() => db.removerGrupo(grupo.id), /Mova/);
});

test('remove um grupo vazio sem problema', () => {
    const grupo = db.criarGrupo({ nome: 'Suprimentos', admin: false });
    db.removerGrupo(grupo.id);
    assert.equal(db.acharGrupo(grupo.id), null);
});

test('não deixa criar dois grupos com o mesmo nome (sem diferenciar maiúsculas)', () => {
    db.criarGrupo({ nome: 'Suprimentos', admin: false });
    assert.throws(() => db.criarGrupo({ nome: 'suprimentos', admin: false }), /Já existe um grupo/);
});

// ---------------------------------------------------------------------------
// Migração: quem já existia antes do recurso de grupos não pode perder acesso.
// ---------------------------------------------------------------------------

test('migração: usuário legado com papel admin ganha um grupo Administradores', async () => {
    fs.writeFileSync(ARQUIVO_DB, JSON.stringify({
        versao: 2,
        usuarios: [{ id: 'u1', login: 'admin', nome: 'Administrador', papel: 'admin', senha: 'x', criadoEm: new Date().toISOString() }],
        dashboards: [],
        grupos: []
    }));
    await db._resetParaTestes();

    const grupos = db.listarGrupos();
    assert.equal(grupos.length, 1);
    assert.equal(grupos[0].admin, true);

    const bruto = db.acharUsuarioPorLogin('admin');
    assert.equal(bruto.grupoId, grupos[0].id);
    assert.equal(bruto.papel, undefined); // não fica mais gravado no registro

    assert.equal(db.listarUsuarios()[0].papel, 'admin'); // mas continua resolvendo certo pra fora
});

test('migração: usuário legado visualizador ganha um grupo Visualizadores padrão equivalente ao de antes', async () => {
    fs.writeFileSync(ARQUIVO_DB, JSON.stringify({
        versao: 2,
        usuarios: [{ id: 'u1', login: 'joao', nome: 'João', papel: 'visualizador', senha: 'x', criadoEm: new Date().toISOString() }],
        dashboards: [],
        grupos: []
    }));
    await db._resetParaTestes();

    const grupos = db.listarGrupos();
    assert.equal(grupos.length, 1);
    assert.equal(grupos[0].admin, false);
    assert.deepEqual(grupos[0].paginas.slice().sort(), ['galeria', 'planilhas']);
    assert.equal(grupos[0].dashboards, 'todos');
});
