'use strict';

/**
 * Sobe o server.js de verdade (contra o banco de teste) e confere, por HTTP,
 * as travas que não podem falhar: só administrador mexe em painéis, a troca de
 * senha obrigatória bloqueia o resto do sistema e o login tem limite de tentativas.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { db } = require('./_banco');

const disponivel = Boolean(process.env.TEST_DB_NAME);
const PORTA = 18000 + (process.pid % 1000);
const BASE = 'http://127.0.0.1:' + PORTA;
let servidor = null;

const t = (nome, fn) => test(nome, { skip: disponivel ? false : 'defina TEST_DB_* para rodar' }, fn);

/** Faz login e devolve uma função fetch que já manda o cookie da sessão. */
async function entrar(login, senha) {
    const resp = await fetch(BASE + '/api/sessao/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login, senha })
    });
    assert.equal(resp.status, 200, 'login de ' + login);
    const cookie = resp.headers.get('set-cookie').split(';')[0];
    return (caminho, opcoes = {}) => fetch(BASE + caminho, Object.assign({ redirect: 'manual' }, opcoes, {
        headers: Object.assign({ cookie, 'Content-Type': 'application/json' }, opcoes.headers || {})
    }));
}

if (disponivel) {
    test.before(async () => {
        await db.iniciar();
        await db._limparParaTestes();

        const admins = await db.criarGrupo({ nome: 'Administradores', admin: true });
        const leitores = await db.criarGrupo({ nome: 'Leitores', admin: false, paginas: ['galeria', 'planilhas'], dashboards: 'todos' });
        await db.criarUsuario({ login: 'chefe', nome: 'Chefe', senha: 'Chefe123', grupoId: admins.id });
        await db.criarUsuario({ login: 'leitor', nome: 'Leitor', senha: 'Leitor123', grupoId: leitores.id });
        await db.criarUsuario({ login: 'novato', nome: 'Novato', senha: 'Inicial1', grupoId: leitores.id });
        // chefe e leitor já trocaram a senha; novato ainda não
        await db.consultar("UPDATE usuarios SET trocar_senha = 0 WHERE login IN ('chefe', 'leitor')");
        await db.salvarDashboard({ titulo: 'Painel A', codigo: 'x' }, { id: 'x', nome: 'Chefe' });
        await db.salvarDashboard({ id: 'painel-a', titulo: 'Painel A', codigo: 'y' }, { id: 'x', nome: 'Chefe' });

        servidor = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
            env: Object.assign({}, process.env, { PORT: String(PORTA) }),
            stdio: 'ignore'
        });
        for (let i = 0; i < 50; i++) {
            try { if ((await fetch(BASE + '/api/saude')).status === 200) return; } catch { /* ainda subindo */ }
            await new Promise(r => setTimeout(r, 200));
        }
        throw new Error('o servidor de teste não subiu');
    });

    test.after(async () => {
        if (servidor) servidor.kill();
        await db._limparParaTestes();
        await db.encerrar();
    });
}

t('visualizador não cria, edita, exclui, duplica nem restaura painéis', async () => {
    const leitor = await entrar('leitor', 'Leitor123');

    assert.equal((await leitor('/api/dashboards')).status, 200);             // ver, pode
    assert.equal((await leitor('/api/dashboards/painel-a')).status, 200);

    const tentativas = [
        ['POST', '/api/dashboards', { titulo: 'Novo', codigo: '' }],
        ['PUT', '/api/dashboards', { id: 'painel-a', titulo: 'Mudado', codigo: 'z' }],
        ['DELETE', '/api/dashboards/painel-a'],
        ['POST', '/api/dashboards/painel-a/duplicar'],
        ['POST', '/api/dashboards/painel-a/restaurar', { indice: 0 }],
        ['GET', '/api/dashboards/painel-a/versoes']
    ];
    for (const [metodo, caminho, corpo] of tentativas) {
        const resp = await leitor(caminho, { method: metodo, body: corpo ? JSON.stringify(corpo) : undefined });
        assert.equal(resp.status, 403, metodo + ' ' + caminho);
    }
    // e nada mudou
    assert.equal((await db.acharDashboard('painel-a')).codigo, 'y');
    assert.equal((await db.listarDashboards()).length, 1);

    // o editor nem é entregue
    const editor = await leitor('/index.html');
    assert.equal(editor.status, 302);
    assert.equal(editor.headers.get('location'), '/lista_dashboards.html');
});

t('administrador cria, duplica, vê o histórico e exclui painéis', async () => {
    const chefe = await entrar('chefe', 'Chefe123');
    assert.equal((await chefe('/index.html')).status, 200);
    const criado = await (await chefe('/api/dashboards', { method: 'POST', body: JSON.stringify({ titulo: 'Novo', codigo: 'a' }) })).json();
    assert.equal(criado.id, 'novo');
    assert.equal((await chefe('/api/dashboards/novo/duplicar', { method: 'POST' })).status, 201);
    assert.equal((await chefe('/api/dashboards/painel-a/versoes')).status, 200);
    assert.equal((await chefe('/api/dashboards/novo', { method: 'DELETE' })).status, 200);
});

t('troca de senha pendente bloqueia o sistema até o usuário criar a dele', async () => {
    const novato = await entrar('novato', 'Inicial1');

    const api = await novato('/api/dashboards');
    assert.equal(api.status, 403);
    assert.equal((await api.json()).codigo, 'TROCAR_SENHA');
    const pagina = await novato('/planilhas.html');
    assert.equal(pagina.status, 302);
    assert.equal(pagina.headers.get('location'), '/conta.html?obrigatorio=1');
    assert.equal((await novato('/conta.html')).status, 200);

    const troca = await novato('/api/sessao/senha', { method: 'PUT', body: JSON.stringify({ senhaAtual: 'Inicial1', novaSenha: 'MinhaSenha7' }) });
    assert.equal(troca.status, 200);
    assert.equal((await troca.json()).usuario.trocarSenha, false);
    assert.equal((await novato('/api/dashboards')).status, 200);   // mesma sessão, agora liberada
});

t('restaurar versão de planilha é só para administrador', async () => {
    await db.salvarPlanilha('P50.xlsx', Buffer.from('um'), null);
    await db.salvarPlanilha('P50.xlsx', Buffer.from('dois'), null);
    const [versao] = await db.listarVersoesPlanilha('P50.xlsx');

    const leitor = await entrar('leitor', 'Leitor123');
    assert.equal((await leitor('/api/planilhas/P50.xlsx/versoes')).status, 200);
    const baixada = await leitor('/api/planilhas/P50.xlsx/versoes/' + versao.id);
    assert.equal(await baixada.text(), 'um');
    assert.equal((await leitor('/api/planilhas/P50.xlsx/versoes/' + versao.id + '/restaurar', { method: 'POST' })).status, 403);

    const chefe = await entrar('chefe', 'Chefe123');
    assert.equal((await chefe('/api/planilhas/P50.xlsx/versoes/' + versao.id + '/restaurar', { method: 'POST' })).status, 200);
    assert.equal((await db.lerPlanilha('P50.xlsx')).dados.toString(), 'um');
});

t('foto de fundo do início: todos veem, só o administrador troca, e só imagem', async () => {
    const chefe = await entrar('chefe', 'Chefe123');
    const leitor = await entrar('leitor', 'Leitor123');
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const enviar = (quem, corpo) => quem('/api/inicio/fundo', { method: 'PUT', body: corpo, headers: { 'Content-Type': 'image/png' } });

    assert.equal((await fetch(BASE + '/api/inicio/fundo')).status, 401);       // sem login
    assert.equal((await leitor('/api/inicio/fundo')).status, 404);             // ainda sem foto: a página usa o degradê
    assert.equal((await enviar(leitor, PNG)).status, 403);
    assert.equal((await enviar(chefe, Buffer.from('<svg><script>alert(1)</script></svg>'))).status, 400);
    assert.equal((await enviar(chefe, PNG)).status, 200);

    const foto = await leitor('/api/inicio/fundo');
    assert.equal(foto.status, 200);
    assert.equal(foto.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await foto.arrayBuffer()), PNG);
    const etag = foto.headers.get('etag');
    assert.equal((await leitor('/api/inicio/fundo', { headers: { 'If-None-Match': etag } })).status, 304);

    assert.equal((await leitor('/api/inicio/fundo', { method: 'DELETE' })).status, 403);
    assert.equal((await chefe('/api/inicio/fundo', { method: 'DELETE' })).status, 200);
    assert.equal((await leitor('/api/inicio/fundo')).status, 404);
});

t('categorias: todos listam, só o administrador cria, edita e exclui', async () => {
    const chefe = await entrar('chefe', 'Chefe123');
    const leitor = await entrar('leitor', 'Leitor123');

    const resp = await leitor('/api/categorias');
    assert.equal(resp.status, 200);
    assert.ok(Array.isArray((await resp.json()).paleta));

    assert.equal((await leitor('/api/categorias', { method: 'POST', body: JSON.stringify({ nome: 'Nope' }) })).status, 403);
    const criada = await chefe('/api/categorias', { method: 'POST', body: JSON.stringify({ nome: 'Obras', cor: '#0E9384' }) });
    assert.equal(criada.status, 201);
    const { id } = await criada.json();

    assert.equal((await leitor('/api/categorias/' + id, { method: 'PUT', body: JSON.stringify({ cor: '#000000' }) })).status, 403);
    const editada = await chefe('/api/categorias/' + id, { method: 'PUT', body: JSON.stringify({ cor: '#F04438' }) });
    assert.equal((await editada.json()).cor, '#f04438');

    // O painel publicado com a categoria por nome volta com nome e cor.
    const painel = await chefe('/api/dashboards', { method: 'POST', body: JSON.stringify({ titulo: 'Com categoria', categoria: 'obras', codigo: '' }) });
    assert.deepEqual((await painel.json()).categoria, { id, nome: 'Obras', cor: '#f04438' });

    assert.equal((await leitor('/api/categorias/' + id, { method: 'DELETE' })).status, 403);
    assert.equal((await chefe('/api/categorias/' + id, { method: 'DELETE' })).status, 200);
});

t('login bloqueia depois de 5 senhas erradas, mesmo acertando em seguida', async () => {
    const tentar = senha => fetch(BASE + '/api/sessao/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.7' },
        body: JSON.stringify({ login: 'leitor', senha })
    });
    for (let i = 0; i < 5; i++) assert.equal((await tentar('errada')).status, 401);
    const bloqueado = await tentar('Leitor123');
    assert.equal(bloqueado.status, 429);
    assert.match((await bloqueado.json()).error, /Tente de novo em 15 minutos/);
});
